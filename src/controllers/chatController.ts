import { AppDataSource } from '../datasource';
import { ChatMessage } from '../models/ChatMessage';
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
import { searchLocalInstallations, refreshInstallationsByTerm, listPendingLocalInstallations, fullSyncInstallations } from '../services/wisphubInstallations';
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

/**
 * Guarda la imagen en disco y devuelve las rutas necesarias.
 * Retorna null si falla o no hay imagen.
 */
function saveImageDataUrl(imageDataUrl?: string): { webPath: string; systemPath: string } | null {
  if (!imageDataUrl || typeof imageDataUrl !== 'string') return null;
  try {
    const matches = imageDataUrl.match(/^data:(image\/[-a-zA-Z0-9.+]+);base64,(.+)$/);
    if (!matches) return null;
    
    const ext = (matches[1].split('/')[1] || 'png').toLowerCase();
    const fileName = `chat_${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`;
    
    // Ruta del sistema (física) - Compatible con Docker si se mapea el volumen
    const uploadDir = path.join(process.cwd(), 'uploads', 'chat');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    const systemPath = path.join(uploadDir, fileName);
    
    // Escribir archivo
    fs.writeFileSync(systemPath, Buffer.from(matches[2], 'base64'));
    
    // Ruta web (para el frontend)
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
  const match = raw.match(/(\d+(?:\.\d+)?)/);
  return match ? `${match[1].replace(/\.0+$/, '')}M` : raw;
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

// --- HELPERS: Data Formatting & Normalization ---

function defaultsFromEntity(entity: any, type: 'client' | 'installation'): Record<string, any> {
    const isInst = type === 'installation';
    const plan = entity.servicio || entity.plan_internet;
    const clientName = `${entity.nombre || ''} ${entity.apellidos || ''}`.trim();

    return {
      sn: entity.sn_onu || undefined,
      name: plan || clientName || undefined, 
      zone: entity.zona || entity.ciudad || entity.localidad || undefined,
      address_or_comment: entity.direccion || undefined,
      ipv4_address: entity.ipv4_address || entity.ip || entity.ip_publica || (isInst ? entity.ip_cliente : entity.ip_cliente) || undefined,
      serviceId: entity.id_servicio || undefined,
      download_speed_profile_name: normalizeSpeedProfileName(plan),
      upload_speed_profile_name: normalizeSpeedProfileName(plan)
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
        defaults
    };
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

// --- CONTROLLER FUNCTIONS ---

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

  return [
    { id: 'auth-olt_id', type: 'input', placeholder: `${collected.olt_id || ''}`, label: 'OLT ID', helperText: 'ID numérico', payload: 'auth set olt_id {input}' },
    { id: 'auth-pon_type', type: 'input', label: 'PON type', placeholder: 'gpon', payload: 'auth set pon_type {input}' },
    { id: 'auth-board', type: 'input', label: 'Board', placeholder: `${collected.board || ''}`, payload: 'auth set board {input}' },
    { id: 'auth-port', type: 'input', label: 'Port', placeholder: `${collected.port || ''}`, payload: 'auth set port {input}' },
    { id: 'auth-sn', type: 'input', label: `SN/MAC ${collected.sn ? `(sug: ${collected.sn})` : ''}`, placeholder: collected.sn || 'Ej: ZTEGC...', payload: 'auth set sn {input}' },
    { id: 'auth-onu_type', type: 'input', label: 'ONU Type', placeholder: 'Ej: ZTE-F660', options: onuTypeOptions, payload: 'auth set onu_type {input}' },
    { id: 'auth-onu_mode', type: 'input', label: 'Mode', placeholder: 'Routing', payload: 'auth set onu_mode {input}' },
    { id: 'auth-vlan', type: 'input', label: 'VLAN', placeholder: 'Ej: 100', options: vlanOptions, payload: 'auth set vlan {input}' },
    { id: 'auth-zone', type: 'input', label: `Zona ${collected.zone ? `(sug: ${collected.zone})` : ''}`, placeholder: collected.zone || 'Zona', options: zoneOptions, payload: 'auth set zone {input}' },
    { id: 'auth-odb', type: 'input', label: `ODB ${defaults.odb ? `(curr: ${defaults.odb})` : ''}`, placeholder: 'Selecciona ODB', options: odbOptions, payload: 'auth set odb {input}' },
    { id: 'auth-odb-port', type: 'input', label: 'Puerto ODB', placeholder: '1', payload: 'auth set odb_port {input}' },
    { id: 'auth-name', type: 'input', label: `Nombre`, placeholder: defaults.name || 'Nombre', payload: 'auth set name {input}' },
    { id: 'auth-address', type: 'input', label: 'Dirección', placeholder: defaults.address_or_comment || 'Dirección', payload: 'auth set address_or_comment {input}' },
    { id: 'auth-speed', type: 'input', label: 'Velocidad', placeholder: defaults.download_speed_profile_name || "200M", options: ['200M', '400M','600M','800M'] },
    { id: 'auth-submit', type: 'button', label: 'Autorizar SmartOLT ahora', payload: 'auth submit' }
  ];
}

export async function addMessage(req: any, res: any) {
    const { userId } = req.session || {};
    if (!userId) return res.status(401).json({ error: 'unauthenticated' });
    const { role, content, imageDataUrl } = req.body;
    
    // Guardamos la imagen si existe
    const savedImage = saveImageDataUrl(imageDataUrl);
    const webPath = savedImage ? savedImage.webPath : undefined;

    const repo = AppDataSource.getRepository(ChatMessage);
    const msg = repo.create({ 
        userId: Number(userId), 
        role, 
        content: content || (imageDataUrl ? '[Img]' : ''), 
        imageUrl: webPath 
    });
    
    await repo.save(msg);
    return res.json({ ok: true, id: msg.id });
}

export async function listUserMessages(req: any, res: any) {
   const repo = AppDataSource.getRepository(ChatMessage);
   const messages = await repo.find({ where: { userId: Number(req.params.userId) }, order: { createdAt: 'ASC' } });
   return res.json({ messages });
}

// --- FUNCIÓN PRINCIPAL DEL BOT (RESPOND) ---

export async function respond(req: any, res: any) {
  const session = req.session as any;
  const userId = session?.userId;
  if (!userId) return res.status(401).json({ error: 'unauthenticated' });

  const { content, imageDataUrl } = req.body;
  if (!content && !imageDataUrl) return res.status(400).json({ error: 'empty' });

  const repo = AppDataSource.getRepository(ChatMessage);

  // 1. Manejo de Imagen: Guardar físicamente
  const savedImage = saveImageDataUrl(imageDataUrl);
  const webPath = savedImage ? savedImage.webPath : undefined;

  // 2. Guardar mensaje del usuario
  await repo.save(repo.create({ 
      userId: Number(userId), 
      role: 'user', 
      content: content || '[Img]', 
      imageUrl: webPath 
  }));

  let finalContent = '';
  let actionsOut: any[] = [];
  let assistantMetadata: any = null;

  try {
    // ------------------------------------------------------------------
    // A. LÓGICA DE IMAGEN (NUEVO BLOQUE PRIORITARIO)
    // ------------------------------------------------------------------
    if (savedImage && savedImage.systemPath) {
        // Verificamos si tenemos contexto de un cliente/instalación activa
        const targetId = session.lastSelectedClientIdServicio || session.lastSelectedInstallationId;
        
        // --- NUEVA LÓGICA: COLA DE FOTOS ---
        // Inicializar el buffer de fotos si no existe
        if (!session.pendingPhotos) {
            session.pendingPhotos = [];
        }

        // Si ya hay cliente seleccionado, subimos directo (o podrías encolar también si prefieres)
        if (targetId) {
            finalContent = `📸 Imagen recibida. Subiendo a Geonet (ID: ${targetId})...`;
            
            // Construimos el usuario técnico 
            const baseName = session.lastAuthNameUsed || 'tecnico'; 
            const fullGeonetUser = `${baseName}@geonet`;

            try {
               const subidaExitosa = await uploadDocumentoCliente(
                   targetId, 
                   fullGeonetUser, 
                   savedImage.systemPath, // Ruta absoluta
                   `Evidencia Chat - ${new Date().toLocaleTimeString()}`, 
                   content || 'Imagen subida automáticamente desde el chat' // Descripción
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
        // Si NO hay cliente seleccionado, guardamos en la cola para procesar después
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
    // B. LÓGICA DE TEXTO (EXISTENTE)
    // ------------------------------------------------------------------
    else {
        const prompt = content || '';
        const lower = prompt.toLowerCase();
        
        const structured = await buildStructuredResponse(prompt); 
        finalContent = structured.content;
        actionsOut = structured.actions as any[];
        assistantMetadata = null;

        // --- 1. PRIORIDAD ALTA: Comandos Específicos (WiFi, Auth) ---

        // --- LÓGICA ACTIVAR WISPHUB (CON SUBIDA DE FOTOS BUFFERED) ---
        if (lower.startsWith('wisphub activate')) {
          const idMatch = prompt.match(/activate\s+(\d+)/i);
          const targetId = idMatch ? idMatch[1] : null;

          const baseName = session.lastAuthNameUsed || targetId;
          const fullGeonetUser = `${baseName}@geonet`;

          if (!targetId) {
              finalContent = "⚠️ Error: No se detectó ID para activar.";
          } else {
              finalContent = `⏳ Activando servicio en Geonet para **${fullGeonetUser}**...`;
              const exito = await activarInstalacionGeonet(targetId, fullGeonetUser);
              
              if (exito) {
                  finalContent = `🚀 **¡Activación Exitosa!**\nLa instalación **${targetId}** ha sido activada correctamente bajo el usuario \`${fullGeonetUser}\`.`;

                  // --- SUBIDA DE FOTOS DEL BUFFER AL ACTIVAR ---
                  if (session.pendingPhotos && session.pendingPhotos.length > 0) {
                      finalContent += `\n\n📤 **Procesando ${session.pendingPhotos.length} fotos acumuladas...**`;
                      let uploadedCount = 0;

                      for (const photo of session.pendingPhotos) {
                          try {
                              const subidaOk = await uploadDocumentoCliente(
                                  targetId, 
                                  fullGeonetUser, 
                                  photo.systemPath, // Ruta física
                                  `Evidencia Activación - ${photo.timestamp}`, 
                                  photo.caption || 'Foto adjunta al activar'
                              );
                              if (subidaOk) uploadedCount++;
                          } catch (err) {
                              console.error('Error subiendo foto batch en activación:', err);
                          }
                      }

                      if (uploadedCount > 0) {
                          finalContent += `\n✅ **${uploadedCount} fotos subidas correctamente a la ficha.**`;
                          delete session.pendingPhotos; // Limpiamos el buffer
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
        // --- LÓGICA WIFI APPLY ---
        else if (lower.startsWith('wifi apply')) {
            const snMatch = prompt.match(/sn\s+([a-zA-Z0-9]+)/i);
            const ssidMatch = prompt.match(/ssid\s+(.+?)(?=\s+pass)/i); 
            const passMatch = prompt.match(/pass\s+(.+?)(?=\s+contract_id|$)/i);

            const bodyData = req.body || {};
            const container = bodyData.collected || bodyData.data || {};
            
            const sn = (snMatch ? snMatch[1].toUpperCase() : null) || container.sn;
            const ssid = (ssidMatch ? ssidMatch[1].trim() : null) || bodyData.wifi_ssid || container.wifi_ssid;
            const pass = (passMatch ? passMatch[1].trim() : null) || bodyData.wifi_pass || container.wifi_pass;

            if (sn && ssid && pass) {
                try {
                    const internalId = await getInternalOnuIdBySn(sn);
                    
                    if (!internalId) {
                        finalContent = `❌ Error: No se encontró el ID interno de la ONU ${sn}. Verifique autorización.`;
                    } else {
                        const results = [];
                        // 2.4GHz
                        try {
                            await updateOnuWifi(internalId, '2.4GHz', ssid, pass, true);
                            results.push('✅ 2.4GHz Configurado');
                        } catch (e: any) {
                            results.push(`❌ 2.4GHz Falló: ${e.message}`);
                        }
                        // 5GHz
                        try {
                            await updateOnuWifi(internalId, '5GHz', `${ssid}_5G`, pass, true);
                            results.push('✅ 5GHz Configurado');
                        } catch (e: any) {
                            results.push(`⚠️ 5GHz: ${e.message || 'No disponible'}`);
                        }
                        
                        finalContent = `📡 Resultado WiFi (SN: ${sn}):\nSSID: ${ssid}\nClave: ${pass}\n\n${results.join('\n')}`;
                        
                        actionsOut = [];
                        
                        const targetId = session.lastSelectedClientIdServicio || session.lastSelectedInstallationId;

                        if (targetId) {
                            actionsOut.push(
                                { 
                                    id: 'btn-contrato', 
                                    type: 'button', 
                                    label: '📄 Generar Contrato', 
                                    payload: `generar contrato ${targetId}` 
                                },
                            );
                            finalContent += `\n\n👇 Acciones post-instalación para ID ${targetId}:`;
                        } else {
                            finalContent += `\n\n(ℹ️ No se detectó un ID seleccionado previamente para generar el contrato)`;
                        }
                    }
                } catch (err: any) {
                    console.error('Error general Wifi:', err);
                    finalContent = `❌ Error crítico WiFi: ${err.message}`;
                }
            } else {
                finalContent = '⚠️ Error de formato WiFi. Intente de nuevo.';
            }
        }
        else if (lower.startsWith('generar contrato')) {
          const idMatch = prompt.match(/generar contrato\s+(\d+)/i);
          const targetId = idMatch ? idMatch[1] : null;
          if (targetId) {
              finalContent = `📄 Generando contrato para ID **${targetId}**...`;
              await processContractUpdate(targetId).catch(err => {
                  console.error('Error generating contract:', err);
              });
              const baseName = session.lastAuthNameUsed || targetId;

              let contratourl = await getAutoLoginContractLink(`${baseName}@geonet`, targetId);
              
              finalContent = `✅ Contrato generado:`;
              const directActions: any[] = [];
                  directActions.push(
                     { 
                        id: 'btn-contrato', 
                        type: 'link', 
                        label: '📄 Copiar Contrato', 
                        url: `${contratourl}` 
                     },
                     { 
                        id: 'btn-activar-wisphub', 
                        type: 'button', 
                        label: '🚀 Activar en WispHub', 
                        payload: `wisphub activate ${targetId}` 
                     });
              actionsOut = directActions;
          } else {
              finalContent = '⚠️ Error: No se detectó ID para generar contrato.';
          }
        }
      
        // --- LÓGICA AUTH SUBMIT ---
        else if (lower === 'auth submit') {
            if (!session.pendingAuth) finalContent = 'No hay autorización en curso.';
            else { await submitAuth(req, res); return; }
        }
        
        // --- 2. PRIORIDAD MEDIA: Selección de Cliente/Instalación ---
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
            } else {
                finalContent = `${isClient ? 'Cliente' : 'Instalación'} no encontrada.`;
            }
        }
        // --- LÓGICA SELECCIÓN MANUAL DE ONU ---
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
                        onu = {
                            sn: sn, olt_id: oltId, pon_type: (ponType || 'gpon').toLowerCase(),
                            board: board || '', port: port || '', onu_type: model, onu_type_name: model, onu_mode: 'Routing'
                        };
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

        // --- 3. PRIORIDAD BAJA: Listados y Búsquedas Generales ---
        else if (lower.includes('instalaciones pendientes') || /^modo\s+b(usqueda|úsqueda)\s+instalacion$/i.test(lower)) {
            if (/^modo\s+b(usqueda|úsqueda)\s+instalacion$/i.test(lower)) { 
                session.searchMode = 'installation'; session.lastContextType = 'installations'; 
            }

            let items = await listPendingLocalInstallations(20);
            if (!items?.length) { await fullSyncInstallations(100, 3).catch(()=>{}); items = await listPendingLocalInstallations(20); }
            
            const table = buildInstallationsTable(items || []);
            finalContent = items?.length ? `Instalaciones pendientes:\n\n${table}` : 'No hay instalaciones pendientes.';
            const fmt = formatEntityList(items || [], 'installation');
            actionsOut = [...fmt.actions, { id: 'refresh', type: 'button', label: 'Refrescar', payload: 'Enséñame las instalaciones pendientes de evidencia para autorizar el alta' }];
        }
        else if (lower.match(/actualiza|refresca|no esta/)) {
            const ctx = session.lastContextType;
            await (ctx === 'installations' ? fullSyncInstallations() : fullSyncClients());
            finalContent = 'Base de datos sincronizada. Intenta buscar de nuevo.';
        }
        // BÚSQUEDA GENERAL
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
                    actionsOut = [
                        { id: 'mode-inst', type: 'button', label: 'Modo Instalación', payload: 'modo busqueda instalacion' }, 
                        ...cFmt.actions, ...iFmt.actions
                    ];
                } else {
                    finalContent = `${refreshed ? 'Actualicé BD pero no' : 'No'} encontré resultados para "${term}".`;
                }
            }
        }
    } // FIN BLOQUE ELSE (TEXTO)

  } catch (err: any) {
      console.error('Respond error:', err);
      finalContent += `\n(Error interno: ${err.message})`;
  }

  const msg = repo.create({ userId: Number(userId), role: 'assistant', content: finalContent, actions: actionsOut, metadata: assistantMetadata });
  await repo.save(msg);
  
  return res.json({
      ok: true,
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
    
    // --- LÓGICA DE VERIFICACIÓN EN TABLA INSTALLATION Y GEONET ---
    
    // A) Resolvemos el ID y Sesión
    const session = data._session || {};
    let clientid = targetId;
    if (!clientid) {
        clientid = session.lastSelectedClientIdServicio || session.lastSelectedInstallationId;
    }

    let skipGeonetRegistration = false;

    // B) Consultamos la tabla Installation si tenemos un ID
    if (clientid) {
        try {
            const instRepo = AppDataSource.getRepository(Installation);
            
            const installation = await instRepo.findOne({ 
                where: [
                    { id: Number(clientid) },
                    { id_servicio: Number(clientid) }
                ]
            });

            if (installation && installation.sn_onu) {
                const storedSn = String(installation.sn_onu).trim().toUpperCase();
                const newSn = String(onuId).trim().toUpperCase();

                if (storedSn === newSn) {
                    console.log(`ℹ️ El SN ${newSn} ya existe en la tabla Installation (ID: ${installation.id}). Saltando registros.`);
                    skipGeonetRegistration = true;
                }
            }
        } catch (err) {
            console.error('⚠️ Error consultando tabla Installation:', err);
        }
    }

    // C) Ejecutamos Geonet y Artículos SOLO si no se debe saltar
    if (!skipGeonetRegistration) {
        // Registrar ONU
        await registrarOnuGeonet(data.onu_type, onuId);
        
        // Agregar Artículo
        console.log('Client ID for adding article:', clientid);
        if (clientid !== undefined) {
            await agregarArticuloACliente(clientid, `${data.name}@geonet` || '', onuId); 
        }

        // --- NOTA: Aquí se eliminó la subida de fotos del buffer (movido a wisphub activate) ---

    } else {
        messages.push('ℹ️ ONU ya registrada en BD (SN coincidente).');
    }

    // --- 3. LOGICA CONDICIONAL (WIFI vs BOTONES DIRECTOS) ---
    const rawType = String(data.onu_type || '').toUpperCase().replace(/[- ]/g, '');
    const wifiModels = ['ZTEF6600P', 'ZXHNF600P']; // Modelos que SÍ requieren WiFi manual

    // Si ES uno de los modelos WiFi, mostramos el formulario
    if (wifiModels.includes(rawType)) {
        const wifiActions = [
            { id: 'wifi_ssid', type: 'input', label: 'Nombre WiFi (SSID)', placeholder: 'Nuevo Nombre', payload: 'wifi set ssid {input}' },
            { id: 'wifi_pass', type: 'input', label: 'Contraseña WiFi', placeholder: 'Nueva Clave (min 8)', payload: 'wifi set pass {input}' },
            { id: 'wifi_submit', type: 'button', label: 'Aplicar Cambios WiFi', payload: `wifi apply sn ${onuId} ssid {wifi_ssid} pass {wifi_pass}` }
        ];
        return { message: messages.join(' '), actions: wifiActions };
    } 
    // Si NO es de esos modelos, vamos directo a Contrato y Activar
    else {
        const directActions: any[] = [];
        if (targetId) {
             directActions.push(
                { 
                    id: 'btn-contrato', 
                    type: 'button', 
                    label: '📄 Generar Contrato', 
                    payload: `generar contrato ${targetId}` 
                },
            );
            messages.push(`\n\n👇 **Proceso finalizado.** Selecciona una acción:`);
        } else {
            messages.push('\n(⚠️ No se detectó ID asociado para generar contrato)');
        }
        
        return { message: messages.join(' '), actions: directActions };
    }
}

export async function submitAuth(req: any, res: any) {
    const session = req.session || {};
    if (!session.userId) return res.status(401).json({ error: 'unauthenticated' });

    const state = session.pendingAuth || {};
    const merged = { ...state.defaults, ...state.collected, ...req.body, ...req.body.collected };

    // --- GUARDAR EL NOMBRE PARA GEONET ---
    session.lastAuthNameUsed = merged.name || state.defaults?.name;
    
    // Recuperamos el ID del cliente/instalación de la sesión para pasarlo a processPostAuthActions
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

        console.log('🚀 Payload Autorización:', JSON.stringify(authPayload));
        const result: any = await authorizeOnu(authPayload);
        const success = result && (result.status === true || String(result.response_code) === 'success');

        if (!success) throw new Error(result?.error || result?.message || 'SmartOLT rechazó la solicitud.');

        // 2. PASAMOS targetId Y LA SESIÓN A LA FUNCIÓN DE POST-PROCESO
        const postResult = await processPostAuthActions({
            ...merged, 
            onu_external_id: explicitSn, 
            vlan: cleanVlan, 
            address_or_comment: finalAddress, 
            odb_port: cleanOdbPort,
            onu_type: merged.onu_type, 
            _session: session 
        }, targetId);

        cacheDelete('listOlts');
        if (merged.olt_id) cacheDelete(`onus:${merged.olt_id}`);
        delete session.pendingAuth;

        return res.json({ ok: true, message: postResult.message, actions: postResult.actions });
    } catch (e: any) {
        console.error('❌ Error en submitAuth:', e);
        const errorMsg = e.response?.data?.error || e.message;
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


export async function getUserChats(req: any, res: any) {
  const userId = req.session?.userId;
  if (!userId) return res.status(401).json({ error: 'unauthenticated' });

  try {
    const repo = AppDataSource.getRepository(ChatMessage);

    const messages = await repo.find({
      where: { userId: Number(userId) },
      order: { createdAt: 'ASC' }
    });

    if (!messages.length) {
      return res.json({ chats: [] });
    }

    // 2. Algoritmo de Agrupación por Tiempo (Time-Gap)
    // Si pasan más de 60 mins entre mensajes, se considera un chat nuevo.
    const chats: any[] = [];
    let currentGroup: any[] = [];
    const TIMEOUT_MS = 60 * 60 * 1000; // 1 Hora

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];

      if (currentGroup.length === 0) {
        currentGroup.push(msg);
        continue;
      }

      const prevMsg = currentGroup[currentGroup.length - 1];
      
      // Convertir fechas a timestamp numérico para comparar
      const tCurrent = new Date(msg.createdAt).getTime();
      const tPrev = new Date(prevMsg.createdAt).getTime();
      const diff = tCurrent - tPrev;

      if (diff > TIMEOUT_MS) {
        // Cierre del grupo anterior
        chats.push(currentGroup);
        // Inicio de grupo nuevo
        currentGroup = [msg];
      } else {
        // Continuación del mismo grupo
        currentGroup.push(msg);
      }
    }
    
    // Empujar el último grupo
    if (currentGroup.length > 0) {
      chats.push(currentGroup);
    }

    // 3. Formatear para el Frontend
    // Usamos .reverse() para que los chats más recientes salgan arriba
    const formattedChats = chats.reverse().map((group) => {
      const firstMsg = group[0];
      const lastMsg = group[group.length - 1];
      
      // Buscar el primer mensaje del usuario para usarlo como título
      const firstUserMsg = group.find((m: any) => m.role === 'user');
      const rawTitle = firstUserMsg ? firstUserMsg.content : (firstMsg.content || 'Conversación');
      
      // Limpiar título si es muy largo
      const title = rawTitle.length > 40 ? rawTitle.substring(0, 40) + '...' : rawTitle;

      return {
        id: `chat-group-${firstMsg.id}`, // ID virtual basado en el primer mensaje
        title: title,
        timestamp: new Date(lastMsg.createdAt).toLocaleString(), // Fecha del último mensaje
        preview: lastMsg.content.substring(0, 50),
        isAdminHistory: false,
        ownerUserId: userId,
        messages: group.map((m: any) => ({
          id: `msg-${m.id}`,
          role: m.role,
          content: m.content,
          imageDataUrl: m.imageUrl,
          createdAt: m.createdAt,
          actions: m.actions,     // TypeORM debería manejar el JSON automáticamente
          metadata: m.metadata
        }))
      };
    });

    return res.json({ chats: formattedChats });

  } catch (error) {
    console.error('Error fetching user chats:', error);
    return res.status(500).json({ error: 'Error interno al cargar chats' });
  }
}