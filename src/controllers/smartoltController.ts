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
import { listGlobalUnconfiguredOnus } from '../services/smartoltClient';
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
  const zoneParam = (req.params.zone || '').toString().trim();
  if (!zoneParam) return res.status(400).json({ error: 'zone is required' });
  const zoneName = decodeURIComponent(zoneParam);

  try {
    // Avoid stale cached responses for dynamic SmartOLT data
    res.setHeader('Cache-Control', 'no-store');

    const odbRepo = AppDataSource.getRepository(SmartoltOdb);
    const zoneRepo = AppDataSource.getRepository(SmartoltZone);

    const zoneLower = zoneName.toLowerCase();
    const zoneCode = (zoneLower.match(/z\d+/) || [null])[0];
    const tokenPattern = zoneLower.split(/\s+/).filter(Boolean).join('%');
    const tokens = zoneLower.split(/[^a-z0-9]+/).filter(Boolean);
    const reversed = zoneLower.split(/\s*-\s*/).reverse().join(' - ');

    const findZone = async () => {
      const qb = zoneRepo
        .createQueryBuilder('z')
        .where('LOWER(z.name) = :zone', { zone: zoneLower })
        .orWhere('LOWER(z.name) LIKE :zoneLike', { zoneLike: `%${zoneLower}%` })
        .orWhere('LOWER(z.name) = :revZone', { revZone: reversed });

      if (zoneCode) qb.orWhere('LOWER(z.name) LIKE :zoneCode', { zoneCode: `%${zoneCode}%` });
      if (tokenPattern) qb.orWhere('LOWER(z.name) LIKE :tokenPattern', { tokenPattern: `%${tokenPattern}%` });
      if (reversed) qb.orWhere('LOWER(z.name) LIKE :revLike', { revLike: `%${reversed}%` });

      return qb.orderBy('LENGTH(z.name)', 'ASC').getOne();
    };

    const fetchOdbsForZone = async (zoneId: number) =>
      odbRepo
        .createQueryBuilder('o')
        .leftJoinAndSelect('o.zone', 'z')
        .where('z.id = :zoneId', { zoneId })
        .orderBy('o.name', 'ASC')
        .getMany();

    const fetchAndUpsertRemoteForZone = async (): Promise<{ zone?: SmartoltZone; odbs: SmartoltOdb[] }> => {
      try {
        const remote = await getOdbs();
        const filtered = (remote || []).filter((o: any) => {
          const rz = (o?.zone || '').toString().toLowerCase();
          if (!rz) return false;
          if (rz.includes(zoneLower) || zoneLower.includes(rz)) return true;
          if (tokens.length > 0) return tokens.every((t) => rz.includes(t));
          return false;
        });

        if (!filtered.length) return { odbs: [] };

        // Prefer linking by SmartOLT zone_id when available
        const firstZoneExtId = filtered.map((o: any) => o?.zone_id || o?.zoneId || o?.zoneid).find(Boolean);
        let zoneRow: SmartoltZone | null = null;
        if (firstZoneExtId) {
          zoneRow = await zoneRepo.findOne({ where: { externalId: String(firstZoneExtId) } });
        }
        if (!zoneRow) {
          zoneRow = await findZone();
        }
        if (!zoneRow) {
          zoneRow = zoneRepo.create({ name: zoneName, externalId: firstZoneExtId ? String(firstZoneExtId) : null, collectedAt: new Date() });
          zoneRow = await zoneRepo.save(zoneRow);
        } else {
          zoneRow.externalId = zoneRow.externalId || (firstZoneExtId ? String(firstZoneExtId) : null);
          zoneRow.collectedAt = new Date();
          await zoneRepo.save(zoneRow);
        }

        await odbRepo.createQueryBuilder().delete().where('zone_id = :zoneId', { zoneId: zoneRow.id }).execute();

        const odbEntities = filtered.map((o: any) =>
          odbRepo.create({
            name: (o?.name || o?.id || '').toString(),
            externalId: o?.id ? String(o.id) : null,
            collectedAt: new Date(),
            zone: zoneRow!
          })
        );
        if (odbEntities.length) await odbRepo.save(odbEntities);

        const odbsByZone = await fetchOdbsForZone(zoneRow.id);
        return { zone: zoneRow, odbs: odbsByZone };
      } catch (err) {
        console.error('No se pudieron refrescar ODBs desde SmartOLT para zona', zoneName, err);
        return { odbs: [] };
      }
    };

    let zone = await findZone();
    const matchedZone = zone ? { id: zone.id, name: zone.name } : undefined;
    let odbs = zone ? await fetchOdbsForZone(zone.id) : [];
    let refreshed = false;

    // If nothing is found locally, refresh the cache once and retry against DB tables
    if (!zone || odbs.length === 0) {
      await refreshZoneOdbCache().catch(() => {});
      refreshed = true;
      zone = await findZone();
      odbs = zone ? await fetchOdbsForZone(zone.id) : [];
    }

    // If still nothing, pull from SmartOLT filtered by this zone name and persist locally
    if ((!zone || odbs.length === 0) && !odbs.length) {
      const remote = await fetchAndUpsertRemoteForZone();
      if (remote.zone) zone = remote.zone;
      if (remote.odbs.length) odbs = remote.odbs;
      refreshed = refreshed || remote.odbs.length > 0;
    }

    if (!zone) {
      return res.status(404).json({ ok: false, error: `Zona "${zoneName}" no encontrada en la base local` });
    }

    const payload = odbs.map((o) => ({
      id: o.externalId || String(o.id),
      name: o.name,
      zoneId: o.zone?.id,
      zone: o.zone?.name || zoneName,
      externalId: o.externalId || null
    }));

    return res.json({
      ok: true,
      source: refreshed ? 'db-refreshed' : 'db',
      zone: { id: zone.id, name: zone.name },
      matchedZone: matchedZone || null,
      tokens,
      odbs: payload
    });
  } catch (err: any) {
    const msg = err?.response?.data || { error: err?.message || 'Failed to fetch ODBs by zone' };
    return res.status(500).json(msg);
  }
}

export async function listUnconfiguredOnus(req: Request, res: Response) {
  try {
    // Prevent caching for dynamic SmartOLT data
    res.setHeader('Cache-Control', 'no-store');
    const data = await listGlobalUnconfiguredOnus();
    return res.json({ ok: true, data });
  } catch (err: any) {
    const msg = err?.response?.data || { error: err?.message || 'Failed to fetch unconfigured ONUs' };
    return res.status(500).json(msg);
  }
}
