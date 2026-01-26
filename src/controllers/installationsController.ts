import { Request, Response } from 'express';
import * as wisphubInst from '../services/wisphubInstallations';

function pickFromRaw(raw: any, key: string) {
  if (!raw) return null;
  const v = raw[key];
  if (v === undefined) return null;
  if (v && typeof v === 'object') return v.name || v.nombre || JSON.stringify(v);
  return v;
}

function enrichInstallationEntity(i: any) {
  const raw = i.raw || {};
  return {
    id: i.id,
    id_servicio: i.id_servicio ?? pickFromRaw(raw, 'id_servicio'),
    tipo: i.tipo ?? pickFromRaw(raw, 'tipo'),
    estado_instalacion: i.estado_instalacion ?? pickFromRaw(raw, 'estado_instalacion'),
    usuario: i.usuario ?? pickFromRaw(raw, 'usuario'),
    nombre: i.nombre ?? pickFromRaw(raw, 'nombre'),
    apellidos: i.apellidos ?? pickFromRaw(raw, 'apellidos'),
    raw: i.raw,
    createdAt: i.createdAt,
    updatedAt: i.updatedAt,
    email: i.email ?? pickFromRaw(raw, 'email'),
    razon_social: i.razon_social ?? pickFromRaw(raw, 'razon_social'),
    tipo_persona: i.tipo_persona ?? pickFromRaw(raw, 'tipo_persona'),
    cedula: i.cedula ?? pickFromRaw(raw, 'cedula'),
    direccion: i.direccion ?? pickFromRaw(raw, 'direccion'),
    localidad: i.localidad ?? pickFromRaw(raw, 'localidad'),
    ciudad: i.ciudad ?? pickFromRaw(raw, 'ciudad'),
    telefono: i.telefono ?? pickFromRaw(raw, 'telefono'),
    rfc: i.rfc ?? pickFromRaw(raw, 'rfc'),
    informacion_adicional: i.informacion_adicional ?? pickFromRaw(raw, 'informacion_adicional'),
    firewall: i.firewall ?? pickFromRaw(raw, 'firewall'),
    servicio: i.servicio ?? pickFromRaw(raw, 'servicio'),
    ip: i.ip ?? pickFromRaw(raw, 'ip'),
    estado: i.estado ?? pickFromRaw(raw, 'estado'),
    modelo_router_wifi: i.modelo_router_wifi ?? pickFromRaw(raw, 'modelo_router_wifi'),
    ip_router_wifi: i.ip_router_wifi ?? pickFromRaw(raw, 'ip_router_wifi'),
    mac_router_wifi: i.mac_router_wifi ?? pickFromRaw(raw, 'mac_router_wifi'),
    comentarios: i.comentarios ?? pickFromRaw(raw, 'comentarios'),
    coordenadas: i.coordenadas ?? pickFromRaw(raw, 'coordenadas'),
    sn_onu: i.sn_onu ?? pickFromRaw(raw, 'sn_onu'),
    fecha_instalacion: i.fecha_instalacion ?? pickFromRaw(raw, 'fecha_instalacion'),
    ultimo_cambio: i.ultimo_cambio ?? pickFromRaw(raw, 'ultimo_cambio'),
    plan_internet: i.plan_internet ?? pickFromRaw(raw, 'plan_internet'),
    zona: i.zona ?? pickFromRaw(raw, 'zona'),
    router: i.router ?? pickFromRaw(raw, 'router'),
    sectorial: i.sectorial ?? pickFromRaw(raw, 'sectorial'),
    tecnico: i.tecnico ?? pickFromRaw(raw, 'tecnico')
  };
}

export async function listInstallations(req: Request, res: Response) {
  try {
    const q = String(req.query.q || '').trim();
    const page = Number(req.query.page || 1);
    const limit = Math.min(Number(req.query.limit || 50), 200);
    const offset = (page - 1) * limit;
    const onlyPending = String(req.query.pending || '').toLowerCase() === 'true';

    if (q) {
      // Refresh matching installations first
      await wisphubInst.refreshInstallationsByTerm(q);
      const repoRes = await wisphubInst.searchLocalInstallations(q, limit);
      return res.json({ results: repoRes.map(enrichInstallationEntity), page, limit });
    }

    const force = !!req.query.sync;
    if (force) {
      await wisphubInst.fullSyncInstallations();
    } else {
      // background sync
      wisphubInst.fullSyncInstallations().catch((e) => console.error('Background installations sync failed', e?.message || e));
    }
    if (onlyPending) {
      const items = await wisphubInst.listPendingLocalInstallations(limit);
      return res.json({ results: items.map(enrichInstallationEntity), page, limit });
    } else {
      const repo = (await import('../datasource')).AppDataSource.getRepository((await import('../models/Installation')).Installation);
      const [items, count] = await repo.findAndCount({ take: limit, skip: offset, order: { updatedAt: 'DESC' } });
      return res.json({ results: items.map(enrichInstallationEntity), page, limit, count });
    }
  } catch (err: any) {
    console.error(err);
    res.status(500).json({ error: err.message || 'error' });
  }
}

export async function syncInstallations(req: Request, res: Response) {
  try {
    const result = await wisphubInst.fullSyncInstallations();
    res.json({ ok: true, result });
  } catch (err: any) {
    console.error(err);
    res.status(500).json({ error: err.message || 'error' });
  }
}

// GET /installations/wisphub - proxy to WispHub installations endpoint with query params
export async function listInstallationsFromWisphub(req: Request, res: Response) {
  try {
    const params: Record<string, any> = {};
    // Allow repeated params like estado_instalacion=1&estado_instalacion=2
    for (const [k, v] of Object.entries(req.query)) {
      if (Array.isArray(v)) params[k] = v;
      else params[k] = String(v);
    }
    // default pagination if none provided
    if (!params.limit) params.limit = 200;
    if (!params.offset) params.offset = 0;

    // Use server-side WISP key from configuration (no client Api-Key required)
    const data = await wisphubInst.listInstallationsPage(params);
    // Ensure local DB is updated with the page we just fetched
    try {
      const processed = await wisphubInst.upsertInstallations(data.results || []);
      // eslint-disable-next-line no-console
      console.log(`upsertInstallations processed=${processed}`);
    } catch (e: any) {
      // log and continue returning the remote data
      // eslint-disable-next-line no-console
      console.error('upsertInstallations failed', e?.message || e);
    }
    // Return a cleaner, UI-friendly projection: ID | Nombre del Cliente | Dirección | Ciudad | Estado
    const mapped = (data.results || []).map((it: any) => {
      const id = it.id_servicio ?? it.id ?? null;
      const nombreCliente = [it.nombre, it.apellidos].filter(Boolean).join(' ').trim() || it.usuario || null;
      const direccion = it.direccion ?? (it.raw && it.raw.direccion) ?? null;
      const ciudad = it.ciudad ?? (it.raw && it.raw.ciudad) ?? null;
      const estado = it.estado ?? it.estado_instalacion ?? (it.raw && (it.raw.estado || it.raw.estado_instalacion)) ?? null;
      return {
        id,
        cliente: nombreCliente,
        direccion,
        ciudad,
        estado
      };
    });

    return res.json({ ok: true, count: data.count, next: data.next, previous: data.previous, results: mapped });
  } catch (err: any) {
    console.error('listInstallationsFromWisphub failed', err?.message || err);
    return res.status(500).json({ error: err?.message || 'error' });
  }
}

// GET /installations/:id/clients - return installations associated with id (id or id_servicio)
export async function getClientsForInstallation(req: Request, res: Response) {
  try {
    const idParam = req.params.id;
    if (!idParam) return res.status(400).json({ error: 'id required' });

    const AppDataSource = (await import('../datasource')).AppDataSource;
    const installationRepo = AppDataSource.getRepository((await import('../models/Installation')).Installation);

    const maybeId = Number(idParam);
    let installations: any[] = [];

    if (!Number.isNaN(maybeId)) {
      // search by primary id or by id_servicio
      installations = await installationRepo.find({
        where: [{ id: maybeId }, { id_servicio: maybeId }],
        order: { updatedAt: 'DESC' }
      });
    } else {
      // non-numeric: try to match id_servicio string in raw or exact string field
      const qb = installationRepo.createQueryBuilder('i');
      qb.where('i.id_servicio = :s', { s: idParam }).orWhere("i.raw::text LIKE :sraw", { sraw: `%${idParam}%` }).orderBy('i.updatedAt', 'DESC').limit(20);
      installations = await qb.getMany();
    }

    if (!installations || installations.length === 0) return res.status(404).json({ ok: false, error: 'no installations found for id', id: idParam });

    return res.json({ ok: true, installations: installations.map(enrichInstallationEntity) });
  } catch (err: any) {
    console.error('getClientsForInstallation failed', err);
    return res.status(500).json({ error: err?.message || 'error' });
  }
}
