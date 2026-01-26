import { Request, Response } from 'express';
import { AppDataSource } from '../datasource';
import { Client } from '../models/Client';
import { fullSyncClients, refreshClientsByTerm, searchLocal, listClientsPage } from '../services/wisphubClient';

function pickFromRaw(raw: any, key: string) {
  if (!raw) return null;
  const v = raw[key];
  if (v === undefined) return null;
  if (v && typeof v === 'object') {
    return v.name || v.nombre || JSON.stringify(v);
  }
  return v;
}

function enrichClientEntity(c: Client) {
  const raw = c.raw || {};
  return {
    id_servicio: c.id_servicio,
    usuario: c.usuario ?? pickFromRaw(raw, 'usuario'),
    nombre: c.nombre ?? pickFromRaw(raw, 'nombre'),
    apellidos: c.apellidos ?? pickFromRaw(raw, 'apellidos'),
    email: c.email ?? pickFromRaw(raw, 'email'),
    telefono: c.telefono ?? pickFromRaw(raw, 'telefono'),
    cedula: c.cedula ?? pickFromRaw(raw, 'cedula'),
    direccion: c.direccion ?? pickFromRaw(raw, 'direccion'),
    ciudad: c.ciudad ?? pickFromRaw(raw, 'ciudad'),
    localidad: c.localidad ?? pickFromRaw(raw, 'localidad'),
    sn_onu: c.sn_onu ?? pickFromRaw(raw, 'sn_onu'),
    mac_cpe: c.mac_cpe ?? pickFromRaw(raw, 'mac_cpe'),
    estado: c.estado ?? pickFromRaw(raw, 'estado'),
    raw: c.raw,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    lastSyncedAt: c.lastSyncedAt,
    email_cc: c.email_cc ?? pickFromRaw(raw, 'email_cc'),
    razon_social: c.razon_social ?? pickFromRaw(raw, 'razon_social'),
    tipo_persona: c.tipo_persona ?? pickFromRaw(raw, 'tipo_persona'),
    rfc: c.rfc ?? pickFromRaw(raw, 'rfc'),
    informacion_adicional: c.informacion_adicional ?? pickFromRaw(raw, 'informacion_adicional'),
    firewall: c.firewall ?? pickFromRaw(raw, 'firewall'),
    servicio: c.servicio ?? pickFromRaw(raw, 'servicio'),
    ip: c.ip ?? pickFromRaw(raw, 'ip'),
    modelo_router_wifi: c.modelo_router_wifi ?? pickFromRaw(raw, 'modelo_router_wifi'),
    mac_router_wifi: c.mac_router_wifi ?? pickFromRaw(raw, 'mac_router_wifi'),
    comentarios: c.comentarios ?? pickFromRaw(raw, 'comentarios'),
    precio_plan: c.precio_plan ?? pickFromRaw(raw, 'precio_plan'),
    estado_facturas: c.estado_facturas ?? pickFromRaw(raw, 'estado_facturas'),
    fecha_instalacion: c.fecha_instalacion ?? pickFromRaw(raw, 'fecha_instalacion'),
    fecha_cancelacion: c.fecha_cancelacion ?? pickFromRaw(raw, 'fecha_cancelacion'),
    fecha_corte: c.fecha_corte ?? pickFromRaw(raw, 'fecha_corte'),
    ultimo_cambio: c.ultimo_cambio ?? pickFromRaw(raw, 'ultimo_cambio'),
    plan_internet: c.plan_internet ?? pickFromRaw(raw, 'plan_internet'),
    zona: c.zona ?? pickFromRaw(raw, 'zona'),
    router: c.router ?? pickFromRaw(raw, 'router'),
    sectorial: c.sectorial ?? pickFromRaw(raw, 'sectorial'),
    tecnico: c.tecnico ?? pickFromRaw(raw, 'tecnico')
  };
}
export async function searchClients(req: Request, res: Response) {
  const term = String(req.query.term || '').trim();
  if (!term) return res.status(400).json({ error: 'Missing term' });

  try {
    // Always refresh from Wisphub for this term to keep results up-to-date
    await refreshClientsByTerm(term);
    const results = await searchLocal(term, 50);
    return res.json({ results: results.map(enrichClientEntity), refreshed: true });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || 'Search failed' });
  }
}

// GET /clients/wisphub - query Wisphub API directly (limit, offset optional)
export async function listClientsFromWisphub(req: Request, res: Response) {
  try {
    const limit = Math.min(Number(req.query.limit || 50), 1000);
    const offset = Math.max(Number(req.query.offset || 0), 0);
    const data = await listClientsPage({ limit, offset });
    return res.json(data);
  } catch (err: any) {
    console.error('listClientsFromWisphub failed', err?.message || err);
    return res.status(500).json({ error: err?.message || 'failed to fetch from wisphub' });
  }
}

export async function listClients(req: Request, res: Response) {
  const take = Math.min(Number(req.query.limit || 50), 200);
  const skip = Math.max(Number(req.query.offset || 0), 0);
  const repo = AppDataSource.getRepository(Client);
  const force = !!req.query.sync;
  try {
    if (force) {
      // If caller requests, perform a full sync and wait
      await fullSyncClients();
    } else {
      // Start a background full sync to keep cache updated
      fullSyncClients().catch((e) => console.error('Background fullSyncClients failed', e?.message || e));
    }
    const [items, count] = await repo.findAndCount({ take, skip, order: { updatedAt: 'DESC' } });
    return res.json({ count, results: items.map(enrichClientEntity) });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || 'List failed' });
  }
}

export async function syncAll(req: Request, res: Response) {
  try {
    const { processed, lastFullSyncAt } = await fullSyncClients();
    return res.json({ ok: true, processed, lastFullSyncAt });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || 'Sync failed' });
  }
}
