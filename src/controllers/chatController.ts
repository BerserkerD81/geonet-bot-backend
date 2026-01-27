<<<<<<< HEAD


export async function handleChatMessage(req: any, res: any) {
  const session = req.session as any;
  let userId = session?.userId;
  // If no session, allow machine-to-machine (n8n) requests authenticated by API token.
  if (!userId) {
    const headerToken = (req.get('x-api-token') || req.get('x-n8n-token') || '').trim();
    const expected = (process.env.N8N_API_TOKEN || process.env.API_TOKEN || process.env.N8N_SAVE_TOKEN || '').trim();
    if (expected && headerToken && headerToken === expected) {
      const bodyUserId = req.body && (req.body.userId ?? req.body.userId === 0 ? req.body.userId : undefined);
      if (bodyUserId === undefined || bodyUserId === null) {
        return res.status(400).json({ error: 'userId required for system requests' });
      }
      const parsed = Number(bodyUserId);
      if (!Number.isInteger(parsed) || parsed <= 0) return res.status(400).json({ error: 'invalid userId' });
      userId = parsed;
    } else {
      return res.status(401).json({ error: 'unauthenticated' });
    }
  }

  const { content, imageUrl, metadata } = req.body || {};
  if (!content && !imageUrl) return res.status(400).json({ error: 'content_required' });

  const repo = AppDataSource.getRepository(ChatMessage);
  // Obtener últimos 10 mensajes para contexto
  const prev = await repo.find({ where: { userId: Number(userId) }, order: { createdAt: 'ASC' }, take: 10 });
  const messages = prev.map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content, imageUrl: m.imageUrl ?? null }));

  // Determine sessionId coming from body/header/session
  const incomingSessionId = (req.body && (req.body.sessionId || req.body.key)) || req.get('Key') || req.get('X-Session-Id') || session?.n8nSessionId;
  // Guardar mensaje de usuario
  const userMsg = repo.create({
    userId: Number(userId),
    role: 'user',
    content: typeof content === 'string' ? content : '',
    imageUrl: typeof imageUrl === 'string' ? imageUrl : undefined,
    metadata: (() => {
      const m = metadata && typeof metadata === 'object' ? { ...metadata } : {};
      if (incomingSessionId) m.sessionId = String(incomingSessionId);
      return Object.keys(m).length ? m : undefined;
    })(),
  });
  await repo.save(userMsg);

  // Llamar a n8n para obtener respuesta
  let assistantMsg;
  try {
    // Ensure a per-session n8n session id exists so n8n can keep context across messages
    if (session && !session.n8nSessionId) session.n8nSessionId = randomUUID();
    const effectiveSessionId = session?.n8nSessionId || incomingSessionId;
    const out = await runChatWorkflow({ userId: Number(userId), content, imageUrl, messages, sessionId: effectiveSessionId });
    assistantMsg = repo.create({
      userId: Number(userId),
      role: 'assistant',
      content: out.content || '',
      actions: Array.isArray(out.actions) ? out.actions : undefined,
      metadata: (() => {
        const m = out.metadata && typeof out.metadata === 'object' ? { ...out.metadata } : {};
        if (effectiveSessionId) m.sessionId = String(effectiveSessionId);
        return Object.keys(m).length ? m : undefined;
      })(),
    });
    await repo.save(assistantMsg);
  } catch (e: any) {
    assistantMsg = repo.create({
      userId: Number(userId),
      role: 'assistant',
      content: 'Ocurrió un error al procesar tu mensaje. Intenta nuevamente.',
    });
    await repo.save(assistantMsg);
  }

  return res.json({
    ok: true,
    userMessage: {
      id: userMsg.id,
      role: userMsg.role,
      content: userMsg.content,
      imageUrl: userMsg.imageUrl ?? null,
      createdAt: userMsg.createdAt,
    },
    assistantMessage: {
      id: assistantMsg.id,
      role: assistantMsg.role,
      content: assistantMsg.content,
      actions: assistantMsg.actions ?? [],
      createdAt: assistantMsg.createdAt,
      metadata: assistantMsg.metadata ?? null,
    },
  });
}
function buildAuthActions(state: any) {
  const defaults = state.defaults || {};
  const collected = state.collected || {};
  const zoneOptions = Array.isArray(state.smartoltZones) ? state.smartoltZones : [];
  const ponTypeForOnuType = (collected.pon_type || defaults.pon_type || 'gpon').toLowerCase();
  const zoneFilter = (collected.zone || defaults.zone || '').toString().toLowerCase();
  const vlanOptions = (() => {
    if (!state.smartoltVlans) return [] as string[];
    const set = new Set<string>();
    Object.values(state.smartoltVlans as Record<string, string[]>).forEach((arr: any) => {
      normalizeVlanValues(arr).forEach((val) => {
        if (val) set.add(val);
      });
    });
    return Array.from(set);
  })();
  const onuTypeOptions = (() => {
    const map = state.smartoltOnuTypes as Record<string, string[]> | undefined;
    if (!map) return [] as string[];
    const list = map[ponTypeForOnuType] || map[collected.pon_type] || [];
    return list || [];
  })();
  const odbOptions = Array.isArray(state.smartoltOdbs)
    ? (state.smartoltOdbs as Array<{ id?: string; name?: string; zone?: string }>)
        .filter((o) => {
          if (!zoneFilter) return true;
          const haystack = `${o.name || ''} ${o.id || ''} ${o.zone || ''}`.toLowerCase();
          return haystack.includes(zoneFilter);
        })
        .map((o) => o.name || o.id || '')
        .filter(Boolean)
    : [];
  const actions = [];
  // Solo incluir OLT ID, Board y Port si NO están definidos en collected
  if (!collected.olt_id) actions.push({ id: 'auth-olt_id', type: 'input', label: `OLT ID${collected.olt_id ? ` (actual: ${collected.olt_id})` : ''}`, helperText: 'ID numérico de la OLT destino', payload: 'auth set olt_id {input}' });
  actions.push({ id: 'auth-pon_type', type: 'input', label: `PON type${collected.pon_type ? ` (actual: ${collected.pon_type})` : ''}`, placeholder: 'gpon', helperText: 'Tipo de PON: gpon o epon', payload: 'auth set pon_type {input}' });
  if (!collected.board) actions.push({ id: 'auth-board', type: 'input', label: `Board${collected.board ? ` (actual: ${collected.board})` : ''}`, placeholder: `${collected.board || '2'}`, payload: 'auth set board {input}' });
  if (!collected.port) actions.push({ id: 'auth-port', type: 'input', label: `Port${collected.port ? ` (actual: ${collected.port})` : ''}`, placeholder: `${collected.port || '2'}`, payload: 'auth set port {input}' });
  actions.push({
    id: 'auth-sn',
    type: 'input',
    label: `SN/MAC${collected.sn ? ` (actual: ${collected.sn})` : defaults.sn ? ` (sugerido: ${defaults.sn})` : ''}`,
    placeholder: collected.sn || 'Ej: ZTEGC7E230E4',
    helperText: 'SN bloqueado: se toma de la ONU seleccionada',
    payload: ''
  });
  actions.push({ id: 'auth-onu_type', type: 'input', label: `ONU Type${collected.onu_type ? ` (actual: ${collected.onu_type})` : ''}`, placeholder: 'Ej: ZTE-F660V6.0', options: onuTypeOptions, payload: 'auth set onu_type {input}' });
  actions.push({ id: 'auth-onu_mode', type: 'input', label: `ONU Mode${collected.onu_mode ? ` (actual: ${collected.onu_mode})` : ''}`, placeholder: 'Routing', payload: 'auth set onu_mode {input}' });
  actions.push({ id: 'auth-vlan', type: 'input', label: `VLAN`, placeholder: 'Ej: 100', options: vlanOptions, payload: 'auth set vlan {input}' });
  actions.push({ id: 'auth-zone', type: 'input', label: `Zona${collected.zone ? ` (actual: ${collected.zone})` : defaults.zone ? ` (sugerido: ${defaults.zone})` : ''}`, placeholder: defaults.zone || 'Ciudad o zona', options: zoneOptions, payload: 'auth set zone {input}' });
  actions.push({ id: 'auth-odb', type: 'input', label: `ODB/Splitter${collected.odb ? ` (actual: ${collected.odb})` : ''}`, placeholder: 'Selecciona ODB', options: odbOptions, payload: 'auth set odb {input}' });
  actions.push({ id: 'auth-odb-port', type: 'input', label: `Puerto ODB${collected.odb_port ? ` (actual: ${collected.odb_port})` : ''}`, placeholder: '1', payload: 'auth set odb_port {input}' });
  actions.push({ id: 'auth-name', type: 'input', label: `Nombre${collected.name ? ` (actual: ${collected.name})` : defaults.name ? ` (sugerido: ${defaults.name})` : ''}`, placeholder: defaults.name || 'Nombre y Apellido', payload: 'auth set name {input}' });
  actions.push({ id: 'auth-address', type: 'input', label: `Dirección/Comentario/Etiqueta Roja${collected.address_or_comment ? ` (actual: ${collected.address_or_comment})` : defaults.address_or_comment ? ` (sugerido: ${defaults.address_or_comment})` : ''}`, placeholder: defaults.address_or_comment || 'Dirección de instalación', payload: 'auth set address_or_comment {input}' });
  actions.push({ id: 'auth-speed', type: 'input', label: `Velocidad (M)`, placeholder: defaults.download_speed_profile_name || "200M" || 'Ej: 300M', options: ['200M', '400M','600M','800M'], helperText: 'La velocidad se aplicará simétrica (bajada/subida)' });


  // (WAN inputs will be requested after successful authorization in a follow-up step)
  actions.push({ id: 'auth-submit', type: 'button', label: 'Autorizar SmartOLT ahora', payload: 'auth submit' });
  return actions;
}
=======
>>>>>>> parent of d0c9887 (feat: add Wisphub client and installation services with full sync capabilities)
import { AppDataSource } from '../datasource';
import { ChatMessage } from '../models/ChatMessage';
import fs from 'fs';
import path from 'path';
<<<<<<< HEAD
import { randomUUID } from 'crypto';
import { buildStructuredResponse } from '../services/simpleBot';
import { runChatWorkflow } from '../services/n8nClient';
import { N8N } from '../config';
import { searchLocal, refreshClientsByTerm, fullSyncClients } from '../services/wisphubClient';
import { searchLocalInstallations, refreshInstallationsByTerm, listPendingLocalInstallations, fullSyncInstallations } from '../services/wisphubInstallations';
import { authorizeOnu, listOlts, type OltInfo, getZones, getOltVlans, listOnusByOlt, listUnconfiguredOnusByOlt, listGlobalUnconfiguredOnus, getOdbs, getOnuTypesByPonType, type SmartOltOnu, updateOnuLocation, setOnuWanModeStaticIp } from '../services/smartoltClient';

// Pre-fill SmartOLT auth payload with any defaults we already know
function buildPrefilledAuth(defaults: Record<string, any> = {}) {
  const collected: Record<string, any> = {};
  if (defaults.sn) collected.sn = defaults.sn;
  if (defaults.name) collected.name = defaults.name;
  if (defaults.zone) collected.zone = defaults.zone;
  if (defaults.address_or_comment) collected.address_or_comment = defaults.address_or_comment;
  const normDown = normalizeSpeedProfileName(defaults.download_speed_profile_name);
  const normUp = normalizeSpeedProfileName(defaults.upload_speed_profile_name);
  if (normDown) collected.download_speed_profile_name = normDown;
  if (normUp) collected.upload_speed_profile_name = normUp;
  collected.pon_type = 'gpon';
  collected.onu_mode = 'Routing';
  // propagate possible IP fields to collected so submitAuth can use them
  if (defaults.ipv4_address) collected.ipv4_address = defaults.ipv4_address;
  if (defaults.ipv4) collected.ipv4 = defaults.ipv4;
  if (defaults.ip) collected.ip = defaults.ip;
  if (defaults.client_ip) collected.client_ip = defaults.client_ip;
  if (defaults.cliente_ip) collected.cliente_ip = defaults.cliente_ip;
  if (defaults.customer_ip) collected.customer_ip = defaults.customer_ip;
  if (defaults.service_ip) collected.service_ip = defaults.service_ip;
  return collected;
}

// Simple in-memory TTL cache for hot lookups
const _simpleCache = new Map<string, { ts: number; val: any }>();
async function cacheGet<T>(key: string, ttlSeconds: number, fetcher: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const existing = _simpleCache.get(key);
  if (existing && now - existing.ts < ttlSeconds * 1000) return existing.val as T;
  const val = await fetcher();
  try {
    _simpleCache.set(key, { ts: now, val });
  } catch {}
  return val;
}

function cacheDelete(keyPrefix: string) {
  for (const k of Array.from(_simpleCache.keys())) {
    if (k.startsWith(keyPrefix)) _simpleCache.delete(k);
  }
}

// Reusable: store a base64 image data URL to disk and return the public URL
function saveImageDataUrl(imageDataUrl?: string): string | null {
  if (!imageDataUrl || typeof imageDataUrl !== 'string') return null;
  try {
    const matches = imageDataUrl.match(/^data:(image\/[-a-zA-Z0-9.+]+);base64,(.+)$/);
    if (!matches) return null;
    const mimeType = matches[1];
    const base64Data = matches[2];
    const ext = (mimeType.split('/')[1] || 'png').toLowerCase();
    const fileName = `chat_${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`;
    const uploadDir = path.join(process.cwd(), 'uploads', 'chat');
    fs.mkdirSync(uploadDir, { recursive: true });
    const filePath = path.join(uploadDir, fileName);
    fs.writeFileSync(filePath, Buffer.from(base64Data, 'base64'));
    return `/uploads/chat/${fileName}`;
  } catch (err) {
    console.error('Failed to store chat image', err);
    return null;
  }
}

// Defaults builders
function defaultsFromInstallation(inst: any): Record<string, any> {
  return {
    sn: inst?.sn_onu || undefined,
    name: (inst?.servicio || inst?.plan_internet) || `${inst?.nombre || ''} ${inst?.apellidos || ''}`.trim() || undefined,
    zone: inst?.zona || inst?.ciudad || inst?.localidad || undefined,
    address_or_comment: inst?.direccion || undefined,
    // possible IP fields from installation record
    ipv4_address: inst?.ipv4_address || inst?.ip || inst?.ip_publica || inst?.ip_cliente || undefined,
    serviceId: inst?.id_servicio || undefined,
    download_speed_profile_name: normalizeSpeedProfileName(inst?.plan_internet || inst?.servicio) || inst?.plan_internet || inst?.servicio || undefined,
    upload_speed_profile_name: normalizeSpeedProfileName(inst?.plan_internet || inst?.servicio) || inst?.plan_internet || inst?.servicio || undefined
  };
}

function defaultsFromClient(c: any): Record<string, any> {
  return {
    sn: c?.sn_onu || undefined,
    name: (c?.plan_internet || c?.servicio) || `${c?.nombre || ''} ${c?.apellidos || ''}`.trim() || undefined,
    zone: c?.zona || c?.ciudad || c?.localidad || undefined,
    address_or_comment: c?.direccion || undefined,
    // possible IP fields from client record
    ipv4_address: c?.ipv4_address || c?.ip || c?.ip_publica || c?.ip_cliente || undefined,
    serviceId: c?.id_servicio || undefined,
    download_speed_profile_name: normalizeSpeedProfileName(c?.plan_internet || c?.servicio) || c?.plan_internet || c?.servicio || undefined,
    upload_speed_profile_name: normalizeSpeedProfileName(c?.plan_internet || c?.servicio) || c?.plan_internet || c?.servicio || undefined
  };
}

function buildInstallationSummary(inst: any): string {
  return [
    `ID instalación: ${inst.id}`,
    `Cliente: ${(inst.nombre || '') + ' ' + (inst.apellidos || '')}`,
    inst.cedula ? `Documento: ${inst.cedula}` : undefined,
    inst.servicio ? `Plan: ${inst.servicio}` : undefined,
    inst.direccion ? `Dirección: ${inst.direccion}` : undefined,
    inst.ciudad ? `Ciudad: ${inst.ciudad}` : undefined,
    inst.localidad ? `Localidad: ${inst.localidad}` : undefined,
    inst.zona ? `Zona: ${inst.zona}` : undefined,
  ].filter(Boolean).join('\n');
}

function buildClientSummary(c: any): string {
  return [
    `ID servicio: ${c.id_servicio}`,
    `Cliente: ${(c.nombre || '') + ' ' + (c.apellidos || '')}`,
    c.cedula ? `Documento: ${c.cedula}` : undefined,
    c.servicio ? `Plan: ${c.servicio}` : undefined,
    c.direccion ? `Dirección: ${c.direccion}` : undefined,
    c.ciudad ? `Ciudad: ${c.ciudad}` : undefined,
    c.localidad ? `Localidad: ${c.localidad}` : undefined,
    c.zona ? `Zona: ${c.zona}` : undefined,
  ].filter(Boolean).join('\n');
}

async function applyOltAndNetworkToState(state: any, serviceIdOrTerm?: number | string, opts?: { skipZonesFetch?: boolean }) {
  const section = await buildOltAndNetworkSection(serviceIdOrTerm, opts);
  // Apply suggestions to collected
  if (section.suggestedVlan && !state.collected.vlan) state.collected.vlan = section.suggestedVlan;
  if (section.suggestedZone && !state.collected.zone) state.collected.zone = section.suggestedZone;
  if (section.suggestedDownload && !state.collected.download_speed_profile_name) state.collected.download_speed_profile_name = section.suggestedDownload;
  if (section.suggestedUpload && !state.collected.upload_speed_profile_name) state.collected.upload_speed_profile_name = section.suggestedUpload;
  // Persist lookups
  state.smartoltZones = section.zones;
  state.smartoltVlans = section.vlansByOlt;
  state.smartoltOdbs = section.odbs;
  state.smartoltOnuTypes = section.onuTypesByPon;
  await hydrateZonesAndOdbs(state, state.collected.zone);
  return section;
}

// Build WAN configuration actions based on collected data
function buildWanActions(collected: Record<string, any>): any[] {
  const ipCandidates = [collected.ipv4_address, collected.ipv4, collected.ip, collected.client_ip, collected.cliente_ip, collected.customer_ip, collected.service_ip];
  const ipRaw = ipCandidates.find((v) => v !== undefined && v !== null && String(v).trim() !== '');
  const ip = ipRaw ? String(ipRaw).trim() : '';

  const actions: any[] = [];
  actions.push({ id: 'wan-sn', type: 'input', label: `SN/MAC`, placeholder: collected.sn || '', payload: 'wan set sn {input}' });
  actions.push({ id: 'wan-onu_external_id', type: 'input', label: `ONU External ID`, placeholder: collected.onu_external_id ? String(collected.onu_external_id) : '', payload: 'wan set onu_external_id {input}' });
  actions.push({ id: 'wan-ipv4', type: 'input', label: `WAN IPv4`, placeholder: ip || 'Ej: 10.100.0.11', payload: 'wan set ipv4_address {input}' });
  actions.push({ id: 'wan-subnet', type: 'input', label: `WAN Subnet Mask`, placeholder: collected.subnet_mask || '255.255.255.0', payload: 'wan set subnet_mask {input}' });
  let gatewayPlaceholder = collected.gateway || '';
  if (!gatewayPlaceholder && ip) {
    const ipParts = ip.split('.');
    if (ipParts.length === 4) {
      gatewayPlaceholder = `${ipParts[0]}.${ipParts[1]}.${ipParts[2]}.254`;
    }
  }
  actions.push({ id: 'wan-gateway', type: 'input', label: `WAN Gateway`, placeholder: gatewayPlaceholder || 'Ej: 10.100.0.254', payload: 'wan set gateway {input}' });
  actions.push({ id: 'wan-dns1', type: 'input', label: `WAN DNS1`, placeholder: collected.dns1 || '8.8.8.8', payload: 'wan set dns1 {input}' });
  actions.push({ id: 'wan-dns2', type: 'input', label: `WAN DNS2`, placeholder: collected.dns2 || '8.8.4.4', payload: 'wan set dns2 {input}' });
  actions.push({ id: 'wan-apply', type: 'button', label: 'Autorizar WAN estático ahora', payload: 'wan apply' });
  return actions;
}

// Endpoint: iniciar autorización SmartOLT (devuelve formulario con acciones)
export async function initiateAuth(req: any, res: any) {
  const session = req.session as any;
  const userId = session?.userId;
  if (!userId) return res.status(401).json({ error: 'unauthenticated' });

  try {
    const defaults = (req.body?.defaults && typeof req.body.defaults === 'object') ? req.body.defaults : {};
    const serviceIdOrTerm = req.body?.serviceIdOrTerm;

    const state = {
      defaults,
      collected: buildPrefilledAuth(defaults),
    } as any;

    const section = await applyOltAndNetworkToState(state, serviceIdOrTerm);
    const actions = buildAuthActions(state);
    const assistantMetadata = {
      smartoltAvailability: {
        olts: section.oltAvailability || [],
        suggestedVlan: section.suggestedVlan,
        suggestedZone: section.suggestedZone,
        suggestedDownload: section.suggestedDownload,
        suggestedUpload: section.suggestedUpload
      },
      smartoltOdbs: section.odbs,
      smartoltZones: section.zones
    };

    session.pendingAuth = state;
    return res.json({ ok: true, message: section.text, actions, metadata: assistantMetadata });
  } catch (e: any) {
    const errMsg = e?.message || 'Failed to initiate auth';
    return res.status(500).json({ ok: false, error: errMsg });
  }
}

// Endpoint: iniciar seteo de WAN estático (devuelve formulario con acciones)
export async function initiateWan(req: any, res: any) {
  const session = req.session as any;
  const userId = session?.userId;
  if (!userId) return res.status(401).json({ error: 'unauthenticated' });

  try {
    const collected = { ...(session?.pendingAuth?.collected || {}), ...(req.body || {}) } as Record<string, any>;
    const actions = buildWanActions(collected);
    session.pendingWan = collected;
    return res.json({ ok: true, message: 'Completa los datos para configurar WAN estático.', actions });
  } catch (e: any) {
    const errMsg = e?.message || 'Failed to initiate WAN';
    return res.status(500).json({ ok: false, error: errMsg });
  }
}

async function ensurePendingAuthFromInstallation(session: any, inst: any): Promise<{ text: string; actions: any[]; assistantMetadata: Record<string, any> }>
{
  const defaults = defaultsFromInstallation(inst);
  session.pendingAuth = {
    installationId: inst.id,
    collected: buildPrefilledAuth(defaults),
    defaults
  };
  const section = await applyOltAndNetworkToState(session.pendingAuth, inst.id_servicio ?? (inst.servicio ?? undefined), { skipZonesFetch: true });
  const assistantMetadata = {
    smartoltAvailability: {
      olts: section.oltAvailability || [],
      suggestedVlan: section.suggestedVlan,
      suggestedZone: section.suggestedZone,
      suggestedDownload: section.suggestedDownload,
      suggestedUpload: section.suggestedUpload
    },
    smartoltOdbs: section.odbs,
    smartoltZones: section.zones
  };
  return {
    text: section.text,
    actions: section.actions,
    assistantMetadata
  };
}

async function ensurePendingAuthFromClient(session: any, c: any): Promise<{ section: any; assistantMetadata: Record<string, any> }>
{
  const defaults = defaultsFromClient(c);
  session.pendingAuth = {
    clientIdServicio: c.id_servicio,
    collected: buildPrefilledAuth(defaults),
    defaults
  };
  const section = await applyOltAndNetworkToState(session.pendingAuth, c.id_servicio);
  const assistantMetadata = {
    smartoltAvailability: {
      olts: section.oltAvailability || [],
      suggestedVlan: section.suggestedVlan,
      suggestedZone: section.suggestedZone,
      suggestedDownload: section.suggestedDownload,
      suggestedUpload: section.suggestedUpload
    },
    smartoltOdbs: section.odbs,
    smartoltZones: section.zones
  };
  return { section, assistantMetadata };
}

async function buildOltListSection(): Promise<{
  text: string;
  actions: Array<{ id: string; type: 'button'; label: string; payload: string }>;
  olts?: OltInfo[];
}> {
  try {
    const rawOlts = await cacheGet('listOlts', 60, async () => await listOlts());
    const unique = new Map<string, OltInfo>();
    (rawOlts || []).forEach((o: OltInfo) => {
      const key = String(o.id);
      if (!unique.has(key)) unique.set(key, o);
    });
    const olts = Array.from(unique.values());

    if (!olts || olts.length === 0) {
      return {
        text: 'No recibí OLTs disponibles desde SmartOLT. Ingresa el ID manualmente.',
        actions: [],
        olts: []
      };
    }

    const limited = olts.slice(0, 12);
    const listText = limited.map((o, idx) => `${idx + 1}. ${o.name || 'OLT'} [${o.id}]${o.ip ? ` (${o.ip})` : ''}`).join('\n');
    const actions = limited.slice(0, 8).map((o) => ({
      id: `select-olt-${o.id}`,
      type: 'button' as const,
      label: `${o.name || 'OLT'} [${o.id}]`,
      payload: `auth set olt_id ${o.id}`,
    }));

    return {
      text: `OLTs disponibles desde SmartOLT (muestra hasta ${limited.length}):\n${listText}\nSelecciona una para predefinir el destino antes de llenar el formulario.`,
      actions,
      olts: limited,
    };
  } catch (error) {
    console.error('No se pudo obtener la lista de OLTs', error);
    return {
      text: 'No pude obtener la lista de OLTs (SmartOLT no respondió). Ingresa el OLT ID manualmente.',
      actions: [],
    };
  }
}

function pickFirstString(values: Array<any>): string | undefined {
  for (const v of values) {
    if (v === undefined || v === null) continue;
    const s = String(v).trim();
    if (s) return s;
  }
  return undefined;
}

function normalizeSpeedProfileName(val: any): string | undefined {
  const raw = val === undefined || val === null ? '' : String(val).trim();
  if (!raw) return undefined;
  const match = raw.match(/(\d+(?:\.\d+)?)/);
  if (!match) return raw;
  const num = match[1].replace(/\.0+$/, '');
  return `${num}M`;
}

function normalizeVlanValues(values: any): string[] {
  if (!Array.isArray(values)) return [];
  const out: string[] = [];
  for (const v of values) {
    let candidate: any = v;
    if (v && typeof v === 'object') {
      const id = (v as any).vlan_id ?? (v as any).vlan ?? (v as any).id ?? (v as any).value ?? (v as any).pon_vlan?.vlan_id;
      const name = (v as any).name ?? (v as any).description ?? (v as any).label ?? (v as any).vlan_name;
      if (id && name) {
        candidate = `${id} - ${name}`;
      } else {
        candidate = id ?? name;
      }
    }
    const s = String(candidate ?? '').trim();
    if (s) out.push(s);
  }
  return Array.from(new Set(out));
}

async function hydrateZonesAndOdbs(state: any, zoneFilter?: string) {
  const existingOdbs: Array<{ id?: string; name?: string; zone?: string }> = Array.isArray(state.smartoltOdbs)
    ? state.smartoltOdbs
    : [];
  try {
    const zoneRepo = AppDataSource.getRepository(SmartoltZone);
    const odbRepo = AppDataSource.getRepository(SmartoltOdb);
    const zoneRows = await cacheGet('dbZones', 300, async () => await zoneRepo.find({ order: { name: 'ASC' } }));
    const zones = (zoneRows || []).map((z: any) => (z.name || '').toString().trim()).filter(Boolean);

    const odbQuery = odbRepo
      .createQueryBuilder('odb')
      .leftJoinAndSelect('odb.zone', 'zone')
      .orderBy('zone.name', 'ASC')
      .addOrderBy('odb.name', 'ASC');

    if (zoneFilter) {
      odbQuery.where('LOWER(zone.name) LIKE :zf', { zf: `%${zoneFilter.toLowerCase()}%` });
    }

    const odbRows = await cacheGet(
      `dbOdbs:${(zoneFilter || '').toLowerCase()}`,
      300,
      async () => await odbQuery.getMany()
    );

    const odbsFromDb = odbRows
      .map((o) => ({
        id: o.externalId || String(o.id),
        name: o.name || '',
        zone: o.zone?.name || ''
      }))
      .filter((o) => o.name);

    const mergedMap = new Map<string, { id?: string; name?: string; zone?: string }>();
    const addToMerged = (list: Array<{ id?: string; name?: string; zone?: string }>) => {
      list.forEach((o) => {
        const key = `${(o.id || o.name || '').toString().toLowerCase()}`;
        if (!key) return;
        if (!mergedMap.has(key)) mergedMap.set(key, o);
      });
    };

    addToMerged(existingOdbs);
    addToMerged(odbsFromDb);

    if (mergedMap.size === 0) {
      try {
        const apiOdbs = await cacheGet('smartolt_odbs', 300, async () => await getOdbs());
        addToMerged(
          (apiOdbs || []).map((o: any) => ({
            id: o.id || o.name,
            name: o.name || o.id || '',
            zone: o.zone || ''
          }))
        );
      } catch (apiErr) {
        console.error('No se pudo obtener ODBs desde SmartOLT', apiErr);
      }
    }

    const zoneFilterLower = (zoneFilter || '').toLowerCase();
    const mergedList = Array.from(mergedMap.values());
    const filteredByZone = mergedList.filter((o) => {
      if (!zoneFilterLower) return true;
      const haystack = `${o.name || ''} ${o.id || ''} ${o.zone || ''}`.toLowerCase();
      return haystack.includes(zoneFilterLower);
    });

    if (zones.length) state.smartoltZones = zones;
    state.smartoltOdbs = filteredByZone.length ? filteredByZone : mergedList;
  } catch (err) {
    console.error('No se pudo hidratar zonas/ODBs desde BD', err);
  }
}

async function buildOltAndNetworkSection(serviceId?: number | string, opts?: { skipZonesFetch?: boolean }): Promise<{
  text: string;
  actions: Array<{ id: string; type: 'button'; label: string; payload: string }>;
  suggestedVlan?: string;
  suggestedZone?: string;
  zones: string[];
  vlansByOlt: Record<string, string[]>;
  odbs: Array<{ id?: string; name?: string }>;
  suggestedDownload?: string;
  suggestedUpload?: string;
  onuTypesByPon: Record<string, string[]>;
  oltAvailability: Array<{
    oltId: string;
    oltName?: string;
    availableCount: number;
    onus: Array<{
      id: string;
      label: string;
      ponType?: string;
      port?: string;
      model?: string;
      actionPayload: string;
    }>;
  }>;
}> {
  const skipZones = !!opts?.skipZonesFetch;

  const [oltSection, serviceData, zonesData, odbData, gponOnuTypes, eponOnuTypes] = await Promise.all([
    buildOltListSection(),
    // Para evitar llamadas innecesarias y errores 404 en SmartOLT,
    // ya no consultamos detalles de servicio aquí.
    Promise.resolve(null),
    skipZones
      ? Promise.resolve([] as any[])
      : cacheGet('smartolt_zones', 300, async () => {
          try {
            return await getZones();
          } catch (err) {
            console.error('No se pudo obtener las zonas de SmartOLT', err);
            return [] as any[];
          }
        }),
    cacheGet('smartolt_odbs', 300, async () => {
      try {
        return await getOdbs();
      } catch (err) {
        console.error('No se pudo obtener ODBs de SmartOLT', err);
        return [] as any[];
      }
    }),
    cacheGet('onuTypes:gpon', 300, async () => {
      try {
        return await getOnuTypesByPonType('gpon');
      } catch (err) {
        console.error('No se pudo obtener ONU types GPON', err);
        return [] as string[];
      }
    }),
    cacheGet('onuTypes:epon', 300, async () => {
      try {
        return await getOnuTypesByPonType('epon');
      } catch (err) {
        console.error('No se pudo obtener ONU types EPON', err);
        return [] as string[];
      }
    })
  ]);

  const zones = Array.isArray(zonesData) ? zonesData : [];
  const zoneNames = zones.map((z: any) => z.name || z.id).filter(Boolean);
  const odbs = Array.isArray(odbData) ? odbData : [];
  const onuTypesByPon: Record<string, string[]> = {
    ...(Array.isArray(gponOnuTypes) ? { gpon: gponOnuTypes } : {}),
    ...(Array.isArray(eponOnuTypes) ? { epon: eponOnuTypes } : {}),
  };

  const vlanMap = new Map<string, string[]>();

  const oltsForVlans = (oltSection.olts || []).slice(0, 3);
  const vlanResults = await Promise.all(
    oltsForVlans.map(async (o) => {
      try {
        const vlanList = await cacheGet(`oltVlans:${o.id}`, 60, async () => await getOltVlans(o.id));
        return { olt: o, vlans: normalizeVlanValues(vlanList as any) };
      } catch (err) {
        console.error(`No se pudo obtener VLANs para OLT ${o.id}`, err);
        return { olt: o, vlans: [] as string[] };
      }
    })
  );

  vlanResults.forEach((r) => vlanMap.set(String(r.olt.id), r.vlans));
  let onuResults: Array<{ olt: OltInfo; onus: SmartOltOnu[] }> = [];

  // Nuevo enfoque: obtener todas las ONUs sin autorizar de una sola vez
  // desde SmartOLT y luego agruparlas por OLT. Así evitamos hacer muchas
  // llamadas por cada OLT y reducimos el riesgo de errores masivos.
  try {
    const allUnconfigured = await cacheGet('smartolt_unconfigured_onus_global', 60, async () => {
      return await listGlobalUnconfiguredOnus();
    });

    const byOlt = new Map<string, SmartOltOnu[]>();
    (allUnconfigured || []).forEach((o: SmartOltOnu) => {
      const oltKey = String(o.olt_id ?? '');
      if (!oltKey) return;
      if (!byOlt.has(oltKey)) byOlt.set(oltKey, []);
      byOlt.get(oltKey)!.push(o);
    });

    onuResults = (oltSection.olts || []).map((olt) => ({
      olt,
      onus: byOlt.get(String(olt.id)) || []
    })).filter((entry) => entry.onus.length > 0);
  } catch (err) {
    console.error('No se pudo obtener ONUs sin autorizar desde SmartOLT', err);
    onuResults = [];
  }

  const service: any = {};
  const vlanCandidates: any[] = [];
  const zoneCandidates: any[] = [...zoneNames];

  const downloadCandidates: any[] = [];
  const uploadCandidates: any[] = [];

  const vlanFromOltLists = vlanResults.flatMap((r) => r.vlans);
  const suggestedVlan = pickFirstString([...vlanCandidates, ...vlanFromOltLists]);
  const suggestedZone = pickFirstString(zoneCandidates);
  const suggestedDownload = pickFirstString(downloadCandidates);
  const suggestedUpload = pickFirstString(uploadCandidates);

  const onuActions: Array<{ id: string; type: 'button'; label: string; payload: string }> = [];
  const oltRows: Array<{ olt: OltInfo; available: SmartOltOnu[]; vlans: string[] }> = [];
  const oltAvailability: Array<{
    oltId: string;
    oltName?: string;
    availableCount: number;
    onus: Array<{
      id: string;
      label: string;
      ponType?: string;
      port?: string;
      model?: string;
      actionPayload: string;
    }>;
  }> = [];

  for (const entry of onuResults) {
    const seenOnuIds = new Set<string>();
    const available = (entry.onus || []).filter((o: SmartOltOnu) => {
      const state = (o.status || (o as any).state || '').toString().toLowerCase();
      const idKey = pickFirstString([o.sn, o.serial, o.onu_sn, o.mac, o.mac_address]) || '';
      if (idKey && seenOnuIds.has(idKey)) return false;
      if (idKey) seenOnuIds.add(idKey);
      return !state || state.includes('free') || state.includes('available') || state.includes('libre');
    });
    if (!available.length) continue;

    const availabilityEntry = {
      oltId: String(entry.olt.id),
      oltName: entry.olt.name || 'OLT',
      availableCount: available.length,
      onus: [] as Array<{
        id: string;
        label: string;
        ponType?: string;
        port?: string;
        model?: string;
        actionPayload: string;
      }>
    };

    available.slice(0, 8).forEach((o: SmartOltOnu, idx: number) => {
      const id = pickFirstString([o.sn, o.serial, o.onu_sn, o.mac, o.mac_address]) || `ONU${idx + 1}`;
      const port = pickFirstString([o.port, o.port_id, o.slot]) || '-';
      const model = pickFirstString([
        (o as any).onu_type_name,
        o.onu_type,
        o.model
      ]) || '-';
      const pon = (pickFirstString([o.pon_type]) || 'gpon').toLowerCase();
      const label = `${id}`;
      const payload = `seleccionar onu ${id} olt ${entry.olt.id} pon ${pon} port ${port}${model !== '-' ? ` model ${model}` : ''}`;

      onuActions.push({
        id: `select-onu-${entry.olt.id}-${idx}`,
        type: 'button',
        label,
        payload
      });

      availabilityEntry.onus.push({
        id,
        label,
        ponType: pon,
        port: port === '-' ? undefined : port,
        model: model === '-' ? undefined : model,
        actionPayload: payload
      });
    });

    oltAvailability.push(availabilityEntry);
    oltRows.push({ olt: entry.olt, available, vlans: vlanMap.get(String(entry.olt.id)) || [] });
  }

  const tableLines = oltRows.map((row, idx) => {
    return `${idx + 1}. ${row.olt.name || 'OLT'} [${row.olt.id}] · ONUs libres: ${row.available.length}`;
  });

  const zonesText = zoneNames.length ? `Zonas SmartOLT: ${zoneNames.slice(0, 12).join(', ')}` : '';
  const serviceZoneText = suggestedZone ? `Zona sugerida: ${suggestedZone}` : '';

  const parts = [zonesText, serviceZoneText].filter(Boolean);
  if (serviceZoneText) parts.push(serviceZoneText);
  if (tableLines.length) {
  } else {
    parts.push('No encontré ONUs libres en las OLTs obtenidas. Ingresa manualmente los datos de la OLT/ONU.');
  }

  return {
    text: parts.filter(Boolean).join('\n'),
    actions: onuActions,
    suggestedVlan,
    suggestedZone,
    zones: zoneNames,
    vlansByOlt: Object.fromEntries(vlanMap),
    odbs,
    suggestedDownload,
    suggestedUpload,
    onuTypesByPon,
    oltAvailability
  };
}
=======
>>>>>>> parent of d0c9887 (feat: add Wisphub client and installation services with full sync capabilities)

export async function addMessage(req: any, res: any) {
  const session = req.session as any;
  const userId = session?.userId;
  if (!userId) return res.status(401).json({ error: 'unauthenticated' });

  const { role, content, imageDataUrl } = req.body as {
    role?: 'user' | 'assistant';
    content?: string;
    imageDataUrl?: string;
  };

  if (!role) return res.status(400).json({ error: 'role required' });
  if (!content && !imageDataUrl) {
    return res.status(400).json({ error: 'content or imageDataUrl required' });
  }

  const repo = AppDataSource.getRepository(ChatMessage);
  let imageUrl: string | null = null;

  if (imageDataUrl && typeof imageDataUrl === 'string') {
    try {
      const matches = imageDataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
      if (matches) {
        const mimeType = matches[1];
        const base64Data = matches[2];

        const ext = mimeType.split('/')[1] || 'png';
        const fileName = `chat_${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`;
        const uploadDir = path.join(process.cwd(), 'uploads', 'chat');

        fs.mkdirSync(uploadDir, { recursive: true });
        const filePath = path.join(uploadDir, fileName);
        fs.writeFileSync(filePath, Buffer.from(base64Data, 'base64'));

        imageUrl = `/uploads/chat/${fileName}`;
      }
    } catch (err) {
      console.error('Failed to store chat image', err);
    }
  }

  const message = repo.create({
    userId: Number(userId),
    role,
    content: content ?? (imageUrl ? '[Imagen enviada]' : ''),
    imageUrl: imageUrl ?? undefined,
  });
  await repo.save(message);

  return res.json({ ok: true, id: message.id, createdAt: message.createdAt, imageUrl: message.imageUrl });
}

export async function listUserMessages(req: any, res: any) {
  const { userId } = req.params;
  if (!userId) return res.status(400).json({ error: 'userId required' });

  const repo = AppDataSource.getRepository(ChatMessage);
  const messages = await repo.find({
    where: { userId: Number(userId) },
    order: { createdAt: 'ASC' },
  });

  return res.json({ messages });
}
<<<<<<< HEAD

export async function respond(req: any, res: any) {
  const session = req.session as any;
  const userId = session?.userId;
  if (!userId) return res.status(401).json({ error: 'unauthenticated' });

  const { content, imageDataUrl } = req.body as {
    content?: string;
    imageDataUrl?: string;
  };

  if (!content && !imageDataUrl) {
    return res.status(400).json({ error: 'content or imageDataUrl required' });
  }

  const repo = AppDataSource.getRepository(ChatMessage);
  const imageUrl: string | null = saveImageDataUrl(imageDataUrl);

  // Store user message
  // Ensure session n8n id exists and store it in message metadata
  if (session && !session.n8nSessionId) session.n8nSessionId = randomUUID();
  const userMsg = repo.create({
    userId: Number(userId),
    role: 'user',
    content: content ?? (imageUrl ? '[Imagen enviada]' : ''),
    imageUrl: imageUrl ?? undefined,
    metadata: { ...(undefined as any), ...(session?.n8nSessionId ? { sessionId: String(session.n8nSessionId) } : {}) } as any,
  });
  await repo.save(userMsg);

  // Build assistant response
  const prompt = content || (imageUrl ? 'Foto enviada' : '');
  const promptText = content || (imageUrl ? 'Foto enviada' : '');
  let finalContent = '';
  let actionsOut: any[] = [];
  let assistantMetadata: Record<string, any> | null = null;

  // Prefer n8n workflow if configured; fallback to local simpleBot
  if (N8N.chatWebhook || N8N.baseUrl) {
    try {
      const prev = await repo.find({ where: { userId: Number(userId) }, order: { createdAt: 'ASC' }, take: 10 });
      const messages = prev.map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content, imageUrl: m.imageUrl ?? null }));
      if (session && !session.n8nSessionId) session.n8nSessionId = randomUUID();
      const out = await runChatWorkflow({ userId: Number(userId), content: promptText, imageUrl, messages, sessionId: session?.n8nSessionId });
      finalContent = out.content || '';
      actionsOut = Array.isArray(out.actions) ? out.actions : [];
      assistantMetadata = out.metadata ?? null;
    } catch (e: any) {
      // Fallback on error
      const structured = buildStructuredResponse(promptText);
      finalContent = structured.content;
      actionsOut = structured.actions as any[];
    }
  } else {
    const structured = buildStructuredResponse(promptText);
    finalContent = structured.content;
    actionsOut = structured.actions as any[];
  }
  // Persist assistant message and return
  const assistantMsg = repo.create({
    userId: Number(userId),
    role: 'assistant',
    content: finalContent,
    actions: actionsOut,
    metadata: (() => {
      const m = assistantMetadata && typeof assistantMetadata === 'object' ? { ...assistantMetadata } : {};
      if (session?.n8nSessionId) m.sessionId = String(session.n8nSessionId);
      return Object.keys(m).length ? m : undefined;
    })(),
  });
  await repo.save(assistantMsg);

  return res.json({
    ok: true,
    userMessage: {
      id: userMsg.id,
      role: userMsg.role,
      content: userMsg.content,
      imageUrl: userMsg.imageUrl ?? null,
      createdAt: userMsg.createdAt,
    },
    assistantMessage: {
      id: assistantMsg.id,
      role: assistantMsg.role,
      content: assistantMsg.content,
      actions: assistantMsg.actions ?? [],
      createdAt: assistantMsg.createdAt,
      metadata: assistantMsg.metadata ?? null,
    },
  });
}

/* Legacy chat logic below is disabled when n8n is enabled
  let assistantMetadata: Record<string, any> | null = null;

  const setSmartoltMetadata = (metadata: any) => {
    if (!metadata) return;
    assistantMetadata = {
      ...(assistantMetadata || {}),
      ...metadata
    };
  };

  // If the prompt requests WispHub data, prefer DB search first and refresh if empty
  let finalContent = structured.content;
  try {
    const lower = prompt.toLowerCase();
    // search by numeric document if present
    const docMatch = prompt.match(/\b(\d{6,20})\b/);
    const nameQueryMatch = prompt.match(/buscar\s+cliente\s+(.+)/i);
    if (lower.includes('buscar cliente') || lower.includes('buscar por documento') || docMatch) {
      const term = docMatch ? docMatch[1] : (nameQueryMatch ? nameQueryMatch[1].trim() : prompt.trim());
      let [clientResults, installationResults] = await Promise.all([
        searchLocal(String(term), 15),
        searchLocalInstallations(String(term), 10)
      ]);
      let refreshed = false;
      if ((clientResults?.length || 0) + (installationResults?.length || 0) === 0) {
        await Promise.all([
          refreshClientsByTerm(String(term)).catch(() => 0),
          refreshInstallationsByTerm(String(term)).catch(() => 0)
        ]);
        [clientResults, installationResults] = await Promise.all([
          searchLocal(String(term), 15),
          searchLocalInstallations(String(term), 10)
        ]);
        refreshed = true;
      }
      if ((clientResults?.length || 0) + (installationResults?.length || 0) === 0) {
        await Promise.all([
          fullSyncClients().catch(() => {}),
          fullSyncInstallations(150, 4).catch(() => {})
        ]);
        [clientResults, installationResults] = await Promise.all([
          searchLocal(String(term), 15),
          searchLocalInstallations(String(term), 10)
        ]);
        refreshed = true;
      }
      (req.session as any).lastContextType = 'clients-installations';
      (req.session as any).lastSearchTerm = String(term);
      const modeActions = [
        { id: 'search-mode-installation', type: 'button', label: 'Buscar para instalación', payload: 'modo busqueda instalacion' },
        { id: 'search-mode-general', type: 'button', label: 'Buscar cliente (general)', payload: 'modo busqueda general' }
      ];
      const clientLines = (clientResults || []).map((c: any, i: number) => `${i + 1}. ${((c.nombre || '') + ' ' + (c.apellidos || '')).trim()} — ${c.cedula || 'sin documento'} [${c.id_servicio}]`);
      const instLines = (installationResults || []).map((it: any, i: number) => `${i + 1}. Instalación [${it.id_servicio || it.id}] ${it.nombre || ''} ${it.apellidos || ''} — ${it.estado_instalacion || 'pendiente'}`);
      const clientActions = (clientResults || []).slice(0, 10).map((c: any) => ({
        id: `select-client-${c.id_servicio}`,
        type: 'button',
        label: `${c.nombre || ''} ${c.apellidos || ''} [${c.id_servicio}]`,
        payload: `seleccionar cliente ${c.id_servicio}`
      }));
      const installationActions = (installationResults || []).slice(0, 10).map((it: any) => ({
        id: `select-installation-${it.id || it.id_servicio}`,
        type: 'button',
        label: `${it.nombre || ''} ${it.apellidos || ''} [${it.id || it.id_servicio}]`,
        payload: `seleccionar instalación ${it.id || it.id_servicio}`
      }));
      if ((clientLines.length + instLines.length) > 0) {
        const parts: string[] = [];
        if (clientLines.length) parts.push(`Clientes encontrados (nombre/documento):\n${clientLines.join('\n')}`);
        if (instLines.length) parts.push(`Instalaciones asociadas encontradas:\n${instLines.join('\n')}`);
        finalContent = `${parts.join('\n\n')}\n\nElige un modo y selecciona un registro.`;
        actionsOut = [...modeActions, ...clientActions, ...installationActions];
      } else {
        const syncMsg = refreshed ? 'Ya actualicé con WispHub' : 'Intentaré actualizar con WispHub';
        finalContent = `${syncMsg}, pero no hay resultados para "${term}". Prueba con otro nombre o documento.`;
        actionsOut = [...modeActions];
      }
    } else if (lower.includes('instalaciones pendientes') || lower.includes('iniciar instalacion') || lower.includes('iniciar instalación')) {
      // Show pending installations
      const items = await listPendingLocalInstallations(20);
      if (!items || items.length === 0) {
        // try a short background refresh without specific term
        await fullSyncInstallations(100, 3).catch(() => {});
      }
      (req.session as any).lastContextType = 'installations';
      (req.session as any).lastSearchTerm = '';
      const list = (items || []).map((it: any) => `- [${it.id_servicio || it.id}] ${it.nombre || ''} ${it.apellidos || ''} — ${it.estado_instalacion || 'pendiente'}`);
      if (list.length > 0) {
        finalContent = `Instalaciones pendientes (selecciona una):\n${list.join('\n')}\n`;
        actionsOut = (items || []).slice(0, 10).map((it: any) => ({
          id: `select-installation-${it.id}`,
          type: 'button',
          label: `${it.nombre || ''} ${it.apellidos || ''} [${it.id}]`,
          payload: `seleccionar instalación ${it.id}`
        }));
      } else {
        finalContent = `Actualiza la lista de instalaciones pendientes`;
      }
    } else if (/^autorizar(\s+instalacion|\s+instalación)?$/i.test(lower)) {
      // Usar última selección (cliente o instalación) para iniciar autorización
      const lastInstId = (req.session as any).lastSelectedInstallationId;
      const lastClientId = (req.session as any).lastSelectedClientIdServicio;
      if (lastInstId) {
        const repoInst = AppDataSource.getRepository((await import('../models/Installation')).Installation);
        const inst = await repoInst.findOne({ where: { id: Number(lastInstId) } });
        if (inst) {
          const summary = buildInstallationSummary(inst);
          const { text, actions, assistantMetadata: meta } = await ensurePendingAuthFromInstallation((req.session as any), inst);
          setSmartoltMetadata(meta);
          finalContent = `Usando la última instalación seleccionada:\n${summary}\n\n${text}\n\nSelecciona una ONU disponible para continuar. Luego podrás completar el formulario.`;
          actionsOut = actions;
        } else {
          finalContent = 'No hay una instalación previamente seleccionada. Busca y selecciona una primero.';
        }
      } else if (lastClientId) {
        const repoClient = AppDataSource.getRepository((await import('../models/Client')).Client);
        const c = await repoClient.findOne({ where: { id_servicio: Number(lastClientId) } });
        if (c) {
          const summary = buildClientSummary(c);
          const sessionDefaults = defaultsFromClient(c);
          (req.session as any).pendingAuth = {
            clientIdServicio: c.id_servicio,
            collected: buildPrefilledAuth(sessionDefaults),
            defaults: sessionDefaults
          };
          await hydrateZonesAndOdbs((req.session as any).pendingAuth, sessionDefaults.zone);
          finalContent = `Usando el último cliente seleccionado:\n${summary}\n\nPrellené los datos conocidos (SN, nombre, zona, dirección). Completa lo faltante para autorizar en SmartOLT.`;
          actionsOut = [
            { id: 'auth-olt_id', type: 'input', label: 'OLT ID', helperText: 'ID numérico de la OLT destino', payload: 'auth set olt_id {input}' },
            { id: 'auth-pon_type', type: 'input', label: 'PON type (gpon/epon)', placeholder: 'gpon', helperText: 'Tipo de PON: gpon o epon', options: ['gpon', 'epon'], payload: 'auth set pon_type {input}' },
            { id: 'auth-board', type: 'input', label: 'Board (opcional)', placeholder: 'Ej: 2', payload: 'auth set board {input}' },
            { id: 'auth-port', type: 'input', label: 'Port (opcional)', placeholder: 'Ej: 3', payload: 'auth set port {input}' },
            { id: 'auth-sn', type: 'input', label: `SN/MAC de la ONU${sessionDefaults.sn ? ` (sugerido: ${sessionDefaults.sn})` : ''}`, placeholder: sessionDefaults.sn || 'Ej: ZTEGC7E230E4', payload: 'auth set sn {input}' },
            { id: 'auth-onu_type', type: 'input', label: 'ONU Type', placeholder: 'Ej: ZTE-F660V6.0', payload: 'auth set onu_type {input}' },
            { id: 'auth-onu_mode', type: 'input', label: ' (Routing/Bridging)', placeholder: 'Routing', payload: 'auth set onu_mode {input}' },
            { id: 'auth-vlan', type: 'input', label: 'VLAN (opcional)', placeholder: 'Ej: 100', payload: 'auth set vlan {input}' },
            { id: 'auth-zone', type: 'input', label: `Zona${sessionDefaults.zone ? ` (sugerido: ${sessionDefaults.zone})` : ''}`, placeholder: sessionDefaults.zone || 'Ciudad o zona', payload: 'auth set zone {input}' },
            { id: 'auth-name', type: 'input', label: `Nombre cliente${sessionDefaults.name ? ` (sugerido: ${sessionDefaults.name})` : ''}`, placeholder: sessionDefaults.name || 'Nombre y Apellido', payload: 'auth set name {input}' },
            { id: 'auth-address', type: 'input', label: 'Dirección/Comentario/Etiqueta Roja (opcional)', placeholder: sessionDefaults.address_or_comment || 'Dirección de instalación', payload: 'auth set address_or_comment {input}' },
            { id: 'auth-submit', type: 'button', label: 'Autorizar SmartOLT ahora', payload: 'auth submit' }
          ];
        } else {
          finalContent = 'No hay un cliente previamente seleccionado. Busca y selecciona uno primero.';
        }
      } else {
        finalContent = 'No hay selección previa. Usa "instalaciones pendientes" o "buscar cliente ..." para elegir y luego autorizar.';
      }
    } else if (/^(autorizar(\s+cliente|\s+instalación)?)\s+.+/i.test(lower)) {
      // Authorize by free text term: try to find installation by term (name/id_servicio)
      const term = prompt.replace(/^(autorizar)(\s+cliente|\s+instalación)?\s+/i, '').trim();
      let results = await searchLocalInstallations(term, 5);
      if (!results || results.length === 0) {
        await refreshInstallationsByTerm(term);
        results = await searchLocalInstallations(term, 5);
      }
      if (!results || results.length === 0) {
        finalContent = `No encontré instalaciones para "${term}". Intenta con otro nombre o documento.`;
      } else if (results.length === 1) {
        const inst = results[0];
        const { text, actions, assistantMetadata: meta } = await ensurePendingAuthFromInstallation((req.session as any), inst);
        setSmartoltMetadata(meta);
        finalContent = `Instalación seleccionada: [${inst.id}] ${inst.nombre || ''} ${inst.apellidos || ''}.\n${text}\n\nSelecciona una ONU disponible para continuar. Luego podrás completar el formulario.`;
        actionsOut = actions;
      } else {
        const lines = results.map((it: any) => `- [${it.id}] ${it.nombre || ''} ${it.apellidos || ''}`);
        finalContent = `Se encontraron varias coincidencias, selecciona una:\n${lines.join('\n')}`;
        actionsOut = results.slice(0, 10).map((it: any) => ({ id: `select-installation-${it.id}`, type: 'button', label: `${it.nombre || ''} ${it.apellidos || ''} [${it.id}]`, payload: `seleccionar instalación ${it.id}` }));
      }
    } else if (/^modo\s+b(usqueda|úsqueda)\s+instalacion$/i.test(lower)) {
      (req.session as any).searchMode = 'installation';
      const lastTerm = ((req.session as any).lastSearchTerm || '').toString().trim();
      (req.session as any).lastContextType = 'installations';
      if (lastTerm) {
        let instResults = await searchLocalInstallations(String(lastTerm), 10);
        if (!instResults || instResults.length === 0) {
          await refreshInstallationsByTerm(String(lastTerm));
          instResults = await searchLocalInstallations(String(lastTerm), 10);
        }
        if (instResults && instResults.length > 0) {
          const lines = instResults.map((it: any) => `- [${it.id_servicio || it.id}] ${it.nombre || ''} ${it.apellidos || ''} — ${it.estado_instalacion || 'pendiente'}`);
          finalContent = `Instalaciones encontradas para "${lastTerm}":\n${lines.join('\n')}\n`;
          actionsOut = instResults.slice(0, 10).map((it: any) => ({ id: `select-installation-${it.id}`, type: 'button', label: `${it.nombre || ''} ${it.apellidos || ''} [${it.id}]`, payload: `seleccionar instalación ${it.id}` }));
        } else {
          const pending = await listPendingLocalInstallations(20);
          if (pending && pending.length > 0) {
            const list = pending.map((it: any) => `- [${it.id_servicio || it.id}] ${it.nombre || ''} ${it.apellidos || ''} — ${it.estado_instalacion || 'pendiente'}`);
            finalContent = `No hubo coincidencias para "${lastTerm}". Instalaciones pendientes:\n${list.join('\n')}\n`;
            actionsOut = pending.slice(0, 10).map((it: any) => ({ id: `select-installation-${it.id}`, type: 'button', label: `${it.nombre || ''} ${it.apellidos || ''} [${it.id}]`, payload: `seleccionar instalación ${it.id}` }));
          } else {
            finalContent = `No se encontraron instalaciones para "${lastTerm}".`;
          }
        }
      } else {
        const items = await listPendingLocalInstallations(20);
        if (items && items.length > 0) {
          const list = items.map((it: any) => `- [${it.id_servicio || it.id}] ${it.nombre || ''} ${it.apellidos || ''} — ${it.estado_instalacion || 'pendiente'}`);
          finalContent = `Modo instalación activado. Instalaciones pendientes:\n${list.join('\n')}\n`;
          actionsOut = items.slice(0, 10).map((it: any) => ({ id: `select-installation-${it.id}`, type: 'button', label: `${it.nombre || ''} ${it.apellidos || ''} [${it.id}]`, payload: `seleccionar instalación ${it.id}` }));
        } else {
          finalContent = 'Modo instalación activado. No hay instalaciones pendientes.';
        }
      }
    } else if (/^modo\s+b(usqueda|úsqueda)\s+general$/i.test(lower)) {
      (req.session as any).searchMode = 'general';
      finalContent = 'Modo de búsqueda seleccionado: general. Ahora selecciona un cliente de la lista.';
    } else if (/no\s+esta|no\s+está|no\s+lo\s+encuentro|no\s+encontré|actualiza|refresca/i.test(lower)) {
      // User indicates the item is not present; refresh the database and retry previous context
      const ctx = (req.session as any).lastContextType;
      const term = (req.session as any).lastSearchTerm || '';
      try {
        if (ctx === 'clients') {
          await fullSyncClients();
          const results = await searchLocal(String(term || ''), 15);
          if (results && results.length > 0) {
            const lines = results.map((c: any, i: number) => `${i + 1}. [${c.id_servicio}] ${c.nombre || ''} ${c.apellidos || ''} — ${c.direccion || ''} ${c.ciudad ? `(${c.ciudad})` : ''}`);
            finalContent = `BD actualizada. Clientes encontrados:\n${lines.join('\n')}\n`;
            actionsOut = results.slice(0, 10).map((c: any) => ({ id: `select-client-${c.id_servicio}`, type: 'button', label: `${c.nombre || ''} ${c.apellidos || ''} [${c.id_servicio}]`, payload: `seleccionar cliente ${c.id_servicio}` }));
          } else {
            finalContent = 'BD actualizada, pero no se encontraron clientes para ese término.';
          }
        } else if (ctx === 'installations') {
          await fullSyncInstallations();
          const items = await listPendingLocalInstallations(20);
          if (items && items.length > 0) {
            const list = items.map((it: any) => `- [${it.id}] ${it.nombre || ''} ${it.apellidos || ''} — ${it.estado_instalacion || 'pendiente'}`);
            finalContent = `BD actualizada. Instalaciones pendientes:\n${list.join('\n')}\n`;
            actionsOut = items.slice(0, 10).map((it: any) => ({ id: `select-installation-${it.id}`, type: 'button', label: `${it.nombre || ''} ${it.apellidos || ''} [${it.id}]`, payload: `seleccionar instalación ${it.id}` }));
          } else {
            finalContent = 'BD actualizada, no hay instalaciones pendientes.';
          }
        } else {
          finalContent = 'Indica si buscas clientes o instalaciones para actualizar la BD.';
          actionsOut = [
            { id: 'search-mode-installation', type: 'button', label: 'Actualizar instalaciones', payload: 'instalaciones pendientes' },
            { id: 'search-mode-general', type: 'button', label: 'Actualizar clientes', payload: 'buscar cliente {input}' }
          ];
        }
      } catch (e: any) {
        finalContent = 'Falló la actualización de la BD. Intenta nuevamente o verifica las credenciales.';
      }
    } else if (/^(seleccionar|select) instalación\s+\d+$/i.test(lower)) {
      // Select one installation by ID
      const idNum = Number(lower.replace(/^(seleccionar|select) instalación\s+/i, '').trim());
      const repoInst = AppDataSource.getRepository((await import('../models/Installation')).Installation);
      const inst = await repoInst.findOne({ where: { id: idNum } });
      if (!inst) {
        finalContent = `No encontré la instalación ${idNum}. Intenta actualizar la lista o buscar por nombre/RUT.`;
      } else {
        (req.session as any).lastSelectedInstallationId = inst.id;
        const summary = buildInstallationSummary(inst);
        const { text, actions } = await ensurePendingAuthFromInstallation((req.session as any), inst);
        finalContent = `Instalación seleccionada:\n${summary}\n\n${text}\n\nSelecciona una ONU disponible para continuar. Luego podrás completar el formulario.`;
        actionsOut = actions;
      }
    } else if (/^auth\s+search\s+zone\s+.+/i.test(lower)) {
      const state = (req.session as any).pendingAuth;
      if (!state || !state.smartoltZones) {
        finalContent = 'No tengo el listado de zonas de SmartOLT en memoria. Selecciona una instalación para refrescar.';
      } else {
        const term = prompt.replace(/^auth\s+search\s+zone\s+/i, '').trim().toLowerCase();
        const zones: string[] = state.smartoltZones || [];
        const matches = zones.filter((z: string) => z.toLowerCase().includes(term));
        if (!matches.length) {
          finalContent = `No encontré zonas que coincidan con "${term}".`;
        } else {
          finalContent = `Zonas encontradas (${matches.length}):\n${matches.slice(0, 12).join('\n')}`;
          actionsOut = matches.slice(0, 8).map((z, idx) => ({
            id: `set-zone-${idx}`,
            type: 'button',
            label: `Usar zona: ${z}`,
            payload: `auth set zone ${z}`
          }));
        }
      }
    } else if (/^auth\s+search\s+vlan\s+.+/i.test(lower)) {
      const state = (req.session as any).pendingAuth;
      if (!state || !state.smartoltVlans) {
        finalContent = 'No tengo VLANs de SmartOLT en memoria. Selecciona una instalación para refrescar.';
      } else {
        const term = prompt.replace(/^auth\s+search\s+vlan\s+/i, '').trim().toLowerCase();
        const vlanEntries: Array<{ oltId: string; vlan: string }> = [];
        Object.entries(state.smartoltVlans || {}).forEach(([oltId, vlans]: any) => {
          (vlans || []).forEach((v: string) => vlanEntries.push({ oltId, vlan: v }));
        });
        const matches = vlanEntries.filter((e) => e.vlan.toLowerCase().includes(term));
        if (!matches.length) {
          finalContent = `No encontré VLANs que coincidan con "${term}".`;
        } else {
          const lines = matches.slice(0, 12).map((e) => `VLAN ${e.vlan} (OLT ${e.oltId})`);
          finalContent = `VLANs encontradas (${matches.length}):\n${lines.join('\n')}`;
          actionsOut = matches.slice(0, 8).map((e, idx) => ({
            id: `set-vlan-${idx}`,
            type: 'button',
            label: `Usar VLAN ${e.vlan} (OLT ${e.oltId})`,
            payload: `auth set vlan ${e.vlan}`
          }));
        }
      }
    } else if (/^auth\s+set\s+[a-z_]+\s+.+/i.test(lower)) {
      // Store collected key=value in session
      const parts = prompt.split(/\s+/);
      const key = parts[2];
      const value = prompt.slice(prompt.toLowerCase().indexOf(key) + key.length).trim();
      const state = (req.session as any).pendingAuth;
      if (!state) {
        finalContent = 'No hay una autorización en progreso. Primero selecciona una instalación.';
      } else {
        // When delegating to n8n, skip backend pre-search/SmartOLT branching here.
            if (found) {
              state.collected.sn = pickFirstString([found.sn, found.serial, found.onu_sn, found.mac, found.mac_address]) || state.collected.sn;
              state.collected.onu_type =
                pickFirstString([
                  (found as any).onu_type_name,
                  found.onu_type,
                  found.model,
                  (found as any).onu_model,
                  (found as any).model_name,
                  (found as any).name,
                  (found as any).type
                ]) || state.collected.onu_type;
              state.collected.pon_type = state.collected.pon_type || pickFirstString([found.pon_type]) || 'gpon';
              state.collected.port = state.collected.port || pickFirstString([found.port, found.port_id, found.slot]);
              state.collected.board = state.collected.board || pickFirstString([(found as any).board]);
              // Intentar capturar identificador externo de ONU para usarlo luego en WAN
              const extId =
                (found as any).onu_external_id ||
                (found as any).external_id ||
                (found as any).onu_id ||
                (found as any).id ||
                undefined;
              if (extId && !state.collected.onu_external_id) {
                state.collected.onu_external_id = String(extId);
              }
            }
          } catch (err) {
            console.error('No se pudo completar datos de ONU seleccionada desde SmartOLT', err);
          }
        }

        const oltIdForVlans = state.collected.olt_id || (oltMatch ? oltMatch[1] : undefined);
        const ponTypeForOnuTypes = (state.collected.pon_type || (ponMatch ? ponMatch[1] : 'gpon')).toLowerCase();

        if (oltIdForVlans) {
          try {
            const vlanList = await getOltVlans(oltIdForVlans);
            const vlanValues = normalizeVlanValues(vlanList as any);
            state.smartoltVlans = {
              ...(state.smartoltVlans || {}),
              [String(oltIdForVlans)]: vlanValues
            };
          } catch (err) {
            console.error(`No se pudo refrescar VLANs para OLT ${oltIdForVlans}`, err);
          }
        }

        try {
          const onuTypes = await getOnuTypesByPonType(ponTypeForOnuTypes === 'epon' ? 'epon' : 'gpon');
          if (Array.isArray(onuTypes) && onuTypes.length) {
            state.smartoltOnuTypes = {
              ...(state.smartoltOnuTypes || {}),
              [ponTypeForOnuTypes]: onuTypes
            };
          }
          if (state.collected.onu_type) {
            const current = (state.smartoltOnuTypes?.[ponTypeForOnuTypes] || []).slice();
            if (!current.includes(state.collected.onu_type)) current.push(state.collected.onu_type);
            state.smartoltOnuTypes = {
              ...(state.smartoltOnuTypes || {}),
              [ponTypeForOnuTypes]: current
            };
          }
        } catch (err) {
          console.error(`No se pudo obtener ONU types para ${ponTypeForOnuTypes}`, err);
        }

        await hydrateZonesAndOdbs(state, state.collected.zone);

        finalContent = `ONU seleccionada${snMatch ? ` (${snMatch[1]})` : ''}.Completa o corrige los datos para autorizar la ONU.`;
        actionsOut = buildAuthActions(state);
      }
    } else if (lower.trim() === 'auth autofill') {
      const state = (req.session as any).pendingAuth;
      if (!state) {
        finalContent = 'No hay una autorización en progreso. Primero selecciona una instalación o cliente.';
      } else {
        const defaults = state.defaults || {};
        state.collected.pon_type = state.collected.pon_type || 'gpon';
        state.collected.onu_mode = state.collected.onu_mode || 'Routing';
        // Completar con valores conocidos si faltan
        if (!state.collected.sn && defaults.sn) state.collected.sn = defaults.sn;
        if (!state.collected.name && defaults.name) state.collected.name = defaults.name;
        if (!state.collected.zone && defaults.zone) state.collected.zone = defaults.zone;
        if (!state.collected.address_or_comment && defaults.address_or_comment) state.collected.address_or_comment = defaults.address_or_comment;
        if (!state.collected.download_speed_profile_name && defaults.download_speed_profile_name) {
          const norm = normalizeSpeedProfileName(defaults.download_speed_profile_name);
          if (norm) state.collected.download_speed_profile_name = norm;
        }
        if (!state.collected.upload_speed_profile_name && defaults.upload_speed_profile_name) {
          const norm = normalizeSpeedProfileName(defaults.upload_speed_profile_name);
          if (norm) state.collected.upload_speed_profile_name = norm;
        }
        finalContent = 'Se completaron valores sugeridos y los datos conocidos (SN, nombre, zona, dirección cuando existen). Revisa y autoriza o ajusta lo necesario.';
        actionsOut = buildAuthActions(state);
      }
    } else if (lower.trim() === 'auth submit') {
      const state = (req.session as any).pendingAuth;
      if (!state) {
        finalContent = 'No hay una autorización en progreso. Primero selecciona una instalación.';
      } else {
        const collected = state.collected || {};
        const defaults = state.defaults || {};
        // Unificar velocidad si solo hay un campo
        if (collected.auth_speed && (!collected.download_speed_profile_name && !collected.upload_speed_profile_name)) {
          collected.download_speed_profile_name = collected.auth_speed;
          collected.upload_speed_profile_name = collected.auth_speed;
        } else if (collected.download_speed_profile_name && !collected.upload_speed_profile_name) {
          collected.upload_speed_profile_name = collected.download_speed_profile_name;
        } else if (collected.upload_speed_profile_name && !collected.download_speed_profile_name) {
          collected.download_speed_profile_name = collected.upload_speed_profile_name;
        }
        const merged: Record<string, string> = { ...defaults, ...collected } as any;
        // Apply suggested defaults if missing
        merged.pon_type = merged.pon_type || 'gpon';
        merged.onu_mode = merged.onu_mode || 'Routing';
        const required = ['olt_id','sn','onu_type','zone','name'];
        const missing = required.filter((k) => !merged[k] || String(merged[k]).trim() === '');
        if (missing.length > 0) {
          finalContent = `Faltan campos requeridos: ${missing.join(', ')}. Por favor complétalos.`;
          actionsOut = buildAuthActions(state);
        } else {
          try {
            // Delegate to the dedicated submitAuth endpoint logic so the response
            // includes the same post-authorize WAN actions (forms) when available.
            await submitAuth(req, res);
            return;
          } catch (e: any) {
            const errMsg = e?.response?.data?.response || e?.response?.data?.error || e?.message || 'Fallo al autorizar';
            finalContent = `Error al autorizar en SmartOLT: ${errMsg}`;
          }
        }
      }
    } else if (/^(seleccionar|select) cliente\s+\d+$/i.test(lower)) {
      // Select client by id_servicio and start SmartOLT authorization wizard based on client info
      const idServicio = Number(lower.replace(/^(seleccionar|select) cliente\s+/i, '').trim());
      const repoClient = AppDataSource.getRepository((await import('../models/Client')).Client);
      const c = await repoClient.findOne({ where: { id_servicio: idServicio } });
      if (!c) {
        finalContent = `No encontré el cliente con id_servicio ${idServicio}. Intenta buscar por nombre o documento.`;
      } else {
        (req.session as any).lastSelectedClientIdServicio = c.id_servicio;
        const mode = (req.session as any).searchMode || 'installation';
        if (mode === 'installation') {
          const repoInst = AppDataSource.getRepository((await import('../models/Installation')).Installation);
          const fetchClientInstallations = async () => {
            const qb = repoInst.createQueryBuilder('i').where('i.id_servicio = :id', { id: c.id_servicio });
            if (c.cedula) qb.orWhere('i.cedula = :ced', { ced: c.cedula });
            if (c.nombre) qb.orWhere('i.nombre LIKE :nom', { nom: `%${c.nombre}%` });
            if (c.apellidos) qb.orWhere('i.apellidos LIKE :ape', { ape: `%${c.apellidos}%` });
            return qb.orderBy('i.updatedAt', 'DESC').limit(10).getMany();
          };

          let installations = await fetchClientInstallations();
          if (!installations.length) {
            const refreshTerm = c.cedula || c.telefono || c.email || c.nombre || String(c.id_servicio);
            await refreshInstallationsByTerm(refreshTerm).catch(() => 0);
            installations = await fetchClientInstallations();
          }

          const { section: oltSection, assistantMetadata: meta } = await ensurePendingAuthFromClient((req.session as any), c);
          setSmartoltMetadata(meta);
          const summaryLines = [
            `ID servicio: ${c.id_servicio}`,
            `Cliente: ${(c.nombre || '') + ' ' + (c.apellidos || '')}`,
            c.cedula ? `Documento: ${c.cedula}` : undefined,
            c.servicio ? `Plan: ${c.servicio}` : undefined,
            c.direccion ? `Dirección: ${c.direccion}` : undefined,
            c.ciudad ? `Ciudad: ${c.ciudad}` : undefined,
            c.localidad ? `Localidad: ${c.localidad}` : undefined,
            c.zona ? `Zona: ${c.zona}` : undefined,
          ].filter(Boolean).join('\n');
          const instLines = (installations || []).map((it: any) => `- [${it.id}] ${it.nombre || c.nombre || ''} ${it.apellidos || c.apellidos || ''} — ${it.estado_instalacion || 'pendiente'}`);
          const instText = instLines.length
            ? `\nInstalaciones vinculadas encontradas:\n${instLines.join('\n')}\n\nSelecciona una instalación para continuar.`
            : '\nNo encontré instalaciones vinculadas en BD para este cliente. Puedes refrescar la búsqueda o completar los datos para autorizar.';
          const oltText = oltSection.text ? `\n${oltSection.text}\n` : '';
          finalContent = `Cliente seleccionado:\n${summaryLines}${instText}\n${oltText}\nPrellené SN, nombre, zona y dirección cuando estaban disponibles. Selecciona una instalación y luego una ONU libre para completar el formulario de autorización.`;
          const installationActions = (installations || []).map((it: any) => ({
            id: `select-installation-${it.id}`,
            type: 'button',
            label: `${it.nombre || c.nombre || ''} ${it.apellidos || c.apellidos || ''} [${it.id}]`,
            payload: `seleccionar instalación ${it.id}`
          }));
          actionsOut = [
            ...oltSection.actions,
            ...installationActions
          ];
        } else {
          // General mode: present client summary and offer actions
          const summaryLines = [
            `ID servicio: ${c.id_servicio}`,
            `Nombre: ${(c.nombre || '') + ' ' + (c.apellidos || '')}`,
            c.cedula ? `Documento: ${c.cedula}` : undefined,
            c.telefono ? `Teléfono: ${c.telefono}` : undefined,
            c.email ? `Email: ${c.email}` : undefined,
            c.direccion ? `Dirección: ${c.direccion}` : undefined,
            c.ciudad ? `Ciudad: ${c.ciudad}` : undefined,
            c.zona ? `Zona: ${c.zona}` : undefined,
          ].filter(Boolean).join('\n');
          finalContent = `Cliente seleccionado (vista general):\n${summaryLines}\n\nSi quieres iniciar una instalación para este cliente, usa el botón siguiente.`;
          actionsOut = [
            { id: 'mode-switch-to-install', type: 'button', label: 'Iniciar instalación para este cliente', payload: `modo busqueda instalacion` },
            { id: 'search-mode-general', type: 'button', label: 'Seguir en modo general', payload: 'modo busqueda general' }
          ];
        }
      }
    } else if (lower.includes('instalaciones') || lower.includes('instalacion')) {
      const termMatch = prompt.match(/\b(\d{6,20})\b/);
      const q = termMatch ? termMatch[1] : '';
      if (q) {
        let results = await searchLocalInstallations(String(q), 10);
        if (!results || results.length === 0) {
          await refreshInstallationsByTerm(String(q));
          results = await searchLocalInstallations(String(q), 10);
        }
        if (results && results.length > 0) {
          const lines = results.map((it: any) => `- [${it.id_servicio || it.id}] ${it.nombre || ''} ${it.apellidos || ''} — ${it.estado_instalacion || ''}`);
          finalContent = `Instalaciones encontradas:\n${lines.join('\n')}\n\n` + finalContent;
        }
      }
    } else if (lower.includes('autorizar alta smartolt') || lower.includes('autorizar onu')) {
      // Expect key=value pairs comma-separated. Example: olt_id=1, pon_type=gpon, sn=ZTE..., onu_type=..., onu_mode=Routing, zone="Centro", name="Juan"
      const kvs: Record<string, string> = {};
      for (const part of prompt.split(',')) {
        const [k, ...rest] = part.split('=');
        if (!k || rest.length === 0) continue;
        kvs[k.trim().toLowerCase()] = rest.join('=').trim().replace(/^"|"$/g, '');
      }
      const required = ['olt_id','pon_type','sn','onu_type','onu_mode','zone','name'];
      const missing = required.filter((r) => !kvs[r]);
      if (missing.length > 0) {
        finalContent = `Para autorizar en SmartOLT necesito: ${required.join(', ')}.\n\nEnvía en formato: olt_id=1, pon_type=gpon, sn=SERIE, onu_type=ZTE-F660V6.0, onu_mode=Routing, zone=Centro, name=Juan Perez.\nOpcionales: board, port, vlan, gpon_channel, odb, address_or_comment, onu_external_id, upload_speed_profile_name, download_speed_profile_name.`;
      } else {
        try {
          const result = await authorizeOnu({
            olt_id: kvs['olt_id'],
            pon_type: kvs['pon_type'] as any,
            sn: kvs['sn'],
            onu_type: kvs['onu_type'],
            onu_mode: kvs['onu_mode'] as any,
            zone: kvs['zone'],
            name: kvs['name'],
            board: kvs['board'],
            port: kvs['port'],
            vlan: kvs['vlan'],
            gpon_channel: kvs['gpon_channel'] as any,
            epon_channel: kvs['epon_channel'] as any,
            odb: kvs['odb'],
            address_or_comment: kvs['address_or_comment'],
            onu_external_id: kvs['onu_external_id'],
            upload_speed_profile_name: kvs['upload_speed_profile_name'],
            download_speed_profile_name: kvs['download_speed_profile_name'],
          } as any);
          // If authorization succeeded, prompt UI for final WAN authorization step
          try {
            const ok = (result && (result.status === true || result.response_code === 'success' || String(result.response || result.response_code || '').toLowerCase().includes('success') || String(result).toLowerCase().includes('onu configuration')));
            if (ok) {
              // prepare prefilled values: prefer kvs, then session pendingAuth
              const sessionDefaults = (session?.pendingAuth && session.pendingAuth.defaults) || {};
              const sessionCollected = (session?.pendingAuth && session.pendingAuth.collected) || {};
              const snPref = kvs['sn'] || sessionCollected.sn || sessionDefaults.sn || '';
              const onuExternalPref = kvs['onu_external_id'] || sessionCollected.onu_external_id || sessionDefaults.onu_external_id || '';
              const ipPref = sessionCollected.ipv4_address || sessionDefaults.ipv4_address || kvs['ipv4_address'] || '';

              finalContent = 'ONU autorizada correctamente. Ahora es el paso final: autorizar WAN por IP estática. Completa los datos y presiona "Autorizar WAN estático ahora".';
              actionsOut = [
                { id: 'wan-sn', type: 'input', label: 'SN/MAC', placeholder: snPref, payload: 'apply set sn {input}' },
                { id: 'wan-onu_external_id', type: 'input', label: 'ONU External ID', placeholder: onuExternalPref, payload: 'apply set onu_external_id {input}' },
                { id: 'wan-ipv4', type: 'input', label: 'WAN IPv4', placeholder: ipPref || 'Ej: 10.100.0.11', payload: 'apply set ipv4_address {input}' },
                { id: 'wan-subnet', type: 'input', label: 'WAN Subnet Mask', placeholder: '255.255.255.0', payload: 'apply set subnet_mask {input}' },
                { id: 'wan-dns1', type: 'input', label: 'WAN DNS1', placeholder: '8.8.8.8', payload: 'apply set dns1 {input}' },
                { id: 'wan-dns2', type: 'input', label: 'WAN DNS2', placeholder: '8.8.4.4', payload: 'apply set dns2 {input}' },
                { id: 'wan-apply', type: 'button', label: 'Autorizar WAN estático ahora', payload: 'apply execute_wan' }
              ];
            } else {
              finalContent = `SmartOLT respuesta: ${typeof result === 'object' ? JSON.stringify(result) : String(result)}`;
            }
          } catch (e: any) {
            finalContent = `SmartOLT respuesta: ${typeof result === 'object' ? JSON.stringify(result) : String(result)}`;
          }
        } catch (e: any) {
          const msg = e?.response?.data || e?.message || 'Fallo al autorizar ONU';
          finalContent = `Error al autorizar en SmartOLT: ${typeof msg === 'object' ? JSON.stringify(msg) : String(msg)}`;
        }
      }
    }
  } catch (err) {
    console.error('WispHub pre-search failed', err);
  }

  // Store assistant message (persist content; actions optional)
  const assistantMsg = repo.create({
    userId: Number(userId),
    role: 'assistant',
    content: finalContent,
    actions: actionsOut,
    metadata: assistantMetadata,
  });
  await repo.save(assistantMsg);

  return res.json({
    ok: true,
    userMessage: {
      id: userMsg.id,
      role: userMsg.role,
      content: userMsg.content,
      imageUrl: userMsg.imageUrl ?? null,
      createdAt: userMsg.createdAt,
    },
    assistantMessage: {
      id: assistantMsg.id,
      role: assistantMsg.role,
      content: assistantMsg.content,
      actions: assistantMsg.actions ?? [],
      createdAt: assistantMsg.createdAt,
      metadata: assistantMsg.metadata ?? null,
    },
  });
}

// New endpoint: submit all collected auth fields in one request (preferred)
*/
export async function submitAuth(req: any, res: any) {
  const session = req.session as any;
  const userId = session?.userId;
  if (!userId) return res.status(401).json({ error: 'unauthenticated' });

  // Allow client to POST full collected object, otherwise fall back to session pendingAuth
  const bodyCollected = req.body?.collected;
  const state = session?.pendingAuth || {};
  const collected = typeof bodyCollected === 'object' && bodyCollected !== null ? { ...(state.collected || {}), ...bodyCollected } : (state.collected || {});
  const defaults = state.defaults || {};

  const merged: Record<string, any> = { ...defaults, ...collected } as any;
  merged.pon_type = merged.pon_type || 'gpon';
  merged.onu_mode = merged.onu_mode || 'Routing';

  // Fallbacks for SN: allow providing `sn` in different places or use defaults/session suggestions
  if (!merged.sn || String(merged.sn).trim() === '') {
    // 1) direct body field
    if (req.body && req.body.sn) merged.sn = req.body.sn;
    // 2) common alternative names
    if ((!merged.sn || String(merged.sn).trim() === '') && req.body && req.body.placeholder_sn) merged.sn = req.body.placeholder_sn;
    // 3) session collected suggestion
    if ((!merged.sn || String(merged.sn).trim() === '') && state && state.collected && state.collected.sn) merged.sn = state.collected.sn;
    // 4) defaults from installation/client
    if ((!merged.sn || String(merged.sn).trim() === '') && defaults && defaults.sn) merged.sn = defaults.sn;
  }

  const required = ['olt_id','sn','onu_type','zone','name'];
  const missing = required.filter((k) => !merged[k] || String(merged[k]).trim() === '');
  if (missing.length > 0) {
    return res.status(400).json({ error: `missing_fields`, details: missing });
  }

  try {
    const payload: any = {
      olt_id: merged.olt_id,
      pon_type: merged.pon_type,
      sn: merged.sn,
      onu_type: merged.onu_type,
      onu_mode: merged.onu_mode,
      zone: merged.zone,
      name: merged.name
    };
    if (merged.board) payload.board = merged.board;
    if (merged.port) payload.port = merged.port;
    if (merged.odb) payload.odb = merged.odb;
    if (merged.odb_port) payload.odb_port = isNaN(Number(merged.odb_port)) ? merged.odb_port : Number(merged.odb_port);
    if (merged.vlan) payload.vlan = merged.vlan;
    if (merged.address_or_comment) payload.address_or_comment = merged.address_or_comment;
    if (merged.download_speed_profile_name) payload.download_speed_profile_name = merged.download_speed_profile_name;
    if (merged.upload_speed_profile_name) payload.upload_speed_profile_name = merged.upload_speed_profile_name;

    // Validate ONU type exists in SmartOLT to avoid hard 400 from remote
    try {
      const availableTypes = await getOnuTypesByPonType((payload.pon_type || 'gpon') as any).catch(() => [] as string[]);
      const desired = String(payload.onu_type || '').trim();
      const found = (availableTypes || []).some((t: string) => String(t).trim().toLowerCase() === desired.toLowerCase());
      if (!found) {
        return res.status(400).json({ ok: false, error: 'onu_type_not_found', message: `ONU type '${desired}' not present in SmartOLT. Available types: ${((availableTypes||[]).slice(0,50)).join(', ')}` });
      }
    } catch (e: any) {}

    const result: any = await authorizeOnu(payload);

    // Simplificación: en SmartOLT este tenant usa el SN como identificador
    // externo de la ONU, así que lo usamos directamente para operaciones
    // posteriores (ubicación, WAN, etc.).
    if (!merged.onu_external_id && merged.sn) {
      merged.onu_external_id = String(merged.sn);
    }

    // If authorization succeeded, attempt to update ONU location details
    let locationUpdateResult: any = null;
    let wanUpdateResult: any = null;
    try {
      const ok = (result && (result.status === true || result.response_code === 'success' || String(result.response || result.response_code || '').toLowerCase().includes('success') || String(result).toLowerCase().includes('onu configuration')));
      if (ok && merged.onu_external_id) {
        const locParams: Record<string, any> = {};
        if (merged.zone) locParams.zone = merged.zone;
        if (merged.odb) locParams.odb = merged.odb;
        if (merged.odb_port) locParams.odb_port = merged.odb_port;
        if (merged.name) locParams.name = merged.name;
        if (merged.address_or_comment) locParams.address_or_comment = merged.address_or_comment;
        if (merged.contact) locParams.contact = merged.contact;
        if (merged.latitude) locParams.latitude = merged.latitude;
        if (merged.longitude) locParams.longitude = merged.longitude;

        if (Object.keys(locParams).length > 0) {
          try {
            locationUpdateResult = await updateOnuLocation(String(merged.onu_external_id), locParams).catch((e) => { throw e; });
          } catch (e: any) {
            console.warn('updateOnuLocation failed', e?.response?.data || e?.message || e);
          }
        }
      }
    } catch (e: any) {
      // non-fatal
      console.warn('post-authorize location update check failed', e?.message || e);
    }

    // After updating location: handle WAN config according to user's choice.
    try {
      const ipCandidates = [merged.ipv4_address, merged.ipv4, merged.ip, merged.client_ip, merged.cliente_ip, merged.customer_ip, merged.service_ip];
      const ipRaw = ipCandidates.find((v) => v !== undefined && v !== null && String(v).trim() !== '');
      const ip = ipRaw ? String(ipRaw).trim() : '';

      const shouldExecuteWan = merged.execute_wan_now === true || merged.execute_wan_now === 'true' || req.body?.executeWan === true || req.body?.executeWan === 'true' || merged.wan_apply_now === true || merged.wan_apply_now === 'true';

      if (ip && merged.onu_external_id && /^\d{1,3}(?:\.\d{1,3}){3}$/.test(ip)) {
        const parts = ip.split('.');
        if (parts.length === 4) {
          const gateway = merged.gateway || `${parts[0]}.${parts[1]}.${parts[2]}.254`;
          const extras: Record<string, any> = {};
          if (merged.sn) extras.sn = merged.sn;
          if (merged.olt_id) extras.olt_id = merged.olt_id;
          if (merged.pon_type) extras.pon_type = merged.pon_type;

          if (shouldExecuteWan) {
            try {
              wanUpdateResult = await setOnuWanModeStaticIp(String(merged.onu_external_id), ip, merged.subnet_mask || '255.255.255.0', gateway, merged.dns1 || '8.8.8.8', merged.dns2 || '8.8.4.4', extras);
            } catch (e: any) {
              console.warn('setOnuWanModeStaticIp failed', e?.response?.data || e?.message || e);
              wanUpdateResult = { ok: false, error: e?.response?.data || e?.message || String(e) };
            }
          } else {
            // Do not auto-save/apply WAN here. Instead, we will prompt the UI with inputs
          }
        }
      }
    } catch (e: any) {
      console.warn('post-authorize WAN static IP step failed', e?.message || e);
    }

    // invalidate relevant caches so subsequent UI updates reflect changes
    try {
      if (payload.olt_id) {
        cacheDelete(`onus:${String(payload.olt_id)}`);
        cacheDelete(`oltVlans:${String(payload.olt_id)}`);
      }
      cacheDelete('listOlts');
    } catch (e: any) {}

    // clear pending auth in session if present
    if (session.pendingAuth) delete session.pendingAuth;

    // Return human-readable message and, if applicable, prompt UI for WAN inputs
    try {
      const parts: string[] = [];
      parts.push('ONU autorizada correctamente.');
      if (locationUpdateResult) parts.push('Ubicación actualizada en SmartOLT.');
      if (wanUpdateResult) {
        const ok = (wanUpdateResult && (wanUpdateResult.status === true || wanUpdateResult.ok === true || String(wanUpdateResult).toLowerCase().includes('success')));
        if (ok) parts.push('WAN configurado correctamente.');
        else parts.push('Intento de configurar WAN estático falló.');
      }

      const baseMessage = parts.join(' ');

      // If we have an ONU external id, prepare follow-up inputs for the UI to authorize WAN by static IP
      const ipCandidates = [merged.ipv4_address, merged.ipv4, merged.ip, merged.client_ip, merged.cliente_ip, merged.customer_ip, merged.service_ip];
      const ipRaw = ipCandidates.find((v) => v !== undefined && v !== null && String(v).trim() !== '');
      const ip = ipRaw ? String(ipRaw).trim() : '';

      const actions: any[] = [];
      // prefill SN y ONU external id (puede venir vacío si SmartOLT no lo devolvió)
      actions.push({ id: 'wan-sn', type: 'input', label: `SN/MAC`, placeholder: merged.sn || '', payload: 'wan set sn {input}' });
      actions.push({ id: 'wan-onu_external_id', type: 'input', label: `ONU External ID`, placeholder: merged.onu_external_id ? String(merged.onu_external_id) : '', payload: 'wan set onu_external_id {input}' });
      actions.push({ id: 'wan-ipv4', type: 'input', label: `WAN IPv4`, placeholder: ip || 'Ej: 10.100.0.11', payload: 'wan set ipv4_address {input}' });
      actions.push({ id: 'wan-subnet', type: 'input', label: `WAN Subnet Mask`, placeholder: merged.subnet_mask || '255.255.255.0', payload: 'wan set subnet_mask {input}' });

      // Gateway es requerido por SmartOLT; sugerimos uno a partir de la IP si existe (terminado en .254)
      let gatewayPlaceholder = merged.gateway || '';
      if (!gatewayPlaceholder && ip) {
        const ipParts = ip.split('.');
        if (ipParts.length === 4) {
          gatewayPlaceholder = `${ipParts[0]}.${ipParts[1]}.${ipParts[2]}.254`;
        }
      }
      actions.push({ id: 'wan-gateway', type: 'input', label: `WAN Gateway`, placeholder: gatewayPlaceholder || 'Ej: 10.100.0.254', payload: 'wan set gateway {input}' });

      actions.push({ id: 'wan-dns1', type: 'input', label: `WAN DNS1`, placeholder: merged.dns1 || '8.8.8.8', payload: 'wan set dns1 {input}' });
      actions.push({ id: 'wan-dns2', type: 'input', label: `WAN DNS2`, placeholder: merged.dns2 || '8.8.4.4', payload: 'wan set dns2 {input}' });
      actions.push({ id: 'wan-apply', type: 'button', label: 'Autorizar WAN estático ahora', payload: 'wan apply' });

      return res.json({
        ok: true,
        message: baseMessage + ' Ya estamos en el momento de configurar el WAN por IP estática. Completa los datos a continuación.',
        actions
      });
    } catch (e: any) {
      return res.json({ ok: true, message: 'ONU autorizada correctamente' });
    }
  } catch (e: any) {
    const errMsg = e?.response?.data || e?.message || 'Fallo al autorizar';
    return res.status(500).json({ ok: false, error: errMsg });
  }
}

// Apply pending WAN configuration saved in session.pendingWan
export async function applyPendingWan(req: any, res: any) {
  const session = req.session as any;
  const userId = session?.userId;
  if (!userId) return res.status(401).json({ error: 'unauthenticated' });

  const pending = session?.pendingWan;
  const body = req.body || {};

  // Prefer explicit body parameters; otherwise fall back to session.pendingWan
  const dataSource = (body && body.ipv4_address) ? body : pending;
  if (!dataSource) return res.status(400).json({ error: 'no_pending_wan' });

  try {
    const extras = dataSource.extras || {};
    const onuExternalId = String(dataSource.onu_external_id || dataSource.onuExternalId || dataSource.onu_external || '');
    const ipv4 = dataSource.ipv4_address || dataSource.ipv4 || dataSource.ip || dataSource.ipv4Address || '';
    if (!onuExternalId || !ipv4) return res.status(400).json({ error: 'missing_fields', details: ['onu_external_id','ipv4_address'] });

    // Si no viene gateway explícito pero tenemos IP válida, sugerimos .254 en la misma red
    let gateway = dataSource.gateway;
    const ipv4Str = String(ipv4);
    if (!gateway && /^\d{1,3}(?:\.\d{1,3}){3}$/.test(ipv4Str)) {
      const parts = ipv4Str.split('.');
      if (parts.length === 4) {
        gateway = `${parts[0]}.${parts[1]}.${parts[2]}.254`;
      }
    }

    const result = await setOnuWanModeStaticIp(
      onuExternalId,
      ipv4Str,
      dataSource.subnet_mask || dataSource.subnetMask || '255.255.255.0',
      gateway,
      dataSource.dns1 || '8.8.8.8',
      dataSource.dns2 || '8.8.4.4',
      extras
    );
    // clear pending after apply if we used session source
    if (!body || !body.ipv4_address) {
      try { delete session.pendingWan; } catch {}
    }
    return res.status(200).json({ ok: true, message: 'WAN configurado correctamente', result });
  } catch (e: any) {
    const errMsg = e?.response?.data || e?.message || 'Fallo al aplicar WAN';
    return res.status(500).json({ ok: false, error: errMsg });
  }
}
=======
>>>>>>> parent of d0c9887 (feat: add Wisphub client and installation services with full sync capabilities)
