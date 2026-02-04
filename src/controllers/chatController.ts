import { AppDataSource } from '../datasource';
import { ChatMessage } from '../models/ChatMessage';
import { ChatSession } from '../models/ChatSession';
import { SmartoltZone } from '../models/SmartoltZone';
import { SmartoltOdb } from '../models/SmartoltOdb';
import { Installation } from '../models/Installation';
import { Client } from '../models/Client';
import fs from 'fs';
import path from 'path';
import { buildStructuredResponse } from '../services/simpleBot';
import { 
  searchLocal, 
  refreshClientsByTerm, 
  fullSyncClients, 
  activarInstalacionGeonet,
  processContractUpdate,
  getAutoLoginContractLink,
  registrarOnuGeonet,
  agregarArticuloACliente,
  uploadDocumentoCliente 
} from '../services/wisphubClient';
import { searchLocalInstallations, refreshInstallationsByTerm, listPendingLocalInstallations, listAllLocalInstallations, fullSyncInstallations } from '../services/wisphubInstallations';
import {
  authorizeOnu, listOlts, type OltInfo, getZones, getOltVlans,
  getOdbs, getOnuTypesByPonType, type SmartOltOnu, updateOnuLocation,
  setOnuWanModeStaticIp, getAllOnuTypes,
  getAllZones, getVlansByOltId, listGlobalUnconfiguredOnus,
  updateOnuWifi,
  getInternalOnuIdBySn
} from '../services/smartoltClient';

// --- HELPERS: Caching & Utils ---

const _simpleCache = new Map<string, { ts: number; val: any }>();

const CHAT_CONTEXT_KEYS = [
  'lastSelectedClientIdServicio',
  'lastSelectedInstallationId',
  'lastSelectedIsPyme',
  'lastSelectedPlan',
  'pendingAuth',
  'pendingPhotos',
  'lastAuthNameUsed',
  'lastContextType',
  'lastSearchTerm',
  'searchMode',
  'photoFlowMode',
  'pendingPhotoClientSearch'
];

async function loadChatContext(session: any, sessionId: number) {
  if (!session) return;
  if (!session.chatContexts) session.chatContexts = {};

  let stored = session.chatContexts[String(sessionId)];
  if (!stored) {
    try {
      const sessionRepo = AppDataSource.getRepository(ChatSession);
      const chatSession = await sessionRepo.findOne({ where: { id: Number(sessionId) } });
      if (chatSession && chatSession.context) {
        stored = chatSession.context as any;
        session.chatContexts[String(sessionId)] = stored;
      }
    } catch (e) {
      console.error('Error cargando contexto desde DB:', e);
    }
  }

  const fallback = stored || {};
  CHAT_CONTEXT_KEYS.forEach((k) => {
    session[k] = fallback[k];
  });
  session.activeChatContextId = sessionId;
}

async function saveChatContext(session: any, sessionId: number) {
  if (!session) return;
  if (!session.chatContexts) session.chatContexts = {};
  const snapshot: any = {};
  CHAT_CONTEXT_KEYS.forEach((k) => {
    snapshot[k] = session[k];
  });
  session.chatContexts[String(sessionId)] = snapshot;
  session.activeChatContextId = sessionId;

  try {
    const sessionRepo = AppDataSource.getRepository(ChatSession);
    await sessionRepo.update({ id: Number(sessionId) }, { context: snapshot });
  } catch (e) {
    console.error('Error guardando contexto en DB:', e);
  }
}

async function cacheGet<T>(key: string, ttlSeconds: number, fetcher: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const existing = _simpleCache.get(key);
  if (existing && now - existing.ts < ttlSeconds * 1000) return existing.val as T;
  const val = await fetcher();
  try { _simpleCache.set(key, { ts: now, val }); } catch {}
  return val;
}

function cacheDelete(keyPrefix: string) {
  for (const k of _simpleCache.keys()) {
    if (k.startsWith(keyPrefix)) _simpleCache.delete(k);
  }
}

function saveImageDataUrl(imageDataUrl?: string): { webPath: string; systemPath: string } | null {
  if (!imageDataUrl || typeof imageDataUrl !== 'string') return null;
  try {
    const matches = imageDataUrl.match(/^data:(image\/[-a-zA-Z0-9.+]+);base64,(.+)$/);
    if (!matches) return null;
    
    const ext = (matches[1].split('/')[1] || 'png').toLowerCase();
    const fileName = `chat_${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`;
    
    const uploadDir = path.join(process.cwd(), 'uploads', 'chat');
    
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    
    const systemPath = path.join(uploadDir, fileName);
    fs.writeFileSync(systemPath, Buffer.from(matches[2], 'base64'));
    
    console.log(`💾 Imagen guardada en Docker: ${systemPath}`);
    
    const webPath = `/uploads/chat/${fileName}`;
    return { webPath, systemPath };
  } catch (err) {
    console.error('Failed to store chat image', err);
    return null;
  }
}

function normalizeSpeedProfileName(val: any): string | undefined {
  const raw = val === undefined || val === null ? '' : String(val).trim();
  if (!raw) return undefined;
  const mbpsMatch = raw.match(/(\d+(?:\.\d+)?)\s*(?:m|mbps|mb)\b/i);
  if (mbpsMatch) return `${mbpsMatch[1].replace(/\.0+$/, '')}M`;
  const match = raw.match(/(\d+(?:\.\d+)?)/);
  return match ? `${match[1].replace(/\.0+$/, '')}M` : raw;
}

function pickPlanFromRaw(raw: any): string | undefined {
  if (!raw || typeof raw !== 'object') return undefined;

  const directKeys = [
    'plan_internet', 'plan', 'plan_name', 'plan_nombre', 'planInternet',
    'plan_internet_name', 'plan_internet_nombre', 'plan_servicio',
    'servicio', 'servicio_plan', 'planServicio', 'nombre_plan'
  ];

  const candidates: any[] = [];
  directKeys.forEach((k) => candidates.push(raw[k]));

  const nestedObjects = [raw.plan_internet, raw.plan, raw.servicio, raw.planServicio, raw.plan_servicio];
  nestedObjects.forEach((obj) => {
    if (!obj || typeof obj !== 'object') return;
    candidates.push(obj.name, obj.nombre, obj.label, obj.descripcion, obj.description, obj.plan, obj.plan_internet);
  });

  if (raw.detalle_plan) candidates.push(raw.detalle_plan);
  if (raw.planInternetNombre) candidates.push(raw.planInternetNombre);

  return pickFirstString(candidates);
}

function normalizeVlanValues(values: any): string[] {
  if (!Array.isArray(values)) return [];
  return Array.from(new Set(values.map((v: any) => {
    if (v && typeof v === 'object') {
      const id = v.vlan_id ?? v.vlan ?? v.id ?? v.value ?? v.pon_vlan?.vlan_id;
      const name = v.name ?? v.description ?? v.label ?? v.vlan_name;
      return (id && name) ? `${id} - ${name}` : (id ?? name);
    }
    return v;
  }).map((s: any) => String(s ?? '').trim()).filter(Boolean)));
}

function pickFirstString(values: Array<any>): string | undefined {
  for (const v of values) {
    const s = String(v ?? '').trim();
    if (s) return s;
  }
  return undefined;
}

function normalizeComparableText(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function isPymeText(value: any): boolean {
  if (!value) return false;
  const norm = normalizeComparableText(String(value));
  return norm.includes('pyme');
}

async function resolveIsPyme(session: any, targetId?: number | string): Promise<boolean> {
  if (session?.lastSelectedIsPyme === true) return true;

  if (session?.lastSelectedPlan && isPymeText(session.lastSelectedPlan)) {
    session.lastSelectedIsPyme = true;
    return true;
  }

  const pendingIsPyme = session?.pendingAuth?.isPyme ?? session?.pendingAuth?.defaults?.is_pyme;
  if (pendingIsPyme === true) {
    session.lastSelectedIsPyme = true;
    return true;
  }

  const numericId = targetId !== undefined ? Number(targetId) : undefined;
  if (numericId && !Number.isNaN(numericId)) {
    try {
      const instRepo = AppDataSource.getRepository(Installation);
      const inst = await instRepo.findOne({
        where: [{ id: numericId }, { id_servicio: numericId }]
      });
      if (inst) {
        const defaults = defaultsFromEntity(inst, 'installation');
        if (defaults.name) session.lastSelectedPlan = defaults.name;
        session.lastSelectedIsPyme = !!defaults.is_pyme;
        return !!defaults.is_pyme;
      }
    } catch (err) {
      console.error('Error resolviendo PYME (Installation):', err);
    }

    try {
      const clientRepo = AppDataSource.getRepository(Client);
      const client = await clientRepo.findOne({ where: { id_servicio: numericId } });
      if (client) {
        const defaults = defaultsFromEntity(client, 'client');
        if (defaults.name) session.lastSelectedPlan = defaults.name;
        session.lastSelectedIsPyme = !!defaults.is_pyme;
        return !!defaults.is_pyme;
      }
    } catch (err) {
      console.error('Error resolviendo PYME (Client):', err);
    }
  }

  const fallbackInstallationId = session?.lastSelectedInstallationId
    ? Number(session.lastSelectedInstallationId)
    : undefined;
  if (fallbackInstallationId && !Number.isNaN(fallbackInstallationId)) {
    try {
      const instRepo = AppDataSource.getRepository(Installation);
      const inst = await instRepo.findOne({ where: { id: fallbackInstallationId } });
      if (inst) {
        const defaults = defaultsFromEntity(inst, 'installation');
        if (defaults.name) session.lastSelectedPlan = defaults.name;
        session.lastSelectedIsPyme = !!defaults.is_pyme;
        return !!defaults.is_pyme;
      }
    } catch (err) {
      console.error('Error resolviendo PYME (Installation fallback):', err);
    }
  }

  const fallbackServiceId = session?.lastSelectedClientIdServicio
    ? Number(session.lastSelectedClientIdServicio)
    : undefined;
  if (fallbackServiceId && !Number.isNaN(fallbackServiceId)) {
    try {
      const instRepo = AppDataSource.getRepository(Installation);
      const inst = await instRepo.findOne({ where: { id_servicio: fallbackServiceId } });
      if (inst) {
        const defaults = defaultsFromEntity(inst, 'installation');
        if (defaults.name) session.lastSelectedPlan = defaults.name;
        session.lastSelectedIsPyme = !!defaults.is_pyme;
        return !!defaults.is_pyme;
      }
    } catch (err) {
      console.error('Error resolviendo PYME (Service fallback):', err);
    }
  }

  return !!session?.lastSelectedIsPyme;
}

function bestMatchOption(input: any, options: string[]): string | undefined {
  if (!input || !options?.length) return undefined;

  const raw = String(input).trim();
  if (!raw) return undefined;

  const normalizedInput = normalizeComparableText(raw);
  if (!normalizedInput) return undefined;

  const normalizedOptions = options.map(o => ({ raw: o, norm: normalizeComparableText(String(o)) }));

  const exact = normalizedOptions.find(o => o.norm === normalizedInput);
  if (exact) return exact.raw;

  const included = normalizedOptions.find(o => o.norm.includes(normalizedInput) || normalizedInput.includes(o.norm));
  if (included) return included.raw;

  const inputNumber = normalizedInput.match(/\d+(?:\.\d+)?/)?.[0];
  if (inputNumber) {
    const numeric = normalizedOptions.find(o => o.norm.includes(inputNumber));
    if (numeric) return numeric.raw;
  }

  const inputTokens = new Set(normalizedInput.split(/\s+/).filter(Boolean));
  let best: { raw: string; score: number } | undefined;
  for (const opt of normalizedOptions) {
    const optTokens = opt.norm.split(/\s+/).filter(Boolean);
    if (!optTokens.length) continue;
    let score = 0;
    for (const t of optTokens) if (inputTokens.has(t)) score++;
    if (!best || score > best.score) best = { raw: opt.raw, score };
  }
  if (best && best.score > 0) return best.raw;

  return undefined;
}

function extractVlanFromZoneLabel(value: any): string | undefined {
  if (!value) return undefined;
  const raw = String(value);
  const match = raw.match(/vlan\s*(\d{1,5})/i);
  if (match) return match[1];
  const fallback = raw.match(/\b(\d{1,5})\b/);
  return fallback ? fallback[1] : undefined;
}

// --- HELPERS: Form Persistence ---

function freezeFormActions(originalActions: any[], submittedData: any): any[] {
  if (!Array.isArray(originalActions)) return [];

  return originalActions.map(action => {
    if (action.type === 'input' || action.type === 'select') {
      let val = '';
      if (submittedData[action.id] !== undefined) {
          val = submittedData[action.id];
      } else {
          const keyFromId = action.id.replace(/^auth-|^wifi_/, '').replace('-', '_');
          if (submittedData[keyFromId] !== undefined) {
              val = submittedData[keyFromId];
          }
      }
      if (!val && action.value) val = action.value;

      return {
        ...action,
        value: val,       
        disabled: true,
        label: `${action.label}`
      };
    }
    if (action.type === 'button') {
      return { ...action, disabled: true, label: action.label + ' (Enviado)' };
    }
    return action;
  });
}

// --- HELPERS: Data Formatting & Normalization ---

function defaultsFromEntity(entity: any, type: 'client' | 'installation'): Record<string, any> {
  const isInst = type === 'installation';
  const plan = entity.servicio || entity.plan_internet || pickPlanFromRaw(entity.raw);
  const clientName = `${entity.nombre || ''} ${entity.apellidos || ''}`.trim();
  const rawString = !plan && entity?.raw ? JSON.stringify(entity.raw) : '';
  const isPyme = isPymeText(plan) || isPymeText(clientName) || (rawString ? isPymeText(rawString) : false);
  const normalizedSpeed = normalizeSpeedProfileName(plan);

    return {
      sn: entity.sn_onu || undefined,
      name: plan || clientName || undefined, 
      zone: entity.zona || entity.ciudad || entity.localidad || undefined,
      address_or_comment: entity.direccion || undefined,
      ipv4_address: entity.ipv4_address || entity.ip || entity.ip_publica || (isInst ? entity.ip_cliente : entity.ip_cliente) || undefined,
      serviceId: entity.id_servicio || undefined,
      download_speed_profile_name: normalizedSpeed,
      upload_speed_profile_name: normalizedSpeed,
      speed: normalizedSpeed,
      is_pyme: isPyme
    };
}

function buildPrefilledAuth(defaults: Record<string, any> = {}) {
  const collected: Record<string, any> = { ...defaults };
  if (defaults.ipv4) collected.ipv4 = defaults.ipv4; 
  collected.pon_type = 'gpon';
  collected.onu_mode = 'Routing';
  return collected;
}

function buildInstallationsTable(items: any[]): string {
  const header = `| # | Cliente | RUT | ID | Dirección |\n|---|---------|-----|----|-----------|`;
  const rows = (items || []).map((it, idx) =>
    `| ${idx + 1} | ${it.nombre || ''} ${it.apellidos || ''} | ${it.cedula || it.rut || 'N/A'} | ${it.id || it.id_servicio || 'N/A'} | ${it.direccion || 'N/A'} |`
  );
  return [header, ...rows].join('\n');
}

function buildClientsTable(items: any[]): string {
  const header = `| # | Cliente | RUT | ID | Dirección |\n|---|---------|-----|----|-----------|`;
  const rows = (items || []).map((it, idx) => {
    const fullName = `${it.nombre || ''} ${it.apellidos || ''}`.trim();
    const rut = it.cedula || it.rut || 'N/A';
    const id = it.id_servicio || it.id || 'N/A';
    const address = it.direccion || 'N/A';
    return `| ${idx + 1} | ${fullName || it.razon_social || ''} | ${rut} | ${id} | ${address} |`;
  });
  return [header, ...rows].join('\n');
}

function formatEntityList(items: any[], type: 'client' | 'installation'): { textLines: string[], actions: any[] } {
  const isClient = type === 'client';
  const textLines = items.map((it, i) => {
    if (isClient) return `${i + 1}. ${((it.nombre || '') + ' ' + (it.apellidos || '')).trim()} — ${it.cedula || 'sin documento'} [${it.id_servicio}]`;
    return `${i + 1}. Instalación [${it.id_servicio || it.id}] ${it.nombre || ''} ${it.apellidos || ''} — ${it.estado_instalacion || 'pendiente'}`;
  });

  const actions = items.slice(0, 10).map((it) => {
    const id = isClient ? it.id_servicio : (it.id || it.id_servicio);
    const label = `${it.nombre || ''} ${it.apellidos || ''} [${id}]`;
    return {
      id: `select-${type}-${id}`,
      type: 'button',
      label,
      payload: `seleccionar ${isClient ? 'cliente' : 'instalación'} ${id}`
    };
  });

  return { textLines, actions };
}

function buildClientDetails(entity: any, type: 'client' | 'installation'): string {
    const isInst = type === 'installation';
    const id = isInst ? (entity.id || entity.id_servicio) : entity.id_servicio;
    const name = `${entity.nombre || ''} ${entity.apellidos || ''}`.trim();
    const address = entity.direccion || 'Sin dirección';
    const plan = entity.plan_internet || entity.servicio || 'Plan desconocido';
    const phone = entity.telefono || entity.celular || entity.movil || 'N/A';
    const coords = (entity.latitud && entity.longitud) ? `${entity.latitud}, ${entity.longitud}` : null;
    const mapLink = coords ? `https://www.google.com/maps/search/?api=1&query=${entity.latitud},${entity.longitud}` : null;
    const ip = entity.ip || entity.ipv4_address || entity.ip_cliente || 'N/A';

    return `
📋 **Ficha de Instalación**
👤 **Cliente:** ${name} [ID: ${id}]
📍 **Dirección:** ${address}
📞 **Tel:** ${phone}
🌍 **IP Asignada:** ${ip}
🚀 **Plan:** ${plan}
${coords ? `🗺️ **Ubicación:** [Ver en Maps](${mapLink})` : '🗺️ **Ubicación:** No registrada'}
`.trim();
}

// --- LOGIC: WispHub Search Strategy ---

async function findOrSync(term: string, type: 'client' | 'installation' | 'both') {
  const results: { clients: any[], installations: any[], refreshed: boolean } = { clients: [], installations: [], refreshed: false };

  const doSearch = async () => {
    const p: any[] = [];
    if (type === 'client' || type === 'both') p.push(searchLocal(term, 15));
    else p.push(Promise.resolve([]));
    if (type === 'installation' || type === 'both') p.push(searchLocalInstallations(term, 10));
    else p.push(Promise.resolve([]));
    const [c, i] = await Promise.all(p);
    return { c: c || [], i: i || [] };
  };

  let { c, i } = await doSearch();

  if (c.length + i.length === 0) {
    await Promise.all([
      (type === 'client' || type === 'both') ? refreshClientsByTerm(term).catch(() => 0) : null,
      (type === 'installation' || type === 'both') ? refreshInstallationsByTerm(term).catch(() => 0) : null
    ]);
    ({ c, i } = await doSearch());
    results.refreshed = true;
  }

  if (c.length + i.length === 0) {
    await Promise.all([
      (type === 'client' || type === 'both') ? fullSyncClients().catch(() => {}) : null,
      (type === 'installation' || type === 'both') ? fullSyncInstallations(150, 4).catch(() => {}) : null
    ]);
    ({ c, i } = await doSearch());
    results.refreshed = true;
  }

  results.clients = c;
  results.installations = i;
  return results;
}

async function searchClientsByNameRut(fullName?: string, rut?: string) {
  const cleanedName = String(fullName || '').trim();
  const cleanedRut = String(rut || '').replace(/[\.\-\s]+/g, '').trim();
  const rawRut = String(rut || '').trim();

  if (!cleanedName && !cleanedRut) return [];

  const repo = AppDataSource.getRepository(Client);
  const qb = repo.createQueryBuilder('c');

  if (cleanedRut || rawRut) {
    const rutLike = cleanedRut ? `%${cleanedRut}%` : undefined;
    const rawLike = rawRut ? `%${rawRut}%` : undefined;
    qb.andWhere(
      '(c.cedula = :rutExact OR LOWER(c.cedula) LIKE LOWER(:rutLike) OR LOWER(c.cedula) LIKE LOWER(:rawLike) OR REPLACE(REPLACE(REPLACE(LOWER(c.cedula), ".", ""), "-", ""), " ", "") LIKE LOWER(:cleanedRut))',
      {
        rutExact: cleanedRut || rawRut,
        rutLike: rutLike || rawLike || '%',
        rawLike: rawLike || rutLike || '%',
        cleanedRut: `%${cleanedRut || rawRut}%`
      }
    );
  }

  const tokens = cleanedName.split(/\s+/).filter(Boolean);
  tokens.forEach((t, idx) => {
    qb.andWhere(`(LOWER(c.nombre) LIKE LOWER(:t${idx}) OR LOWER(c.apellidos) LIKE LOWER(:t${idx}))`, {
      [`t${idx}`]: `%${t}%`
    });
  });

  return await qb.orderBy('c.id_servicio', 'DESC').take(10).getMany();
}

async function findClientsByNameRutWithSync(fullName?: string, rut?: string) {
  const nameTerm = String(fullName || '').trim();
  const rutTerm = String(rut || '').trim();
  let clients = await searchClientsByNameRut(nameTerm, rutTerm);

  if (clients.length === 0) {
    const syncTerm = rutTerm || nameTerm;
    if (syncTerm) {
      await refreshClientsByTerm(syncTerm).catch(() => 0);
      clients = await searchClientsByNameRut(nameTerm, rutTerm);
    }
  }

  if (clients.length === 0) {
    await fullSyncClients().catch(() => {});
    clients = await searchClientsByNameRut(nameTerm, rutTerm);
  }

  return clients;
}

// --- LOGIC: SmartOLT State & Auth ---

async function hydrateZonesAndOdbs(state: any, zoneFilter?: string) {
  const existingOdbs = Array.isArray(state.smartoltOdbs) ? state.smartoltOdbs : [];
  try {
    const zoneRepo = AppDataSource.getRepository(SmartoltZone);
    const odbRepo = AppDataSource.getRepository(SmartoltOdb);
    const zoneRows = await cacheGet('dbZones', 300, async () => await zoneRepo.find({ order: { name: 'ASC' } }));
    const zones = (zoneRows || []).map((z: any) => (z.name || '').toString().trim()).filter(Boolean);

    const odbQuery = odbRepo.createQueryBuilder('odb').leftJoinAndSelect('odb.zone', 'zone').orderBy('zone.name', 'ASC').addOrderBy('odb.name', 'ASC');
    if (zoneFilter) odbQuery.where('LOWER(zone.name) LIKE :zf', { zf: `%${zoneFilter.toLowerCase()}%` });

    const odbRows = await cacheGet(`dbOdbs:${(zoneFilter || '').toLowerCase()}`, 300, async () => await odbQuery.getMany());
    const odbsFromDb = odbRows.map(o => ({ id: o.externalId || String(o.id), name: o.name || '', zone: o.zone?.name || '' })).filter(o => o.name);

    const mergedMap = new Map();
    [existingOdbs, odbsFromDb].flat().forEach(o => {
      const key = `${(o.id || o.name || '').toString().toLowerCase()}`;
      if (key && !mergedMap.has(key)) mergedMap.set(key, o);
    });

    if (mergedMap.size === 0) {
      const apiOdbs = await cacheGet('smartolt_odbs', 300, async () => await getOdbs().catch(() => []));
      (apiOdbs || []).forEach((o: any) => {
          const item = { id: o.id || o.name, name: o.name || o.id || '', zone: o.zone || '' };
          mergedMap.set(`${item.id}`.toLowerCase(), item);
      });
    }

    const zoneFilterLower = (zoneFilter || '').toLowerCase();
    const mergedList = Array.from(mergedMap.values());
    const filteredByZone = zoneFilterLower ? mergedList.filter(o => `${o.name} ${o.id} ${o.zone}`.toLowerCase().includes(zoneFilterLower)) : mergedList;

    if (zones.length) state.smartoltZones = zones;
    state.smartoltOdbs = filteredByZone.length ? filteredByZone : mergedList;
  } catch (err) {
    console.error('Failed to hydrate zones/ODBs', err);
  }
}

async function buildOltAndNetworkSection(serviceIdOrTerm?: number | string, opts?: { skipZonesFetch?: boolean }) {
  const skipZones = !!opts?.skipZonesFetch;

  const [oltSection, zonesData, odbData, gponTypes, eponTypes, allUnconfiguredRaw] = await Promise.all([
    buildOltListSection(),
    skipZones ? [] : cacheGet('smartolt_zones', 300, async () => await getZones().catch(() => [])),
    cacheGet('smartolt_odbs', 300, async () => await getOdbs().catch(() => [])),
    cacheGet('onuTypes:gpon', 300, async () => await getOnuTypesByPonType('gpon').catch(() => [])),
    cacheGet('onuTypes:epon', 300, async () => await getOnuTypesByPonType('epon').catch(() => [])),
    cacheGet('smartolt_unconfigured_onus_global', 60, async () => await listGlobalUnconfiguredOnus().catch(() => []))
  ]);

  const zones = Array.isArray(zonesData) ? zonesData : [];
  const zoneNames = zones.map((z: any) => z.name || z.id).filter(Boolean);
  const odbs = Array.isArray(odbData) ? odbData : [];

  const vlanMap = new Map<string, string[]>();
  const oltsForVlans = (oltSection.olts || []).slice(0, 3);
  await Promise.all(oltsForVlans.map(async (o) => {
    const vlanList = await cacheGet(`oltVlans:${o.id}`, 60, async () => await getOltVlans(o.id).catch(() => []));
    vlanMap.set(String(o.id), normalizeVlanValues(vlanList));
  }));

  const byOlt = new Map<string, SmartOltOnu[]>();
  (Array.isArray(allUnconfiguredRaw) ? allUnconfiguredRaw : []).forEach((o: any) => {
    const k = String(o.olt_id ?? '');
    if (k) {
      if (!byOlt.has(k)) byOlt.set(k, []);
      byOlt.get(k)!.push(o);
    }
  });

  const onuActions: any[] = [];
  const oltAvailability: any[] = [];
  const vlanFromOltLists = Array.from(vlanMap.values()).flat();

  (oltSection.olts || []).forEach(olt => {
      const rawOnus = byOlt.get(String(olt.id)) || [];
      const seen = new Set();
      const available = rawOnus.filter(o => {
        const k = pickFirstString([o.sn, o.serial, o.onu_sn, o.mac]) || '';
        if (k && seen.has(k)) return false;
        if (k) seen.add(k);
        return true; // Assume free if in this list
      });

      if (available.length) {
        const entry = { oltId: String(olt.id), oltName: olt.name, availableCount: available.length, onus: [] as any[] };
        available.slice(0, 8).forEach((o, idx) => {
          const id = pickFirstString([o.sn, o.serial, o.onu_sn]) || `ONU${idx}`;
          const pon = (o.pon_type || 'gpon').toLowerCase();
          const port = pickFirstString([o.port, o.port_id, o.slot]) || '-';
          const model = o.onu_type_name || o.onu_type || o.model || '-';
          const payload = `seleccionar onu ${id} olt ${olt.id} pon ${pon} port ${port}${model !== '-' ? ` model ${model}` : ''}`;
          entry.onus.push({ id, label: id, ponType: pon, port, model, actionPayload: payload });
          onuActions.push({ id: `select-onu-${olt.id}-${idx}`, type: 'button', label: id, payload });
        });
        oltAvailability.push(entry);
      }
  });

  const suggestedVlan = pickFirstString(vlanFromOltLists);
  const suggestedZone = pickFirstString(zoneNames);

  const parts = [];
  if (zoneNames.length) parts.push(`Zonas: ${zoneNames.slice(0, 12).join(', ')}`);
  if (suggestedZone) parts.push(`Sugerida: ${suggestedZone}`);
  if (!oltAvailability.length) parts.push('No encontré ONUs libres.');

  return {
    text: parts.join('\n'),
    actions: onuActions,
    suggestedVlan,
    suggestedZone,
    zones: zoneNames,
    vlansByOlt: Object.fromEntries(vlanMap),
    odbs,
    onuTypesByPon: { gpon: Array.isArray(gponTypes) ? gponTypes : [], epon: Array.isArray(eponTypes) ? eponTypes : [] },
    oltAvailability,
    suggestedDownload: undefined as string | undefined,
    suggestedUpload: undefined as string | undefined
  };
}

async function buildOltListSection(): Promise<{ text: string; actions: any[]; olts: OltInfo[] }> {
    const rawOlts = await cacheGet('listOlts', 60, async () => await listOlts().catch(() => []));
    const unique = new Map<string, OltInfo>();
    (rawOlts || []).forEach((o: any) => unique.set(String(o.id), o));
    const olts = Array.from(unique.values());

    if (!olts.length) return { text: 'No OLTs found.', actions: [], olts: [] };

    const limited = olts.slice(0, 12);
    const text = `OLTs:\n${limited.map((o, i) => `${i+1}. ${o.name} [${o.id}]`).join('\n')}`;
    const actions = limited.slice(0, 8).map(o => ({
       id: `select-olt-${o.id}`, type: 'button', label: `${o.name} [${o.id}]`, payload: `auth set olt_id ${o.id}`
    }));
    return { text, actions, olts: limited };
}

async function prepareAuthSession(session: any, entity: any, type: 'client' | 'installation') {
    const defaults = defaultsFromEntity(entity, type);
    session.pendingAuth = {
        installationId: type === 'installation' ? entity.id : undefined,
        clientIdServicio: type === 'client' ? entity.id_servicio : undefined,
        collected: buildPrefilledAuth(defaults),
    defaults,
    isPyme: !!defaults.is_pyme
    };
  session.lastSelectedIsPyme = !!defaults.is_pyme;
  if (defaults.name) session.lastSelectedPlan = defaults.name;
    const section = await buildOltAndNetworkSection(entity.id_servicio, { skipZonesFetch: type === 'installation' });

    // Apply suggestions
    const collected = session.pendingAuth.collected;
    if (section.suggestedVlan && !collected.vlan) collected.vlan = section.suggestedVlan;
    if (section.suggestedZone && !collected.zone) collected.zone = section.suggestedZone;
    if (section.suggestedDownload && !collected.download_speed_profile_name) collected.download_speed_profile_name = section.suggestedDownload;
    
    // Store metadata
    session.pendingAuth.smartoltZones = section.zones;
    session.pendingAuth.smartoltVlans = section.vlansByOlt;
    session.pendingAuth.smartoltOdbs = section.odbs;
    session.pendingAuth.smartoltOnuTypes = section.onuTypesByPon;

    await hydrateZonesAndOdbs(session.pendingAuth, collected.zone);

    return { 
        text: section.text, 
        actions: section.actions, 
        assistantMetadata: { 
            smartoltAvailability: { olts: section.oltAvailability, suggestedVlan: section.suggestedVlan, suggestedZone: section.suggestedZone },
            smartoltOdbs: section.odbs,
            smartoltZones: section.zones
        }
    };
}

export async function buildAuthActions(state: any, req?: any) {
  const defaults = state.defaults || {};
  const collected = state.collected || {};

  const onuTypeOptions = await getAllOnuTypes().catch(() => []);
  const zoneOptions = await getAllZones().catch(() => []);
  let vlanOptions: string[] = [];
  if (collected.olt_id) {
    const vlansRaw = await getVlansByOltId(collected.olt_id).catch(() => []);
    vlanOptions = normalizeVlanValues(vlansRaw);
  }

  const odbOptions = ((state.smartoltOdbs || []) as any[]).map(o => o.name || o.id).filter(Boolean);

  const speedOptions = ['200M', '400M', '600M', '800M'];
  const speedSeed = collected.download_speed_profile_name
    || defaults.download_speed_profile_name
    || collected.speed
    || defaults.speed
    || defaults.name
    || collected.name;
  const vlanSeed = collected.vlan || defaults.vlan || collected.vlan_id || defaults.vlan_id;
  const zoneSeed = collected.zone || defaults.zone || collected.zona || defaults.zona;

  const vlanFromZone = extractVlanFromZoneLabel(zoneSeed);
  const zoneBasedVlan = vlanFromZone ? bestMatchOption(vlanFromZone, vlanOptions) || vlanFromZone : undefined;
  const autoVlan = zoneBasedVlan || bestMatchOption(vlanSeed, vlanOptions) || vlanSeed;
  const autoZone = bestMatchOption(zoneSeed, zoneOptions) || zoneSeed;
  const autoSpeed = bestMatchOption(normalizeSpeedProfileName(speedSeed), speedOptions) || speedSeed;

  if (!collected.vlan && autoVlan) collected.vlan = autoVlan;
  if (!collected.zone && autoZone) collected.zone = autoZone;
  if (!collected.download_speed_profile_name && autoSpeed) collected.download_speed_profile_name = autoSpeed;

  return [
    { id: 'auth-olt_id', type: 'input', placeholder: `${collected.olt_id || ''}`, label: 'OLT ID', helperText: 'ID numérico', payload: 'auth set olt_id {input}' },
    { id: 'auth-pon_type', type: 'input', label: 'PON type', placeholder: 'gpon', payload: 'auth set pon_type {input}' },
    { id: 'auth-board', type: 'input', label: 'Board', placeholder: `${collected.board || ''}`, payload: 'auth set board {input}' },
    { id: 'auth-port', type: 'input', label: 'Port', placeholder: `${collected.port || ''}`, payload: 'auth set port {input}' },
    { id: 'auth-sn', type: 'input', label: `SN/MAC ${collected.sn ? `(sug: ${collected.sn})` : ''}`, placeholder: collected.sn || 'Ej: ZTEGC...', payload: 'auth set sn {input}' },
    { id: 'auth-onu_type', type: 'input', label: 'ONU Type', placeholder: 'Ej: ZTE-F660', options: onuTypeOptions, payload: 'auth set onu_type {input}' },
    { id: 'auth-onu_mode', type: 'input', label: 'Mode', placeholder: 'Routing', payload: 'auth set onu_mode {input}' },
    { id: 'auth-vlan', type: 'input', label: 'VLAN', placeholder: autoVlan || 'Ej: 100', value: autoVlan || '', options: vlanOptions, payload: 'auth set vlan {input}' },
    { id: 'auth-zone', type: 'input', label: `Zona ${collected.zone ? `(sug: ${collected.zone})` : ''}`, placeholder: autoZone || 'Zona', value: autoZone || '', options: zoneOptions, payload: 'auth set zone {input}' },
    { id: 'auth-odb', type: 'input', label: `ODB ${defaults.odb ? `(curr: ${defaults.odb})` : ''}`, placeholder: 'Selecciona ODB', options: odbOptions, payload: 'auth set odb {input}' },
    { id: 'auth-odb-port', type: 'input', label: 'Puerto ODB', placeholder: '1', payload: 'auth set odb_port {input}' },
    { id: 'auth-name', type: 'input', label: `Nombre`, placeholder: defaults.name || 'Nombre', payload: 'auth set name {input}' },
    { id: 'auth-address', type: 'input', label: 'Dirección', placeholder: defaults.address_or_comment || 'Dirección', payload: 'auth set address_or_comment {input}' },
    { id: 'auth-speed', type: 'input', label: 'Velocidad', placeholder: autoSpeed || defaults.download_speed_profile_name || '200M', value: autoSpeed || '', options: speedOptions },
    { id: 'auth-submit', type: 'button', label: 'Autorizar SmartOLT ahora', payload: 'auth submit' }
  ];
}

// =========================================================================
// --- CONTROLLER FUNCTIONS ---
// =========================================================================

// NUEVO: Obtener lista de sesiones para Sidebar
export async function getUserSessions(req: any, res: any) {
  const userId = req.session?.userId;
  if (!userId) return res.status(401).json({ error: 'unauthenticated' });

  try {
    const sessionRepo = AppDataSource.getRepository(ChatSession);
    const sessions = await sessionRepo.find({
      where: { userId: Number(userId) },
      order: { createdAt: 'DESC' },
      take: 50 // Límite razonable
    });
    return res.json({ sessions });
  } catch (error) {
    console.error('Error fetching sessions:', error);
    return res.status(500).json({ error: 'Error interno al cargar sesiones' });
  }
}

// NUEVO: Obtener mensajes de una sesión específica


// MODIFICADO: Add Message (Creación automática de sesión)
export async function addMessage(req: any, res: any) {
    const { userId } = req.session || {};
    if (!userId) return res.status(401).json({ error: 'unauthenticated' });
    
    // Recibe sessionId (puede ser null/undefined para chats nuevos)
    const { role, content, imageDataUrl, sessionId } = req.body;
    
    // Guardamos la imagen si existe
    const savedImage = saveImageDataUrl(imageDataUrl);
    const webPath = savedImage ? savedImage.webPath : undefined;

    const sessionRepo = AppDataSource.getRepository(ChatSession);
    const msgRepo = AppDataSource.getRepository(ChatMessage);

    let activeSessionId = sessionId;

    // 1. Si no hay sessionId, creamos una NUEVA sesión
    if (!activeSessionId) {
        const title = content ? content.substring(0, 40) + (content.length > 40 ? '...' : '') : 'Nueva Conversación';
        const newSession = sessionRepo.create({
            userId: Number(userId),
            title: title
        });
        const savedSession = await sessionRepo.save(newSession);
        activeSessionId = savedSession.id;

      // Reset session-scoped context for a new chat
      req.session.lastSelectedClientIdServicio = undefined;
      req.session.lastSelectedInstallationId = undefined;
      req.session.lastSelectedIsPyme = undefined;
      req.session.pendingAuth = undefined;
      req.session.pendingPhotos = undefined;
      req.session.lastAuthNameUsed = undefined;
      req.session.lastContextType = undefined;
      req.session.lastSearchTerm = undefined;
      req.session.searchMode = undefined;

        await saveChatContext(req.session, activeSessionId);
      } else if (req.session?.activeChatContextId !== activeSessionId) {
        await loadChatContext(req.session, activeSessionId);
    }

    // 2. Guardamos el mensaje vinculado a la sesión
    const msg = msgRepo.create({ 
        userId: Number(userId), 
        sessionId: Number(activeSessionId), // <--- VINCUACIÓN
        role, 
        content: content || (imageDataUrl ? '[Img]' : ''), 
        imageUrl: webPath 
    });
    
    await msgRepo.save(msg);
    
    // Devolvemos el ID de sesión para que el frontend lo actualice
    return res.json({ ok: true, id: msg.id, sessionId: activeSessionId });
}


// --- FUNCIÓN PRINCIPAL DEL BOT (RESPOND) ---

function sanitizeSsid(value?: string | null): string | undefined {
  if (value === undefined || value === null) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.replace(/\s+/g, '_');
}

export async function respond(req: any, res: any) {
  const session = req.session as any; // Express Session (state temporal)
  const userId = session?.userId;
  if (!userId) return res.status(401).json({ error: 'unauthenticated' });

  // Recibimos sessionId del frontend (o null si es chat nuevo y addMessage no se llamó antes)
  const { content, imageDataUrl, collected, actions: submittedActions, sessionId } = req.body;
  if (!content && !imageDataUrl) return res.status(400).json({ error: 'empty' });

  const msgRepo = AppDataSource.getRepository(ChatMessage);
  const sessionRepo = AppDataSource.getRepository(ChatSession);

  // 1. Garantizar Sesión (por si se llama directo a respond sin addMessage)
  let activeSessionId = sessionId;
  if (!activeSessionId) {
      const title = content ? content.substring(0, 40) : 'Conversación sin título';
      const newS = await sessionRepo.save(sessionRepo.create({ userId: Number(userId), title }));
      activeSessionId = newS.id;

      // Reset session-scoped context for a new chat
      session.lastSelectedClientIdServicio = undefined;
      session.lastSelectedInstallationId = undefined;
      session.lastSelectedIsPyme = undefined;
      session.pendingAuth = undefined;
      session.pendingPhotos = undefined;
      session.lastAuthNameUsed = undefined;
      session.lastContextType = undefined;
      session.lastSearchTerm = undefined;
      session.searchMode = undefined;

        await saveChatContext(session, activeSessionId);
      } else if (session?.activeChatContextId !== activeSessionId) {
        await loadChatContext(session, activeSessionId);
  }

  // 2. Manejo de Imagen: Guardar físicamente
  const savedImage = saveImageDataUrl(imageDataUrl);
  const webPath = savedImage ? savedImage.webPath : undefined;

  // --- DETECTAR Y GUARDAR FORMULARIOS ---
  let userMessageActions = undefined;

  if (collected || (content && content.toLowerCase().startsWith('wifi apply'))) {
      if (Array.isArray(submittedActions)) {
          userMessageActions = freezeFormActions(submittedActions, collected || req.body);
      }
      else if (content.toLowerCase().startsWith('wifi apply')) {
          const ssidMatch = content.match(/ssid\s+(.+?)(?=\s+pass)/i);
          const passMatch = content.match(/pass\s+(.+?)(?=\s+contract_id|$)/i);
          const rawSsid = ssidMatch ? ssidMatch[1] : (typeof req.body.wifi_ssid === 'string' ? req.body.wifi_ssid : undefined);
          const formattedSsid = sanitizeSsid(rawSsid) ?? (rawSsid ? rawSsid.trim() : '***');
          const pass = passMatch ? passMatch[1] : (req.body.wifi_pass || '***');
          
          userMessageActions = [
            { type: 'input', label: 'SSID Configurado', value: formattedSsid, disabled: true, id: 'wifi_ssid' },
              { type: 'input', label: 'Password Configurado', value: pass, disabled: true, id: 'wifi_pass' }
          ];
      }
  }

  // 3. Guardar mensaje del usuario (Vinculado a la Session DB)
  await msgRepo.save(msgRepo.create({ 
      userId: Number(userId), 
      sessionId: Number(activeSessionId), // <---
      role: 'user', 
      content: content || '[Img]', 
      imageUrl: webPath,
      actions: userMessageActions,
      metadata: collected ? { submittedData: collected } : undefined
  }));

  let finalContent = '';
  let actionsOut: any[] = [];
  let assistantMetadata: any = null;

  try {
    // ------------------------------------------------------------------
    // A. LÓGICA DE IMAGEN
    // ------------------------------------------------------------------
    if (savedImage && savedImage.systemPath) {
        const targetId = session.lastSelectedClientIdServicio || session.lastSelectedInstallationId;
        
        if (!session.pendingPhotos) session.pendingPhotos = [];

        if (targetId) {
          finalContent = `📸 Imagen recibida. Subiendo a Geonet (ID: ${targetId})...`;

          // Intentar obtener el usuario asociado al cliente (campo `usuario`) para usarlo en Geonet
          let clienteUsuario: string | null = null;
          try {
            const clientRepo = AppDataSource.getRepository(Client);
            const clientEntity = await clientRepo.findOne({ where: { id_servicio: targetId } });
            if (clientEntity && clientEntity.usuario) clienteUsuario = clientEntity.usuario;
          } catch (e) {
            console.error('Error buscando cliente para obtener usuario Geonet:', e);
          }

          const fullGeonetUser = clienteUsuario || `${session.lastAuthNameUsed || 'tecnico'}@geonet`;

          try {
             const subidaExitosa = await uploadDocumentoCliente(
               targetId,
               fullGeonetUser,
               savedImage.systemPath,
               `Evidencia Chat - ${new Date().toLocaleTimeString()}`,
               content || 'Imagen subida automáticamente desde el chat'
             );

               if (subidaExitosa) {
                   finalContent = `✅ **Imagen subida a Geonet exitosamente** como evidencia para el cliente **${targetId}**.`;
               } else {
                   finalContent = `⚠️ La imagen se guardó en el chat, pero **falló la subida a Geonet**. Verifique si el usuario técnico es correcto.`;
               }
            } catch (error: any) {
                console.error('Error subiendo imagen auto:', error);
                finalContent = `❌ Error interno al subir evidencia: ${error.message}`;
            }
        } 
        else {
            session.pendingPhotos.push({
                systemPath: savedImage.systemPath,
                timestamp: new Date().toLocaleTimeString(),
                caption: content || 'Evidencia previa autorización'
            });
            const count = session.pendingPhotos.length;
            finalContent = `📥 **Foto recolectada** (Total pendientes: ${count}).\n\nEstas fotos se subirán automáticamente a Geonet cuando **Actives el Servicio** en Wisphub.`;
        }
    } 
    // ------------------------------------------------------------------
    // B. LÓGICA DE TEXTO
    // ------------------------------------------------------------------
    else {
        const prompt = content || '';
        const lower = prompt.toLowerCase();
        
        const structured = await buildStructuredResponse(prompt); 
        finalContent = structured.content;
        actionsOut = structured.actions as any[];
        assistantMetadata = null;

        // --- FOTO FLOW: START ---
        if (lower.includes('quiero agregar fotos') && (lower.includes('instalacion') || lower.includes('instalaicion'))) {
          session.photoFlowMode = true;
          session.pendingPhotoClientSearch = true;
          finalContent = 'Perfecto. Ingresa el nombre completo y el RUT para buscar al cliente.';
          actionsOut = [
            { id: 'photo_fullname', type: 'input', label: 'Nombre Completo', placeholder: 'Ej: Juan Pérez', payload: 'fotos buscar nombre {photo_fullname} rut {photo_rut}' },
            { id: 'photo_rut', type: 'input', label: 'RUT', placeholder: 'Ej: 12.345.678-9', payload: 'fotos buscar nombre {photo_fullname} rut {photo_rut}' },
            { id: 'photo_submit', type: 'button', label: 'Buscar Cliente', payload: 'fotos buscar nombre {photo_fullname} rut {photo_rut}' }
          ];
        }
        // --- FOTO FLOW: SEARCH CLIENT ---
        else if (lower.startsWith('fotos buscar') || lower.startsWith('foto buscar') || (session.pendingPhotoClientSearch && (collected?.photo_fullname || collected?.photo_rut))) {
          const nameMatch = prompt.match(/nombre\s+(.+?)(?=\s+rut|$)/i);
          const rutMatch = prompt.match(/rut\s+([^\s]+)/i);

          let fullName = (collected?.photo_fullname || nameMatch?.[1] || '').trim();
          let rut = (collected?.photo_rut || rutMatch?.[1] || '').trim();

          if (fullName.includes('{photo_fullname}')) fullName = '';
          if (rut.includes('{photo_rut}')) rut = '';

          if (!fullName && !rut) {
            finalContent = 'Ingresa nombre completo y/o RUT para buscar al cliente.';
            actionsOut = [
              { id: 'photo_fullname', type: 'input', label: 'Nombre Completo', placeholder: 'Ej: Juan Pérez', payload: 'fotos buscar nombre {photo_fullname} rut {photo_rut}' },
              { id: 'photo_rut', type: 'input', label: 'RUT', placeholder: 'Ej: 12.345.678-9', payload: 'fotos buscar nombre {photo_fullname} rut {photo_rut}' },
              { id: 'photo_submit', type: 'button', label: 'Buscar Cliente', payload: 'fotos buscar nombre {photo_fullname} rut {photo_rut}' }
            ];
            session.pendingPhotoClientSearch = true;
          } else {
            const clients = await findClientsByNameRutWithSync(fullName, rut);
          session.pendingPhotoClientSearch = false;
          session.photoFlowMode = true;
          session.lastContextType = 'photo-client-search';

          if (clients.length) {
            const fmt = formatEntityList(clients, 'client');
            const table = buildClientsTable(clients);
            finalContent = `Resultados para "${[fullName, rut].filter(Boolean).join(' / ') || 'búsqueda'}":\n\n${table}`;
            actionsOut = [...fmt.actions];
          } else {
            finalContent = 'No encontré clientes con esos datos. Intenta nuevamente.';
            actionsOut = [
              { id: 'photo_fullname', type: 'input', label: 'Nombre Completo', placeholder: 'Ej: Juan Pérez', payload: 'fotos buscar nombre {photo_fullname} rut {photo_rut}' },
              { id: 'photo_rut', type: 'input', label: 'RUT', placeholder: 'Ej: 12.345.678-9', payload: 'fotos buscar nombre {photo_fullname} rut {photo_rut}' },
              { id: 'photo_submit', type: 'button', label: 'Buscar Cliente', payload: 'fotos buscar nombre {photo_fullname} rut {photo_rut}' }
            ];
          }
          }
        }

        // --- WISPHUB ACTIVATE ---
        else if (lower.startsWith('wisphub activate')) {
          const idMatch = prompt.match(/activate\s+(\d+)/i);
          const targetId = idMatch ? idMatch[1] : null;

          // Resolver usuario Geonet del cliente/instalación (preferir `Client.usuario`, luego `Installation.usuario`)
          let clienteUsuario: string | null = null;
          try {
            const clientRepo = AppDataSource.getRepository(Client);
            const clientEntity = await clientRepo.findOne({ where: { id_servicio: targetId } });
            if (clientEntity && clientEntity.usuario) clienteUsuario = clientEntity.usuario;
          } catch (e) { console.error('Error buscando cliente para activar (Client):', e); }

          if (!clienteUsuario) {
            try {
              const instRepo = AppDataSource.getRepository(Installation);
              const inst = await instRepo.findOne({ where: [{ id: Number(targetId) }, { id_servicio: Number(targetId) }] });
              if (inst && inst.usuario) clienteUsuario = inst.usuario;
            } catch (e) { console.error('Error buscando cliente para activar (Installation):', e); }
          }

          const baseName = String(clienteUsuario || session.lastAuthNameUsed || targetId || '').trim();
          const hasGeonet = baseName.toLowerCase().includes('@geonet');
          const fullGeonetUser = hasGeonet ? baseName : `${baseName}@geonet`;

          if (!targetId) {
              finalContent = "⚠️ Error: No se detectó ID para activar.";
          } else {
              finalContent = `⏳ Activando servicio en Geonet para **${fullGeonetUser}**...`;
              const exito = await activarInstalacionGeonet(targetId, fullGeonetUser);
              
              if (exito) {
                  finalContent = `🚀 **¡Activación Exitosa!**\nLa instalación **${targetId}** ha sido activada correctamente bajo el usuario \`${fullGeonetUser}\`.`;

                  if (session.pendingPhotos && session.pendingPhotos.length > 0) {
                      finalContent += `\n\n📤 **Procesando ${session.pendingPhotos.length} fotos acumuladas...**`;
                      let uploadedCount = 0;
                      for (const photo of session.pendingPhotos) {
                          try {
                              const subidaOk = await uploadDocumentoCliente(
                                  targetId, 
                                  fullGeonetUser, 
                                  photo.systemPath, 
                                  `Evidencia Activación - ${photo.timestamp}`, 
                                  photo.caption || 'Foto adjunta al activar'
                              );
                              if (subidaOk) uploadedCount++;
                          } catch (err) { console.error('Error batch foto:', err); }
                      }
                      if (uploadedCount > 0) {
                          finalContent += `\n✅ **${uploadedCount} fotos subidas correctamente a la ficha.**`;
                          delete session.pendingPhotos;
                      } else {
                          finalContent += `\n⚠️ Hubo un problema subiendo las fotos.`;
                      }
                  }
                  
              } else {
                  finalContent = `❌ **Error en Activación**\nNo se pudo activar el usuario \`${fullGeonetUser}\`. Por favor, verifique el panel de Geonet.`;
                  actionsOut = [{ id: 'retry', type: 'button', label: '🔄 Reintentar', payload: `wisphub activate ${targetId}` }];
              }
          }
        }
        // --- WIFI APPLY ---
        else if (lower.startsWith('wifi apply')) {
            const snMatch = prompt.match(/sn\s+([a-zA-Z0-9]+)/i);
            const ssidMatch = prompt.match(/ssid\s+(.+?)(?=\s+pass)/i); 
            const passMatch = prompt.match(/pass\s+(.+?)(?=\s+contract_id|$)/i);
            const bodyData = req.body || {};
            const container = bodyData.collected || bodyData.data || {};
            
            const sn = (snMatch ? snMatch[1].toUpperCase() : null) || container.sn;
            const rawSsidValue = (ssidMatch ? ssidMatch[1] : null) ?? bodyData.wifi_ssid ?? container.wifi_ssid;
            const ssid = typeof rawSsidValue === 'string' ? sanitizeSsid(rawSsidValue) : undefined;
            const pass = (passMatch ? passMatch[1].trim() : null) || bodyData.wifi_pass || container.wifi_pass;

            if (sn && ssid && pass) {
                try {
                    const internalId = await getInternalOnuIdBySn(sn);
                    if (!internalId) {
                        finalContent = `❌ Error: No se encontró el ID interno de la ONU ${sn}. Verifique autorización.`;
                    } else {
                        const results = [];
                        try { await updateOnuWifi(internalId, '2.4GHz', ssid, pass, true); results.push('✅ 2.4GHz Configurado'); } catch (e: any) { results.push(`❌ 2.4GHz Falló: ${e.message}`); }
                        try { await updateOnuWifi(internalId, '5GHz', `${ssid}_5G`, pass, true); results.push('✅ 5GHz Configurado'); } catch (e: any) { results.push(`⚠️ 5GHz: ${e.message || 'No disponible'}`); }
                        
                        finalContent = `📡 Resultado WiFi (SN: ${sn}):\nSSID: ${ssid}\nClave: ${pass}\n\n${results.join('\n')}`;
                        actionsOut = [];
                        const targetId = session.lastSelectedClientIdServicio || session.lastSelectedInstallationId;
                        const isPyme = await resolveIsPyme(session, targetId);
                        let planText = session.lastSelectedPlan || session.pendingAuth?.defaults?.name;
                        let planIsPyme = isPyme || (planText ? isPymeText(planText) : false);

                        if (!planIsPyme && targetId) {
                          try {
                            const instRepo = AppDataSource.getRepository(Installation);
                            const inst = await instRepo.findOne({ where: [{ id: Number(targetId) }, { id_servicio: Number(targetId) }] });
                            const instPlan = inst?.plan_internet || inst?.servicio || pickPlanFromRaw(inst?.raw);
                            if (instPlan) {
                              planText = instPlan;
                              session.lastSelectedPlan = instPlan;
                              planIsPyme = isPymeText(instPlan);
                            }
                          } catch (err) {
                            console.error('Error obteniendo plan (Installation) para PYME:', err);
                          }

                          if (!planIsPyme) {
                            try {
                              const clientRepo = AppDataSource.getRepository(Client);
                              const client = await clientRepo.findOne({ where: { id_servicio: Number(targetId) } });
                              const clientPlan = client?.plan_internet || client?.servicio || pickPlanFromRaw(client?.raw);
                              if (clientPlan) {
                                planText = clientPlan;
                                session.lastSelectedPlan = clientPlan;
                                planIsPyme = isPymeText(clientPlan);
                              }
                            } catch (err) {
                              console.error('Error obteniendo plan (Client) para PYME:', err);
                            }
                          }
                        }

                        if (targetId) {
                          if (planIsPyme) {
                            actionsOut.push({ id: 'btn-activar-wisphub', type: 'button', label: '🚀 Activar en WispHub', payload: `wisphub activate ${targetId}` });
                            finalContent += `\n\n👇 Acciones post-instalación (PYME) para ID ${targetId}:`;
                          } else {
                            actionsOut.push({ id: 'btn-contrato', type: 'button', label: '📄 Generar Contrato', payload: `generar contrato ${targetId}` });
                            finalContent += `\n\n👇 Acciones post-instalación para ID ${targetId}:`;
                          }
                        } else {
                            finalContent += `\n\n(ℹ️ No se detectó un ID seleccionado previamente para generar el contrato)`;
                        }
                    }
                } catch (err: any) {
                    finalContent = `❌ Error crítico WiFi: ${err.message}`;
                }
            } else {
                finalContent = '⚠️ Error de formato WiFi. Intente de nuevo.';
            }
        }
        // --- GENERAR CONTRATO ---
        else if (lower.startsWith('generar contrato')) {
          const idMatch = prompt.match(/generar contrato\s+(\d+)/i);
          const targetId = idMatch ? idMatch[1] : null;
          if (targetId) {
            const isPyme = await resolveIsPyme(session, targetId);
            if (isPyme) {
              finalContent = `✅ Cliente PYME detectado. Omitiendo contrato.`;
              actionsOut = [
                { id: 'btn-activar-wisphub', type: 'button', label: '🚀 Activar en WispHub', payload: `wisphub activate ${targetId}` }
              ];
            } else {
              finalContent = `📄 Generando contrato para ID **${targetId}**...`;
              await processContractUpdate(targetId).catch(err => console.error('Error generating contract:', err));
              const baseName = session.lastAuthNameUsed || targetId;
              let contratourl = await getAutoLoginContractLink(`${baseName}@geonet`, targetId);
                  
              finalContent = `✅ Contrato generado:`;
              actionsOut = [
                 { id: 'btn-contrato', type: 'link', label: '📄 Copiar Contrato', url: `${contratourl}` },
                 { id: 'btn-activar-wisphub', type: 'button', label: '🚀 Activar en WispHub', payload: `wisphub activate ${targetId}` }
              ];
            }
          } else {
              finalContent = '⚠️ Error: No se detectó ID para generar contrato.';
          }
        }
        // --- AUTH SUBMIT (Trigger) ---
        else if (lower === 'auth submit') {
            if (!session.pendingAuth) finalContent = 'No hay autorización en curso.';
            else { await submitAuth(req, res); return; }
        }
        
        // --- SELECCIONAR CLIENTE/INSTALACION ---
        else if (/^(seleccionar|select) (cliente|instalación|instalacion)/i.test(lower)) {
            const isClient = lower.includes('cliente');
            const id = Number(lower.split(/\s+/).pop());
            
            let entity: any = null;
            if (isClient) {
                 const repo = AppDataSource.getRepository(Client);
                 entity = await repo.findOne({ where: { id_servicio: id } });
            } else {
                 const repo = AppDataSource.getRepository(Installation);
                 entity = await repo.findOne({ where: { id: id } });
            }

            if (entity) {
                 const serviceId = entity.id_servicio || entity.id; 
                 session.lastSelectedClientIdServicio = serviceId; 
                 if (!isClient) session.lastSelectedInstallationId = entity.id;

                const planName = entity.plan_internet || entity.servicio || pickPlanFromRaw(entity.raw);
                if (planName) {
                  session.lastSelectedPlan = planName;
                  if (isPymeText(planName)) session.lastSelectedIsPyme = true;
                }

                const displayName = `${entity.nombre || ''} ${entity.apellidos || ''}`.trim();
                const dateLabel = new Date().toLocaleDateString('es-CL');
                const sessionTitle = `${displayName || 'Cliente'} - ${dateLabel}`;
                await sessionRepo.update({ id: Number(activeSessionId), userId: Number(userId) }, { title: sessionTitle });

                if (isClient && session.photoFlowMode) {
                  session.photoFlowMode = false;
                  session.pendingPhotoClientSearch = false;
                  session.lastSelectedInstallationId = undefined;
                  finalContent = `✅ Cliente seleccionado para evidencias: **${displayName || 'Cliente'}** [ID: ${serviceId}].\n\nAhora puedes enviar las fotos y se subirán automáticamente a Geonet.`;
                  actionsOut = [];
                } else {
                  const { text, actions, assistantMetadata: meta } = await prepareAuthSession(session, entity, isClient ? 'client' : 'installation');
                  assistantMetadata = meta;

                  const clientDetails = buildClientDetails(entity, isClient ? 'client' : 'installation');
                  finalContent = `${clientDetails}\n\n📡 **Disponibilidad en SmartOLT:**\n${text}\n👇 Selecciona una ONU libre abajo o completa el formulario.`;
                  actionsOut = actions;

                  if (isClient) {
                    const insts = await AppDataSource.getRepository(Installation).find({ where: { id_servicio: (entity as Client).id_servicio }, take: 5 });
                    if (insts.length) {
                      const iFmt = formatEntityList(insts, 'installation');
                      finalContent += `\n\n⚠️ **Instalaciones vinculadas encontradas:**`;
                      actionsOut = [...actionsOut, ...iFmt.actions];
                    }
                  }
                }
            } else {
                finalContent = `${isClient ? 'Cliente' : 'Instalación'} no encontrada.`;
            }
        }
        // --- SELECCIONAR ONU ---
        else if (/^seleccionar\s+onu\s+/i.test(lower)) {
            const snMatch = lower.match(/onu\s+([a-z0-9]+)/i);
            const sn = snMatch ? snMatch[1].toUpperCase() : null;
            
            if (sn) {
                const allOnus = (await cacheGet('smartolt_unconfigured_onus_global', 60, listGlobalUnconfiguredOnus) as any[]) || [];
                let onu = allOnus.find(o => String(o.sn || o.serial).toUpperCase() === sn);
                
                if (!onu) {
                    const oltId = (lower.match(/olt\s+([0-9]+)/i) || [])[1];
                    const ponType = (lower.match(/pon\s+([a-z0-9]+)/i) || [])[1];
                    const port = (lower.match(/port\s+([0-9]+)/i) || [])[1];
                    const board = (lower.match(/board\s+([0-9]+)/i) || [])[1];
                    const model = (lower.match(/model\s+([^\s]+)/i) || [])[1];
                    if (oltId) {
                        onu = { sn: sn, olt_id: oltId, pon_type: (ponType || 'gpon').toLowerCase(), board: board || '', port: port || '', onu_type: model, onu_type_name: model, onu_mode: 'Routing' };
                    }
                }

                if (onu) {
                    session.pendingAuth = session.pendingAuth || { collected: {} };
                    session.pendingAuth.collected = {
                        ...session.pendingAuth.collected,
                        olt_id: onu.olt_id, pon_type: (onu.pon_type || 'gpon').toLowerCase(),
                        board: onu.board, port: onu.port, sn: onu.sn || onu.serial,
                        onu_type: onu.onu_type_name || onu.onu_type, onu_mode: 'Routing'
                    };
                    finalContent = `ONU ${sn} seleccionada. Formulario prellenado.`;
                    actionsOut = await buildAuthActions(session.pendingAuth, req);
                } else {
                    finalContent = 'No pude encontrar los detalles de esa ONU.';
                }
            }
        }
        // --- LISTADOS Y BUSQUEDA ---
        else if (lower.includes('instalaciones pendientes') || /^modo\s+b(usqueda|úsqueda)\s+instalacion$/i.test(lower)) {
            if (/^modo\s+b(usqueda|úsqueda)\s+instalacion$/i.test(lower)) { 
                session.searchMode = 'installation'; session.lastContextType = 'installations'; 
            }
            const isRefreshRequest = lower.includes('enseñame las instalaciones pendientes de evidencia para autorizar el alta')
              || lower.includes('ensename las instalaciones pendientes de evidencia para autorizar el alta');

            if (isRefreshRequest) {
                console.log('[pending-installations] Refrescar solicitado (payload). Sincronizando desde WispHub API...');
                await fullSyncInstallations(100, 3).catch((err) => console.error('[pending-installations] Error fullSyncInstallations:', err));
            }

            console.log('[pending-installations] Iniciando búsqueda local en DB (Installation)');
            let items = await listAllLocalInstallations(0);
            console.log(`[pending-installations] Resultados locales: ${items?.length || 0}`);
            if (!items?.length) {
                console.log('[pending-installations] Sin resultados locales. Sincronizando desde WispHub API...');
                await fullSyncInstallations(100, 3).catch((err) => console.error('[pending-installations] Error fullSyncInstallations:', err));
                console.log('[pending-installations] Reintentando búsqueda local tras sync...');
              items = await listAllLocalInstallations(0);
                console.log(`[pending-installations] Resultados locales post-sync: ${items?.length || 0}`);
            }
            const table = buildInstallationsTable(items || []);
            finalContent = items?.length ? `Instalaciones pendientes:\n\n${table}` : 'No hay instalaciones pendientes.';
            const fmt = formatEntityList(items || [], 'installation');
            actionsOut = [...fmt.actions, { id: 'refresh', type: 'button', label: 'Refrescar', payload: 'Enséñame las instalaciones pendientes de evidencia para autorizar el alta' }];
        }
        else if (lower.match(/actualiza|refresca|no esta/)) {
          const ctx = session.lastContextType;
          if (ctx === 'installations') {
            console.log('[pending-installations] Refrescar solicitado. Sincronizando desde WispHub API...');
            await fullSyncInstallations(100, 3).catch((err) => console.error('[pending-installations] Error fullSyncInstallations:', err));
            const items = await listAllLocalInstallations(0);
            const table = buildInstallationsTable(items || []);
            finalContent = items?.length ? `Instalaciones pendientes:\n\n${table}` : 'No hay instalaciones pendientes.';
            const fmt = formatEntityList(items || [], 'installation');
            actionsOut = [...fmt.actions, { id: 'refresh', type: 'button', label: 'Refrescar', payload: 'Enséñame las instalaciones pendientes de evidencia para autorizar el alta' }];
          } else {
            await fullSyncClients();
            finalContent = 'Base de datos sincronizada. Intenta buscar de nuevo.';
          }
        }
        else {
            const docMatch = prompt.match(/\b(\d{6,20})\b/);
            const nameMatch = prompt.match(/buscar\s+cliente\s+(.+)/i);
            const searchGenMode = /^modo\s+b(usqueda|úsqueda)\s+general$/i.test(lower);
            if (searchGenMode) { session.searchMode = 'general'; }

            if (lower.includes('buscar cliente') || docMatch || nameMatch) {
                const term = docMatch ? docMatch[1] : (nameMatch ? nameMatch[1].trim() : prompt.trim());
                const { clients, installations, refreshed } = await findOrSync(String(term), 'both');
                
                session.lastSearchTerm = String(term);
                session.lastContextType = 'clients-installations';
                const cFmt = formatEntityList(clients, 'client');
                const iFmt = formatEntityList(installations, 'installation');

                if (clients.length + installations.length > 0) {
                    finalContent = `Resultados para "${term}":\n\n${cFmt.textLines.join('\n')}\n\n${iFmt.textLines.join('\n')}`;
                    actionsOut = [{ id: 'mode-inst', type: 'button', label: 'Modo Instalación', payload: 'modo busqueda instalacion' }, ...cFmt.actions, ...iFmt.actions];
                } else {
                    finalContent = `${refreshed ? 'Actualicé BD pero no' : 'No'} encontré resultados para "${term}".`;
                }
            }
        }
    }

  } catch (err: any) {
      console.error('Respond error:', err);
      finalContent += `\n(Error interno: ${err.message})`;
  }

  const msg = msgRepo.create({ 
      userId: Number(userId), 
      sessionId: Number(activeSessionId), // <---
      role: 'assistant', 
      content: finalContent, 
      actions: actionsOut, 
      metadata: assistantMetadata 
  });
  await msgRepo.save(msg);

  await saveChatContext(session, activeSessionId);
  
  return res.json({
      ok: true,
      sessionId: activeSessionId, // Importante retornar el ID
      userMessage: { role: 'user', content: content, imageUrl: webPath },
      assistantMessage: { role: 'assistant', content: finalContent, actions: actionsOut, metadata: assistantMetadata }
  });
}

// --- LOGIC: Post-Auth Actions (Location + WAN + WiFi Form) ---

async function processPostAuthActions(data: any, targetId?: string | number) {
    const messages = ['✅ ONU Autorizada.'];
    const onuId = data.onu_external_id;

    if (!onuId) return { message: '⚠️ ONU autorizada, falta SN.', actions: [] };

    // 1. CHANGE LOCATION
    if (data.zone && data.odb) {
        try {
            const locParams: any = { zone: data.zone, odb: data.odb, odb_port: data.odb_port, name: data.name, address_or_comment: data.address_or_comment };
            Object.keys(locParams).forEach(k => !locParams[k] && delete locParams[k]);
            await updateOnuLocation(String(onuId), locParams);
            messages.push('✅ Ubicación actualizada.');
        } catch (err: any) {
            messages.push('❌ Falló ubicación.');
        }
    }

    // 2. WAN CONFIGURATION
    const ip = pickFirstString([data.ipv4_address, data.ipv4, data.ip, data.client_ip]);
    if (ip) {
        const parts = ip.split('.');
        const gateway = data.gateway || (parts.length === 4 ? `${parts[0]}.${parts[1]}.${parts[2]}.254` : undefined);
        const subnet = data.subnet_mask || '255.255.255.0';
        try {
            await setOnuWanModeStaticIp(String(onuId), ip, subnet, gateway || '', '8.8.8.8', '8.8.4.4', {});
            messages.push(`✅ WAN Configurada (${ip}).`);
        } catch (e: any) {
            messages.push('❌ Error WAN.');
        }
    } else {
        messages.push('⚠️ Falta IP para WAN.');
    }
    
    // --- VERIFICACIÓN EN TABLA INSTALLATION Y GEONET ---
    const session = data._session || {};
    const planText = session.lastSelectedPlan || session.pendingAuth?.defaults?.name;
    const isPyme = !!(data.is_pyme || session.lastSelectedIsPyme || (planText ? isPymeText(planText) : false));
    let clientid = targetId;
    if (!clientid) {
        clientid = session.lastSelectedClientIdServicio || session.lastSelectedInstallationId;
    }
    let skipGeonetRegistration = false;
    if (clientid) {
        try {
            const instRepo = AppDataSource.getRepository(Installation);
            const installation = await instRepo.findOne({ 
                where: [{ id: Number(clientid) }, { id_servicio: Number(clientid) }]
            });
            if (installation && installation.sn_onu) {
                const storedSn = String(installation.sn_onu).trim().toUpperCase();
                const newSn = String(onuId).trim().toUpperCase();
                if (storedSn === newSn) {
                    console.log(`ℹ️ El SN ${newSn} ya existe en la tabla Installation (ID: ${installation.id}). Saltando registros.`);
                    skipGeonetRegistration = true;
                }
            }
        } catch (err) { console.error('⚠️ Error consultando tabla Installation:', err); }
    }

    if (!skipGeonetRegistration) {
        await registrarOnuGeonet(data.onu_type, onuId);
        if (clientid !== undefined) {
            await agregarArticuloACliente(clientid, `${data.name}@geonet` || '', onuId); 
        }
    } else {
        messages.push('ℹ️ ONU ya registrada en BD (SN coincidente).');
    }

    // --- WIFI vs BOTONES DIRECTOS ---
    const rawType = String(data.onu_type || '').toUpperCase().replace(/[- ]/g, '');
    const wifiModels = ['ZTEF6600P', 'ZXHNF600P'];

    if (wifiModels.includes(rawType)) {
        const wifiActions = [
            { id: 'wifi_ssid', type: 'input', label: 'Nombre WiFi (SSID)', placeholder: 'Nuevo Nombre', payload: 'wifi set ssid {input}' },
            { id: 'wifi_pass', type: 'input', label: 'Contraseña WiFi', placeholder: 'Nueva Clave (min 8)', payload: 'wifi set pass {input}' },
            { id: 'wifi_submit', type: 'button', label: 'Aplicar Cambios WiFi', payload: `wifi apply sn ${onuId} ssid {wifi_ssid} pass {wifi_pass}` }
        ];
        return { message: messages.join(' '), actions: wifiActions };
    } 
    else {
        const directActions: any[] = [];
        if (targetId) {
        if (isPyme) {
          directActions.push({ id: 'btn-activar-wisphub', type: 'button', label: '🚀 Activar en WispHub', payload: `wisphub activate ${targetId}` });
          messages.push(`\n\n👇 **Proceso finalizado (PYME).** Selecciona una acción:`);
        } else {
          directActions.push({ id: 'btn-contrato', type: 'button', label: '📄 Generar Contrato', payload: `generar contrato ${targetId}` });
          messages.push(`\n\n👇 **Proceso finalizado.** Selecciona una acción:`);
        }
        } else {
            messages.push('\n(⚠️ No se detectó ID asociado para generar contrato)');
        }
        return { message: messages.join(' '), actions: directActions };
    }
}

export async function submitAuth(req: any, res: any) {
    const session = req.session || {};
    const userId = session.userId;
    if (!userId) return res.status(401).json({ error: 'unauthenticated' });

    // Extraemos sessionId del request body para saber dónde guardar la respuesta
    const sessionId = req.body.sessionId; 

    if (sessionId && session?.activeChatContextId !== Number(sessionId)) {
      await loadChatContext(session, Number(sessionId));
    }
    
    const state = session.pendingAuth || {};
    const merged = { ...state.defaults, ...state.collected, ...req.body, ...req.body.collected };

    session.lastAuthNameUsed = merged.name || state.defaults?.name;
    const targetId = session.lastSelectedClientIdServicio || session.lastSelectedInstallationId;
    const finalAddress = req.body.address || req.body.collected?.address || merged.address || merged.address_or_comment || merged.direccion || 'Sin dirección';
    let cleanVlan = merged.vlan;
    if (cleanVlan && String(cleanVlan).includes('-')) cleanVlan = String(cleanVlan).split('-')[0].trim();
    const cleanOdbPort = merged['odb-port'] || merged.odb_port || merged.odb_split;
    merged.sn = merged.sn || req.body.placeholder_sn;
    const explicitSn = merged.sn;

    const required = ['olt_id', 'sn', 'onu_type', 'zone', 'name'];
    const missing = required.filter(k => !merged[k]);

    if (missing.length) {
        const newActions = await buildAuthActions({ defaults: state.defaults, collected: merged });
        return res.json({ ok: false, message: `Faltan campos: ${missing.join(', ')}`, actions: newActions });
    }

    const msgRepo = AppDataSource.getRepository(ChatMessage);

    // Guardar "intento" del usuario
    try {
        const rawActions = await buildAuthActions({ defaults: state.defaults, collected: merged });
        const frozenActions = freezeFormActions(rawActions, merged);
        
        await msgRepo.save(msgRepo.create({ 
            userId: Number(userId), 
            sessionId: sessionId ? Number(sessionId) : undefined, // VINCULAR
            role: 'user', 
            content: `📝 Solicitud de Autorización Enviada\nSN: ${explicitSn}\nZona: ${merged.zone}`, 
            actions: frozenActions, 
            metadata: { type: 'form_submission', context: 'auth_onu', payload: merged }
        }));
    } catch (err) { console.error('Error guardando historial Auth form:', err); }

    try {
        const authPayload = {
            olt_id: merged.olt_id, pon_type: merged.pon_type || 'gpon', board: merged.board,
            port: merged.port, sn: explicitSn, vlan: cleanVlan, onu_type: merged.onu_type,
            zone: merged.zone, odb: merged.odb, name: merged.name, address_or_comment: finalAddress,
            onu_mode: merged.onu_mode || 'Routing', odb_port: cleanOdbPort,
            onu_external_id: explicitSn, 
            download_speed_profile_name: merged.download_speed_profile_name,
            upload_speed_profile_name: merged.upload_speed_profile_name
        };

        const result: any = await authorizeOnu(authPayload);
        const success = result && (result.status === true || String(result.response_code) === 'success');
        if (!success) throw new Error(result?.error || result?.message || 'SmartOLT rechazó la solicitud.');

        const postResult = await processPostAuthActions({
          ...merged,
          onu_external_id: explicitSn,
          vlan: cleanVlan,
          address_or_comment: finalAddress,
          odb_port: cleanOdbPort,
          onu_type: merged.onu_type,
          is_pyme: state.isPyme || state.defaults?.is_pyme,
          _session: session 
        }, targetId);

        cacheDelete('listOlts');
        if (merged.olt_id) cacheDelete(`onus:${merged.olt_id}`);
        delete session.pendingAuth;

        await msgRepo.save(msgRepo.create({ 
            userId: Number(userId), 
            sessionId: sessionId ? Number(sessionId) : undefined, // VINCULAR
            role: 'assistant', 
            content: postResult.message, 
            actions: postResult.actions 
        }));

        if (sessionId) await saveChatContext(session, Number(sessionId));

        return res.json({ ok: true, message: postResult.message, actions: postResult.actions });
    } catch (e: any) {
        console.error('❌ Error en submitAuth:', e);
        const errorMsg = e.response?.data?.error || e.message;
        
        await msgRepo.save(msgRepo.create({ 
            userId: Number(userId), 
            sessionId: sessionId ? Number(sessionId) : undefined, // VINCULAR
            role: 'assistant', 
            content: `❌ Error al autorizar: ${errorMsg}` 
        }));
        if (sessionId) await saveChatContext(session, Number(sessionId));
        return res.status(500).json({ ok: false, error: errorMsg });
    }
}

export async function applyPendingWan(req: any, res: any) {
    const session = req.session;
    const body = req.body || {};
    const data = (body.ipv4_address) ? body : session?.pendingWan;

    if (!data?.onu_external_id || !data?.ipv4_address) return res.status(400).json({ error: 'Datos insuficientes' });

    try {
        await setOnuWanModeStaticIp(
            String(data.onu_external_id), data.ipv4_address, 
            data.subnet_mask || '255.255.255.0', data.gateway || '', 
            data.dns1 || '8.8.8.8', data.dns2 || '8.8.4.4', data.extras || {}
        );
        delete session.pendingWan;
        return res.json({ ok: true, message: 'WAN Configurado' });
    } catch (e: any) {
        return res.status(500).json({ error: e.message });
    }
}

// -------------------------------------------------------------------------
// FUNCIONES DE SOPORTE PARA ADMIN Y LEGACY ROUTING
// -------------------------------------------------------------------------

/**
 * RESTAURADO: Listar todos los mensajes de un usuario en orden cronológico.
 * Usado por el Admin Panel para construir el historial.
 */
export async function listUserMessages(req: any, res: any) {
    try {
        const userId = Number(req.params.userId);
        if (!userId) return res.status(400).json({ error: 'User ID required' });
        
        const repo = AppDataSource.getRepository(ChatMessage);
        const messages = await repo.find({ 
            where: { userId: userId }, 
            order: { createdAt: 'ASC' } 
        });
        
        return res.json({ messages });
    } catch (error) {
        console.error('Error fetching user messages (admin)', error);
        return res.status(500).json({ error: 'Error fetching user history' });
    }
}
// ... importaciones existentes ...
import { Brackets } from 'typeorm'; // Asegúrate de importar esto de typeorm

// -------------------------------------------------------------------------
// BÚSQUEDA GLOBAL (Endpoint Nuevo)
// -------------------------------------------------------------------------
export async function searchUserMessages(req: any, res: any) {
  const userId = req.session?.userId;
  const { query } = req.query;

  if (!userId) return res.status(401).json({ error: 'unauthenticated' });
  if (!query || String(query).trim().length < 2) return res.json({ results: [] });

  try {
    const msgRepo = AppDataSource.getRepository(ChatMessage);
    
    // Debug: Ver con qué ID estamos buscando
    // console.log(`Buscando "${query}" para usuario ID: ${userId}`);

    const messages = await msgRepo.createQueryBuilder('msg')
      // Usamos LEFT JOIN para traer el mensaje aunque la sesión se haya borrado
      .leftJoinAndSelect('msg.session', 'session')
      .where('msg.userId = :userId', { userId })
      // COMPATIBILIDAD: Usamos LOWER(col) LIKE LOWER(val) para soportar MySQL y Postgres
      .andWhere('LOWER(msg.content) LIKE LOWER(:query)', { query: `%${query}%` })
      .orderBy('msg.createdAt', 'DESC')
      .take(20)
      .getMany();

    const results = messages.map(m => ({
      chatId: String(m.sessionId),
      // Si no hay sesión (orphan), mostramos un fallback
      chatTitle: (m as any).session?.title || 'Chat sin título', 
      chatTimestamp: new Date(m.createdAt).toLocaleDateString(),
      messageId: m.id, // TypeORM suele devolver number o string según config
      messageRole: m.role,
      messageContent: m.content,
      matchType: 'message'
    }));

    return res.json({ results });
  } catch (error) {
    console.error('Search error:', error);
    return res.status(500).json({ error: 'Error en búsqueda' });
  }
}
// -------------------------------------------------------------------------
// OBTENER MENSAJES (Modificado para Contexto y Paginación)
// -------------------------------------------------------------------------
// En controllers/chatController.ts

export async function getSessionMessages(req: any, res: any) {
  const userId = req.session?.userId;
  const { sessionId } = req.params;
  const { limit = 20, aroundId, beforeId } = req.query;

  if (!userId) return res.status(401).json({ error: 'unauthenticated' });

  try {
    const msgRepo = AppDataSource.getRepository(ChatMessage);
    
    // 1. Validar que la sesión exista y pertenezca al usuario
    // Si la búsqueda arrojó un mensaje huérfano (sin sesión), esto daría 404.
    // Usamos createQueryBuilder para ser más flexibles o un findOne básico.
    const sessionRepo = AppDataSource.getRepository(ChatSession);
    const session = await sessionRepo.findOne({ 
        where: { id: Number(sessionId), userId: Number(userId) } 
    });

    // Si no existe la sesión pero intentamos cargar mensajes, devolvemos array vacío
    // en lugar de error 404 para que el frontend no rompa.
    if (!session) {
        return res.json({ messages: [] });
    }

    let messages: any[] = [];
    const take = Math.min(Number(limit), 50);

    // 2. Lógica de Contexto (Saltar al mensaje)
    if (aroundId) {
      const targetId = Number(aroundId);
      
      // Mensajes anteriores + el actual
      const prevMsgs = await msgRepo.createQueryBuilder('msg')
        .where('msg.sessionId = :sid', { sid: sessionId })
        .andWhere('msg.id <= :mid', { mid: targetId }) 
        .orderBy('msg.createdAt', 'DESC') // Hacia atrás
        .take(Math.ceil(take / 2) + 1)
        .getMany();

      // Mensajes posteriores
      const nextMsgs = await msgRepo.createQueryBuilder('msg')
        .where('msg.sessionId = :sid', { sid: sessionId })
        .andWhere('msg.id > :mid', { mid: targetId })
        .orderBy('msg.createdAt', 'ASC') // Hacia adelante
        .take(Math.ceil(take / 2))
        .getMany();

      // Unir y ordenar por fecha ascendente para el chat
      messages = [...prevMsgs, ...nextMsgs].sort((a, b) => 
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
      );

    } 
    // 3. Lógica de Paginación (Scroll hacia arriba)
    else if (beforeId) {
      const targetId = Number(beforeId);
      
      messages = await msgRepo.createQueryBuilder('msg')
        .where('msg.sessionId = :sid', { sid: sessionId })
        .andWhere('msg.id < :bid', { bid: targetId })
        .orderBy('msg.createdAt', 'DESC') // Los más recientes anteriores a ese ID
        .take(take)
        .getMany();
      
      // Invertimos para que queden cronológicos (Viejo -> Nuevo)
      messages.reverse();

    } 
    // 4. Lógica Inicial (Últimos mensajes)
    else {
      messages = await msgRepo.find({
        where: { sessionId: Number(sessionId) },
        order: { createdAt: 'DESC' },
        take: take
      });
      messages.reverse();
    }

    return res.json({ messages });
  } catch (error: any) {
    console.error("Error en getSessionMessages:", error);
    // Devolvemos 500 con el mensaje para que puedas verlo en la consola del navegador
    return res.status(500).json({ error: error.message });
  }
}