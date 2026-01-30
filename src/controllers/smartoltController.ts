import { Request, Response } from 'express';
import {
  authorizeOnu,
  AuthorizeOnuParams,
  getCustomerById,
  getInstallationById,
  getOnuBySerial,
  getServiceById,
  getOdbs
} from '../services/smartoltClient';
import { AppDataSource } from '../datasource';
import { SmartoltZone } from '../models/SmartoltZone';
import { SmartoltOdb } from '../models/SmartoltOdb';
import { refreshZoneOdbCache } from '../services/zoneOdbCache';

export async function authorize(req: Request, res: Response) {
  try {
    const params = req.body as Partial<AuthorizeOnuParams>;
    const required: Array<keyof AuthorizeOnuParams> = ['olt_id', 'pon_type', 'sn', 'onu_type', 'onu_mode', 'zone', 'name'];
    const missing = required.filter((k) => !(k in params) || params[k] === undefined || params[k] === null || String(params[k]).trim() === '');
    if (missing.length > 0) {
      return res.status(400).json({ error: `Missing required fields: ${missing.join(', ')}` });
    }

    const result = await authorizeOnu(params as AuthorizeOnuParams);
    return res.json({ ok: true, result });
  } catch (err: any) {
    const msg = err?.response?.data || { error: err?.message || 'SmartOLT authorize failed' };
    return res.status(400).json(msg);
  }
}

export async function getOnu(req: Request, res: Response) {
  try {
    const { serial } = req.params;
    if (!serial) return res.status(400).json({ error: 'serial is required' });
    const data = await getOnuBySerial(serial);
    return res.json({ ok: true, data });
  } catch (err: any) {
    const msg = err?.response?.data || { error: err?.message || 'Failed to fetch ONU data' };
    return res.status(400).json(msg);
  }
}

export async function getCustomer(req: Request, res: Response) {
  try {
    const { id } = req.params;
    if (!id) return res.status(400).json({ error: 'id is required' });
    const data = await getCustomerById(id);
    return res.json({ ok: true, data });
  } catch (err: any) {
    const msg = err?.response?.data || { error: err?.message || 'Failed to fetch customer data' };
    return res.status(400).json(msg);
  }
}

export async function getService(req: Request, res: Response) {
  try {
    const { id } = req.params;
    if (!id) return res.status(400).json({ error: 'id is required' });
    const data = await getServiceById(id);
    return res.json({ ok: true, data });
  } catch (err: any) {
    const msg = err?.response?.data || { error: err?.message || 'Failed to fetch service data' };
    return res.status(400).json(msg);
  }
}

export async function getInstallation(req: Request, res: Response) {
  try {
    const { id } = req.params;
    if (!id) return res.status(400).json({ error: 'id is required' });
    const data = await getInstallationById(id);
    return res.json({ ok: true, data });
  } catch (err: any) {
    const msg = err?.response?.data || { error: err?.message || 'Failed to fetch installation data' };
    return res.status(400).json(msg);
  }
}

export async function listOdbsByZone(req: Request, res: Response) {
  // 1. Obtener y limpiar el parámetro
  const zoneParam = (req.params.zone || '').toString().trim();
  if (!zoneParam) return res.status(400).json({ error: 'zone parameter is required' });

  const zoneNameDecoded = decodeURIComponent(zoneParam);
  const isIdParam = !isNaN(Number(zoneParam));
  const zoneIdTarget = isIdParam ? Number(zoneParam) : null;

  try {
    res.setHeader('Cache-Control', 'no-store');

    const odbRepo = AppDataSource.getRepository(SmartoltOdb);
    const zoneRepo = AppDataSource.getRepository(SmartoltZone);

    // -----------------------------------------------------------
    // FUNCIONES AUXILIARES
    // -----------------------------------------------------------

    /**
     * Busca la entidad Zona en la DB local.
     * - Si zoneParam es número, busca por ID.
     * - Si zoneParam es texto, busca por nombre.
     */
    const findZoneLocal = async (): Promise<SmartoltZone | null> => {
      const qb = zoneRepo.createQueryBuilder('z');

      if (isIdParam && zoneIdTarget) {
        // Búsqueda exacta por ID
        qb.where('z.id = :id', { id: zoneIdTarget });
      } else {
        // Búsqueda por Nombre (para obtener el ID correspondiente)
        const zoneLower = zoneNameDecoded.toLowerCase();
        qb.where('LOWER(z.name) = :name', { name: zoneLower })
          .orWhere('LOWER(z.name) LIKE :likeName', { likeName: `%${zoneLower}%` });
      }

      return qb.getOne();
    };

    /**
     * Busca las ODBs estrictamente por el ID de la zona.
     */
    const fetchOdbsByZoneId = async (zoneId: number) => {
      return odbRepo.createQueryBuilder('o')
        .leftJoinAndSelect('o.zone', 'z')
        .where('z.id = :zoneId', { zoneId }) // <--- FILTRO ESTRICTO: zone_id == id
        .orderBy('o.name', 'ASC')
        .getMany();
    };

    /**
     * Lógica de sincronización con SmartOLT (API externa).
     * Se ejecuta solo si no encontramos datos localmente.
     */
    const syncRemoteData = async (): Promise<{ zone: SmartoltZone | null; odbs: SmartoltOdb[] }> => {
      try {
        const remoteData = await getOdbs(); // Trae todas las ODBs de la API
        if (!remoteData) return { zone: null, odbs: [] };

        // Filtramos los datos remotos para encontrar la zona que buscamos
        const filteredRemote = remoteData.filter((o: any) => {
          // CORRECCIÓN: Usar zone_name en lugar de zone según el error de TS
          const rz = (o?.zone_name || o?.zone || '').toString().toLowerCase();
          
          if (!rz) return false;
          return isIdParam ? true : rz.includes(zoneNameDecoded.toLowerCase());
        });

        if (filteredRemote.length === 0) return { zone: null, odbs: [] };

        // Identificar o Crear la Zona Localmente
        let targetZone = await findZoneLocal();

        if (!targetZone) {
          // Si no existía, tomamos el nombre del primer resultado remoto
          const firstMatch = filteredRemote[0];
          // CORRECCIÓN: Usar zone_name y soportar estructuras remotas variadas (cast a any)
          const firstZoneName = (firstMatch as any).zone_name || (firstMatch as any).zone || firstMatch.name;
          const firstZoneExtId = firstMatch.zone_id;

          targetZone = zoneRepo.create({
            name: firstZoneName,
            externalId: firstZoneExtId ? String(firstZoneExtId) : null,
            collectedAt: new Date(),
          });
          targetZone = await zoneRepo.save(targetZone);
        }

        // Ahora que tenemos targetZone (y su ID), actualizamos sus ODBs
        // 1. Borramos las ODBs viejas de ESTA zona específica
        await odbRepo.createQueryBuilder()
          .delete()
          .where('zone_id = :zid', { zid: targetZone.id })
          .execute();

        // 2. Insertamos las nuevas que coincidan con el nombre de la zona encontrada
        const odbsToInsert = remoteData
          // CORRECCIÓN: Usar zone_name para comparar
          .filter((o: any) => (o.zone_name || o.zone) === targetZone!.name) 
          .map((o: any) => odbRepo.create({
            name: (o?.name || o?.id || '').toString(),
            externalId: o?.id ? String(o.id) : null,
            collectedAt: new Date(),
            zone: targetZone! // Vinculación relacional
          }));

        if (odbsToInsert.length) {
          await odbRepo.save(odbsToInsert);
        }

        // Retornamos buscando de nuevo por ID para asegurar consistencia
        const finalOdbs = await fetchOdbsByZoneId(targetZone.id);
        return { zone: targetZone, odbs: finalOdbs };

      } catch (err) {
        console.error('Error sincronizando datos remotos:', err);
        return { zone: null, odbs: [] };
      }
    };

    // -----------------------------------------------------------
    // FLUJO PRINCIPAL DE EJECUCIÓN
    // -----------------------------------------------------------

    // PASO 1: Intentar buscar la zona localmente
    let zone = await findZoneLocal();
    let odbs: SmartoltOdb[] = [];
    let source = 'db';

    // PASO 2: Si tenemos zona, buscamos sus ODBs por ID
    if (zone) {
      odbs = await fetchOdbsByZoneId(zone.id);
    }

    // PASO 3: Si no hay zona o no hay ODBs, intentamos sincronizar con remoto
    if (!zone || odbs.length === 0) {
      const remoteResult = await syncRemoteData();
      
      if (remoteResult.zone) {
        zone = remoteResult.zone;
        odbs = remoteResult.odbs;
        source = 'db-refreshed';
      }
    }

    // PASO 4: Respuesta final
    if (!zone) {
      return res.status(404).json({ 
        ok: false, 
        error: `Zona no encontrada: ${zoneNameDecoded}` 
      });
    }

    const payload = odbs.map((o) => ({
      id: o.externalId || String(o.id),
      name: o.name,
      zoneId: o.zone.id,      // ID numérico de la relación
      zone: o.zone.name,      // Nombre de la zona
      externalId: o.externalId || null
    }));

    return res.json({
      ok: true,
      source,
      zone: { id: zone.id, name: zone.name },
      odbs: payload
    });

  } catch (err: any) {
    console.error(err);
    return res.status(500).json({ error: err.message || 'Internal Server Error' });
  }
}