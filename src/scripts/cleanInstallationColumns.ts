import { AppDataSource } from '../datasource';
import { Installation } from '../models/Installation';
import { MYSQL } from '../config';

async function ensureInitialized() {
  if (!AppDataSource.isInitialized) await AppDataSource.initialize();
}

async function columnExists(table: string, column: string) {
  const sql = `SELECT COUNT(*) as cnt FROM information_schema.columns WHERE table_schema = ? AND table_name = ? AND column_name = ?`;
  const res: any = await AppDataSource.query(sql, [MYSQL.database, table, column]);
  return Number(res[0]?.cnt || 0) > 0;
}

export async function dropInstallationColumns() {
  await ensureInitialized();
  const table = AppDataSource.getRepository(Installation).metadata.tableName;
  const cols = [
    'descuento','saldo','notificacion_sms','aviso_pantalla','notificaciones_push','auto_activar_servicio',
    'password_servicio','server_hotspot','ip_local','modelo_antena','password_cpe','mac_cpe','interfaz_lan',
    'usuario_router_wifi','password_router_wifi','ssid_router_wifi','password_ssid_router_wifi',
    'costo_instalacion','precio_plan','forma_contratacion','estado_facturas'
  ];
  const dropped: string[] = [];
  const notFound: string[] = [];
  for (const c of cols) {
    const exists = await columnExists(table, c);
    if (exists) {
      await AppDataSource.query(`ALTER TABLE \`${table}\` DROP COLUMN \`${c}\``);
      dropped.push(c);
    } else {
      notFound.push(c);
    }
  }
  return { table, dropped, notFound };
}

export default dropInstallationColumns;
