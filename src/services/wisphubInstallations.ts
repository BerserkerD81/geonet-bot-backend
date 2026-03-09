import axios, { AxiosHeaders } from 'axios';
import { Brackets } from 'typeorm';
import { AppDataSource } from '../datasource';
import { Installation } from '../models/Installation';
import { WISPHUB } from '../config';
import { parseRaw, asString, asDateString, stripHtml } from './rawParser';
import { ensureRequestDelay } from '../utils/apiThrottle';

const http = axios.create({
  baseURL: WISPHUB.baseUrl.replace(/\/$/, ''),
  timeout: 15000,
  paramsSerializer: {
    indexes: null
  }
});

ensureRequestDelay(http);

http.interceptors.request.use((config) => {
  if (!config.headers) config.headers = new AxiosHeaders();
  if (WISPHUB.apiKey) {
    config.headers.set('Authorization', `Api-Key ${WISPHUB.apiKey}`);
  }
  return config;
});

export type WisphubInstallationItem = {
  id?: number;
  id_servicio?: number;
  estado_instalacion?: string | number;
  usuario?: string;
  nombre?: string;
  apellidos?: string;
  fecha_registro?: string;
  [key: string]: any;
};

const DEFAULT_INSTALLATION_STATES = ['1', '2', '3', '4', '7'];

function coerceEstadoInstalacion(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  const raw = Array.isArray(value) ? value : String(value).split(',');
  const sanitized = raw
    .map((item) => (item === undefined || item === null ? '' : String(item).trim()))
    .filter(Boolean);
  if (!sanitized.length) return undefined;
  return Array.from(new Set(sanitized));
}

export async function listInstallationsPage(params: Record<string, any> = {}) {
  const mergedParams = { ...params } as Record<string, any>;
  const estado = coerceEstadoInstalacion(mergedParams.estado_instalacion ?? DEFAULT_INSTALLATION_STATES);
  if (estado && estado.length) {
    mergedParams.estado_instalacion = estado;
  } else {
    delete mergedParams.estado_instalacion;
  }
  console.log('[wisphub] GET /api/instalaciones/', mergedParams);
  const res = await http.get('/api/instalaciones/', { params: mergedParams });
  const count = res?.data?.count ?? 0;
  const resultsLen = Array.isArray(res?.data?.results) ? res.data.results.length : 0;
  console.log(`[wisphub] response instalaciones: count=${count}, results=${resultsLen}`);
  return res.data as { count: number; next: string | null; previous: string | null; results: WisphubInstallationItem[] };
}

function mapToInstallation(item: WisphubInstallationItem): Installation {
  const inst = new Installation();
  inst.id_servicio = item.id_servicio ?? null;
  inst.tipo = item.tipo ?? (item.estado_instalacion ? 'preinstalacion' : 'instalacion');
  inst.estado_instalacion = item.estado_instalacion ? String(item.estado_instalacion) : null;
  inst.usuario = item.usuario ?? null;
  inst.nombre = item.nombre ?? null;
  inst.apellidos = item.apellidos ?? null;
  const rawObj = parseRaw(item);
  inst.raw = rawObj;
  inst.email = asString(rawObj, 'email') ?? null;
  inst.razon_social = asString(rawObj, 'razon_social') ?? null;
  inst.tipo_persona = asString(rawObj, 'tipo_persona') ?? null;
  inst.cedula = asString(rawObj, 'cedula') ?? null;
  inst.direccion = asString(rawObj, 'direccion') ?? null;
  inst.localidad = asString(rawObj, 'localidad') ?? null;
  inst.ciudad = asString(rawObj, 'ciudad') ?? null;
  inst.telefono = asString(rawObj, 'telefono') ?? null;
  inst.rfc = asString(rawObj, 'rfc') ?? null;
  inst.informacion_adicional = stripHtml(asString(rawObj, 'informacion_adicional')) ?? null;
  inst.firewall = asString(rawObj, 'firewall') ?? null;
  inst.servicio = asString(rawObj, 'servicio') ?? null;
  inst.ip = asString(rawObj, 'ip') ?? null;
  inst.estado = asString(rawObj, 'estado') ?? null;
  inst.modelo_router_wifi = asString(rawObj, 'modelo_router_wifi') ?? null;
  inst.ip_router_wifi = asString(rawObj, 'ip_router_wifi') ?? null;
  inst.mac_router_wifi = asString(rawObj, 'mac_router_wifi') ?? null;
  inst.comentarios = stripHtml(asString(rawObj, 'comentarios')) ?? null;
  const coord = rawObj.coordenadas;
  inst.coordenadas = coord ? (typeof coord === 'string' ? coord : JSON.stringify(coord)) : null;
  inst.sn_onu = asString(rawObj, 'sn_onu') ?? null;
  inst.fecha_instalacion = asDateString(rawObj, 'fecha_instalacion');
  inst.ultimo_cambio = asDateString(rawObj, 'ultimo_cambio');
  inst.plan_internet = asString(rawObj, 'plan_internet')
    ?? asString(rawObj, 'plan')
    ?? asString(rawObj, 'servicio')
    ?? null;
  inst.zona = asString(rawObj, 'zona') ?? null;
  inst.router = asString(rawObj, 'router') ?? null;
  // Sincronización zona-router
  if (inst.zona && inst.router && inst.zona !== inst.router) {
    console.log(`[sync] Zona y router diferentes: zona='${inst.zona}', router='${inst.router}'. Se ajusta router para igualar zona.`);
    inst.router = inst.zona;
  } else if (inst.zona && !inst.router) {
    console.log(`[sync] Router no definido, se autoselecciona router igual a zona: zona='${inst.zona}'.`);
    inst.router = inst.zona;
  }
  // Log de transición preinstalación a instalación
  if (inst.tipo === 'preinstalacion' && inst.estado_instalacion && inst.estado_instalacion.toLowerCase().includes('instalacion')) {
    console.log(`[transition] Pasando de preinstalación a instalación: id_servicio=${inst.id_servicio}, usuario=${inst.usuario}, zona=${inst.zona}, router=${inst.router}`);
  }
  inst.sectorial = asString(rawObj, 'sectorial') ?? null;
  inst.tecnico = asString(rawObj, 'tecnico') ?? null;
  return inst;
}

export async function upsertInstallations(items: WisphubInstallationItem[]): Promise<number> {
  if (!items.length) return 0;
  const repo = AppDataSource.getRepository(Installation);
  let processed = 0;
  for (const item of items) {
    const candidate = mapToInstallation(item);
    let existing: Installation | null = null;
    if (candidate.id_servicio) {
      existing = await repo.findOne({ where: { id_servicio: candidate.id_servicio } });
    } else if (candidate.usuario || candidate.nombre || candidate.apellidos) {
      // Fallback match by basic identity if id_servicio is absent
      const qb = repo.createQueryBuilder('i').where('1=1');
      if (candidate.usuario) qb.andWhere('i.usuario = :u', { u: candidate.usuario });
      if (candidate.nombre) qb.andWhere('i.nombre = :n', { n: candidate.nombre });
      if (candidate.apellidos) qb.andWhere('i.apellidos = :a', { a: candidate.apellidos });
      existing = await qb.getOne();
    }
    if (existing) {
      // Merge fields but preserve primary id
      const merged: Installation = Object.assign(existing, candidate);
      // Ensure primary key stays the same
      merged.id = existing.id;
      await repo.save(merged);
    } else {
      await repo.save(candidate);
    }
    processed++;
  }
  return processed;
}

async function purgeMissingInstallations(fetchedIds: Set<number>): Promise<number> {
  if (!fetchedIds.size) return 0;
  const repo = AppDataSource.getRepository(Installation);
  const all = await repo.find({ select: { id: true, id_servicio: true } as any });
  const toDelete = all
    .filter((i: any) => i.id_servicio && !fetchedIds.has(Number(i.id_servicio)))
    .map((i: any) => i.id);

  if (!toDelete.length) return 0;

  const chunkSize = 500;
  let deleted = 0;
  for (let i = 0; i < toDelete.length; i += chunkSize) {
    const chunk = toDelete.slice(i, i + chunkSize);
    const res = await repo.delete(chunk);
    deleted += res.affected || 0;
  }
  return deleted;
}

export async function fullSyncInstallations(batchSize = 200, maxPages = 1000, purgeMissing = true) {
  console.log(`[wisphub] fullSyncInstallations start batchSize=${batchSize} maxPages=${maxPages} purgeMissing=${purgeMissing}`);
  let offset = 0;
  let processed = 0;
  const fetchedIds = new Set<number>();
  for (let page = 0; page < maxPages; page++) {
    const data = await listInstallationsPage({ limit: batchSize, offset });
    (data.results || []).forEach((item) => {
      const idServicio = item.id_servicio ?? item.id;
      if (idServicio) fetchedIds.add(Number(idServicio));
    });
    const added = await upsertInstallations(data.results || []);
    processed += added;
    console.log(`[wisphub] sync page=${page + 1} offset=${offset} fetched=${(data.results || []).length} upserted=${added} processed=${processed}`);
    if (!data.next || (data.results || []).length === 0) break;
    offset += batchSize;
  }
  let deleted = 0;
  if (purgeMissing) {
    deleted = await purgeMissingInstallations(fetchedIds);
    if (deleted) console.log(`[wisphub] fullSyncInstallations purge deleted=${deleted}`);
  }
  console.log(`[wisphub] fullSyncInstallations done processed=${processed}`);
  return { processed, deleted, lastSyncAt: new Date() };
}

export async function searchLocalInstallations(term: string, limit = 50) {
  const repo = AppDataSource.getRepository(Installation);
  return repo.createQueryBuilder('i')
    .where(new Brackets((qb) => {
      qb.where('i.usuario LIKE :q', { q: `%${term}%` })
        .orWhere('i.nombre LIKE :q', { q: `%${term}%` })
        .orWhere('i.apellidos LIKE :q', { q: `%${term}%` });
    }))
    .andWhere('LOWER(i.tipo) NOT LIKE :pre', { pre: '%preinstal%' })
    .limit(limit)
    .getMany();
}

export async function listPendingLocalInstallations(limit = 50) {
  const repo = AppDataSource.getRepository(Installation);
  console.log(`[db] listPendingLocalInstallations limit=${limit}`);
  // Pending: no fecha_instalacion OR estado/tipo indica preinstalación/pendiente
  let qb = repo.createQueryBuilder('i')
    .where(new Brackets((sub) => {
      sub.where('i.fecha_instalacion IS NULL')
        .orWhere('i.fecha_instalacion = :empty', { empty: '' })
        .orWhere('LOWER(i.estado_instalacion) LIKE :p', { p: '%pend%' })
        .orWhere('LOWER(i.estado) LIKE :p', { p: '%pend%' })
        .orWhere('LOWER(i.tipo) LIKE :pre', { pre: '%preinstal%' });
    }))
    .andWhere('LOWER(i.tipo) NOT LIKE :preExclude', { preExclude: '%preinstal%' })
    .orderBy('i.updatedAt', 'DESC');
  if (limit && limit > 0) qb = qb.limit(limit);
  const results = await qb.getMany();
  console.log(`[db] listPendingLocalInstallations results=${results.length}`);
  return results;
}

export async function listAllLocalInstallations(limit = 0) {
  const repo = AppDataSource.getRepository(Installation);
  console.log(`[db] listAllLocalInstallations limit=${limit}`);
  let qb = repo.createQueryBuilder('i')
    .where('LOWER(i.tipo) NOT LIKE :pre', { pre: '%preinstal%' })
    .orderBy('i.updatedAt', 'DESC');
  if (limit && limit > 0) qb = qb.limit(limit);
  const results = await qb.getMany();
  console.log(`[db] listAllLocalInstallations results=${results.length}`);
  return results;
}

export async function refreshInstallationsByTerm(term: string): Promise<number> {
  const filters = [
    { usuario__contains: term },
    { nombre__contains: term },
    { apellidos__contains: term },
    { cedula__contains: term },
    { telefono__contains: term },
    { email__contains: term }
  ];
  const seen = new Map<number, WisphubInstallationItem>();
  for (const f of filters) {
    try {
      const data = await listInstallationsPage({ ...f, limit: 50, offset: 0 });
      for (const item of data.results || []) seen.set(item.id ?? Math.floor(Math.random() * 1e9), item);
    } catch (e) {
      // ignore
    }
  }
  return upsertInstallations([...seen.values()]);
}

export default {
  listInstallationsPage,
  upsertInstallations,
  fullSyncInstallations,
  searchLocalInstallations,
  listPendingLocalInstallations,
  listAllLocalInstallations
};
