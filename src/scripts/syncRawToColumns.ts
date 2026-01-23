import { AppDataSource } from '../datasource';
import { Client } from '../models/Client';
import { Installation } from '../models/Installation';
import { MYSQL } from '../config';
import { parseRaw, asDate, stripHtml } from '../services/rawParser';

function sanitizeColumnName(key: string) {
  return key.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase().slice(0, 60);
}

async function ensureInitialized() {
  if (!AppDataSource.isInitialized) await AppDataSource.initialize();
}

async function columnExists(table: string, column: string) {
  const sql = `SELECT COUNT(*) as cnt FROM information_schema.columns WHERE table_schema = ? AND table_name = ? AND column_name = ?`;
  const res: any = await AppDataSource.query(sql, [MYSQL.database, table, column]);
  return Number(res[0]?.cnt || 0) > 0;
}

async function addColumn(table: string, column: string) {
  const sql = `ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` TEXT NULL`;
  try {
    await AppDataSource.query(sql);
  } catch (e: any) {
    // Ignore duplicate column errors to keep idempotent runs
    if (e?.code === 'ER_DUP_FIELDNAME') return;
    throw e;
  }
}

async function updateRowValue(table: string, pkName: string, pkValue: any, column: string, value: any) {
  const sql = `UPDATE \`${table}\` SET \`${column}\` = ? WHERE \`${pkName}\` = ?`;
  await AppDataSource.query(sql, [value, pkValue]);
}

async function extractKeysFromRawRows(rows: any[]) {
  const keys = new Set<string>();
  for (const r of rows) {
    const raw = r.raw;
    if (!raw) continue;
    let obj: any = raw;
    if (typeof raw === 'string') {
      try { obj = JSON.parse(raw); } catch { obj = null; }
    }
    if (obj && typeof obj === 'object') {
      for (const k of Object.keys(obj)) keys.add(k);
    }
  }
  return Array.from(keys);
}

export async function syncRawToColumns() {
  await ensureInitialized();
  const reports: any = {};

  const targets = [
    { repo: AppDataSource.getRepository(Client), tableName: AppDataSource.getRepository(Client).metadata.tableName },
    { repo: AppDataSource.getRepository(Installation), tableName: AppDataSource.getRepository(Installation).metadata.tableName }
  ];

  // blacklist per table (sanitized column names)
  const blacklistPerTable: Record<string, string[]> = {};
  // build blacklist for installation table
  const instTable = AppDataSource.getRepository(Installation).metadata.tableName;
  const instBlacklist = [
    'descuento','saldo','notificacion_sms','aviso_pantalla','notificaciones_push','auto_activar_servicio',
    'password_servicio','server_hotspot','ip_local','modelo_antena','password_cpe','mac_cpe','interfaz_lan',
    'usuario_router_wifi','password_router_wifi','ssid_router_wifi','password_ssid_router_wifi',
    'costo_instalacion','precio_plan','forma_contratacion','estado_facturas'
  ].map(sanitizeColumnName);
  blacklistPerTable[instTable] = instBlacklist;
  // build blacklist for client table
  const clientTable = AppDataSource.getRepository(Client).metadata.tableName;
  const clientBlacklist = [
    'estado_instalacion','is_preinstallation','descuento','saldo','notificacion_sms','aviso_pantalla',
    'notificaciones_push','auto_activar_servicio','password_servicio','server_hotspot','ip_local','modelo_antena',
    'password_cpe','interfaz_lan','usuario_router_wifi','password_router_wifi','ssid_router_wifi',
    'password_ssid_router_wifi','coordenadas','costo_instalacion','forma_contratacion'
  ].map(sanitizeColumnName);
  blacklistPerTable[clientTable] = clientBlacklist;

  for (const t of targets) {
    const table = t.tableName;
    const pk = t.repo.metadata.primaryColumns[0].databaseName;
    const rows: any[] = await AppDataSource.query(`SELECT \`${pk}\`, raw FROM \`${table}\` WHERE raw IS NOT NULL`);
    const keys = await extractKeysFromRawRows(rows);
    reports[table] = { rows: rows.length, discoveredKeys: keys.length, addedColumns: [] };

    for (const key of keys) {
      const col = sanitizeColumnName(key);
      const tableBlacklist = blacklistPerTable[table] || [];
      if (tableBlacklist.includes(col)) {
        // skip blacklisted columns for this table
        continue;
      }
      const exists = await columnExists(table, col);
      if (!exists) {
        await addColumn(table, col);
        reports[table].addedColumns.push(col);
      }
      // update each row value for this column
      for (const r of rows) {
        let raw = r.raw;
        if (!raw) continue;
        if (typeof raw === 'string') {
          try { raw = JSON.parse(raw); } catch { raw = null; }
        }
        const hasKey = raw && Object.prototype.hasOwnProperty.call(raw, key);
        const val = hasKey ? raw[key] : null;
        let storeVal: any = null;
        if (val === null || val === undefined) {
          storeVal = null;
        } else {
          const keyLower = key.toLowerCase();
          // fecha_* fields: normalize to ISO (use asDate which treats YYYY-MM-DD as local midnight)
          if (/^fecha_/.test(keyLower)) {
            const parsed = asDate(raw, key);
            storeVal = parsed ? parsed.toISOString() : String(val);
          } else if (keyLower.includes('coment') || keyLower.includes('informacion')) {
            // comments or informacion_adicional: strip HTML
            storeVal = stripHtml(typeof val === 'string' ? val : JSON.stringify(val));
          } else if (typeof val === 'object') {
            // prefer name/nombre if present
            if (val && (val.name || val.nombre)) {
              storeVal = String(val.name || val.nombre);
            } else {
              storeVal = JSON.stringify(val);
            }
          } else {
            storeVal = String(val);
          }
        }
        await updateRowValue(table, pk, r[pk], col, storeVal);
      }
    }
  }

  return reports;
}

export default syncRawToColumns;
