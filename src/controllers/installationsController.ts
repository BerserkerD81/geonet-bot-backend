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
