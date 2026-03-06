import { AppDataSource } from '../datasource';
import { ChatMessage } from '../models/ChatMessage';
import { ChatSession } from '../models/ChatSession';
import { SmartoltZone } from '../models/SmartoltZone';
import { SmartoltOdb } from '../models/SmartoltOdb';
import { SmartoltOnuDetail } from '../models/SmartoltOnuDetail';
import { Installation } from '../models/Installation';
import { Client } from '../models/Client';
import fs from 'fs';
import path from 'path';
import { sendContractLinkEmail } from '../services/emailService';
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
  uploadDocumentoCliente,
  getClientByServiceId,
  _placeholder
} from '../services/wisphubClient';
import { replaceOnuForClient } from '../services/wisphubClient';
import { getLatestSmartoltOnuSnapshot, scheduleSmartoltOnuSnapshots,captureSmartoltOnuSnapshot} from '../services/smartoltOnuSnapshot';
import { searchLocalInstallations, refreshInstallationsByTerm, listPendingLocalInstallations, listAllLocalInstallations, fullSyncInstallations } from '../services/wisphubInstallations';
import {
  authorizeOnu, listOlts, type OltInfo, getZones, getOltVlans,
  getOdbs, getOnuTypesByPonType, type SmartOltOnu, updateOnuLocation,
  setOnuWanModeStaticIp, getAllOnuTypes,
  getAllZones, getVlansByOltId, listGlobalUnconfiguredOnus,
  updateOnuWifi,
  getInternalOnuIdBySn,
  getOnuBySerial,
  updateOnuSn,
  changeOnuType,
  getAllOnusDetails,
  getOnuFullStatusInfoByExternalId,
  getOnuDetailsByExternalId,
  getOnuSignalByExternalId,
  getOnuRunningConfigByExternalId,
  getOnuSignalGraphByExternalId,
  getOnuTrafficGraphByExternalId,
  type SmartoltGraphType,
  resyncOnuConfigByExternalId,
  rebootOnuByExternalId
} from '../services/smartoltClient';
import { IsNull } from 'typeorm';

// --- HELPERS: Caching & Utils ---

const _simpleCache = new Map<string, { ts: number; val: any }>();
const _searchCache = new Map<string, { ts: number; results: any }>();

// Detecta si un mensaje es principalmente una tabla/listado (evita resultados irrelevantes)
function isTableOrListMessage(content: string): boolean {
  if (!content) return false;
  const lines = content.split('\n');
  
  // Contar líneas que son tablas Markdown o solo headers/separadores
  const tableLikeLines = lines.filter(l => /^\|.*\|$/.test(l.trim())).length;
  const totalLines = lines.filter(l => l.trim()).length;
  
  // Si más del 70% son líneas de tabla, es una tabla
  if (totalLines > 2 && tableLikeLines / totalLines > 0.7) return true;
  
  // Detectar si es solo bullets/numbered list
  const listLines = lines.filter(l => /^[\d\-\*\+]\s+/.test(l.trim())).length;
  if (totalLines > 5 && listLines / totalLines > 0.8) return true;
  
  return false;
}

// Calcula relevancia del resultado (favorece búsquedas en contexto, no en tablas)
function calculateRelevance(content: string, query: string): number {
  let score = 0;
  const queryLower = query.toLowerCase();
  
  // Penaliza si es tabla
  if (isTableOrListMessage(content)) score -= 50;
  
  // Bonifica por palabra completa exacta
  if (new RegExp(`\\b${queryLower}\\b`, 'i').test(content)) score += 30;
  
  // Bonifica si aparece al inicio del mensaje
  if (content.toLowerCase().startsWith(queryLower)) score += 20;
  
  // Bonifica por múltiples ocurrencias
  const matches = content.match(new RegExp(queryLower, 'gi')) || [];
  score += Math.min(matches.length * 5, 25);
  
  return score;
}

const CHAT_CONTEXT_KEYS = [
  'lastSelectedClientIdServicio',
  'lastSelectedInstallationId',
  'lastSelectedIsPyme',
  'lastSelectedPlan',
  'lastSelectedEmail',
  'lastSelectedEmailCc',
  'pendingAuth',
  // IPs
  'ipv4',
  'ipv4_address',
  // Drafts / uploads
  'lastMessageDraft',
  'lastImageSystemPath',
  'pendingPhotos',
  // Forms / flows
  'pendingForm',
  'pendingFormFields',
  'pendingWanConfig',
  'pendingWifiConfig',
  'pendingChangeOnu',
  'pendingActionQueue',
  'lastBotStep',
  // Selections / search
  'lastSelectedOltId',
  'lastSelectedOnuSn',
  'lastSearchResults',
  'lastAuthNameUsed',
  'lastContextType',
  'lastSearchTerm',
  'searchMode',
  'photoFlowMode',
  'pendingPhotoClientSearch',
  'changeOnuFlowMode',
  'pendingChangeOnuClientSearch',
  'pendingWifiClientSearch',
  'pendingWifiChange',
  'monitorClientFlowMode',
  'pendingMonitorClientSearch',
  'pendingMonitorClient',
  'monitorGraphType',
  // Assistant metadata and housekeeping
  'assistantMetadata',
  'sessionExpiresAt',
  'contextVersion',
  'locale',
  'timezone',
  // Security / attempts
  'authAttempts',
  'otpPending'
];

async function loadChatContext(session: any, sessionId: number) {
  if (!session) return;
  if (!session.chatContexts) session.chatContexts = {};

  let stored = session.chatContexts[String(sessionId)];
  if (!stored) {
    try {
      const sessionRepo = AppDataSource.getRepository(ChatSession);
      const where: any = { id: Number(sessionId) };
      if (session?.userId) where.userId = Number(session.userId);
      const chatSession = await sessionRepo.findOne({ where });
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

  // Antes de persistir en DB, sanitizar/maskear datos sensibles
  try {
    const sessionRepo = AppDataSource.getRepository(ChatSession);
    const sanitized = sanitizeContextForDb(snapshot);
    const where: any = { id: Number(sessionId) };
    if (session?.userId) where.userId = Number(session.userId);
    await sessionRepo.update(where, { context: sanitized });
  } catch (e) {
    console.error('Error guardando contexto en DB:', e);
  }
}

// Sanitiza snapshot de contexto antes de guardar en DB: enmascara claves sensibles
function sanitizeContextForDb(snapshot: any) {
  const sensitiveKeyRegex = /pass(word)?|pwd|token|secret|otp|ssn|credit|card|cvv|clave/i;

  function cloneAndMask(val: any): any {
    if (val === null || val === undefined) return val;
    if (typeof val === 'string') return val;
    if (typeof val === 'number' || typeof val === 'boolean') return val;
    if (Array.isArray(val)) return val.map(cloneAndMask);
    if (typeof val === 'object') {
      const out: any = {};
      for (const [k, v] of Object.entries(val)) {
        try {
          if (sensitiveKeyRegex.test(k)) {
            out[k] = '***';
            continue;
          }
        } catch { }
        // Protección específica: no guardar contraseñas WiFi en claro
        if ((k === 'pass' || k === 'password' || k === 'wifi_password') && typeof v === 'string') {
          out[k] = '***';
          continue;
        }

        out[k] = cloneAndMask(v);
      }
      return out;
    }
    return val;
  }

  return cloneAndMask(snapshot);
}

async function cacheGet<T>(key: string, ttlSeconds: number, fetcher: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const existing = _simpleCache.get(key);
  if (existing && now - existing.ts < ttlSeconds * 1000) return existing.val as T;
  const val = await fetcher();
  try { _simpleCache.set(key, { ts: now, val }); } catch { }
  return val;
}

function cacheDelete(keyPrefix: string) {
  for (const k of _simpleCache.keys()) {
    if (k.startsWith(keyPrefix)) _simpleCache.delete(k);
  }
}

// Limpia el cache de búsqueda para un usuario (cuando se agregan mensajes nuevos)
function invalidateSearchCache(userId: number) {
  for (const k of _searchCache.keys()) {
    if (k.startsWith(`search:${userId}:`)) {
      _searchCache.delete(k);
    }
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
  if (val === undefined || val === null) return undefined;

  // Limpieza básica
  let raw = '';
  if (typeof val === 'object') {
    // Intenta sacar el nombre del plan de objetos complejos
    raw = val.download_speed_profile_name || val.name || val.plan_internet || val.plan || '';
  } else {
    raw = String(val);
  }
  raw = raw.trim();
  if (!raw) return undefined;
  try { console.log('[normalizeSpeedProfileName] input raw:', { raw }); } catch (e) { }

  const normalizeNumberToken = (token: string): string => {
    const t = token.trim();
    // Elimina separadores de miles (puntos en 1.000 o comas en 1,000 si no son decimales obvios)
    if (/^\d{1,3}(?:\.\d{3})+$/.test(t)) return t.replace(/\./g, '');
    return t.replace(',', '.'); // Estandarizar decimales
  };

  // 1. PRIORIDAD: Buscar Gbps (ej: 1 Gbps, 2.5 Gb)
  const gbpsMatch = raw.match(/(\d+(?:[\.,]\d+)?)\s*(?:g|gbps|gb)\b/i);
  if (gbpsMatch) {
    try { console.log('[normalizeSpeedProfileName] gbpsMatch:', { gbpsMatch: gbpsMatch[1] }); } catch (e) { }
    const gbps = Number(normalizeNumberToken(gbpsMatch[1]));
    if (!Number.isNaN(gbps)) return `${gbps * 1000}M`;
  }

  // 2. PRIORIDAD: Buscar Mbps (ej: 600 Mbps, 300 Megas)
  // Esto evita confundirse con el precio "$15.990" porque busca la palabra "Mb/Mega"
  const mbpsMatch = raw.match(/(\d+(?:[\.,]\d+)?)\s*(?:mbps|mb|m|mega|megas)\b/i);
  if (mbpsMatch) {
    try { console.log('[normalizeSpeedProfileName] mbpsMatch:', { mbpsMatch: mbpsMatch[1] }); } catch (e) { }
    const n = normalizeNumberToken(mbpsMatch[1]);
    return `${Number(n)}M`; // "600M"
  }

  // 3. FALLBACK: Si solo hay números sin unidad, tomamos el más lógico
  // (Aquí sí podría confundirse con precios, pero el paso 1 y 2 deberían haber capturado el plan)
  const numbers = Array.from(raw.matchAll(/\d+/g)).map(m => Number(m[0]));
  if (numbers.length) {
    // Filtros heurísticos: Velocidades comunes suelen ser 50, 100, 200... 1000.
    // Precios suelen ser > 2000 (en CLP).
    const candidates = numbers.filter(n => n < 2000 && n > 10);
    if (candidates.length) return `${Math.max(...candidates)}M`;
  }

  return raw; // Retorna el valor original si no pudo parsear
}

// Extrae solo el número de velocidad (ej. '600' desde 'Plan ... 600 Mbps')
function extractSpeedNumber(val: any): string | undefined {
  if (val === undefined || val === null) return undefined;
  const s = typeof val === 'string' ? val : (typeof val === 'object' ? JSON.stringify(val) : String(val));
  const raw = String(s).trim();
  if (!raw) return undefined;

  // Buscar tokens en Gbps o Mbps, preferir Mbps
  const gbpsMatch = raw.match(/(\d{1,3}(?:[\.,]\d{3})+|\d+(?:[\.,]\d+)?)\s*(?:g|gbps|gb)\b/i);
  if (gbpsMatch) {
    try { console.log('[extractSpeedNumber] gbpsMatch:', { raw, match: gbpsMatch[1] }); } catch (e) { }
    const num = gbpsMatch[1].replace(/\./g, '').replace(/,/g, '.');
    const n = Number(num);
    if (!Number.isNaN(n)) return String(Math.round(n * 1000)); // Gbps -> Mbps
  }

  const mbpsMatch = raw.match(/(\d{1,3}(?:[\.,]\d{3})+|\d+(?:[\.,]\d+)?)\s*(?:mbps|mb\/?s|mb|m|mega|megas)\b/i);
  if (mbpsMatch) {
    try { console.log('[extractSpeedNumber] mbpsMatch:', { raw, match: mbpsMatch[1] }); } catch (e) { }
    const num = mbpsMatch[1].replace(/\./g, '').replace(/,/g, '.');
    const n = Number(num);
    if (!Number.isNaN(n)) return String(Math.round(n));
  }

  // Fallback: tomar el número más grande encontrado
  const numbers = Array.from(raw.matchAll(/\d{1,3}(?:[\.,]\d{3})+|\d+(?:[\.,]\d+)?/g)).map(m => m[0].replace(/\./g, '').replace(/,/g, '\.'));
  const numericCandidates = numbers.map(s => ({ raw: s, n: Number(s) })).filter(x => !Number.isNaN(x.n));
  if (numericCandidates.length) {
    try { console.log('[extractSpeedNumber] numericCandidates:', { raw, numericCandidates }); } catch (e) { }
    const best = numericCandidates.reduce((a, b) => (b.n > a.n ? b : a));
    return String(Math.round(best.n));
  }

  return undefined;
}
const AUTH_SPEED_OPTIONS = ['200M', '400M', '600M', '800M', '700M', '940M'] as const;

function matchSpeedOption(val: any, options: readonly string[] = AUTH_SPEED_OPTIONS): string | undefined {
  const normalized = normalizeSpeedProfileName(val);
  const opts = [...options];
  try { console.log('[matchSpeedOption] val, normalized, options:', { val, normalized, options: opts }); } catch (e) { }
  const matched = bestMatchOption(normalized, opts) || bestMatchOption(val, opts);
  try { console.log('[matchSpeedOption] matched:', { matched }); } catch (e) { }
  return matched;
}

function pickFirstSpeedMatch(candidates: any[], options: readonly string[] = AUTH_SPEED_OPTIONS): string | undefined {
  for (const c of candidates) {
    const match = matchSpeedOption(c, options);
    if (match) return match;
  }
  return undefined;
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
  // Considerar 'pyme' o 'empresa' (y derivados) como indicador de cliente PyME
  return norm.includes('pyme') || norm.includes('empresa');
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

    // Si no hay match exacto por inclusión, elegimos el número más cercano.
    const inputNumeric = Number(inputNumber);
    if (!Number.isNaN(inputNumeric)) {
      let bestNumeric: { raw: string; distance: number } | undefined;
      for (const opt of normalizedOptions) {
        const optNumber = opt.norm.match(/\d+(?:\.\d+)?/)?.[0];
        if (!optNumber) continue;
        const optNumeric = Number(optNumber);
        if (Number.isNaN(optNumeric)) continue;
        const distance = Math.abs(optNumeric - inputNumeric);
        if (!bestNumeric || distance < bestNumeric.distance) bestNumeric = { raw: opt.raw, distance };
      }
      if (bestNumeric) return bestNumeric.raw;
    }
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
        const keyFromId = action.id.replace(/^auth-|^wifi_|^change-onu-|^change_onu_/, '').replace('-', '_');
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
  // Priorizar `plan_internet` (el nombre del plan) por sobre `servicio` (nombre de servicio/usuario)
  const rawPlan = entity.plan_internet || entity.servicio || pickPlanFromRaw(entity.raw);
  const plan = typeof rawPlan === 'object'
    ? pickFirstString([
      rawPlan?.name,
      rawPlan?.nombre,
      rawPlan?.label,
      rawPlan?.descripcion,
      rawPlan?.description
    ])
    : rawPlan;
  const planForSpeed = rawPlan;
  const clientName = `${entity.nombre || ''} ${entity.apellidos || ''}`.trim();
  const rawString = !plan && entity?.raw ? JSON.stringify(entity.raw) : '';
  const isPyme = isPymeText(plan) || isPymeText(clientName) || (rawString ? isPymeText(rawString) : false);
  const normalizedSpeed = normalizeSpeedProfileName(planForSpeed);

  return {
    sn: entity.sn_onu || undefined,
    // Priorizar el identificador del servicio (`servicio`) para el campo 'name'
    // Esto preserva la lógica de extracción de velocidad pero asegura que
    // el `auth-name` muestre el usuario/servicio como '1256_jorge' cuando exista.
    name: entity.servicio || plan || clientName || undefined,
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

function buildUnconfiguredOnusTable(oltAvailability: any[]): string {
  const header = `| # | OLT | SN | PON | Port | Modelo |\n|---|-----|----|-----|------|--------|`;
  const rows: string[] = [];
  let idx = 1;
  (oltAvailability || []).forEach((olt: any) => {
    (olt.onus || []).forEach((o: any) => {
      const sn = o.id || '-';
      const pon = o.ponType || '-';
      const port = o.port || '-';
      const model = o.model || '-';
      const oltLabel = `${olt.oltName || ''} [${olt.oltId || ''}]`.trim();
      rows.push(`| ${idx++} | ${oltLabel} | ${sn} | ${pon} | ${port} | ${model} |`);
    });
  });
  return [header, ...(rows.length ? rows : ['| - | - | - | - | - | - |'])].join('\n');
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
  const emailData = extractEmails(entity);
  const emailLabel = emailData.primary && emailData.cc && emailData.cc !== emailData.primary
    ? `${emailData.primary} (cc: ${emailData.cc})`
    : (emailData.primary || emailData.cc || 'N/A');
  const coords = (entity.latitud && entity.longitud) ? `${entity.latitud}, ${entity.longitud}` : null;
  const mapLink = coords ? `https://www.google.com/maps/search/?api=1&query=${entity.latitud},${entity.longitud}` : null;
  const ip = entity.ip || entity.ipv4_address || entity.ip_cliente || 'N/A';

  return `
  📋 **Ficha de Instalación**
  👤 **Cliente:** ${name} [ID: ${id}]
  📍 **Dirección:** ${address}
  📞 **Tel:** ${phone}
  📧 **Correo:** ${emailLabel}
  🌍 **IP Asignada:** ${ip}
  🚀 **Plan:** ${plan}
  ${coords ? `🗺️ **Ubicación:** [Ver en Maps](${mapLink})` : '🗺️ **Ubicación:** No registrada'}
  `.trim();
}

function normalizeName(value?: string | null): string {
  if (!value) return '';
  return String(value)
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^a-zA-Z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function onuMatchesAnyField(onu: any, needle: string): boolean {
  if (!onu || !needle) return false;
  const target = normalizeName(needle);
  if (!target) return false;

  for (const val of Object.values(onu)) {
    if (val === undefined || val === null) continue;
    const normalized = normalizeName(String(val));
    if (normalized && normalized.includes(target)) return true;
  }
  return false;
}

function onuMatchesNameLoose(onu: any, needle: string): boolean {
  if (!onu || !needle) return false;
  const target = normalizeName(needle);
  const name = normalizeName(onu?.name);
  if (!target || !name) return false;
  return name.includes(target) || target.includes(name);
}

function pickActionValue(actions: any[] | undefined, ids: string[]): string | undefined {
  if (!Array.isArray(actions)) return undefined;
  for (const id of ids) {
    const hit = actions.find(a => String(a?.id || '').toLowerCase() === id.toLowerCase());
    if (hit) {
      // Check both value and payload fields
      const val = hit.value ?? hit.payload;
      if (val !== undefined && val !== null && String(val).trim() !== '') {
        return String(val).trim();
      }
    }
  }
  return undefined;
}

function extractEmails(entity: any): { primary?: string; cc?: string } {
  const primary = pickFirstString([entity?.email, entity?.correo, entity?.mail, entity?.email_cc]);
  const cc = pickFirstString([entity?.email_cc]);
  const trimmedPrimary = typeof primary === 'string' ? primary.trim() : undefined;
  const trimmedCc = typeof cc === 'string' ? cc.trim() : undefined;
  return { primary: trimmedPrimary || undefined, cc: trimmedCc || undefined };
}

async function resolveContactEmail(targetId: number | string): Promise<{ primary?: string; cc?: string; name?: string }> {
  const instRepo = AppDataSource.getRepository(Installation);
  const clientRepo = AppDataSource.getRepository(Client);

  const inst = await instRepo.findOne({ where: [{ id: Number(targetId) }, { id_servicio: Number(targetId) }] });
  if (inst) {
    const emails = extractEmails(inst);
    const name = `${inst.nombre || ''} ${inst.apellidos || ''}`.trim() || inst.usuario || undefined;
    return { ...emails, name };
  }

  const client = await clientRepo.findOne({ where: { id_servicio: Number(targetId) } });
  if (client) {
    const emails = extractEmails(client);
    const name = `${client.nombre || ''} ${client.apellidos || ''}`.trim() || client.usuario || undefined;
    return { ...emails, name };
  }

  return {};
}

async function resolveGeonetInstallationUser(targetId: number | string, session?: any): Promise<{ fullUser: string; source: string }> {
  let resolvedUser: string | null = null;
  let source = 'id_fallback';

  const sessionTargetMatches =
    String(session?.lastSelectedClientIdServicio) === String(targetId) ||
    String(session?.lastSelectedInstallationId) === String(targetId) ||
    (session?.pendingAuth && (session.pendingAuth.clientIdServicio == targetId || session.pendingAuth.installationId == targetId));

  if (session?.lastAuthNameUsed && sessionTargetMatches) {
    resolvedUser = String(session.lastAuthNameUsed).trim();
    source = 'session.lastAuthNameUsed';
  }

  if (!resolvedUser) {
    try {
      const instRepo = AppDataSource.getRepository(Installation);
      const inst = await instRepo.findOne({ where: [{ id: Number(targetId) }, { id_servicio: Number(targetId) }] });
      if (inst?.usuario) {
        resolvedUser = String(inst.usuario).trim();
        source = 'installation.usuario';
      }
    } catch (e) {
      console.error('[resolveGeonetInstallationUser] Error Installation DB:', e);
    }
  }

  if (!resolvedUser) {
    try {
      const clientRepo = AppDataSource.getRepository(Client);
      const client = await clientRepo.findOne({ where: { id_servicio: Number(targetId) } });
      if (client?.usuario) {
        resolvedUser = String(client.usuario).trim();
        source = 'client.usuario';
      }
    } catch (e) {
      console.error('[resolveGeonetInstallationUser] Error Client DB:', e);
    }
  }

  const rawUser = resolvedUser || String(targetId).trim();
  const fullUser = rawUser.toLowerCase().includes('@geonet') ? rawUser : `${rawUser}@geonet`;
  return { fullUser, source };
}

async function findOnuDetailByServiceName(serviceName: string, ip?: string) {
  const repo = AppDataSource.getRepository(SmartoltOnuDetail);

  // Only search by IP. If no IP provided, return null.
  if (!ip) return null;

  try {
    const byIp = await repo
      .createQueryBuilder('o')
      .where('o.ipAddress = :ip', { ip })
      .orWhere('o.ipAddress LIKE :like', { like: `%${ip}%` })
      .orderBy('o.capturedAt', 'DESC')
      .limit(1)
      .getOne();

    if (byIp) {
      console.log(`[findOnuDetailByServiceName] IP match for ${ip}: id=${byIp.id}, name=${byIp.name}, ipAddress=${byIp.ipAddress}`);
      return byIp;
    } else {
      console.log(`[findOnuDetailByServiceName] No match for IP ${ip}`);
    }
  } catch (e) {
    console.error('[findOnuDetailByServiceName] DB error searching by IP', e);
  }

  return null;
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
      (type === 'client' || type === 'both') ? fullSyncClients().catch(() => { }) : null,
      (type === 'installation' || type === 'both') ? fullSyncInstallations(150, 4).catch(() => { }) : null
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
    await fullSyncClients().catch(() => { });
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

async function buildOltAndNetworkSection(serviceIdOrTerm?: number | string, opts?: { skipZonesFetch?: boolean; forceUnconfiguredFetch?: boolean }) {
  const skipZones = !!opts?.skipZonesFetch;
  const forceUnconfigured = !!opts?.forceUnconfiguredFetch;

  const [oltSection, zonesData, odbData, gponTypes, eponTypes, allUnconfiguredRaw] = await Promise.all([
    buildOltListSection(),
    skipZones ? [] : cacheGet('smartolt_zones', 300, async () => await getZones().catch(() => [])),
    cacheGet('smartolt_odbs', 300, async () => await getOdbs().catch(() => [])),
    cacheGet('onuTypes:gpon', 300, async () => await getOnuTypesByPonType('gpon').catch(() => [])),
    cacheGet('onuTypes:epon', 300, async () => await getOnuTypesByPonType('epon').catch(() => [])),
    forceUnconfigured ? await listGlobalUnconfiguredOnus().catch(() => []) : await cacheGet('smartolt_unconfigured_onus_global', 60, async () => await listGlobalUnconfiguredOnus().catch(() => []))
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

  // Agregar botón de refresh SOLO si hay ONUs y es flujo de autorización
  let actionsOut = [...onuActions];
  // Mostrar el botón de refresh SIEMPRE en el flujo de autorización (no solo si hay ONUs)
  if (opts?.skipZonesFetch !== true) {
    actionsOut.unshift({
      id: 'refresh-unconfigured-onus',
      type: 'button',
      label: '🔄 Refrescar ONUs libres',
      payload: 'auth refresh onu-list'
    });
  }

  return {
    text: parts.join('\n'),
    actions: actionsOut,
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
  const text = `OLTs:\n${limited.map((o, i) => `${i + 1}. ${o.name} [${o.id}]`).join('\n')}`;
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

  // Asegurar que el botón de refresh esté presente en las acciones
  let actions = section.actions || [];
  const hasRefresh = actions.some(a => a.id === 'refresh-unconfigured-onus');
  if (!hasRefresh) {
    actions = [
      {
        id: 'refresh-unconfigured-onus',
        type: 'button',
        label: '🔄 Refrescar ONUs libres',
        payload: 'auth refresh onu-list'
      },
      ...actions
    ];
  }
  return {
    text: section.text,
    actions,
    assistantMetadata: {
      flow: 'authorization',
      smartoltAvailability: { olts: section.oltAvailability, suggestedVlan: section.suggestedVlan, suggestedZone: section.suggestedZone },
      smartoltOdbs: section.odbs,
      smartoltZones: section.zones
    }
  };
}

export async function buildAuthActions(state: any, req?: any) {
  const defaults = state.defaults || {};
  const collected = state.collected || {};

  // --- OBTENCION DE DATOS DE CONTEXTO ---
  const onuTypeOptions = await getAllOnuTypes().catch(() => []);
  const zoneOptions = await getAllZones().catch(() => []);
  let vlanOptions: string[] = [];
  if (collected.olt_id) {
    const vlansRaw = await getVlansByOltId(collected.olt_id).catch(() => []);
    vlanOptions = normalizeVlanValues(vlansRaw);
  }
  const odbOptions = ((state.smartoltOdbs || []) as any[]).map(o => o.name || o.id).filter(Boolean);

  // --- LOGICA MEJORADA DE VELOCIDAD ---
  const speedOptions = [...AUTH_SPEED_OPTIONS]; // Copia de la lista base ['200M', '400M', etc]

  // 1. Buscamos el texto del plan en la sesión (donde se guardó al seleccionar cliente)
  // Priorizar los campos relacionados al plan (`plan_internet`, `plan`) para
  // la extracción de la velocidad; `defaults.name` puede contener el servicio
  // (ej. '1256_jorge') y NO debe usarse para parsear la velocidad.
  let planNameSource = req?.session?.lastSelectedPlan
    || state.defaults?.plan_internet
    || state.defaults?.plan
    || collected?.plan
    || collected?.plan_internet
    || state.defaults?.name
    || collected?.name;
  // Replace spaces with '-' in planNameSource
  if (typeof planNameSource === 'string') {
    planNameSource = planNameSource.replace(/\s+/g, '-');
  }

  // 2. Extraemos SOLO el número de velocidad (ej: '600' desde '600 Mbps')
  const extractedNumber = extractSpeedNumber(planNameSource);

  // LOG: traza del proceso de extracción y matching de velocidad
  try {
    console.log('[buildAuthActions] planNameSource preview:', String(planNameSource).slice(0, 200));
    console.log('[buildAuthActions] extractedNumber:', extractedNumber);
  } catch (e) { }

  // 3. Determinamos el valor a usar (Prioridad: Recolectado > Extraído del Plan > Default)
  //    Pero NO inyectamos nuevos elementos en la lista de opciones. Si extraemos '600',
  //    intentamos hacer match con las opciones conocidas (p.ej. '600M').
  let autoSpeed: string | undefined = undefined;
  if (collected.download_speed_profile_name) {
    autoSpeed = collected.download_speed_profile_name;
  } else if (extractedNumber) {
    // Asegurarse que el token tenga la 'M' al final (ej: '600' -> '600M')
    const token = String(extractedNumber).trim();
    const withMSuffix = /^\d+(?:[.,]\d+)?$/i.test(token) ? `${Number(token.replace(/,/g, '.'))}M` : token;
    let matched = matchSpeedOption(withMSuffix, speedOptions) || matchSpeedOption(token, speedOptions);
    try { console.log('[buildAuthActions] speed token preview:', { token, withMSuffix, matched }); } catch (e) { }

    // Si no hay match, añadimos la opción detectada (como cadena, p.ej. '600M') al inicio
    if (!matched && typeof withMSuffix === 'string' && withMSuffix) {
      const exists = speedOptions.find(s => String(s).toLowerCase() === String(withMSuffix).toLowerCase());
      if (!exists) {
        speedOptions.unshift(withMSuffix as typeof AUTH_SPEED_OPTIONS[number]);
        matched = withMSuffix as typeof AUTH_SPEED_OPTIONS[number];
      } else {
        matched = exists;
      }
    }
    autoSpeed = matched || undefined;
  } else if (defaults.download_speed_profile_name) {
    autoSpeed = defaults.download_speed_profile_name;
  }

  if (autoSpeed && typeof autoSpeed === 'string') autoSpeed = autoSpeed.trim();

  // Si detectamos una velocidad, movemos esa opción al principio
  if (autoSpeed && typeof autoSpeed === 'string') {
    const idx = speedOptions.findIndex(s => String(s).toLowerCase() === String(autoSpeed).toLowerCase());
    if (idx > 0) {
      const found = speedOptions.splice(idx, 1)[0];
      speedOptions.unshift(found);
    }
  }

  // --- LOGICA VLAN / ZONE (Igual que antes) ---
  const vlanSeed = collected.vlan || defaults.vlan || collected.vlan_id || defaults.vlan_id;
  const zoneSeed = collected.zone || defaults.zone || collected.zona || defaults.zona;
  const vlanFromZone = extractVlanFromZoneLabel(zoneSeed);
  const zoneBasedVlan = vlanFromZone ? bestMatchOption(vlanFromZone, vlanOptions) || vlanFromZone : undefined;
  const autoVlan = zoneBasedVlan || bestMatchOption(vlanSeed, vlanOptions) || vlanSeed;
  const autoZone = bestMatchOption(zoneSeed, zoneOptions) || zoneSeed;

  // Prellenado de collected para que el input muestre el value
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
    { id: 'auth-address', type: 'input', label: 'Etiqueta Roja', _placeholder: 'E134332', payload: 'auth set address_or_comment {input}' },
    // INPUT DE VELOCIDAD ACTUALIZADO
    {
      id: 'auth-speed',
      type: 'input',
      label: `Velocidad ${extractedNumber ? '(Detectada)' : ''}`, // Feedback visual extra
      placeholder: (collected.download_speed_profile_name || autoSpeed) || '200M',
      value: (collected.download_speed_profile_name || autoSpeed) || '',
      options: speedOptions,
      payload: 'auth set download_speed_profile_name {input}'
    },
    { id: 'auth-submit', type: 'button', label: 'Autorizar SmartOLT ahora', payload: 'auth submit' }
  ];
}

export async function buildChangeOnuActions(state: any) {
  const collected = state.collected || {};
  const onuTypeOptions = await getAllOnuTypes().catch(() => []);

  const sn = collected.sn || state.sn || state.selectedSn || '';
  const oldModel = collected.old_model || state.oldModel || state.selectedModel || '';
  const newModel = collected.new_model || state.newModel || '';

  return [
    { id: 'refresh-change-onus', type: 'button', label: '🔄 Refrescar ONUs libres', payload: 'change refresh onu-list' },
    { id: 'change-onu-sn', type: 'input', label: 'SN ONU seleccionada', placeholder: sn || 'SN', value: sn || '', payload: 'cambio onu set sn {input}' },
    { id: 'change-onu-old-model', type: 'input', label: 'Modelo antiguo (SmartOLT)', placeholder: oldModel || '-', value: oldModel || '-', disabled: true },
    { id: 'change-onu-new-model', type: 'input', label: 'Modelo nuevo', placeholder: 'Selecciona modelo', value: newModel || '', options: onuTypeOptions, payload: 'cambio onu set new_model {input}' },
    { id: 'change-onu-submit', type: 'button', label: 'Remplazar', payload: 'cambio onu submit sn {change-onu-sn} new_model {change-onu-new-model} old_model {change-onu-old-model}' }
  ];
}

const WIFI_ONU_MODELS = ['ZTEF6600P', 'ZXHNF600P'];

function normalizeOnuModel(value?: string | null): string {
  return String(value || '').toUpperCase().replace(/[- ]/g, '');
}

function isWifiCapableModel(model?: string | null): boolean {
  const normalized = normalizeOnuModel(model);
  return WIFI_ONU_MODELS.includes(normalized);
}

function buildWifiChangeActions(sn: string) {
  return [
    { id: 'wifi_onu_ssid', type: 'input', label: 'Nombre WiFi (SSID)', placeholder: 'Nuevo Nombre', payload: 'wifi set ssid {input}' },
    { id: 'wifi_onu_pass', type: 'input', label: 'Contraseña WiFi', placeholder: 'Nueva Clave (min 8)', payload: 'wifi set pass {input}' },
    { id: 'wifi_onu_apply', type: 'button', label: 'Aplicar Cambios WiFi', payload: `wifi apply sn ${sn} ssid {wifi_onu_ssid} pass {wifi_onu_pass}` }
  ];
}

function buildMonitorClientSearchActions() {
  return [
    { id: 'monitor_search_fullname', type: 'input', label: 'Nombre Completo', placeholder: 'Ej: Juan Pérez', payload: 'monitoreo buscar nombre {monitor_search_fullname} rut {monitor_search_rut}' },
    { id: 'monitor_search_rut', type: 'input', label: 'RUT', placeholder: 'Ej: 12.345.678-9', payload: 'monitoreo buscar nombre {monitor_search_fullname} rut {monitor_search_rut}' },
    { id: 'monitor_search_submit', type: 'button', label: 'Buscar Cliente', payload: 'monitoreo buscar nombre {monitor_search_fullname} rut {monitor_search_rut}' }
  ];
}

function buildMonitorPanelActions(onuExternalId?: string) {
  const actions: any[] = [];
  if (onuExternalId) {
    actions.push({ id: 'monitor_graph_hourly', type: 'button', label: '🕐 Hora', payload: `monitoreo grafico hourly ${onuExternalId}` });
    actions.push({ id: 'monitor_graph_daily', type: 'button', label: '📅 Día', payload: `monitoreo grafico daily ${onuExternalId}` });
    actions.push({ id: 'monitor_graph_weekly', type: 'button', label: '🗓️ Semana', payload: `monitoreo grafico weekly ${onuExternalId}` });
    actions.push({ id: 'monitor_graph_monthly', type: 'button', label: '📆 Mes', payload: `monitoreo grafico monthly ${onuExternalId}` });
    actions.push({ id: 'monitor_graph_yearly', type: 'button', label: '🗃️ Año', payload: `monitoreo grafico yearly ${onuExternalId}` });
    actions.push({ id: 'monitor_refresh', type: 'button', label: '🔄 Actualizar panel', payload: `monitoreo refresh ${onuExternalId}` });
    actions.push({ id: 'monitor_resync', type: 'button', label: '🛠️ Resync ONU', payload: `monitoreo resync ${onuExternalId}` });
    actions.push({ id: 'monitor_reboot', type: 'button', label: '🔌 Reiniciar ONU', payload: `monitoreo reboot ${onuExternalId}` });
  }
  actions.push({ id: 'monitor_new_search', type: 'button', label: 'Buscar otro cliente', payload: 'monitoreo cliente' });
  return actions;
}

function normalizeMonitorGraphType(value?: string): SmartoltGraphType {
  const v = String(value || '').toLowerCase().trim();
  if (v === 'hourly') return 'hourly';
  if (v === 'weekly') return 'weekly';
  if (v === 'monthly') return 'monthly';
  if (v === 'yearly') return 'yearly';
  return 'daily';
}

function monitorGraphTypeLabel(value?: string): string {
  const t = normalizeMonitorGraphType(value);
  if (t === 'hourly') return 'Hora';
  if (t === 'weekly') return 'Semana';
  if (t === 'monthly') return 'Mes';
  if (t === 'yearly') return 'Año';
  return 'Día';
}

function resolveOnuExternalIdFromDetail(detail: any): string | undefined {
  const payload = detail?.payload || {};
  return pickFirstString([
    detail?.uniqueExternalId,
    payload?.unique_external_id,
    payload?.uniqueExternalId,
    payload?.onu_external_id,
    payload?.onuExternalId,
    payload?.external_id,
    payload?.onu_id,
    payload?.id
  ]);
}

function findValueByKeyRegex(source: any, regex: RegExp, depth = 0): any {
  if (source === null || source === undefined || depth > 6) return undefined;
  if (typeof source !== 'object') return undefined;

  if (Array.isArray(source)) {
    for (const item of source) {
      const found = findValueByKeyRegex(item, regex, depth + 1);
      if (found !== undefined) return found;
    }
    return undefined;
  }

  for (const [key, value] of Object.entries(source)) {
    if (regex.test(String(key)) && value !== undefined && value !== null && typeof value !== 'object') {
      return value;
    }
  }

  for (const value of Object.values(source)) {
    const found = findValueByKeyRegex(value, regex, depth + 1);
    if (found !== undefined) return found;
  }

  return undefined;
}

function toCompactString(value: any): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') {
    const t = value.trim();
    return t || undefined;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    const txt = JSON.stringify(value);
    return txt && txt.length > 180 ? `${txt.slice(0, 180)}...` : txt;
  } catch {
    return String(value);
  }
}

function toDbmString(value: any): string | undefined {
  if (value === undefined || value === null) return undefined;
  const raw = String(value).trim();
  if (!raw) return undefined;
  if (/dbm/i.test(raw)) return raw.replace(/\s+/g, ' ').trim();
  const num = Number(raw.replace(',', '.'));
  if (!Number.isNaN(num)) {
    const text = Number.isInteger(num) ? String(num) : num.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
    return `${text} dBm`;
  }
  return raw;
}

function parseDbmNumber(value: any): number | undefined {
  if (value === undefined || value === null) return undefined;
  const raw = String(value).replace(',', '.').trim();
  if (!raw) return undefined;
  const match = raw.match(/-?\d+(?:\.\d+)?/);
  if (!match) return undefined;
  const parsed = Number(match[0]);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function classifyOnuSignalQuality(input: { signal1490?: string; signalValue?: string; rx?: string; statusSummary?: string }): { label: string; tone: string; detail?: string } {
  const dbm = parseDbmNumber(input.signal1490) ?? parseDbmNumber(input.signalValue) ?? parseDbmNumber(input.rx);

  if (dbm !== undefined) {
    const dbmText = Number.isInteger(dbm) ? `${dbm}` : dbm.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
    if (dbm > -8) return { label: 'Mala', tone: '🔴', detail: `RX ONU ${dbmText} dBm (potencia muy alta)` };
    if (dbm >= -18) return { label: 'Excelente', tone: '🟢', detail: `RX ONU ${dbmText} dBm` };
    if (dbm >= -23) return { label: 'Buena', tone: '🟢', detail: `RX ONU ${dbmText} dBm` };
    if (dbm >= -27) return { label: 'Regular', tone: '🟡', detail: `RX ONU ${dbmText} dBm` };
    return { label: 'Mala', tone: '🔴', detail: `RX ONU ${dbmText} dBm` };
  }

  const status = normalizeComparableText(String(input.statusSummary || ''));
  if (/critical|critico|critica|offline|caido|falla|error|down/.test(status)) return { label: 'Mala', tone: '🔴' };
  if (/regular|warning|alerta|inestable|degradado|degraded/.test(status)) return { label: 'Regular', tone: '🟡' };
  if (/very good|muy bueno|good|ok|online|up|estable|normal/.test(status)) return { label: 'Buena', tone: '🟢' };

  return { label: 'N/D', tone: '⚪' };
}

function buildWifiSignalRefreshActions(sn?: string): any[] {
  const cleanSn = String(sn || '').trim().toUpperCase();
  if (!cleanSn) return [];
  return [{ id: 'wifi_signal_refresh', type: 'button', label: '🔄 Refrescar señal ONU', payload: `wifi signal refresh sn ${cleanSn}` }];
}

function formatMonitorDate(value: any): string | undefined {
  const raw = toCompactString(value);
  if (!raw) return undefined;
  const parsed = new Date(raw);
  if (!Number.isNaN(parsed.getTime())) {
    return parsed.toLocaleDateString('es-CL');
  }
  return raw;
}

function extractDistanceFromText(value: any): string | undefined {
  if (value === undefined || value === null) return undefined;
  const raw = String(value);

  const parenMeters = raw.match(/\((\d{2,7}(?:[\.,]\d+)?)\s*m\)/i);
  if (parenMeters?.[1]) {
    const n = Number(parenMeters[1].replace(',', '.'));
    if (!Number.isNaN(n)) return `${Math.round(n)}m`;
  }

  const directMeters = raw.match(/(?:distance|distancia|ranging|range)?[^\d-]{0,12}(\d{2,7}(?:[\.,]\d+)?)\s*(?:m|mts|metros?)\b/i);
  if (directMeters?.[1]) {
    const n = Number(directMeters[1].replace(',', '.'));
    if (!Number.isNaN(n)) return `${Math.round(n)}m`;
  }

  const inKm = raw.match(/(\d+(?:[\.,]\d+)?)\s*km\b/i);
  if (inKm?.[1]) {
    const n = Number(inKm[1].replace(',', '.'));
    if (!Number.isNaN(n)) return `${Math.round(n * 1000)}m`;
  }

  return undefined;
}

function toMetersString(value: any): string | undefined {
  const extracted = extractDistanceFromText(value);
  if (extracted) return extracted;
  if (value === undefined || value === null) return undefined;
  const raw = String(value).trim();
  if (!raw) return undefined;
  const num = Number(raw.replace(',', '.'));
  if (!Number.isNaN(num) && num > 0 && num < 100000) {
    return `${Math.round(num)}m`;
  }
  return undefined;
}

function extractOnlineUptimeFromText(value: any): string | undefined {
  if (value === undefined || value === null) return undefined;
  const raw = String(value);

  const onlineWithAgo = raw.match(/online\s*\(([^)]+)\)/i);
  if (onlineWithAgo?.[1]) return onlineWithAgo[1].trim();

  const uptime = raw.match(/(?:uptime|up\s*time|tiempo\s+en\s+l[ií]nea|online\s*time)\s*[:\-]?\s*([^\n,;]+)/i);
  if (uptime?.[1]) return uptime[1].trim();

  const onlineSince = raw.match(/online\s+since\s+([^\n,;]+)/i);
  if (onlineSince?.[1]) return `Desde ${onlineSince[1].trim()}`;

  return undefined;
}

function normalizeWisphubServiceStatus(value: any, entity?: any): string | undefined {
  if (entity?.fecha_cancelacion) return 'Cancelado';
  const raw = toCompactString(value);
  if (!raw) return undefined;

  const normalized = raw
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

  if (/^\d+$/.test(normalized)) {
    if (normalized === '1') return 'Activo';
    if (normalized === '2') return 'Suspendido';
    if (normalized === '3') return 'Cancelado';
  }

  if (normalized.includes('cancel') || normalized.includes('baja') || normalized.includes('retir') || normalized.includes('inactiv')) return 'Cancelado';
  if (normalized.includes('suspend') || normalized.includes('cort') || normalized.includes('bloq') || normalized.includes('moros')) return 'Suspendido';
  if (normalized.includes('activ') || normalized.includes('habil') || normalized.includes('online') || normalized.includes('al dia') || normalized.includes('aldia')) return 'Activo';

  return raw;
}

function normalizeInvoicePaidStatus(value: any): string | undefined {
  const raw = toCompactString(value);
  if (!raw) return undefined;

  const normalized = raw
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

  if (normalized.includes('pagad') || normalized.includes('paid') || normalized.includes('al dia') || normalized.includes('aldia')) return 'Pagada';
  if (normalized.includes('pend') || normalized.includes('venc') || normalized.includes('deud') || normalized.includes('moros') || normalized.includes('impag') || normalized.includes('unpaid') || normalized.includes('no pag')) return 'No pagada';

  return raw;
}

function extractMonitorWisphubSummary(entity: any, clientApiPayload?: any): { wisphubServiceStatus?: string; lastInvoiceDate?: string; lastInvoicePaid?: string } {
  const raw = entity?.raw || {};
  const remote = clientApiPayload || {};

  const wisphubServiceStatus = normalizeWisphubServiceStatus(
    pickFirstString([
      remote?.estado,
      entity?.estado,
      findValueByKeyRegex(remote, /(^estado$|estado_?servicio|service_?status|status_?service)/i),
      findValueByKeyRegex(raw, /(^estado$|estado_?servicio|service_?status|status_?service)/i)
    ]),
    { ...(entity || {}), fecha_cancelacion: remote?.fecha_cancelacion || entity?.fecha_cancelacion }
  );

  const paidFlag = remote?.facturas_pagadas;
  const paidFromFlag = typeof paidFlag === 'boolean' ? (paidFlag ? 'Pagada' : 'No pagada') : undefined;

  const lastInvoiceDate = formatMonitorDate(
    pickFirstString([
      remote?.fecha_ultima_factura,
      remote?.fecha_factura,
      remote?.fecha_corte,
      remote?.fecha_registro,
      findValueByKeyRegex(remote, /(fecha.*(ultima|última).*factura|ultima.*factura.*fecha|last.*invoice.*date|invoice.*date|fecha_?factura|fecha.*ultimo.*pago|last.*payment.*date)/i),
      findValueByKeyRegex(raw, /(fecha.*(ultima|última).*factura|ultima.*factura.*fecha|last.*invoice.*date|invoice.*date|fecha_?factura|fecha.*ultimo.*pago|last.*payment.*date)/i)
    ])
  );

  const lastInvoicePaid = paidFromFlag || normalizeInvoicePaidStatus(
    pickFirstString([
      remote?.estado_facturas,
      entity?.estado_facturas,
      findValueByKeyRegex(remote, /(facturas?_?pagadas|estado.*factura|factura.*estado|invoice.*status|payment.*status|pagad|paid|pend|venc|deud|moros|impag|unpaid)/i),
      findValueByKeyRegex(raw, /(estado.*factura|factura.*estado|invoice.*status|payment.*status|pagad|paid|pend|venc|deud|moros|impag|unpaid)/i)
    ])
  );

  return { wisphubServiceStatus, lastInvoiceDate, lastInvoicePaid };
}

function extractTxFromFullStatus(fullStatusInfo: string | undefined, wavelength: '1310' | '1490'): string | undefined {
  if (!fullStatusInfo) return undefined;
  const lineRegex = new RegExp(`${wavelength}nm[^\\r\\n]*Tx\\s*:?\\s*(-?\\d+(?:\\.\\d+)?)`, 'i');
  const m = fullStatusInfo.match(lineRegex);
  return toDbmString(m?.[1]);
}

function persistGraphImage(buffer?: Buffer | null): string | undefined {
  if (!buffer || !Buffer.isBuffer(buffer) || buffer.length === 0) return undefined;
  const dataUrl = `data:image/png;base64,${buffer.toString('base64')}`;
  const saved = saveImageDataUrl(dataUrl);
  return saved?.webPath;
}

function buildMonitorGraphsSection(monitor: { signalGraphUrl?: string; trafficGraphUrl?: string }): string {
  const lines: string[] = [];
  const periodLabel = monitorGraphTypeLabel((monitor as any).graphType);
  if (monitor.signalGraphUrl) lines.push(`📈 **Gráfico señal (${periodLabel}):** [Ver](${monitor.signalGraphUrl})`);
  if (monitor.trafficGraphUrl) lines.push(`📊 **Gráfico tráfico (${periodLabel}):** [Ver](${monitor.trafficGraphUrl})`);
  return lines.length ? `\n${lines.join('\n')}` : '';
}

async function loadMonitorSmartoltData(onuExternalId: string, graphType: SmartoltGraphType = 'daily') {
  const normalizedGraphType = normalizeMonitorGraphType(graphType);

  // Ejecutamos secuencialmente para no disparar 6 requests simultáneos
  // que causan rate-limit / bloqueo de IP en SmartOLT.
  const safe = async <T>(fn: () => Promise<T>): Promise<{ status: 'fulfilled'; value: T } | { status: 'rejected'; reason: any }> => {
    try { return { status: 'fulfilled', value: await fn() }; }
    catch (reason) { return { status: 'rejected', reason }; }
  };

  const fullStatusRes  = await safe(() => getOnuFullStatusInfoByExternalId(onuExternalId));
  const detailsRes     = await safe(() => getOnuDetailsByExternalId(onuExternalId));
  const signalRes      = await safe(() => getOnuSignalByExternalId(onuExternalId));
  const runningRes     = await safe(() => getOnuRunningConfigByExternalId(onuExternalId));
  const signalGraphRes = await safe(() => getOnuSignalGraphByExternalId(onuExternalId, normalizedGraphType));
  const trafficGraphRes = await safe(() => getOnuTrafficGraphByExternalId(onuExternalId, normalizedGraphType));

  const fullStatus = fullStatusRes.status === 'fulfilled' ? fullStatusRes.value : null;
  const details = detailsRes.status === 'fulfilled' ? detailsRes.value : null;
  const signal = signalRes.status === 'fulfilled' ? signalRes.value : null;
  const runningConfig = runningRes.status === 'fulfilled' ? runningRes.value : null;
  const signalGraphUrl = signalGraphRes.status === 'fulfilled' ? persistGraphImage(signalGraphRes.value as Buffer) : undefined;
  const trafficGraphUrl = trafficGraphRes.status === 'fulfilled' ? persistGraphImage(trafficGraphRes.value as Buffer) : undefined;

  // Debug: log raw API responses to diagnose empty signal data
  try {
    console.log(`[loadMonitorSmartoltData] onuExternalId=${onuExternalId}`);
    console.log(`[loadMonitorSmartoltData] fullStatus keys:`, fullStatus ? Object.keys(fullStatus) : 'null', typeof fullStatus === 'string' ? fullStatus.slice(0, 300) : '');
    console.log(`[loadMonitorSmartoltData] details keys:`, details ? Object.keys(details) : 'null', typeof details === 'string' ? details.slice(0, 300) : '');
    console.log(`[loadMonitorSmartoltData] signal keys:`, signal ? Object.keys(signal) : 'null', typeof signal === 'string' ? signal.slice(0, 300) : '');
    console.log(`[loadMonitorSmartoltData] signal data:`, JSON.stringify(signal)?.slice(0, 500));
    console.log(`[loadMonitorSmartoltData] details data:`, JSON.stringify(details)?.slice(0, 500));
    console.log(`[loadMonitorSmartoltData] fullStatus data:`, JSON.stringify(fullStatus)?.slice(0, 500));
  } catch (e) { /* ignore logging errors */ }
  const fullStatusInfo = pickFirstString([fullStatus?.full_status_info, fullStatus?.fullStatusInfo]);
  const runningConfigText = pickFirstString([
    runningConfig?.running_config,
    runningConfig?.runningConfig,
    runningConfig?.config,
    runningConfig?.result
  ]);

  const signal1310 = toDbmString(pickFirstString([
    signal?.onu_signal_1310,
    signal?.signal_1310,
    details?.onu_details?.signal_1310,
    details?.signal_1310,
    findValueByKeyRegex(signal, /signal_?1310|1310.*rx|olt.*rx/i),
    findValueByKeyRegex(details, /signal_?1310|1310.*rx|olt.*rx/i)
  ]));

  const signal1490 = toDbmString(pickFirstString([
    signal?.onu_signal_1490,
    signal?.signal_1490,
    details?.onu_details?.signal_1490,
    details?.signal_1490,
    findValueByKeyRegex(signal, /signal_?1490|1490.*rx|onu.*rx/i),
    findValueByKeyRegex(details, /signal_?1490|1490.*rx|onu.*rx/i)
  ]));

  const signalValue = toCompactString(pickFirstString([
    signal?.onu_signal_value,
    details?.onu_details?.onu_signal_value,
    details?.onu_signal_value,
    signal1490 && signal1310 ? `ONU ${signal1490} / OLT ${signal1310}` : undefined
  ]));

  const statusSummary = toCompactString(
    pickFirstString([
      signal?.onu_signal,
      details?.onu_details?.signal,
      details?.status,
      details?.onu_status,
      fullStatus?.status,
      fullStatus?.onu_status,
      fullStatusInfo,
      details?.status,
      details?.onu_status,
      findValueByKeyRegex(fullStatus, /status|state/i),
      findValueByKeyRegex(details, /status|state/i)
    ])
  ) || 'N/D';

  const rx = toCompactString(pickFirstString([
    signalValue,
    signal1490 && signal1310 ? `ONU ${signal1490} / OLT ${signal1310}` : undefined,
    findValueByKeyRegex(signal, /(^rx$|optical.*rx|rx.*power|signal.*rx|rssi)/i),
    findValueByKeyRegex(details, /(^rx$|optical.*rx|rx.*power|signal.*rx|rssi)/i)
  ])) || 'N/D';

  const txOnu = toDbmString(pickFirstString([
    extractTxFromFullStatus(fullStatusInfo, '1310'),
    findValueByKeyRegex(signal, /(onu.*tx|tx.*onu|1310.*tx|^tx$)/i),
    findValueByKeyRegex(details, /(onu.*tx|tx.*onu|1310.*tx|^tx$)/i)
  ]));

  const txOlt = toDbmString(pickFirstString([
    extractTxFromFullStatus(fullStatusInfo, '1490'),
    findValueByKeyRegex(signal, /(olt.*tx|tx.*olt|1490.*tx)/i),
    findValueByKeyRegex(details, /(olt.*tx|tx.*olt|1490.*tx)/i)
  ]));

  const tx = toCompactString(pickFirstString([
    txOnu && txOlt ? `ONU ${txOnu} / OLT ${txOlt}` : undefined,
    txOnu,
    findValueByKeyRegex(signal, /(^tx$|optical.*tx|tx.*power|signal.*tx)/i)
  ])) || 'N/D';

  const distanceOltOnu = toMetersString(pickFirstString([
    findValueByKeyRegex(signal, /(distance|distancia|ranging|range|fiber.*length|line.*length)/i),
    findValueByKeyRegex(details, /(distance|distancia|ranging|range|fiber.*length|line.*length)/i),
    extractDistanceFromText(signalValue),
    extractDistanceFromText(fullStatusInfo),
    extractDistanceFromText(statusSummary)
  ]));

  const onlineUptime = toCompactString(pickFirstString([
    findValueByKeyRegex(fullStatus, /(uptime|online.*time|online_since|connected_since|time_online|duration)/i),
    findValueByKeyRegex(details, /(uptime|online.*time|online_since|connected_since|time_online|duration)/i),
    extractOnlineUptimeFromText(statusSummary),
    extractOnlineUptimeFromText(fullStatusInfo)
  ]));

  const failedApis: string[] = [];
  const resultEntries: Array<[string, { status: string; reason?: any }]> = [
    ['full_status', fullStatusRes],
    ['details', detailsRes],
    ['signal', signalRes],
    ['running_config', runningRes],
    [`signal_graph_${normalizedGraphType}`, signalGraphRes],
    [`traffic_graph_${normalizedGraphType}`, trafficGraphRes]
  ];
  for (const [name, r] of resultEntries) {
    if (r.status === 'rejected') {
      failedApis.push(`${name}: ${(r as any).reason?.message || 'error'}`);
    }
  }

  return {
    statusSummary,
    rx,
    tx,
    distanceOltOnu,
    onlineUptime,
    signalValue,
    signal1310,
    signal1490,
    runningConfig: runningConfigText,
    fullStatusInfo,
    graphType: normalizedGraphType,
    signalGraphUrl,
    trafficGraphUrl,
    failedApis,
    raw: {
      fullStatus,
      details,
      signal,
      runningConfig,
      graphType: normalizedGraphType,
      signalGraphUrl,
      trafficGraphUrl
    }
  };
}

async function loadWifiSignalCheckBySn(snInput: string) {
  const sn = String(snInput || '').trim().toUpperCase();
  if (!sn) throw new Error('SN requerido');

  let onuExternalId = sn;
  try {
    const bySerial = await getOnuBySerial(sn);
    const resolvedExternalId = pickFirstString([
      bySerial?.onu_external_id,
      bySerial?.onuExternalId,
      bySerial?.unique_external_id,
      bySerial?.uniqueExternalId,
      bySerial?.external_id,
      bySerial?.externalId,
      findValueByKeyRegex(bySerial, /(onu_?external_?id|unique_?external_?id|external_?id)/i)
    ]);
    if (resolvedExternalId) onuExternalId = resolvedExternalId;
  } catch {
  }

  const monitor = await loadMonitorSmartoltData(onuExternalId, 'daily');
  const signalLine = monitor.signalValue || monitor.rx || 'N/D';
  const quality = classifyOnuSignalQuality({
    signal1490: monitor.signal1490,
    signalValue: monitor.signalValue,
    rx: monitor.rx,
    statusSummary: monitor.statusSummary
  });

  return {
    sn,
    onuExternalId,
    monitor,
    signalLine,
    quality
  };
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
      where: { userId: Number(userId), deletedByUserAt: IsNull() },
      order: { createdAt: 'DESC' },
      take: 50 // Límite razonable
    });
    return res.json({ sessions });
  } catch (error) {
    console.error('Error fetching sessions:', error);
    return res.status(500).json({ error: 'Error interno al cargar sesiones' });
  }
}

export async function deleteUserSession(req: any, res: any) {
  const userId = req.session?.userId;
  if (!userId) return res.status(401).json({ error: 'unauthenticated' });

  const sessionId = Number(req.params.sessionId);
  if (!Number.isFinite(sessionId) || sessionId <= 0) {
    return res.status(400).json({ error: 'invalid_session_id' });
  }

  try {
    const sessionRepo = AppDataSource.getRepository(ChatSession);
    const chatSession = await sessionRepo.findOne({
      where: { id: sessionId, userId: Number(userId), deletedByUserAt: IsNull() }
    });

    if (!chatSession) return res.status(404).json({ error: 'session_not_found' });

    chatSession.deletedByUserAt = new Date();
    await sessionRepo.save(chatSession);

    if (req.session?.chatContexts) delete req.session.chatContexts[String(sessionId)];
    if (Number(req.session?.activeChatContextId) === sessionId) {
      CHAT_CONTEXT_KEYS.forEach((k) => {
        req.session[k] = undefined;
      });
      req.session.activeChatContextId = undefined;
    }

    invalidateSearchCache(Number(userId));
    return res.json({ ok: true, sessionId });
  } catch (error) {
    console.error('Error soft-deleting session:', error);
    return res.status(500).json({ error: 'Error interno al borrar sesión' });
  }
}

export async function deleteUserMessage(req: any, res: any) {
  const userId = req.session?.userId;
  if (!userId) return res.status(401).json({ error: 'unauthenticated' });

  const messageId = Number(req.params.messageId);
  if (!Number.isFinite(messageId) || messageId <= 0) {
    return res.status(400).json({ error: 'invalid_message_id' });
  }

  try {
    const msgRepo = AppDataSource.getRepository(ChatMessage);
    const msg = await msgRepo.findOne({
      where: { id: messageId, userId: Number(userId), deletedByUserAt: IsNull() }
    });

    if (!msg) return res.status(404).json({ error: 'message_not_found' });

    msg.deletedByUserAt = new Date();
    await msgRepo.save(msg);

    invalidateSearchCache(Number(userId));
    return res.json({ ok: true, messageId, sessionId: msg.sessionId });
  } catch (error) {
    console.error('Error soft-deleting message:', error);
    return res.status(500).json({ error: 'Error interno al borrar mensaje' });
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

  let activeSessionId = sessionId ? Number(sessionId) : null;
  if (sessionId && (!Number.isFinite(activeSessionId) || Number(activeSessionId) <= 0)) {
    return res.status(400).json({ error: 'invalid_session_id' });
  }

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
    req.session.lastSelectedEmail = undefined;
    req.session.lastSelectedEmailCc = undefined;
    req.session.pendingAuth = undefined;
    req.session.pendingPhotos = undefined;
    req.session.lastAuthNameUsed = undefined;
    req.session.lastContextType = undefined;
    req.session.lastSearchTerm = undefined;
    req.session.searchMode = undefined;
    req.session.changeOnuFlowMode = undefined;
    req.session.pendingChangeOnuClientSearch = undefined;
    req.session.pendingChangeOnu = undefined;
    req.session.wifiFlowMode = undefined;
    req.session.pendingWifiClientSearch = undefined;
    req.session.pendingWifiChange = undefined;
    req.session.monitorClientFlowMode = undefined;
    req.session.pendingMonitorClientSearch = undefined;
    req.session.pendingMonitorClient = undefined;
    req.session.monitorGraphType = undefined;

    await saveChatContext(req.session, activeSessionId);
  } else {
    const existingSession = await sessionRepo.findOne({
      where: { id: Number(activeSessionId), userId: Number(userId), deletedByUserAt: IsNull() }
    });
    if (!existingSession) return res.status(404).json({ error: 'session_not_found' });

    if (Number(req.session?.activeChatContextId) !== Number(activeSessionId)) {
      await loadChatContext(req.session, Number(activeSessionId));
    }
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
  
  // Invalidar cache de búsqueda del usuario para que obtenga resultados actualizados
  invalidateSearchCache(Number(userId));

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
  // Permitir refresh actions aunque content sea vacío, siempre que haya actions
  const hasActions = Array.isArray(req.body.actions) && req.body.actions.length > 0;
  if (!content && !imageDataUrl && !hasActions) return res.status(400).json({ error: 'empty' });

  const msgRepo = AppDataSource.getRepository(ChatMessage);
  const sessionRepo = AppDataSource.getRepository(ChatSession);

  // 1. Garantizar Sesión (por si se llama directo a respond sin addMessage)
  let activeSessionId = sessionId ? Number(sessionId) : null;
  if (sessionId && (!Number.isFinite(activeSessionId) || Number(activeSessionId) <= 0)) {
    return res.status(400).json({ error: 'invalid_session_id' });
  }
  if (!activeSessionId) {
    const title = content ? content.substring(0, 40) : 'Conversación sin título';
    const newS = await sessionRepo.save(sessionRepo.create({ userId: Number(userId), title }));
    activeSessionId = newS.id;

    // Reset session-scoped context for a new chat
    session.lastSelectedClientIdServicio = undefined;
    session.lastSelectedInstallationId = undefined;
    session.lastSelectedIsPyme = undefined;
    session.lastSelectedEmail = undefined;
    session.lastSelectedEmailCc = undefined;
    session.pendingAuth = undefined;
    session.pendingPhotos = undefined;
    session.lastAuthNameUsed = undefined;
    session.lastContextType = undefined;
    session.lastSearchTerm = undefined;
    session.searchMode = undefined;
    session.changeOnuFlowMode = undefined;
    session.pendingChangeOnuClientSearch = undefined;
    session.pendingChangeOnu = undefined;
    session.wifiFlowMode = undefined;
    session.pendingWifiClientSearch = undefined;
    session.pendingWifiChange = undefined;
    session.monitorClientFlowMode = undefined;
    session.pendingMonitorClientSearch = undefined;
    session.pendingMonitorClient = undefined;
    session.monitorGraphType = undefined;

    await saveChatContext(session, activeSessionId);
  } else {
    const existingSession = await sessionRepo.findOne({
      where: { id: Number(activeSessionId), userId: Number(userId), deletedByUserAt: IsNull() }
    });
    if (!existingSession) return res.status(404).json({ error: 'session_not_found' });

    if (Number(session?.activeChatContextId) !== Number(activeSessionId)) {
      await loadChatContext(session, Number(activeSessionId));
    }
  }

  // 2. Manejo de Imagen: Guardar físicamente
  const savedImage = saveImageDataUrl(imageDataUrl);
  const webPath = savedImage ? savedImage.webPath : undefined;

  // --- DETECCIÓN DE ACCIÓN DE REFRESCO (CAMBIO NUEVO) ---
  const lower = (content || '').toLowerCase().trim();

  const monitorRefreshByText = /^monitoreo\s+(refresh|resync|reboot|reiniciar|grafico|gr[aá]fico|periodo|per[ií]odo)\b/i.test(lower);
  const wifiSignalRefreshByText = /^wifi\s+signal\s+refresh\b/i.test(lower);
  const monitorRefreshByActions = Array.isArray(req.body.actions) && req.body.actions.some((a: any) => {
    const id = String(a?.id || '').toLowerCase();
    const value = String(a?.value || a?.payload || '').toLowerCase();
    if (id.startsWith('monitor_graph')) return true;
    if (['monitor_refresh', 'monitor-refresh', 'monitor_resync', 'monitor-resync', 'monitor_reboot', 'monitor-reboot'].includes(id)) return true;
    return /^monitoreo\s+(refresh|resync|reboot|reiniciar|grafico|gr[aá]fico|periodo|per[ií]odo)\b/i.test(value);
  });
  const wifiSignalRefreshByActions = Array.isArray(req.body.actions) && req.body.actions.some((a: any) => {
    const id = String(a?.id || '').toLowerCase();
    const value = String(a?.value || a?.payload || '').toLowerCase();
    if (['wifi_signal_refresh', 'wifi-signal-refresh'].includes(id)) return true;
    return /^wifi\s+signal\s+refresh\b/i.test(value);
  });

  // Detectamos si el payload o el contenido indican una acción de actualizar tabla
  const isRefreshAction =
    ['auth refresh onu-list', 'change refresh onu-list', 'instalaciones sync', 'sync instalaciones', 'refresh'].includes(lower) ||
    monitorRefreshByText ||
    wifiSignalRefreshByText ||
    monitorRefreshByActions ||
    wifiSignalRefreshByActions ||
    (Array.isArray(req.body.actions) && req.body.actions.some((a: any) =>
      ['refresh', 'instalaciones sync', 'auth refresh onu-list', 'change refresh onu-list', 'wifi signal refresh', 'monitoreo reboot'].includes(a.value || a.payload)
    ));

  // --- DETECTAR Y GUARDAR FORMULARIOS ---
  let userMessageActions = undefined;

  if (collected || (content && content.toLowerCase().startsWith('wifi apply'))) {
    if (Array.isArray(submittedActions)) {
      userMessageActions = freezeFormActions(submittedActions, collected || req.body);
    }
    else if (content.toLowerCase().startsWith('wifi apply')) {
      const ssidMatch = content.match(/ssid\s+(.+?)(?=\s+pass)/i);
      const passMatch = content.match(/pass\s+(.+?)(?=\s+contract_id|$)/i);
      const rawSsid = ssidMatch ? ssidMatch[1] : (typeof req.body.wifi_ssid === 'string' ? req.body.wifi_ssid : (typeof req.body.wifi_onu_ssid === 'string' ? req.body.wifi_onu_ssid : undefined));
      const formattedSsid = sanitizeSsid(rawSsid) ?? (rawSsid ? rawSsid.trim() : '***');
      const pass = passMatch ? passMatch[1] : (req.body.wifi_pass || req.body.wifi_onu_pass || '***');

      userMessageActions = [
        { type: 'input', label: 'SSID Configurado', value: formattedSsid, disabled: true, id: 'wifi_ssid' },
        { type: 'input', label: 'Password Configurado', value: pass, disabled: true, id: 'wifi_pass' }
      ];
    }
  }

  // 3. Guardar mensaje del usuario (Vinculado a la Session DB)
  // --- CAMBIO: NO GUARDAR si es una acción de refresco para no ensuciar el chat ---
  if (!isRefreshAction) {
    await msgRepo.save(msgRepo.create({
      userId: Number(userId),
      sessionId: Number(activeSessionId), // <---
      role: 'user',
      content: content || '[Img]',
      imageUrl: webPath,
      actions: userMessageActions,
      metadata: collected ? { submittedData: collected } : undefined
    }));
  }

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
        // PRIORIDAD: si la sesión actual corresponde al target, preferir `session.lastAuthNameUsed`
        let clienteUsuario: string | null = null;
        try {
          const clientRepo = AppDataSource.getRepository(Client);
          const clientEntity = await clientRepo.findOne({ where: { id_servicio: targetId } });
          if (clientEntity && clientEntity.usuario) clienteUsuario = clientEntity.usuario;
        } catch (e) {
          console.error('Error buscando cliente para obtener usuario Geonet:', e);
        }

        const sessionTargetMatches = Boolean(
          session && (
            String(session.lastSelectedClientIdServicio) === String(targetId) ||
            String(session.lastSelectedInstallationId) === String(targetId) ||
            (session.pendingAuth && (session.pendingAuth.clientIdServicio == targetId || session.pendingAuth.installationId == targetId))
          )
        );

        let fullGeonetUser = '';
        if (session?.lastAuthNameUsed && sessionTargetMatches) {
          fullGeonetUser = session.lastAuthNameUsed;
        } else if (clienteUsuario) {
          fullGeonetUser = clienteUsuario;
        } else {
          fullGeonetUser = `${session.lastAuthNameUsed || 'tecnico'}@geonet`;
        }
        if (fullGeonetUser && !String(fullGeonetUser).toLowerCase().includes('@geonet')) {
          fullGeonetUser = `${String(fullGeonetUser).trim()}@geonet`;
        }

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
      // lower ya está definido arriba

      // Evitar llamadas pesadas cuando la acción es solo un "refresh".
      if (!isRefreshAction) {
        const structured = await buildStructuredResponse(prompt);
        finalContent = structured.content;
        actionsOut = structured.actions as any[];
        assistantMetadata = null;
      }

      // --- CLIENT MONITOR FLOW: START ---
      if (/(monitoreo\s+cliente|monitor(?:eo)?\s+cliente)/i.test(lower) && !/(buscar|select|seleccionar)/i.test(lower)) {
        session.monitorClientFlowMode = true;
        session.pendingMonitorClientSearch = true;
        session.pendingMonitorClient = undefined;
        session.monitorGraphType = 'daily';
        session.changeOnuFlowMode = false;
        session.pendingChangeOnuClientSearch = false;
        session.pendingChangeOnu = undefined;
        session.wifiFlowMode = false;
        session.pendingWifiClientSearch = false;
        session.pendingWifiChange = undefined;
        session.lastContextType = 'monitor-client-search';
        finalContent = 'Perfecto. Ingresa el nombre completo y/o el RUT para buscar al cliente en monitoreo.';
        actionsOut = buildMonitorClientSearchActions();
      }
      // --- CLIENT MONITOR FLOW: SEARCH ---
      else if (lower.startsWith('monitoreo buscar') || (session.pendingMonitorClientSearch && (collected?.monitor_search_fullname || collected?.monitor_search_rut))) {
        const nameMatch = prompt.match(/nombre\s+(.+?)(?=\s+rut|$)/i);
        const rutMatch = prompt.match(/rut\s+([^\s]+)/i);

        let fullName = (collected?.monitor_search_fullname || nameMatch?.[1] || '').trim();
        let rut = (collected?.monitor_search_rut || rutMatch?.[1] || '').trim();

        if (fullName.includes('{monitor_search_fullname}')) fullName = '';
        if (rut.includes('{monitor_search_rut}')) rut = '';

        if (!fullName && !rut) {
          finalContent = 'Ingresa nombre completo y/o RUT para buscar al cliente.';
          actionsOut = buildMonitorClientSearchActions();
          session.pendingMonitorClientSearch = true;
          session.monitorClientFlowMode = true;
        } else {
          const clients = await findClientsByNameRutWithSync(fullName, rut);
          session.pendingMonitorClientSearch = false;
          session.monitorClientFlowMode = true;
          if (!session.monitorGraphType) session.monitorGraphType = 'daily';
          session.lastContextType = 'monitor-client-search';

          if (clients.length) {
            const fmt = formatEntityList(clients, 'client');
            const table = buildClientsTable(clients);
            finalContent = `📡 **Monitoreo Cliente**\n\nResultados para "${[fullName, rut].filter(Boolean).join(' / ') || 'búsqueda'}":\n\n${table}`;
            actionsOut = fmt.actions.map(a => ({
              ...a,
              payload: String(a.payload || '').trim() + ' monitor'
            }));
          } else {
            finalContent = 'No encontré clientes con esos datos. Intenta nuevamente.';
            actionsOut = buildMonitorClientSearchActions();
            session.pendingMonitorClientSearch = true;
          }
        }
      }
      // --- CLIENT MONITOR FLOW: CHANGE GRAPH PERIOD ---
      else if (lower.startsWith('monitoreo grafico') || lower.startsWith('monitoreo gráfico') || lower.startsWith('monitoreo periodo') || lower.startsWith('monitoreo período') || pickActionValue(req.body?.actions, ['monitor_graph_hourly', 'monitor_graph_daily', 'monitor_graph_weekly', 'monitor_graph_monthly', 'monitor_graph_yearly'])) {
        const actionGraph = pickActionValue(req.body?.actions, ['monitor_graph_hourly', 'monitor_graph_daily', 'monitor_graph_weekly', 'monitor_graph_monthly', 'monitor_graph_yearly']);
        const source = String(actionGraph || prompt || '');
        const graphMatch = source.match(/(?:grafico|gr[aá]fico|periodo|per[ií]odo)\s+(hourly|daily|weekly|monthly|yearly)/i);
        const graphType = normalizeMonitorGraphType(graphMatch?.[1] || session?.monitorGraphType || 'daily');
        const onuExternalId = (source.match(/(?:hourly|daily|weekly|monthly|yearly)\s+([^\s]+)/i)?.[1] || session?.pendingMonitorClient?.onuExternalId || '').trim();

        if (!onuExternalId) {
          finalContent = '⚠️ No tengo el ID de ONU para cambiar el período del gráfico. Vuelve a seleccionar el cliente en monitoreo.';
          actionsOut = buildMonitorPanelActions();
        } else {
          session.monitorGraphType = graphType;
          const monitor = await loadMonitorSmartoltData(onuExternalId, graphType);
          let selected = session?.pendingMonitorClient || {};
          if (selected?.clientIdServicio) {
            const clientApiPayload = await getClientByServiceId(selected.clientIdServicio).catch(() => null);
            const wisphubSummary = extractMonitorWisphubSummary(selected, clientApiPayload || undefined);
            selected = { ...selected, ...wisphubSummary };
            session.pendingMonitorClient = { ...(session.pendingMonitorClient || {}), ...wisphubSummary };
          }
          const graphSection = buildMonitorGraphsSection(monitor);
          const apiWarnings = monitor.failedApis.length ? `\n\n⚠️ APIs con error: ${monitor.failedApis.join(' | ')}` : '';
          const lastInvoiceLabel = selected.lastInvoiceDate
            ? `${selected.lastInvoiceDate}${selected.lastInvoicePaid ? ` (${selected.lastInvoicePaid})` : ''}`
            : (selected.lastInvoicePaid || 'N/D');

          finalContent = `📡 **Panel Monitoreo SmartOLT**\n\n👤 **Cliente:** ${selected.clientName || 'N/D'}\n🆔 **Servicio:** ${selected.clientIdServicio || 'N/D'}\n🌍 **IP:** ${selected.ip || 'N/D'}\n🛰️ **Estado WispHub:** ${selected.wisphubServiceStatus || 'N/D'}\n💳 **Última factura:** ${lastInvoiceLabel}\n🔢 **ONU External ID:** ${onuExternalId}\n🗂️ **Período gráficos:** ${monitorGraphTypeLabel(graphType)}\n📶 **Estado ONU:** ${monitor.statusSummary}\n⏱️ **Tiempo en línea:** ${monitor.onlineUptime || 'N/D'}\n📏 **Distancia ONU-OLT:** ${monitor.distanceOltOnu || 'N/D'}\n📥 **RX:** ${monitor.rx}\n📤 **TX:** ${monitor.tx}${graphSection}${apiWarnings}`;
          actionsOut = buildMonitorPanelActions(onuExternalId);
          assistantMetadata = {
            flow: 'monitor-client',
            monitor: {
              ...selected,
              onuExternalId,
              graphType,
              refreshedAt: new Date().toISOString(),
              statusSummary: monitor.statusSummary,
              rx: monitor.rx,
              tx: monitor.tx,
              distanceOltOnu: monitor.distanceOltOnu,
              onlineUptime: monitor.onlineUptime,
              signalValue: monitor.signalValue,
              signal1310: monitor.signal1310,
              signal1490: monitor.signal1490,
              runningConfig: monitor.runningConfig,
              fullStatusInfo: monitor.fullStatusInfo,
              signalGraphUrl: monitor.signalGraphUrl,
              trafficGraphUrl: monitor.trafficGraphUrl,
              smartolt: monitor.raw,
              failedApis: monitor.failedApis
            }
          };
        }
      }
      // --- CLIENT MONITOR FLOW: REFRESH PANEL ---
      else if (lower.startsWith('monitoreo refresh') || pickActionValue(req.body?.actions, ['monitor_refresh', 'monitor-refresh'])) {
        const actionRefresh = pickActionValue(req.body?.actions, ['monitor_refresh', 'monitor-refresh']);
        const source = String(actionRefresh || prompt || '');
        const onuExternalId = (source.match(/refresh\s+([^\s]+)/i)?.[1] || session?.pendingMonitorClient?.onuExternalId || '').trim();

        if (!onuExternalId) {
          finalContent = '⚠️ No tengo el ID de ONU para refrescar monitoreo. Vuelve a seleccionar el cliente en el flujo de monitoreo.';
          actionsOut = buildMonitorPanelActions();
        } else {
          const graphType = normalizeMonitorGraphType(session?.monitorGraphType || 'daily');
          const monitor = await loadMonitorSmartoltData(onuExternalId, graphType);
          let selected = session?.pendingMonitorClient || {};
          if (selected?.clientIdServicio) {
            const clientApiPayload = await getClientByServiceId(selected.clientIdServicio).catch(() => null);
            const wisphubSummary = extractMonitorWisphubSummary(selected, clientApiPayload || undefined);
            selected = { ...selected, ...wisphubSummary };
            session.pendingMonitorClient = { ...(session.pendingMonitorClient || {}), ...wisphubSummary };
          }
          const graphSection = buildMonitorGraphsSection(monitor);
          const apiWarnings = monitor.failedApis.length ? `\n\n⚠️ APIs con error: ${monitor.failedApis.join(' | ')}` : '';
          const lastInvoiceLabel = selected.lastInvoiceDate
            ? `${selected.lastInvoiceDate}${selected.lastInvoicePaid ? ` (${selected.lastInvoicePaid})` : ''}`
            : (selected.lastInvoicePaid || 'N/D');

          finalContent = `📡 **Panel Monitoreo SmartOLT**\n\n👤 **Cliente:** ${selected.clientName || 'N/D'}\n🆔 **Servicio:** ${selected.clientIdServicio || 'N/D'}\n🌍 **IP:** ${selected.ip || 'N/D'}\n🛰️ **Estado WispHub:** ${selected.wisphubServiceStatus || 'N/D'}\n💳 **Última factura:** ${lastInvoiceLabel}\n🔢 **ONU External ID:** ${onuExternalId}\n🗂️ **Período gráficos:** ${monitorGraphTypeLabel(graphType)}\n📶 **Estado ONU:** ${monitor.statusSummary}\n⏱️ **Tiempo en línea:** ${monitor.onlineUptime || 'N/D'}\n📏 **Distancia ONU-OLT:** ${monitor.distanceOltOnu || 'N/D'}\n📥 **RX:** ${monitor.rx}\n📤 **TX:** ${monitor.tx}${graphSection}${apiWarnings}`;
          actionsOut = buildMonitorPanelActions(onuExternalId);
          assistantMetadata = {
            flow: 'monitor-client',
            monitor: {
              ...selected,
              onuExternalId,
              graphType,
              refreshedAt: new Date().toISOString(),
              statusSummary: monitor.statusSummary,
              rx: monitor.rx,
              tx: monitor.tx,
              distanceOltOnu: monitor.distanceOltOnu,
              onlineUptime: monitor.onlineUptime,
              signalValue: monitor.signalValue,
              signal1310: monitor.signal1310,
              signal1490: monitor.signal1490,
              runningConfig: monitor.runningConfig,
              fullStatusInfo: monitor.fullStatusInfo,
              signalGraphUrl: monitor.signalGraphUrl,
              trafficGraphUrl: monitor.trafficGraphUrl,
              smartolt: monitor.raw,
              failedApis: monitor.failedApis
            }
          };
        }
      }
      // --- CLIENT MONITOR FLOW: REBOOT ONU ---
      else if (lower.startsWith('monitoreo reboot') || lower.startsWith('monitoreo reiniciar') || pickActionValue(req.body?.actions, ['monitor_reboot', 'monitor-reboot'])) {
        const actionReboot = pickActionValue(req.body?.actions, ['monitor_reboot', 'monitor-reboot']);
        const source = String(actionReboot || prompt || '');
        const onuExternalId = (source.match(/(?:reboot|reiniciar)\s+([^\s]+)/i)?.[1] || session?.pendingMonitorClient?.onuExternalId || '').trim();

        if (!onuExternalId) {
          finalContent = '⚠️ No tengo el ID de ONU para ejecutar reinicio. Vuelve a seleccionar el cliente en monitoreo.';
          actionsOut = buildMonitorPanelActions();
        } else {
          const rebootResult = await rebootOnuByExternalId(onuExternalId).catch((e: any) => ({ error: e?.message || 'error' }));
          const graphType = normalizeMonitorGraphType(session?.monitorGraphType || 'daily');
          const monitor = await loadMonitorSmartoltData(onuExternalId, graphType);
          let selected = session?.pendingMonitorClient || {};
          if (selected?.clientIdServicio) {
            const clientApiPayload = await getClientByServiceId(selected.clientIdServicio).catch(() => null);
            const wisphubSummary = extractMonitorWisphubSummary(selected, clientApiPayload || undefined);
            selected = { ...selected, ...wisphubSummary };
            session.pendingMonitorClient = { ...(session.pendingMonitorClient || {}), ...wisphubSummary };
          }
          const failedReboot = !!(rebootResult && (rebootResult as any).error);
          const rebootLine = failedReboot
            ? `❌ **Reinicio ONU:** ${(rebootResult as any).error}`
            : `✅ **Reinicio ONU enviado** para ${onuExternalId}`;
          const graphSection = buildMonitorGraphsSection(monitor);
          const apiWarnings = monitor.failedApis.length ? `\n\n⚠️ APIs con error: ${monitor.failedApis.join(' | ')}` : '';
          const lastInvoiceLabel = selected.lastInvoiceDate
            ? `${selected.lastInvoiceDate}${selected.lastInvoicePaid ? ` (${selected.lastInvoicePaid})` : ''}`
            : (selected.lastInvoicePaid || 'N/D');

          finalContent = `📡 **Panel Monitoreo SmartOLT**\n\n${rebootLine}\n\n👤 **Cliente:** ${selected.clientName || 'N/D'}\n🆔 **Servicio:** ${selected.clientIdServicio || 'N/D'}\n🌍 **IP:** ${selected.ip || 'N/D'}\n🛰️ **Estado WispHub:** ${selected.wisphubServiceStatus || 'N/D'}\n💳 **Última factura:** ${lastInvoiceLabel}\n🔢 **ONU External ID:** ${onuExternalId}\n🗂️ **Período gráficos:** ${monitorGraphTypeLabel(graphType)}\n📶 **Estado ONU:** ${monitor.statusSummary}\n⏱️ **Tiempo en línea:** ${monitor.onlineUptime || 'N/D'}\n📏 **Distancia ONU-OLT:** ${monitor.distanceOltOnu || 'N/D'}\n📥 **RX:** ${monitor.rx}\n📤 **TX:** ${monitor.tx}${graphSection}${apiWarnings}`;
          actionsOut = buildMonitorPanelActions(onuExternalId);
          assistantMetadata = {
            flow: 'monitor-client',
            monitor: {
              ...selected,
              onuExternalId,
              graphType,
              refreshedAt: new Date().toISOString(),
              rebootResult,
              statusSummary: monitor.statusSummary,
              rx: monitor.rx,
              tx: monitor.tx,
              distanceOltOnu: monitor.distanceOltOnu,
              onlineUptime: monitor.onlineUptime,
              signalValue: monitor.signalValue,
              signal1310: monitor.signal1310,
              signal1490: monitor.signal1490,
              runningConfig: monitor.runningConfig,
              fullStatusInfo: monitor.fullStatusInfo,
              signalGraphUrl: monitor.signalGraphUrl,
              trafficGraphUrl: monitor.trafficGraphUrl,
              smartolt: monitor.raw,
              failedApis: monitor.failedApis
            }
          };
        }
      }
      // --- CLIENT MONITOR FLOW: RESYNC ONU ---
      else if (lower.startsWith('monitoreo resync') || pickActionValue(req.body?.actions, ['monitor_resync', 'monitor-resync'])) {
        const actionResync = pickActionValue(req.body?.actions, ['monitor_resync', 'monitor-resync']);
        const source = String(actionResync || prompt || '');
        const onuExternalId = (source.match(/resync\s+([^\s]+)/i)?.[1] || session?.pendingMonitorClient?.onuExternalId || '').trim();

        if (!onuExternalId) {
          finalContent = '⚠️ No tengo el ID de ONU para ejecutar resync. Vuelve a seleccionar el cliente en monitoreo.';
          actionsOut = buildMonitorPanelActions();
        } else {
          const resyncResult = await resyncOnuConfigByExternalId(onuExternalId).catch((e: any) => ({ error: e?.message || 'error' }));
          const graphType = normalizeMonitorGraphType(session?.monitorGraphType || 'daily');
          const monitor = await loadMonitorSmartoltData(onuExternalId, graphType);
          let selected = session?.pendingMonitorClient || {};
          if (selected?.clientIdServicio) {
            const clientApiPayload = await getClientByServiceId(selected.clientIdServicio).catch(() => null);
            const wisphubSummary = extractMonitorWisphubSummary(selected, clientApiPayload || undefined);
            selected = { ...selected, ...wisphubSummary };
            session.pendingMonitorClient = { ...(session.pendingMonitorClient || {}), ...wisphubSummary };
          }
          const failedResync = !!(resyncResult && (resyncResult as any).error);
          const resyncLine = failedResync
            ? `❌ **Resync:** ${(resyncResult as any).error}`
            : `✅ **Resync ejecutado** para ONU ${onuExternalId}`;
          const graphSection = buildMonitorGraphsSection(monitor);
          const apiWarnings = monitor.failedApis.length ? `\n\n⚠️ APIs con error: ${monitor.failedApis.join(' | ')}` : '';
          const lastInvoiceLabel = selected.lastInvoiceDate
            ? `${selected.lastInvoiceDate}${selected.lastInvoicePaid ? ` (${selected.lastInvoicePaid})` : ''}`
            : (selected.lastInvoicePaid || 'N/D');

          finalContent = `📡 **Panel Monitoreo SmartOLT**\n\n${resyncLine}\n\n👤 **Cliente:** ${selected.clientName || 'N/D'}\n🆔 **Servicio:** ${selected.clientIdServicio || 'N/D'}\n🌍 **IP:** ${selected.ip || 'N/D'}\n🛰️ **Estado WispHub:** ${selected.wisphubServiceStatus || 'N/D'}\n💳 **Última factura:** ${lastInvoiceLabel}\n🔢 **ONU External ID:** ${onuExternalId}\n🗂️ **Período gráficos:** ${monitorGraphTypeLabel(graphType)}\n📶 **Estado ONU:** ${monitor.statusSummary}\n⏱️ **Tiempo en línea:** ${monitor.onlineUptime || 'N/D'}\n📏 **Distancia ONU-OLT:** ${monitor.distanceOltOnu || 'N/D'}\n📥 **RX:** ${monitor.rx}\n📤 **TX:** ${monitor.tx}${graphSection}${apiWarnings}`;
          actionsOut = buildMonitorPanelActions(onuExternalId);
          assistantMetadata = {
            flow: 'monitor-client',
            monitor: {
              ...selected,
              onuExternalId,
              graphType,
              refreshedAt: new Date().toISOString(),
              resyncResult,
              statusSummary: monitor.statusSummary,
              rx: monitor.rx,
              tx: monitor.tx,
              distanceOltOnu: monitor.distanceOltOnu,
              onlineUptime: monitor.onlineUptime,
              signalValue: monitor.signalValue,
              signal1310: monitor.signal1310,
              signal1490: monitor.signal1490,
              runningConfig: monitor.runningConfig,
              fullStatusInfo: monitor.fullStatusInfo,
              signalGraphUrl: monitor.signalGraphUrl,
              trafficGraphUrl: monitor.trafficGraphUrl,
              smartolt: monitor.raw,
              failedApis: monitor.failedApis
            }
          };
        }
      }
      // --- CHANGE ONU FLOW: START ---
      else if (/(cambiar\s+onu|cambio\s+onu|cambio\s+de\s+onu)/i.test(lower) && !/(buscar|submit)/i.test(lower)) {
        session.monitorClientFlowMode = false;
        session.pendingMonitorClientSearch = false;
        session.pendingMonitorClient = undefined;
        session.monitorGraphType = undefined;
        session.changeOnuFlowMode = true;
        session.pendingChangeOnuClientSearch = true;
        session.pendingChangeOnu = { stage: 'search' };
        finalContent = 'Perfecto. Ingresa el nombre completo y/o el RUT para buscar al cliente y cambiar la ONU.';
        actionsOut = [
          { id: 'change_fullname', type: 'input', label: 'Nombre Completo', placeholder: 'Ej: Juan Pérez', payload: 'cambio onu buscar nombre {change_fullname} rut {change_rut}' },
          { id: 'change_rut', type: 'input', label: 'RUT', placeholder: 'Ej: 12.345.678-9', payload: 'cambio onu buscar nombre {change_fullname} rut {change_rut}' },
          { id: 'change_submit', type: 'button', label: 'Buscar Cliente', payload: 'cambio onu buscar nombre {change_fullname} rut {change_rut}' }
        ];
      }
      // --- CHANGE WIFI FLOW: START ---
      else if (/(cambiar\s+wifi|cambio\s+wifi|cambiar\s+clave\s+wifi|cambiar\s+contrase(n|ñ)a\s+wifi|cambiar\s+password\s+wifi)/i.test(lower) && !/(buscar|submit|apply)/i.test(lower)) {
        session.monitorClientFlowMode = false;
        session.pendingMonitorClientSearch = false;
        session.pendingMonitorClient = undefined;
        session.monitorGraphType = undefined;
        session.wifiFlowMode = true;
        session.pendingWifiClientSearch = true;
        session.pendingWifiChange = { stage: 'search' };
        finalContent = 'Perfecto. Ingresa el nombre completo y/o el RUT para buscar al cliente y cambiar el WiFi.';
        actionsOut = [
          { id: 'wifi_search_fullname', type: 'input', label: 'Nombre Completo', placeholder: 'Ej: Juan Pérez', payload: 'wifi buscar nombre {wifi_search_fullname} rut {wifi_search_rut}' },
          { id: 'wifi_search_rut', type: 'input', label: 'RUT', placeholder: 'Ej: 12.345.678-9', payload: 'wifi buscar nombre {wifi_search_fullname} rut {wifi_search_rut}' },
          { id: 'wifi_search_submit', type: 'button', label: 'Buscar Cliente', payload: 'wifi buscar nombre {wifi_search_fullname} rut {wifi_search_rut}' }
        ];
      }
      // --- CHANGE WIFI FLOW: SEARCH CLIENT ---
      else if (lower.startsWith('wifi buscar') || (session.pendingWifiClientSearch && (collected?.wifi_search_fullname || collected?.wifi_search_rut))) {
        const nameMatch = prompt.match(/nombre\s+(.+?)(?=\s+rut|$)/i);
        const rutMatch = prompt.match(/rut\s+([^\s]+)/i);

        let fullName = (collected?.wifi_search_fullname || nameMatch?.[1] || '').trim();
        let rut = (collected?.wifi_search_rut || rutMatch?.[1] || '').trim();

        if (fullName.includes('{wifi_search_fullname}')) fullName = '';
        if (rut.includes('{wifi_search_rut}')) rut = '';

        if (!fullName && !rut) {
          finalContent = 'Ingresa nombre completo y/o RUT para buscar al cliente.';
          actionsOut = [
            { id: 'wifi_search_fullname', type: 'input', label: 'Nombre Completo', placeholder: 'Ej: Juan Pérez', payload: 'wifi buscar nombre {wifi_search_fullname} rut {wifi_search_rut}' },
            { id: 'wifi_search_rut', type: 'input', label: 'RUT', placeholder: 'Ej: 12.345.678-9', payload: 'wifi buscar nombre {wifi_search_fullname} rut {wifi_search_rut}' },
            { id: 'wifi_search_submit', type: 'button', label: 'Buscar Cliente', payload: 'wifi buscar nombre {wifi_search_fullname} rut {wifi_search_rut}' }
          ];
          session.pendingWifiClientSearch = true;
        } else {
          const clients = await findClientsByNameRutWithSync(fullName, rut);
          session.pendingWifiClientSearch = false;
          session.wifiFlowMode = true;
          session.lastContextType = 'wifi-client-search';

          if (clients.length) {
            const fmt = formatEntityList(clients, 'client');
            const table = buildClientsTable(clients);
            finalContent = `Resultados para "${[fullName, rut].filter(Boolean).join(' / ') || 'búsqueda'}":\n\n${table}`;
            // Mark these selection payloads as coming from the WiFi flow to avoid cross-flow confusion
            actionsOut = fmt.actions.map(a => ({
              ...a,
              payload: String(a.payload || '').trim() + ' wifi'
            }));
          } else {
            finalContent = 'No encontré clientes con esos datos. Intenta nuevamente.';
            actionsOut = [
              { id: 'wifi_search_fullname', type: 'input', label: 'Nombre Completo', placeholder: 'Ej: Juan Pérez', payload: 'wifi buscar nombre {wifi_search_fullname} rut {wifi_search_rut}' },
              { id: 'wifi_search_rut', type: 'input', label: 'RUT', placeholder: 'Ej: 12.345.678-9', payload: 'wifi buscar nombre {wifi_search_fullname} rut {wifi_search_rut}' },
              { id: 'wifi_search_submit', type: 'button', label: 'Buscar Cliente', payload: 'wifi buscar nombre {wifi_search_fullname} rut {wifi_search_rut}' }
            ];
          }
        }
      }
      // --- CHANGE ONU FLOW: SEARCH CLIENT ---
      else if (lower.startsWith('cambio onu buscar') || lower.startsWith('cambiar onu buscar') || (session.pendingChangeOnuClientSearch && (collected?.change_fullname || collected?.change_rut))) {
        const nameMatch = prompt.match(/nombre\s+(.+?)(?=\s+rut|$)/i);
        const rutMatch = prompt.match(/rut\s+([^\s]+)/i);

        let fullName = (collected?.change_fullname || nameMatch?.[1] || '').trim();
        let rut = (collected?.change_rut || rutMatch?.[1] || '').trim();

        if (fullName.includes('{change_fullname}')) fullName = '';
        if (rut.includes('{change_rut}')) rut = '';

        if (!fullName && !rut) {
          finalContent = 'Ingresa nombre completo y/o RUT para buscar al cliente.';
          actionsOut = [
            { id: 'change_fullname', type: 'input', label: 'Nombre Completo', placeholder: 'Ej: Juan Pérez', payload: 'cambio onu buscar nombre {change_fullname} rut {change_rut}' },
            { id: 'change_rut', type: 'input', label: 'RUT', placeholder: 'Ej: 12.345.678-9', payload: 'cambio onu buscar nombre {change_fullname} rut {change_rut}' },
            { id: 'change_submit', type: 'button', label: 'Buscar Cliente', payload: 'cambio onu buscar nombre {change_fullname} rut {change_rut}' }
          ];
          session.pendingChangeOnuClientSearch = true;
        } else {
          const clients = await findClientsByNameRutWithSync(fullName, rut);
          session.pendingChangeOnuClientSearch = false;
          session.changeOnuFlowMode = true;
          session.lastContextType = 'change-onu-client-search';

          if (clients.length) {
            const fmt = formatEntityList(clients, 'client');
            const table = buildClientsTable(clients);
            finalContent = `Resultados para "${[fullName, rut].filter(Boolean).join(' / ') || 'búsqueda'}":\n\n${table}`;
            actionsOut = [...fmt.actions];
          } else {
            finalContent = 'No encontré clientes con esos datos. Intenta nuevamente.';
            actionsOut = [
              { id: 'change_fullname', type: 'input', label: 'Nombre Completo', placeholder: 'Ej: Juan Pérez', payload: 'cambio onu buscar nombre {change_fullname} rut {change_rut}' },
              { id: 'change_rut', type: 'input', label: 'RUT', placeholder: 'Ej: 12.345.678-9', payload: 'cambio onu buscar nombre {change_fullname} rut {change_rut}' },
              { id: 'change_submit', type: 'button', label: 'Buscar Cliente', payload: 'cambio onu buscar nombre {change_fullname} rut {change_rut}' }
            ];
          }
        }
      }
      // --- FOTO FLOW: START ---
      else if (lower.includes('quiero agregar fotos') && (lower.includes('instalacion') || lower.includes('instalaicion'))) {
        session.photoFlowMode = true;
        session.pendingPhotoClientSearch = true;
        finalContent = 'Perfecto. Ingresa el nombre completo y/o el RUT para buscar al cliente.';
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

        if (!targetId) {
          finalContent = "⚠️ Error: No se detectó ID para activar.";
        } else {
          const { fullUser: fullGeonetUser, source } = await resolveGeonetInstallationUser(targetId, session);

          console.log(`[wisphub activate] Activating User: ${fullGeonetUser} (Source: ${source}, ID: ${targetId})`);

          finalContent = `⏳ Activando servicio en Geonet para **${fullGeonetUser}**...`;

          const actRes = await activarInstalacionGeonet(targetId, fullGeonetUser);

          if (actRes?.ok) {
            const activationPending = actRes?.status === 202 || (actRes as any)?.pending === true;
            if (activationPending) {
              finalContent = `⏳ **Activación enviada**\nLa instalación **${targetId}** fue enviada a activación para el usuario \`${fullGeonetUser}\`.\n\nLa confirmación se está verificando en segundo plano en la terminal.`;
              if ((actRes as any)?.detail) {
                finalContent += `\n\nDetalle: ${String((actRes as any).detail).slice(0, 260)}`;
              }
            } else {
              finalContent = `🚀 **¡Activación Exitosa!**\nLa instalación **${targetId}** ha sido activada correctamente bajo el usuario \`${fullGeonetUser}\`.\n\nYa puedes cargarle imágenes a la instalación del cliente.`;
            }

            // Subida de fotos pendientes si existen
            if (!activationPending && session.pendingPhotos && session.pendingPhotos.length > 0) {
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
            if (actRes?.status === 429) {
              finalContent += `\n\n⚠️ Respuesta 429 (rate limit). Intenta nuevamente en unos segundos.`;
            }
            if (actRes?.error) {
              finalContent += `\n\nDetalle técnico: ${String(actRes.error).slice(0, 260)}`;
            }
          }
        }
      }
      else if (lower.startsWith('wifi signal refresh') || pickActionValue(req.body?.actions, ['wifi_signal_refresh', 'wifi-signal-refresh'])) {
        const actionWifiSignalRefresh = pickActionValue(req.body?.actions, ['wifi_signal_refresh', 'wifi-signal-refresh']);
        const source = String(actionWifiSignalRefresh || prompt || '');
        const snMatch = source.match(/sn\s+([a-zA-Z0-9]+)/i);
        const sn = ((snMatch ? snMatch[1] : null) || session.lastSelectedOnuSn || '').toString().trim().toUpperCase();

        if (!sn) {
          finalContent = '⚠️ No tengo el SN de la ONU para refrescar la señal. Vuelve a aplicar WiFi o indica el SN.';
          actionsOut = [];
        } else {
          try {
            const signalCheck = await loadWifiSignalCheckBySn(sn);
            const qualitySuffix = signalCheck.quality.detail ? ` (${signalCheck.quality.detail})` : '';
            finalContent = `📶 **Verificación señal post-WiFi**\n\n🧾 **SN:** ${signalCheck.sn}\n🔢 **ONU External ID:** ${signalCheck.onuExternalId}\n📡 **Señal ONU/OLT Rx:** ${signalCheck.signalLine}\n🏷️ **Calidad señal:** ${signalCheck.quality.tone} ${signalCheck.quality.label}${qualitySuffix}\n📶 **Estado ONU:** ${signalCheck.monitor.statusSummary}\n⏱️ **Tiempo en línea:** ${signalCheck.monitor.onlineUptime || 'N/D'}\n📏 **Distancia ONU-OLT:** ${signalCheck.monitor.distanceOltOnu || 'N/D'}\n📤 **TX:** ${signalCheck.monitor.tx}`;
            actionsOut = buildWifiSignalRefreshActions(signalCheck.sn);
            session.lastSelectedOnuSn = signalCheck.sn;
          } catch (err: any) {
            finalContent = `⚠️ No se pudo refrescar la señal de la ONU ${sn}: ${err?.message || 'error desconocido'}`;
            actionsOut = buildWifiSignalRefreshActions(sn);
            session.lastSelectedOnuSn = sn;
          }

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
              actionsOut.push({ id: 'btn-contrato', type: 'button', label: '📄 Generar Contrato y Activar en WispHub', payload: `generar contrato activar ${targetId}` });
              finalContent += `\n\n👇 Acciones post-instalación para ID ${targetId}:`;
            }
          }
        }
      }
      // --- WIFI APPLY ---
      else if (lower.startsWith('wifi apply') || pickActionValue(req.body?.actions, ['wifi-apply', 'wifi_apply', 'wifi apply', 'wifi_apply_action'])) {
        const actionWifi = pickActionValue(req.body?.actions, ['wifi-apply', 'wifi_apply', 'wifi apply', 'wifi_apply_action']);
        const source = actionWifi ? String(actionWifi) : prompt;
        try { console.log('[wifi apply] source:', source); } catch (e) { }

        const snMatch = source.match(/sn\s+([a-zA-Z0-9]+)/i);
        const ssidMatch = source.match(/ssid\s+(.+?)(?=\s+pass|$)/i);
        const passMatch = source.match(/pass\s+(.+?)(?=\s+contract_id|$)/i);
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
              session.lastSelectedOnuSn = String(sn).trim().toUpperCase();

              try {
                const signalCheck = await loadWifiSignalCheckBySn(String(sn));
                const qualitySuffix = signalCheck.quality.detail ? ` (${signalCheck.quality.detail})` : '';
                finalContent += `\n\n📶 **Señal ONU autorizada:** ${signalCheck.signalLine}\n🏷️ **Calidad señal:** ${signalCheck.quality.tone} ${signalCheck.quality.label}${qualitySuffix}\n🔢 **ONU External ID:** ${signalCheck.onuExternalId}`;
                actionsOut.push(...buildWifiSignalRefreshActions(signalCheck.sn));
                session.lastSelectedOnuSn = signalCheck.sn;
              } catch (signalErr: any) {
                finalContent += `\n\n⚠️ No se pudo obtener señal de la ONU ahora mismo: ${signalErr?.message || 'error desconocido'}`;
                actionsOut.push(...buildWifiSignalRefreshActions(String(sn)));
              }

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
                // Evitar mostrar acciones post-instalación si estamos en flujo explícito
                // de cambio WiFi o cambio de ONU (evita confusión y colisiones de flujo).
                const skipPostActions = !!(
                  session?.wifiFlowMode ||
                  session?.changeOnuFlowMode ||
                  session?.monitorClientFlowMode ||
                  session?.pendingWifiChange ||
                  session?.pendingChangeOnu ||
                  session?.pendingMonitorClient ||
                  String(session?.lastContextType || '').toLowerCase().includes('wifi') ||
                  String(session?.lastContextType || '').toLowerCase().includes('onu') ||
                  String(session?.lastContextType || '').toLowerCase().includes('monitor')
                );
                if (!skipPostActions) {
                  if (planIsPyme) {
                    actionsOut.push({ id: 'btn-activar-wisphub', type: 'button', label: '🚀 Activar en WispHub', payload: `wisphub activate ${targetId}` });
                    finalContent += `\n\n👇 Acciones post-instalación (PYME) para ID ${targetId}:`;
                  } else {
                    // Botón combinado: generar contrato y activar en WispHub
                    actionsOut.push({ id: 'btn-contrato', type: 'button', label: '📄 Generar Contrato y Activar en WispHub', payload: `generar contrato activar ${targetId}` });
                    finalContent += `\n\n👇 Acciones post-instalación para ID ${targetId}:`;
                  }
                } else {
                  finalContent += `\n\n(ℹ️ Flujo activo: omito acciones post-instalación)`;
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
        const idMatch = prompt.match(/generar contrato(?:\s+activar)?\s+(\d+)/i);
        const targetId = idMatch ? idMatch[1] : null;
        const wantsActivate = /activar/i.test(prompt);
        if (targetId) {
          const isPyme = await resolveIsPyme(session, targetId);
          if (isPyme && !wantsActivate) {
            // Para PYME sin petición de activar, mantener comportamiento: ofrecer activar
            finalContent = `✅ Cliente PYME detectado. Omitiendo contrato.`;
            actionsOut = [
              { id: 'btn-activar-wisphub', type: 'button', label: '🚀 Activar en WispHub', payload: `wisphub activate ${targetId}` }
            ];
          } else {
            finalContent = `📄 Generando contrato para ID **${targetId}**...`;
            await processContractUpdate(targetId).catch(err => console.error('Error generating contract:', err));
            const userResolution = await resolveGeonetInstallationUser(targetId, session);
            const fullUser = userResolution.fullUser;
            let contratourl = await getAutoLoginContractLink(fullUser, targetId);
            const contact = await resolveContactEmail(targetId);
            const recipientList = [contact.primary, contact.cc].filter(Boolean) as string[];
            const primaryRecipient = recipientList[0];
            let emailNote = '';

            // Si el botón solicitó activación, ejecutar activación ahora y anexar resultado
            if (wantsActivate) {
              finalContent = `✅ Contrato generado e intentando activación en WispHub...`;
              try {
                const sleep = (ms: number) => new Promise<void>(res => setTimeout(res, ms));
                const maxAttempts = 4;
                let attempt = 0;
                let activated = false;
                let delayMs = 2000;
                let lastStatus: number | undefined = undefined;

                for (attempt = 1; attempt <= maxAttempts; attempt++) {
                  try {
                    const res = await activarInstalacionGeonet(targetId, fullUser);
                    lastStatus = res?.status;
                    if (res && res.ok) {
                      activated = true;
                      break;
                    }
                    if (lastStatus === 429) {
                      finalContent += `\nIntento ${attempt} falló por rate limit (429). Esperando ${Math.round(delayMs / 1000)}s antes de reintentar...`;
                      await sleep(delayMs);
                      delayMs *= 2; // backoff exponencial para 429
                    } else {
                      finalContent += `\nIntento ${attempt} falló (status: ${lastStatus ?? 'unknown'}). Reintentando en 2s...`;
                      await sleep(2000);
                    }
                  } catch (err) {
                    console.error('Error auto-activating in WispHub (attempt):', err);
                    await sleep(2000);
                  }
                }

                if (activated) {
                  if (lastStatus === 202) {
                    finalContent += `\n\n⏳ Activación enviada para ${fullUser}. Confirmación en segundo plano (revisa logs en terminal).`;
                  } else {
                    finalContent += `\n\n🚀 Activación en WispHub completada para ${fullUser}.`;
                  }
                } else {
                  finalContent += `\n\n⚠️ No se pudo activar automáticamente en WispHub tras ${maxAttempts} intentos.`;
                  if (lastStatus === 429) finalContent += `\n⚠️ Se detectaron errores 429 (rate limit). Espera antes de reintentar.`;
                }
              } catch (err) {
                console.error('Error auto-activating in WispHub:', err);
                finalContent += `\n\n⚠️ Error al intentar activar en WispHub.`;
              }
            } else {
              finalContent = `✅ Contrato generado:`;
            }

            // Intentar enviar el contrato al correo del cliente
            if (!contratourl) {
              emailNote = '\n⚠️ No se generó el link de contrato para enviarlo por correo.';
            } else if (primaryRecipient) {
              try {
                await sendContractLinkEmail({
                  to: primaryRecipient,
                  cc: contact.cc && contact.cc !== primaryRecipient ? contact.cc : undefined,
                  contractUrl: contratourl,
                  clientName: contact.name || String(fullUser),
                  installationId: targetId,
                  planName: session.lastSelectedPlan
                });
                emailNote = `\n📧 Contrato enviado a: ${recipientList.join(', ')}`;
              } catch (err: any) {
                console.error('Error enviando contrato por correo:', err);
                emailNote = `\n⚠️ No pude enviar el contrato por correo: ${err?.message || err}`;
              }
            } else {
              emailNote = '\n⚠️ No encontré correo del cliente para enviar el contrato.';
            }

            // Mostrar solamente el link para copiar contrato (no mostrar botón separado de activar)
            actionsOut = [
              { id: 'btn-contrato', type: 'link', label: '📄 Copiar Contrato', url: `${contratourl}` }
            ];
            finalContent += emailNote;
          }
        } else {
          finalContent = '⚠️ Error: No se detectó ID para generar contrato.';
        }
      }
      // --- AUTH REFRESH ONU LIST (Botón de refresh de ONUs libres) ---
      else if (lower === 'auth refresh onu-list') {
        // Refresca la lista de ONUs sin autorizar y la envía al chat (fast, no autoriza)
        if (!session.pendingAuth) {
          finalContent = 'No hay autorización en curso.';
          actionsOut = [];
        } else {
          // intentar obtener entidad relacionada (client o installation)
          const entityType = session.pendingAuth.installationId ? 'installation' : 'client';
          const entityId = session.pendingAuth.installationId || session.pendingAuth.clientIdServicio;
          let entity: any = null;
          if (entityType === 'client') {
            try { entity = await AppDataSource.getRepository(Client).findOne({ where: { id_servicio: entityId } }); } catch { }
          } else {
            try { entity = await AppDataSource.getRepository(Installation).findOne({ where: { id: entityId } }); } catch { }
          }

          if (!entity) {
            finalContent = 'No se encontró el cliente o instalación para refrescar.';
            actionsOut = [];
          } else {
            // Forzar fetch fresco de ONUs no configuradas (cache bypass)
            const allOnus = (await listGlobalUnconfiguredOnus({ cacheTtlMs: 0 }).catch(() => [])) as any[];

            // Agrupar por OLT y preparar estructura para la tabla
            const byOlt = new Map<string, any[]>();
            (allOnus || []).forEach(o => {
              const k = String(o.olt_id || o.oltId || o.olt || '');
              if (!k) return;
              if (!byOlt.has(k)) byOlt.set(k, []);
              byOlt.get(k)!.push(o);
            });

            const oltAvailability: any[] = [];
            const onuActions: any[] = [];
            Array.from(byOlt.entries()).forEach(([oltId, onus]) => {
              const oltName = onus[0]?.olt_name || `OLT ${oltId}`;
              const entry: any = { oltId: String(oltId), oltName, availableCount: onus.length, onus: [] };
              (onus || []).slice(0, 8).forEach((o: any, idx: number) => {
                const id = (o.sn || o.serial || o.onu_sn || `ONU${idx}`).toString();
                const pon = (o.pon_type || o.pon || 'gpon').toLowerCase();
                const port = o.port || o.port_id || o.slot || '-';
                const model = o.onu_type_name || o.onu_type || o.model || '-';
                const payload = `seleccionar onu ${id} olt ${oltId} pon ${pon} port ${port}${model !== '-' ? ` model ${model}` : ''}`;
                entry.onus.push({ id, label: id, ponType: pon, port, model, actionPayload: payload });
                onuActions.push({ id: `select-onu-${oltId}-${idx}`, type: 'button', label: id, payload });
              });
              if (entry.onus.length) oltAvailability.push(entry);
            });

            const details = buildClientDetails(entity, entityType as any);
            const onuTable = buildUnconfiguredOnusTable(oltAvailability);
            assistantMetadata = { flow: 'authorization', smartoltAvailability: { olts: oltAvailability } };
            finalContent = `\n${details}\n\n🔁 **Flujo:** Autorización\n\n📡 **ONUs sin autorizar (frescas):**\n\n${onuTable}`;

            // Actions: include refresh + per-onu select buttons
            const actions = [{ id: 'refresh-unconfigured-onus', type: 'button', label: '🔄 Refrescar ONUs libres', payload: 'auth refresh onu-list' }, ...onuActions];
            actionsOut = actions;
          }
        }
      }
      // --- CHANGE-ONU REFRESH ---
      else if (lower === 'change refresh onu-list') {
        // Similar to auth refresh: for change-ONU flow, fetch fresh unconfigured ONUs and send table
        if (!session.pendingChangeOnu) {
          finalContent = 'No hay flujo de cambio de ONU en curso.';
          actionsOut = [];
        } else {
          const serviceId = session.pendingChangeOnu.clientIdServicio || session.pendingChangeOnu.installationId;
          if (!serviceId) {
            finalContent = 'No hay cliente o instalación seleccionada para refrescar.';
            actionsOut = [];
          } else {
            // Try to fetch entity metadata for display
            let entity: any = null;
            try { entity = await AppDataSource.getRepository(Client).findOne({ where: { id_servicio: serviceId } }); } catch (e) { }
            if (!entity) {
              try { entity = await AppDataSource.getRepository(Installation).findOne({ where: { id: serviceId } }); } catch (e) { }
            }
            if (!entity) {
              finalContent = 'No se encontró el cliente o instalación para refrescar.';
              actionsOut = [];
            } else {
              try {
                const allOnus = (await listGlobalUnconfiguredOnus({ cacheTtlMs: 0 }).catch(() => [])) as any[];
                const byOlt = new Map<string, any[]>();
                (allOnus || []).forEach(o => {
                  const k = String(o.olt_id || o.oltId || o.olt || '');
                  if (!k) return;
                  if (!byOlt.has(k)) byOlt.set(k, []);
                  byOlt.get(k)!.push(o);
                });

                const oltAvailability: any[] = [];
                const onuActions: any[] = [];
                Array.from(byOlt.entries()).forEach(([oltId, onus]) => {
                  const oltName = onus[0]?.olt_name || `OLT ${oltId}`;
                  const entry: any = { oltId: String(oltId), oltName, availableCount: onus.length, onus: [] };
                  (onus || []).slice(0, 8).forEach((o: any, idx: number) => {
                    const id = (o.sn || o.serial || o.onu_sn || `ONU${idx}`).toString();
                    const pon = (o.pon_type || o.pon || 'gpon').toLowerCase();
                    const port = o.port || o.port_id || o.slot || '-';
                    const model = o.onu_type_name || o.onu_type || o.model || '-';
                    const payload = `seleccionar onu ${id} olt ${oltId} pon ${pon} port ${port}${model !== '-' ? ` model ${model}` : ''}`;
                    entry.onus.push({ id, label: id, ponType: pon, port, model, actionPayload: payload });
                    onuActions.push({ id: `select-onu-${oltId}-${idx}`, type: 'button', label: id, payload });
                  });
                  if (entry.onus.length) oltAvailability.push(entry);
                });

                const onuTable = buildUnconfiguredOnusTable(oltAvailability);
                assistantMetadata = { flow: 'change-onu', smartoltAvailability: { olts: oltAvailability } };
                finalContent = `\n🔁 **Flujo:** Cambio de ONU\n\n✅ Lista de ONUs refrescada para **${session.pendingChangeOnu.clientName || ''}**:\n\n${onuTable}`;
                const actions = [{ id: 'refresh-change-onus', type: 'button', label: '🔄 Refrescar ONUs libres', payload: 'change refresh onu-list' }, ...onuActions];
                actionsOut = actions;
              } catch (err) {
                console.error('[change refresh onu-list] Error refreshing ONUs:', err);
                finalContent = 'Error al intentar refrescar ONUs.';
                actionsOut = [];
              }
            }
          }
        }
      }
      // --- AUTH SUBMIT (Trigger) ---
      else if (lower === 'auth submit') {
        if (!session.pendingAuth) finalContent = 'No hay autorización en curso.';
        else { await submitAuth(req, res); return; }
      }
      // --- CHANGE ONU SET (Field Update) ---
      else if (lower.startsWith('cambio onu set') || lower.startsWith('cambiar onu set')) {
        const match = prompt.match(/cambio\s+onu\s+set\s+([a-zA-Z0-9_\-]+)\s+(.+)/i)
          || prompt.match(/cambiar\s+onu\s+set\s+([a-zA-Z0-9_\-]+)\s+(.+)/i);
        if (match) {
          const key = match[1].replace(/-/g, '_');
          const value = match[2].trim();
          session.pendingChangeOnu = session.pendingChangeOnu || { collected: {} };
          session.pendingChangeOnu.collected = {
            ...(session.pendingChangeOnu.collected || {}),
            [key]: value
          };
          finalContent = `✅ Campo actualizado: ${key} = ${value}`;
          actionsOut = await buildChangeOnuActions(session.pendingChangeOnu);
        } else {
          finalContent = '⚠️ Formato inválido. Usa: cambio onu set <campo> <valor>';
        }
      }
      // --- CHANGE ONU SUBMIT (Trigger) ---
      else if (lower.startsWith('cambio onu submit') || lower.startsWith('cambiar onu submit')) {
        const state = session.pendingChangeOnu || {};
        const merged: any = { ...state, ...state.collected, ...req.body, ...req.body.collected };
        const collectedFromState = (session.pendingChangeOnu && session.pendingChangeOnu.collected) || {};
        try {
          console.log('[cambio-onu-submit] session.pendingChangeOnu present:', !!session.pendingChangeOnu);
          try { console.log('[cambio-onu-submit] merged payload keys:', Object.keys(merged || {}).slice(0, 10)); } catch (e) { }
        } catch (e) { /* ignore logging errors */ }

        const actionSn = pickActionValue(req.body?.actions, ['change-onu-sn', 'change_onu_sn']);
        const actionNewModel = pickActionValue(req.body?.actions, ['change-onu-new-model', 'change_onu_new_model']);
        const actionOldModel = pickActionValue(req.body?.actions, ['change-onu-old-model', 'change_onu_old_model']);

        const snMatch = prompt.match(/\bsn\s+(.+?)(?=\s+new_model\b|\s+old_model\b|$)/i);
        const newModelMatch = prompt.match(/\bnew_model\s+(.+?)(?=\s+old_model\b|$)/i);
        const oldModelMatch = prompt.match(/\bold_model\s+(.+?)(?=$)/i);
        const sanitizePromptValue = (val: string) => {
          const cleaned = String(val || '').trim();
          if (!cleaned) return '';
          if (cleaned.includes('{') || cleaned.includes('}')) return '';
          return cleaned;
        };
        const promptSn = sanitizePromptValue(snMatch ? snMatch[1].trim() : '');
        const promptNewModel = sanitizePromptValue(newModelMatch ? newModelMatch[1].trim() : '');
        const promptOldModel = sanitizePromptValue(oldModelMatch ? oldModelMatch[1].trim() : '');

        if (req.body?.actions) {
          try {
            console.log('[cambio-onu-submit] actions count:', Array.isArray(req.body.actions) ? req.body.actions.length : 1);
          } catch (e) { }
        }

        const sn = merged.sn || merged['change-onu-sn'] || merged.change_onu_sn || actionSn || promptSn || state.sn || collectedFromState.old_sn || collectedFromState.sn || collectedFromState['change-onu-sn'];
        const oldModel = merged.old_model || merged['change-onu-old-model'] || merged.change_onu_old_model || actionOldModel || promptOldModel || state.oldModel || collectedFromState.old_model;
        const newModel = merged.new_model || merged['change-onu-new-model'] || merged.change_onu_new_model || actionNewModel || promptNewModel || merged.onu_type || collectedFromState.new_model;
        const newSn = merged.new_sn || merged.change_onu_new_sn || merged['change-onu-new-sn'] || sn || collectedFromState.new_sn;
        const onuExternalId = merged.onu_external_id || merged.onuExternalId || state.onuExternalId;
        const clientName = merged.clientName || state.clientName;
        const smartoltName = merged.smartoltName || state.smartoltName || clientName;

        try {
          console.log('[cambio-onu-submit] resolved values', { sn, oldModel, newModel, newSn, onuExternalId, smartoltName });
        } catch (e) { }
        if (!sn || !newModel) {
          // keep the flow active so the user can complete missing fields
          session.changeOnuFlowMode = true;
          session.pendingChangeOnu = session.pendingChangeOnu || {};
          session.pendingChangeOnu.collected = {
            ...(session.pendingChangeOnu.collected || {}),
            old_model: oldModel || session.pendingChangeOnu.collected?.old_model,
            old_sn: sn || session.pendingChangeOnu.collected?.old_sn,
            new_model: newModel || session.pendingChangeOnu.collected?.new_model,
          };
          finalContent = 'Faltan campos para el cambio de ONU. Completa el SN y el modelo nuevo.';
          actionsOut = await buildChangeOnuActions(session.pendingChangeOnu);
        } else {
          try {
            const onuTypeOptions = await getAllOnuTypes().catch(() => []);
            const normalizedOnuTypeOptions: string[] = Array.isArray(onuTypeOptions)
              ? onuTypeOptions.map((opt: any) => String(opt))
              : [];
            const newModelText = String(newModel || '').trim();
            const resolvedNewModel = bestMatchOption(newModelText, normalizedOnuTypeOptions)
              || (normalizedOnuTypeOptions.includes(newModelText) ? newModelText : undefined);

            if (!resolvedNewModel) {
              finalContent = '❌ Modelo ONU no válido. Selecciona un modelo válido (como en autorización).';
              actionsOut = await buildChangeOnuActions({ collected: { sn, old_model: oldModel, new_model: newModel } });
              return;
            }

            let targetOnuId = onuExternalId;
            if (!targetOnuId && smartoltName) {
              try {
                const ipCandidate = merged.ipv4_address || merged.ip || merged.ip_address || session?.ipv4_address || session?.ipv4 || null;
                const detail = await findOnuDetailByServiceName(smartoltName, ipCandidate);
                const found = detail?.payload || null;
                if (found) {
                  targetOnuId = found.onu_external_id || found.unique_external_id || found.external_id || found.onu_id || found.id;
                }
              } catch (err) {
                console.error('Error resolviendo ONU por name/ip en smartolt_onu_detail (submit):', err);
              }
            }

            if (!targetOnuId) {
              finalContent = `❌ No se encontró la ONU actual del cliente en SmartOLT para ejecutar el cambio.`;
              actionsOut = await buildChangeOnuActions({ collected: { sn, old_model: oldModel, new_model: newModel } });
            } else {
              const results: string[] = [];
              let typeUpdated = false;
              try {
                const normalizedOldModel = String(oldModel || collectedFromState.old_model || '').trim().toUpperCase().replace(/[- ]/g, '');
                const normalizedNewModel = String(resolvedNewModel || '').trim().toUpperCase().replace(/[- ]/g, '');
                if (normalizedOldModel && normalizedOldModel === normalizedNewModel) {
                  results.push(`ℹ️ Modelo igual (${normalizedNewModel}). No se solicita cambio de modelo en SmartOLT.`);
                  // consider model as effectively "updated" so SN update step can proceed
                  typeUpdated = true;
                } else {
                  await changeOnuType(targetOnuId, String(resolvedNewModel));
                  results.push(`✅ Tipo ONU actualizado a ${resolvedNewModel}`);
                  typeUpdated = true;
                }
              } catch (e: any) {
                results.push(`❌ Error cambiando modelo: ${e?.message || 'falló'}`);
              }

              if (typeUpdated) {
                try {
                  await updateOnuSn(targetOnuId, String(newSn));
                  results.push(`✅ SN actualizado a ${newSn}`);
                } catch (e: any) {
                  results.push(`❌ Error actualizando SN: ${e?.message || 'falló'}`);
                }
              } else {
                results.push('⚠️ SN no actualizado porque el cambio de modelo falló.');
              }

              finalContent = `🔁 **Cambio de ONU ejecutado**\nONU ID: ${targetOnuId}\nSN nuevo: ${newSn}\nModelo antiguo: ${oldModel || 'N/D'}\nModelo nuevo: ${resolvedNewModel}\n\n${results.join('\n')}`;

              // Después de ejecutar los cambios en SmartOLT (tipo + SN), intentamos sincronizar/realizar
              // el reemplazo en Geonet (borrar ONU vieja, registrar nueva y asignar al cliente).
              try {
                const clientIdServicio = merged.clientIdServicio || session.pendingChangeOnu?.clientIdServicio || session.lastSelectedClientIdServicio;
                let clienteUsuario: string | undefined = merged.clienteUsuario || session.pendingChangeOnu?.clientUser || session.pendingChangeOnu?.clientUsuario;
                if (clientIdServicio && !clienteUsuario) {
                  try {
                    const repo = AppDataSource.getRepository(Client);
                    const clientEntity = await repo.findOne({ where: { id_servicio: Number(clientIdServicio) } });
                    if (clientEntity) clienteUsuario = clientEntity.usuario || `${clientEntity.id_servicio}@geonet`;
                  } catch (e) {
                    console.warn('No se pudo obtener cliente desde DB para replaceOnuForClient:', (e as any)?.message || e);
                  }
                }

                if (clientIdServicio && clienteUsuario) {
                  const oldSerialToUse = merged.old_sn || merged.oldSn || collectedFromState.old_sn || session.pendingChangeOnu?.oldSn || session.pendingChangeOnu?.old_sn || sn;
                  const replaced = await replaceOnuForClient(clientIdServicio, clienteUsuario, oldSerialToUse, resolvedNewModel || newModel, newSn, '');
                  results.push(replaced ? '✅ Reemplazo en Geonet completado' : '⚠️ Reemplazo en Geonet falló');
                  // actualizar finalContent con el resultado actualizado
                  finalContent = `🔁 **Cambio de ONU ejecutado**\nONU ID: ${targetOnuId}\nSN nuevo: ${newSn}\nModelo antiguo: ${oldModel || 'N/D'}\nModelo nuevo: ${resolvedNewModel}\n\n${results.join('\n')}`;
                } else {
                  results.push('⚠️ No se intentó reemplazo en Geonet (falta cliente o cliente.usuario)');
                  finalContent = `🔁 **Cambio de ONU ejecutado**\nONU ID: ${targetOnuId}\nSN nuevo: ${newSn}\nModelo antiguo: ${oldModel || 'N/D'}\nModelo nuevo: ${resolvedNewModel}\n\n${results.join('\n')}`;
                }
              } catch (e) {
                console.error('Error ejecutando replaceOnuForClient:', (e as any)?.message || e);
                // no hacemos throw; sólo añadimos aviso a resultados
                try { results.push('❌ Excepción al intentar reemplazo en Geonet'); } catch { };
                finalContent = `🔁 **Cambio de ONU ejecutado**\nONU ID: ${targetOnuId}\nSN nuevo: ${newSn}\nModelo antiguo: ${oldModel || 'N/D'}\nModelo nuevo: ${resolvedNewModel}\n\n${results.join('\n')}`;
              }

              const rawType = String(resolvedNewModel || '').toUpperCase().replace(/[- ]/g, '');
              const wifiModels = ['ZTEF6600P', 'ZXHNF600P'];
              if (wifiModels.includes(rawType)) {
                actionsOut = [
                  { id: 'wifi_onu_ssid', type: 'input', label: 'Nombre WiFi (SSID)', placeholder: 'Nuevo Nombre', payload: 'wifi set ssid {input}' },
                  { id: 'wifi_onu_pass', type: 'input', label: 'Contraseña WiFi', placeholder: 'Nueva Clave (min 8)', payload: 'wifi set pass {input}' },
                  { id: 'wifi_onu_apply', type: 'button', label: 'Aplicar Cambios WiFi', payload: `wifi apply sn ${newSn} ssid {wifi_onu_ssid} pass {wifi_onu_pass}` }
                ];
              } else {
                actionsOut = [];
              }
              session.changeOnuFlowMode = false;
              session.pendingChangeOnuClientSearch = false;
              session.pendingChangeOnu = undefined;
            }
          } catch (err: any) {
            finalContent = `❌ Error ejecutando cambio de ONU: ${err?.message || 'desconocido'}`;
            actionsOut = await buildChangeOnuActions({ collected: { sn, old_model: oldModel, new_model: newModel } });
          }
        }
      }

      // --- SELECCIONAR CLIENTE/INSTALACION ---
      else if (/^(seleccionar|select) (cliente|instalación|instalacion)/i.test(lower) || pickActionValue(req.body?.actions, ['select-client', 'select_client', 'seleccionar-cliente', 'seleccionar_cliente', 'select', 'seleccionar'])) {
        // allow selection via text or via actions payloads
        const actionSelect = pickActionValue(req.body?.actions, ['select-client', 'select_client', 'seleccionar-cliente', 'seleccionar_cliente', 'select', 'seleccionar']);
        // If frontend sent only the action id (e.g. 'select-client-1205'), try to extract from that as a fallback
        let rawActionSelect = actionSelect;
        if (!rawActionSelect && Array.isArray(req.body?.actions)) {
          const hit = (req.body.actions || []).find((a: any) => typeof a?.id === 'string' && /^select-(client|installation)-\d+/i.test(a.id));
          if (hit) {
            // derive a string similar to previous payloads: prefer explicit value/payload, otherwise use id
            rawActionSelect = String(hit.value || hit.payload || hit.id || '').trim();
            // if payload contains flow marker, ensure context reflects source flow
            try {
              const rawPayload = String(hit.value || hit.payload || '').toLowerCase();
              if (rawPayload.includes('wifi')) {
                (req.session ||= {}).lastContextType = 'wifi-client-search';
              } else if (rawPayload.includes('monitor')) {
                (req.session ||= {}).lastContextType = 'monitor-client-search';
              }
            } catch (e) { /* ignore */ }
          }
        }
        let isClient = false;
        let id: number | null = null;
        if (rawActionSelect) {
          const m = String(rawActionSelect).match(/(cliente|instalaci[oó]n|instalacion)?\s*(\d+)/i);
          if (m) {
            isClient = /cliente/i.test(m[1] || 'cliente');
            id = Number(m[2]);
          } else {
            // fallback: treat as numeric id
            const n = String(rawActionSelect).match(/(\d+)/);
            if (n) id = Number(n[1]);
          }
        }
        if (!id) {
          isClient = lower.includes('cliente');
          id = Number(lower.split(/\s+/).pop());
        }

        let entity: any = null;
        if (isClient) {
          const repo = AppDataSource.getRepository(Client);
          entity = await repo.findOne({ where: { id_servicio: id } });
        } else {
          const repo = AppDataSource.getRepository(Installation);
          entity = await repo.findOne({ where: { id: id } });
        }

        if (entity) {

          try {
            console.log('[select-client] entity id:', entity?.id_servicio || entity?.id || 'N/A');
            console.log('[select-client] session flags:', {
              monitorClientFlowMode: !!session.monitorClientFlowMode,
              changeOnuFlowMode: !!session.changeOnuFlowMode,
              wifiFlowMode: !!session.wifiFlowMode,
              pendingChangeOnu: !!session.pendingChangeOnu,
              pendingWifiChange: !!session.pendingWifiChange
            });
          } catch (e) {
            /* ignore logging errors */
          }
          const serviceId = entity.id_servicio || entity.id;
          session.lastSelectedClientIdServicio = serviceId;
          if (!isClient) session.lastSelectedInstallationId = entity.id;
          // ACTUALIZAR USUARIO INSTALACION SIEMPRE
          session.lastSelectedUsuarioInstalacion = entity.usuario || undefined;
          const emails = extractEmails(entity);
          session.lastSelectedEmail = emails.primary;
          session.lastSelectedEmailCc = emails.cc;

          const planName = entity.plan_internet || entity.servicio || pickPlanFromRaw(entity.raw);
          if (planName) {
            session.lastSelectedPlan = planName;
            if (isPymeText(planName)) session.lastSelectedIsPyme = true;
          }

          const displayName = `${entity.nombre || ''} ${entity.apellidos || ''}`.trim();
          const dateLabel = new Date().toLocaleDateString('es-CL');
          const sessionTitle = `${displayName || 'Cliente'} - ${dateLabel}`;
          await sessionRepo.update({ id: Number(activeSessionId), userId: Number(userId) }, { title: sessionTitle });

          if (isClient && (session.monitorClientFlowMode || session.lastContextType === 'monitor-client-search' || session.pendingMonitorClientSearch)) {
            session.pendingMonitorClientSearch = false;
            session.monitorClientFlowMode = false;
            session.lastContextType = 'monitor-client-selected';

            const rut = entity.cedula || entity.rut || 'N/A';
            const plan = entity.plan_internet || entity.servicio || 'Plan desconocido';
            const ip = entity.ipv4_address || entity.ip || entity.ip_cliente || entity.ip_publica || undefined;
            const smartoltName = entity.servicio || displayName || `Cliente ${serviceId}`;
            const clientApiPayload = await getClientByServiceId(serviceId).catch(() => null);
            const wisphubSummary = extractMonitorWisphubSummary(entity, clientApiPayload || undefined);
            const lastInvoiceLabel = wisphubSummary.lastInvoiceDate
              ? `${wisphubSummary.lastInvoiceDate}${wisphubSummary.lastInvoicePaid ? ` (${wisphubSummary.lastInvoicePaid})` : ''}`
              : (wisphubSummary.lastInvoicePaid || 'N/D');

            let detail: any = null;
            try {
              detail = await findOnuDetailByServiceName(smartoltName, ip);
            } catch (err) {
              console.error('Error resolviendo smartolt_onu_detail para monitoreo:', err);
            }

            const onuExternalId = resolveOnuExternalIdFromDetail(detail);
            const snapshotSn = pickFirstString([detail?.sn, detail?.payload?.sn, detail?.payload?.serial, detail?.payload?.onu_sn]);
            const snapshotAt = detail?.capturedAt ? new Date(detail.capturedAt).toLocaleString('es-CL') : 'N/D';

            session.pendingMonitorClient = {
              clientIdServicio: serviceId,
              clientName: displayName || `Cliente ${serviceId}`,
              ip: ip || 'N/D',
              smartoltName,
              onuExternalId: onuExternalId || undefined,
              wisphubServiceStatus: wisphubSummary.wisphubServiceStatus,
              lastInvoiceDate: wisphubSummary.lastInvoiceDate,
              lastInvoicePaid: wisphubSummary.lastInvoicePaid
            };

            if (!onuExternalId) {
              finalContent = `📡 **Monitoreo Cliente**\n\n✅ Cliente seleccionado: **${displayName || 'Cliente'}** [ID: ${serviceId}]\n🪪 **RUT:** ${rut}\n🚀 **Plan:** ${plan}\n🌍 **IP:** ${ip || 'N/D'}\n🛰️ **Estado WispHub:** ${wisphubSummary.wisphubServiceStatus || 'N/D'}\n💳 **Última factura:** ${lastInvoiceLabel}\n\n⚠️ No encontré **ONU External ID** en \`smartolt_onu_detail\` para esa IP.\n💾 Último snapshot: SN ${snapshotSn || 'N/D'} | Capturado: ${snapshotAt}`;
              actionsOut = buildMonitorPanelActions();
              assistantMetadata = {
                flow: 'monitor-client',
                monitor: {
                  clientIdServicio: serviceId,
                  clientName: displayName || `Cliente ${serviceId}`,
                  rut,
                  plan,
                  ip: ip || 'N/D',
                  wisphubServiceStatus: wisphubSummary.wisphubServiceStatus,
                  lastInvoiceDate: wisphubSummary.lastInvoiceDate,
                  lastInvoicePaid: wisphubSummary.lastInvoicePaid,
                  snapshot: detail || null,
                  onuExternalId: null
                }
              };
            } else {
              const graphType = normalizeMonitorGraphType(session?.monitorGraphType || 'daily');
              session.monitorGraphType = graphType;
              const monitor = await loadMonitorSmartoltData(onuExternalId, graphType);
              const graphSection = buildMonitorGraphsSection(monitor);
              const apiWarnings = monitor.failedApis.length ? `\n\n⚠️ APIs con error: ${monitor.failedApis.join(' | ')}` : '';

              finalContent = `📡 **Panel Monitoreo SmartOLT**\n\n✅ Cliente seleccionado: **${displayName || 'Cliente'}** [ID: ${serviceId}]\n🪪 **RUT:** ${rut}\n🚀 **Plan:** ${plan}\n🌍 **IP:** ${ip || 'N/D'}\n🛰️ **Estado WispHub:** ${wisphubSummary.wisphubServiceStatus || 'N/D'}\n💳 **Última factura:** ${lastInvoiceLabel}\n🔢 **ONU External ID:** ${onuExternalId}\n🧾 **SN:** ${snapshotSn || 'N/D'}\n🗂️ **Período gráficos:** ${monitorGraphTypeLabel(graphType)}\n📶 **Estado ONU:** ${monitor.statusSummary}\n⏱️ **Tiempo en línea:** ${monitor.onlineUptime || 'N/D'}\n📏 **Distancia ONU-OLT:** ${monitor.distanceOltOnu || 'N/D'}\n📥 **RX:** ${monitor.rx}\n📤 **TX:** ${monitor.tx}${graphSection}${apiWarnings}`;
              actionsOut = buildMonitorPanelActions(onuExternalId);
              assistantMetadata = {
                flow: 'monitor-client',
                monitor: {
                  clientIdServicio: serviceId,
                  clientName: displayName || `Cliente ${serviceId}`,
                  rut,
                  plan,
                  ip: ip || 'N/D',
                  wisphubServiceStatus: wisphubSummary.wisphubServiceStatus,
                  lastInvoiceDate: wisphubSummary.lastInvoiceDate,
                  lastInvoicePaid: wisphubSummary.lastInvoicePaid,
                  smartoltName,
                  onuExternalId,
                  graphType,
                  statusSummary: monitor.statusSummary,
                  rx: monitor.rx,
                  tx: monitor.tx,
                  distanceOltOnu: monitor.distanceOltOnu,
                  onlineUptime: monitor.onlineUptime,
                  signalValue: monitor.signalValue,
                  signal1310: monitor.signal1310,
                  signal1490: monitor.signal1490,
                  runningConfig: monitor.runningConfig,
                  fullStatusInfo: monitor.fullStatusInfo,
                  snapshot: detail || null,
                  signalGraphUrl: monitor.signalGraphUrl,
                  trafficGraphUrl: monitor.trafficGraphUrl,
                  smartolt: monitor.raw,
                  failedApis: monitor.failedApis
                }
              };
            }
          } else if (isClient && (session.changeOnuFlowMode || session.lastContextType === 'change-onu-client-search' || session.pendingChangeOnu || session.pendingChangeOnuClientSearch)) {
            // CHANGE-ONU flow: prepare pendingChangeOnu and show unconfigured ONUs table
            session.pendingChangeOnuClientSearch = false;
            console.log('[select-client] chosen-flow: change-onu');
            const clientName = displayName || `Cliente ${serviceId}`;
            const smartoltName = entity.servicio || clientName;
            session.pendingChangeOnu = {
              clientIdServicio: serviceId,
              clientName,
              smartoltName,
              collected: {
                client_id: serviceId
              }
            };

            let targetOnu: any = null;
            try {
              const ipCandidate = entity.ipv4_address || entity.ip || entity.ip_cliente || entity.ip_publica || null;
              const detail = await findOnuDetailByServiceName(smartoltName, ipCandidate);
              targetOnu = detail?.payload || null;
            } catch (err) {
              console.error('Error obteniendo ONUs detalles por name/ip:', err);
            }

            if (targetOnu) {
              const onuExternalId = targetOnu.onu_external_id || targetOnu.unique_external_id || targetOnu.external_id || targetOnu.onu_id || targetOnu.id;
              const oldSn = targetOnu.sn || targetOnu.serial || targetOnu.onu_sn || '';
              const oldModel = targetOnu.onu_type || targetOnu.model || targetOnu.onu_type_name || '';
              session.pendingChangeOnu = {
                ...session.pendingChangeOnu,
                onuExternalId,
                oldSn,
                oldModel,
                collected: {
                  ...(session.pendingChangeOnu.collected || {}),
                  old_model: oldModel,
                  old_sn: oldSn,
                  onu_external_id: onuExternalId
                }
              };
            }
            // Show unconfigured ONUs table so user can pick one for the change
            const section = await buildOltAndNetworkSection(serviceId, { skipZonesFetch: true });
            const table = buildUnconfiguredOnusTable(section.oltAvailability || []);
            assistantMetadata = { flow: 'change-onu', smartoltAvailability: { olts: section.oltAvailability || [] } };
            finalContent = `🔁 **Flujo:** Cambio de ONU\n\n✅ Cliente seleccionado para cambio de ONU: **${clientName}** [ID: ${serviceId}].\n\n📡 **ONUs sin autorizar (cambio de ONU):**\n\n${table}\n\n👇 Selecciona una ONU libre para cambiarla.`;
            if (!targetOnu) {
              finalContent += `\n\n⚠️ No encontré una ONU en smartolt_onu_detail con name = "${smartoltName}". Se intentará nuevamente al confirmar.`;
            }
            // Ensure the change-ONU refresh button is present in the actions
            let changeActions = section.actions || [];
            const hasChangeRefresh = changeActions.some((a: any) => a.id === 'refresh-change-onus');
            if (!hasChangeRefresh) {
              changeActions = [{ id: 'refresh-change-onus', type: 'button', label: '🔄 Refrescar ONUs libres', payload: 'change refresh onu-list' }, ...changeActions];
            }
            actionsOut = changeActions;
          } else if (isClient && (session.wifiFlowMode || session.lastContextType === 'wifi-client-search' || session.pendingWifiChange || session.pendingWifiClientSearch)) {
            // WIFI flow: try to find ONU details and show WiFi form if possible
            session.pendingWifiClientSearch = false;
            console.log('[select-client] chosen-flow: wifi');
            const clientName = displayName || `Cliente ${serviceId}`;
            const smartoltName = entity.servicio || clientName;
            session.pendingWifiChange = {
              clientIdServicio: serviceId,
              clientName,
              smartoltName
            };

            let targetOnu: any = null;
            try {
              const ipCandidate = entity.ipv4_address || entity.ip || entity.ip_cliente || entity.ip_publica || null;
              const detail = await findOnuDetailByServiceName(smartoltName, ipCandidate);
              targetOnu = detail?.payload || null;
            } catch (err) {
              console.error('Error obteniendo ONU para cambio WiFi por name/ip:', err);
            }

            if (!targetOnu) {
              finalContent = '❌ No se encontró la ONU del cliente en SmartOLT.';
              actionsOut = [];
            } else {
              const onuSn = pickFirstString([targetOnu.sn, targetOnu.serial, targetOnu.onu_sn, targetOnu.mac]) || '';
              const onuType = pickFirstString([targetOnu.onu_type, targetOnu.model, targetOnu.onu_type_name]) || '';

              if (!onuSn) {
                finalContent = '❌ No se encontró el SN de la ONU en SmartOLT.';
                actionsOut = [];
              } else if (!isWifiCapableModel(onuType)) {
                finalContent = `❌ El modelo de ONU (${onuType || 'desconocido'}) no permite cambio de WiFi.`;
                actionsOut = [];
              } else {
                finalContent = `✅ ONU encontrada: ${onuSn}\nModelo: ${onuType}\nCompleta el formulario para cambiar WiFi.`;
                actionsOut = buildWifiChangeActions(onuSn);
              }
            }
            session.wifiFlowMode = false;
            session.pendingWifiClientSearch = false;
          } else if (isClient && session.photoFlowMode) {
            session.photoFlowMode = false;
            session.pendingPhotoClientSearch = false;
            session.lastSelectedInstallationId = undefined;
            finalContent = `✅ Cliente seleccionado para evidencias: **${displayName || 'Cliente'}** [ID: ${serviceId}].\n\nAhora puedes enviar las fotos y se subirán automáticamente a Geonet.`;
            actionsOut = [];
          } else {
            const { text, actions, assistantMetadata: meta } = await prepareAuthSession(session, entity, isClient ? 'client' : 'installation');
            assistantMetadata = meta;

            const clientDetails = buildClientDetails(entity, isClient ? 'client' : 'installation');
            finalContent = `${clientDetails}\n\n🔁 **Flujo:** Autorización\n\n📡 **Disponibilidad en SmartOLT:**\n${text}\n👇 Selecciona una ONU libre abajo o completa el formulario.`;
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
            if (session.changeOnuFlowMode) {
              const selectedSn = onu.sn || onu.serial || sn;
              const pending = session.pendingChangeOnu || { collected: {} };
              const oldModel = pending.oldModel || pending.old_model || pending.collected?.old_model || 'N/D';
              const oldSn = pending.oldSn || pending.collected?.old_sn || '';

              session.pendingChangeOnu = {
                ...pending,
                newSn: selectedSn,
                olt_id: onu.olt_id,
                pon_type: (onu.pon_type || 'gpon').toLowerCase(),
                board: onu.board,
                port: onu.port,
                collected: {
                  ...(pending.collected || {}),
                  sn: selectedSn,
                  new_sn: selectedSn,
                  old_model: oldModel,
                  old_sn: oldSn
                }
              };

              finalContent = `ONU ${selectedSn} seleccionada para **cambio de ONU**.\nModelo antiguo (SmartOLT): **${oldModel}**.\n\nCompleta el modelo nuevo y presiona **Remplazar**.`;
              actionsOut = await buildChangeOnuActions(session.pendingChangeOnu);
            } else {
              session.pendingAuth = session.pendingAuth || { collected: {} };
              session.pendingAuth.collected = {
                ...session.pendingAuth.collected,
                olt_id: onu.olt_id, pon_type: (onu.pon_type || 'gpon').toLowerCase(),
                board: onu.board, port: onu.port, sn: onu.sn || onu.serial,
                onu_type: onu.onu_type_name || onu.onu_type, onu_mode: 'Routing'
              };
              finalContent = `ONU ${sn} seleccionada. Formulario prellenado.`;
              actionsOut = await buildAuthActions(session.pendingAuth, req);
            }
          } else {
            finalContent = 'No pude encontrar los detalles de esa ONU.';
          }
        }
      }
      // --- LISTADOS Y BUSQUEDA ---

      // Acción: sincronizar instalaciones manualmente (desde botón o comando)
      else if (lower === 'instalaciones sync' || lower === 'sync instalaciones' || Boolean(pickActionValue(req.body?.actions, ['instalaciones sync', 'instalaciones_sync', 'sync instalaciones', 'sync_installations', 'refresh']))) {
        finalContent = '🔄 Iniciando sincronización de instalaciones...';
        try {
          await fullSyncInstallations(100, 3);
          const itemsAfter = await listAllLocalInstallations(0);
          const tableAfter = buildInstallationsTable(itemsAfter || []);
          // Mantener mismo formato que el comando 'instalaciones pendientes'
          session.searchMode = 'installation';
          session.lastContextType = 'installations';
          finalContent = itemsAfter?.length ? `Instalaciones pendientes:\n\n${tableAfter}` : 'No hay instalaciones pendientes.';
          const fmtAfter = formatEntityList(itemsAfter || [], 'installation');
          actionsOut = [...fmtAfter.actions, { id: 'refresh', type: 'button', label: 'Refrescar', payload: 'instalaciones sync' }];
        } catch (err: any) {
          console.error('[instalaciones sync] Error fullSyncInstallations:', err);
          finalContent = '❌ Falló la sincronización de instalaciones.';
        }
      }
      else if (lower.includes('instalaciones pendientes') || /^modo\s+b(usqueda|úsqueda)\s+instalacion$/i.test(lower)) {
        if (/^modo\s+b(usqueda|úsqueda)\s+instalacion$/i.test(lower)) {
          session.searchMode = 'installation'; session.lastContextType = 'installations';
        }
        const isRefreshRequest = lower.includes('enseñame las instalaciones pendientes de evidencia para autorizar el alta')
          || lower.includes('ensename las instalaciones pendientes de evidencia para autorizar el alta')
          || Boolean(pickActionValue(req.body?.actions, ['refresh', 'instalaciones sync', 'sync instalaciones', 'sync_installations']));

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
        actionsOut = [...fmt.actions, { id: 'refresh', type: 'button', label: 'Refrescar', payload: 'instalaciones sync' }];
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
          actionsOut = [...fmt.actions, { id: 'refresh', type: 'button', label: 'Refrescar', payload: 'instalaciones sync' }];
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

  // --- CAMBIO FINAL: Actualizar mensaje si es refresco, o Crear nuevo ---
  let assistantMessage;

  if (isRefreshAction) {
    // Buscar el último mensaje del asistente en esta sesión para actualizarlo
    const lastAssistantMsg = await msgRepo.findOne({
      where: { sessionId: Number(activeSessionId), role: 'assistant' },
      order: { createdAt: 'DESC' }
    });

    if (lastAssistantMsg) {
      // ACTUALIZAR
      lastAssistantMsg.content = finalContent;
      lastAssistantMsg.actions = actionsOut;
      lastAssistantMsg.metadata = assistantMetadata;
      assistantMessage = await msgRepo.save(lastAssistantMsg);
    } else {
      // Fallback: Si no hay mensaje previo (raro), crear uno nuevo
      assistantMessage = await msgRepo.save(msgRepo.create({
        userId: Number(userId),
        sessionId: Number(activeSessionId),
        role: 'assistant',
        content: finalContent,
        actions: actionsOut,
        metadata: assistantMetadata
      }));
    }
  } else {
    // COMPORTAMIENTO NORMAL: CREAR NUEVO
    assistantMessage = await msgRepo.save(msgRepo.create({
      userId: Number(userId),
      sessionId: Number(activeSessionId),
      role: 'assistant',
      content: finalContent,
      actions: actionsOut,
      metadata: assistantMetadata
    }));
  }

  await saveChatContext(session, activeSessionId);

  return res.json({
    ok: true,
    sessionId: activeSessionId,
    // Si fue refresh, no devolvemos userMessage para que el front no lo pinte duplicado
    userMessage: isRefreshAction ? null : { role: 'user', content: content, imageUrl: webPath },
    assistantMessage: {
      id: assistantMessage.id,
      role: 'assistant',
      content: finalContent,
      actions: actionsOut,
      metadata: assistantMetadata,
      isUpdate: isRefreshAction // Flag para que el front sepa qué hacer
    }
  });
}

// --- LOGIC: Post-Auth Actions (Location + WAN + WiFi Form) ---

async function processPostAuthActions(data: any, targetId?: string | number) {

  // Consolidated variable declarations at the top
  let messages = ['✅ ONU Autorizada.'];
  let onuId = data.onu_external_id;
  let clientid = targetId;

  // --- LOG PARA ACTIVAR INSTALACION ---
  let usuarioInstalacion = '';
  let usuarioInstalacionSource = '';
  let sessionUsuarioInstalacion = data._session && data._session.lastSelectedUsuarioInstalacion;
  let sessionDump = JSON.stringify(data._session || {});
  // Buscar usuarioInstalacion: PRIORIDAD a la sesión si coincide con el target (comportamiento similar a "wisphub activate")
  try {
    const sess = data._session || {};
    const sessionTargetMatches = Boolean(
      sess && (
        String(sess.lastSelectedClientIdServicio) === String(clientid) ||
        String(sess.lastSelectedInstallationId) === String(clientid) ||
        (sess.pendingAuth && (sess.pendingAuth.clientIdServicio == clientid || sess.pendingAuth.installationId == clientid))
      )
    );

    if (sess.lastAuthNameUsed && sessionTargetMatches) {
      usuarioInstalacion = sess.lastAuthNameUsed;
      usuarioInstalacionSource = 'session.lastAuthNameUsed (priority)';
    } else {
      const clientRepo = AppDataSource.getRepository(Client);
      const instRepo = AppDataSource.getRepository(Installation);
      let entity: any = await clientRepo.findOne({ where: { id_servicio: Number(clientid) } });
      if (entity && entity.usuario) {
        usuarioInstalacion = entity.usuario;
        usuarioInstalacionSource = 'Client.usuario';
      } else {
        entity = await instRepo.findOne({ where: [{ id: Number(clientid) }, { id_servicio: Number(clientid) }] });
        if (entity && entity.usuario) {
          usuarioInstalacion = entity.usuario;
          usuarioInstalacionSource = 'Installation.usuario';
        } else {
          usuarioInstalacion = data.usuario || sessionUsuarioInstalacion || (data._session && data._session.lastAuthNameUsed) || `${clientid}@geonet`;
          if (data.usuario) usuarioInstalacionSource = 'data.usuario';
          else if (sessionUsuarioInstalacion) usuarioInstalacionSource = 'session.lastSelectedUsuarioInstalacion';
          else if (data._session && data._session.lastAuthNameUsed) usuarioInstalacionSource = 'session.lastAuthNameUsed';
          else usuarioInstalacionSource = 'default';
        }
      }
    }
  } catch (e) {
    console.warn('No se pudo obtener usuario para activarInstalacionGeonet:', e);
    usuarioInstalacion = data.usuario || sessionUsuarioInstalacion || (data._session && data._session.lastAuthNameUsed) || `${clientid}@geonet`;
    if (data.usuario) usuarioInstalacionSource = 'data.usuario';
    else if (sessionUsuarioInstalacion) usuarioInstalacionSource = 'session.lastSelectedUsuarioInstalacion';
    else if (data._session && data._session.lastAuthNameUsed) usuarioInstalacionSource = 'session.lastAuthNameUsed';
    else usuarioInstalacionSource = 'default';
  }
  console.log(`[processPostAuthActions] activarInstalacionGeonet: clientid=${clientid}, usuarioInstalacion='${usuarioInstalacion}' (source: ${usuarioInstalacionSource}), onuId=${onuId}`);
  // Asegurar formato del usuario para Geonet (incluir @geonet si hace falta)
  if (usuarioInstalacion && !String(usuarioInstalacion).toLowerCase().includes('@geonet')) {
    usuarioInstalacion = `${String(usuarioInstalacion).trim()}@geonet`;
  }
  if (!onuId) return { message: '⚠️ ONU autorizada, falta SN.', actions: [] };

  // 1. CHANGE LOCATION
  if (data.zone && data.odb) {
    try {
      const locParams: any = { zone: data.zone, odb: data.odb, odb_port: data.odb_port, name: data.name, address_or_comment: data.address_or_comment };
      Object.keys(locParams).forEach(k => !locParams[k] && delete locParams[k]);
      await updateOnuLocation(String(onuId), locParams);
    } catch (err: any) {
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
    const registered = await registrarOnuGeonet(data.onu_type, onuId);
    if (registered) messages.push(`✅ Registro ONU en Geonet (${onuId}) exitoso.`);
    else messages.push(`❌ Registro ONU en Geonet (${onuId}) falló.`);

    if (clientid !== undefined) {
      // Buscar el usuario correcto desde la entidad Client o Installation
      let clienteUsuario = '';
      let clienteUsuarioSource = '';
      let sessionUsuario = data._session && data._session.lastAuthNameUsed;
      let sessionDump = JSON.stringify(data._session || {});
      try {
        const sess = data._session || {};
        const sessionTargetMatches = Boolean(
          sess && (
            String(sess.lastSelectedClientIdServicio) === String(clientid) ||
            String(sess.lastSelectedInstallationId) === String(clientid) ||
            (sess.pendingAuth && (sess.pendingAuth.clientIdServicio == clientid || sess.pendingAuth.installationId == clientid))
          )
        );

        if (sess.lastAuthNameUsed && sessionTargetMatches) {
          clienteUsuario = sess.lastAuthNameUsed;
          clienteUsuarioSource = 'session.lastAuthNameUsed (priority)';
        } else {
          const clientRepo = AppDataSource.getRepository(Client);
          const instRepo = AppDataSource.getRepository(Installation);
          let entity: any = await clientRepo.findOne({ where: { id_servicio: Number(clientid) } });
          if (entity && entity.usuario) {
            clienteUsuario = entity.usuario;
            clienteUsuarioSource = 'Client.usuario';
          } else {
            entity = await instRepo.findOne({ where: [{ id: Number(clientid) }, { id_servicio: Number(clientid) }] });
            if (entity && entity.usuario) {
              clienteUsuario = entity.usuario;
              clienteUsuarioSource = 'Installation.usuario';
            } else {
              clienteUsuario = data.usuario || sessionUsuarioInstalacion || (data._session && data._session.lastAuthNameUsed) || `${clientid}@geonet`;
              if (data.usuario) clienteUsuarioSource = 'data.usuario';
              else if (sessionUsuarioInstalacion) clienteUsuarioSource = 'session.lastSelectedUsuarioInstalacion';
              else if (data._session && data._session.lastAuthNameUsed) clienteUsuarioSource = 'session.lastAuthNameUsed';
              else clienteUsuarioSource = 'default';
            }
          }
        }
      } catch (e) {
        console.warn('No se pudo obtener usuario para agregarArticuloACliente:', e);
        clienteUsuario = data.usuario || sessionUsuarioInstalacion || (data._session && data._session.lastAuthNameUsed) || `${clientid}@geonet`;
        if (data.usuario) clienteUsuarioSource = 'data.usuario';
        else if (sessionUsuarioInstalacion) clienteUsuarioSource = 'session.lastSelectedUsuarioInstalacion';
        else clienteUsuarioSource = 'default';
      }
      // Asegurar que el usuario tenga el sufijo @geonet
      if (clienteUsuario && !String(clienteUsuario).toLowerCase().includes('@geonet')) {
        clienteUsuario = `${String(clienteUsuario).trim()}@geonet`;
      }
      console.log(`[processPostAuthActions] agregarArticuloACliente: clientid=${clientid}, usuario='${clienteUsuario}' (source: ${clienteUsuarioSource}), onuId=${onuId}`);
      messages.push(`🔄 Asignando ONU ${onuId} al usuario ${clienteUsuario}...`);
      const assigned = await agregarArticuloACliente(clientid, clienteUsuario, onuId);
      if (assigned) messages.push(`✅ ONU asignada a ${clienteUsuario}.`);
      else messages.push(`❌ Falló asignación a ${clienteUsuario}.`);
    }
  } else {
    messages.push('ℹ️ ONU ya registrada en BD (SN coincidente).');
    // Intentar asignar si no se hizo aún
    if (clientid !== undefined) {
      let clienteUsuario = '';
      let clienteUsuarioSource = '';
      try {
        const sess = data._session || {};
        const sessionTargetMatches = Boolean(
          sess && (
            String(sess.lastSelectedClientIdServicio) === String(clientid) ||
            String(sess.lastSelectedInstallationId) === String(clientid) ||
            (sess.pendingAuth && (sess.pendingAuth.clientIdServicio == clientid || sess.pendingAuth.installationId == clientid))
          )
        );
        if (sess.lastAuthNameUsed && sessionTargetMatches) {
          clienteUsuario = sess.lastAuthNameUsed;
          clienteUsuarioSource = 'session.lastAuthNameUsed (priority)';
        } else {
          const clientRepo = AppDataSource.getRepository(Client);
          const instRepo = AppDataSource.getRepository(Installation);
          let entity: any = await clientRepo.findOne({ where: { id_servicio: Number(clientid) } });
          if (entity && entity.usuario) {
            clienteUsuario = entity.usuario;
            clienteUsuarioSource = 'Client.usuario';
          } else {
            entity = await instRepo.findOne({ where: [{ id: Number(clientid) }, { id_servicio: Number(clientid) }] });
            if (entity && entity.usuario) {
              clienteUsuario = entity.usuario;
              clienteUsuarioSource = 'Installation.usuario';
            } else {
              clienteUsuario = data.usuario || sessionUsuarioInstalacion || (data._session && data._session.lastAuthNameUsed) || `${clientid}@geonet`;
              if (data.usuario) clienteUsuarioSource = 'data.usuario';
              else if (sessionUsuarioInstalacion) clienteUsuarioSource = 'session.lastSelectedUsuarioInstalacion';
              else if (data._session && data._session.lastAuthNameUsed) clienteUsuarioSource = 'session.lastAuthNameUsed';
              else clienteUsuarioSource = 'default';
            }
          }
        }
      } catch (e) {
        clienteUsuario = data.usuario || sessionUsuarioInstalacion || (data._session && data._session.lastAuthNameUsed) || `${clientid}@geonet`;
        clienteUsuarioSource = 'default';
      }
      if (clienteUsuario && !String(clienteUsuario).toLowerCase().includes('@geonet')) {
        clienteUsuario = `${String(clienteUsuario).trim()}@geonet`;
      }
      messages.push(`🔄 Intentando asignar ONU ${onuId} al usuario ${clienteUsuario}...`);
      try {
        const assigned = await agregarArticuloACliente(clientid, clienteUsuario, onuId);
        if (assigned) messages.push(`✅ ONU asignada a ${clienteUsuario}.`);
        else messages.push(`❌ Falló asignación a ${clienteUsuario}.`);
      } catch (e: any) {
        messages.push(`❌ Error al intentar asignar ONU: ${e?.message || e}`);
      }
    }
  }

  // --- WIFI vs BOTONES DIRECTOS ---
  const rawType = String(data.onu_type || '').toUpperCase().replace(/[- ]/g, '');
  const wifiModels = ['ZTEF6600P', 'ZXHNF600P'];

  if (wifiModels.includes(rawType)) {
    // Botón para saltar la configuración WiFi y continuar con generación/activación
    // Payload y etiqueta varían si el cliente es PyME: para PyME solo activamos
    // la instalación (no generar contrato). Para clientes residenciales se
    // permite "Generar Contrato y Activar".
    const skipPayload = (clientid || clientid === 0)
      ? (isPyme ? `wisphub activate ${clientid}` : `generar contrato activar ${clientid}`)
      : undefined;
    const skipLabel = isPyme ? 'Saltar configuración WiFi y Activar Instalación' : 'Saltar configuración WiFi y Generar Contrato';

    const wifiActions: any[] = [
      { id: 'wifi_ssid', type: 'input', label: 'Nombre WiFi (SSID)', placeholder: 'Nuevo Nombre', payload: 'wifi set ssid {input}' },
      { id: 'wifi_pass', type: 'input', label: 'Contraseña WiFi', placeholder: 'Nueva Clave (min 8)', payload: 'wifi set pass {input}' },
      { id: 'wifi_submit', type: 'button', label: 'Aplicar Cambios WiFi', payload: `wifi apply sn ${onuId} ssid {wifi_ssid} pass {wifi_pass}` }
    ];

    if (skipPayload) {
      wifiActions.push({ id: 'wifi_skip_generate', type: 'button', label: skipLabel, payload: skipPayload });
    } else {
      wifiActions.push({ id: 'wifi_skip_generate_disabled', type: 'button', label: skipLabel, disabled: true, helperText: 'No se detectó ID de cliente/instalación' });
    }

    return { message: messages.join(' '), actions: wifiActions };
  }
  else {
    // Si estamos en un flujo explícito de cambio WiFi, no adjuntar acciones
    // post-instalación (p. ej. generar contrato). Esto evita confundir al usuario
    // mostrando botones ajenos al cambio de WiFi.
    const session = data._session || {};
    if (
      session?.wifiFlowMode ||
      session?.changeOnuFlowMode ||
      String(session?.lastContextType || '').toLowerCase().includes('wifi') ||
      String(session?.lastContextType || '').toLowerCase().includes('onu') ||
      session?.pendingWifiChange ||
      session?.pendingChangeOnu
    ) {
      return { message: messages.join(' '), actions: [] };
    }

    const directActions: any[] = [];
    if (targetId) {
      if (isPyme) {
        directActions.push({ id: 'btn-activar-wisphub', type: 'button', label: '🚀 Activar en WispHub', payload: `wisphub activate ${targetId}` });
        messages.push(`\n\n👇 **Proceso finalizado (PYME).** Selecciona una acción:`);
      } else {
        directActions.push({ id: 'btn-contrato', type: 'button', label: '📄 Generar Contrato y Activar en WispHub', payload: `generar contrato activar ${targetId}` });
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

  // Extraemos sessionId del request body
  const sessionId = req.body.sessionId ? Number(req.body.sessionId) : undefined;

  if (req.body.sessionId && (!Number.isFinite(sessionId) || Number(sessionId) <= 0)) {
    return res.status(400).json({ error: 'invalid_session_id' });
  }

  if (sessionId) {
    const sessionRepo = AppDataSource.getRepository(ChatSession);
    const ownedSession = await sessionRepo.findOne({
      where: { id: Number(sessionId), userId: Number(userId), deletedByUserAt: IsNull() }
    });
    if (!ownedSession) return res.status(404).json({ error: 'session_not_found' });
  }

  if (sessionId && session?.activeChatContextId !== Number(sessionId)) {
    await loadChatContext(session, Number(sessionId));
  }

  const state = session.pendingAuth || {};
  const merged: any = { ...state.defaults, ...state.collected, ...req.body, ...req.body.collected };

  // Normalizar velocidad
  const speedCandidate = merged.download_speed_profile_name
    ?? merged['auth-speed']
    ?? merged.speed
    ?? merged.download_speed
    ?? merged.downloadSpeed;
  const matchedSpeed = matchSpeedOption(speedCandidate);
  if (matchedSpeed) {
    merged.download_speed_profile_name = matchedSpeed;
    if (!merged.upload_speed_profile_name) merged.upload_speed_profile_name = matchedSpeed;
  }

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
      sessionId: sessionId ? Number(sessionId) : undefined,
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

    // --- CORRECCIÓN ERROR 400 (DUPLICADO) AQUÍ ---
    let result: any;
    try {
      result = await authorizeOnu(authPayload);
    } catch (apiError: any) {
      // Verificar si es error de ID Duplicado (SmartOLT devuelve 400)
      const errData = apiError.response?.data || {};
      const isDuplicate = errData.error_code === 'onu_external_id_not_unique' ||
        (typeof errData.error === 'string' && errData.error.includes('unique'));

      if (apiError.response?.status === 400 && isDuplicate) {
        console.log(`⚠️ ONU ${explicitSn} ya existe en SmartOLT (registrada por Puppeteer). Ignorando error 400 y continuando.`);
        // Simulamos una respuesta exitosa para que el flujo continúe
        result = { status: true, response_code: 'success' };
      } else {
        // Si es otro error, lo lanzamos para que caiga en el catch principal
        throw apiError;
      }
    }
    // ------------------------------------------------

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
      sessionId: sessionId ? Number(sessionId) : undefined,
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
      sessionId: sessionId ? Number(sessionId) : undefined,
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

    const msgRepo = AppDataSource.getRepository(ChatMessage);
    const sessionRepo = AppDataSource.getRepository(ChatSession);

    const messages = await msgRepo.find({
      where: { userId: userId },
      order: { createdAt: 'ASC' }
    });

    const sessions = await sessionRepo.find({
      where: { userId: userId },
      order: { createdAt: 'DESC' }
    });

    const bySession = new Map<number | null, any[]>();
    for (const m of messages) {
      const key = m.sessionId === null || m.sessionId === undefined ? null : Number(m.sessionId);
      if (!bySession.has(key)) bySession.set(key, []);
      bySession.get(key)!.push(m);
    }

    const sessionItems: any[] = sessions.map((s) => {
      const sessionMessages = bySession.get(Number(s.id)) || [];
      const lastMessageAt = sessionMessages.length
        ? sessionMessages[sessionMessages.length - 1].createdAt
        : s.createdAt;

      return {
        sessionId: s.id,
        title: s.title || `Sesión ${s.id}`,
        createdAt: s.createdAt,
        deletedByUserAt: s.deletedByUserAt || null,
        messageCount: sessionMessages.length,
        lastMessageAt,
        messages: sessionMessages
      };
    });

    const orphanMessages = bySession.get(null) || [];
    if (orphanMessages.length) {
      sessionItems.push({
        sessionId: null,
        title: 'Sesión legacy (sin sessionId)',
        createdAt: orphanMessages[0]?.createdAt,
        deletedByUserAt: null,
        messageCount: orphanMessages.length,
        lastMessageAt: orphanMessages[orphanMessages.length - 1]?.createdAt,
        messages: orphanMessages
      });
    }

    sessionItems.sort((a, b) => new Date(b.lastMessageAt || 0).getTime() - new Date(a.lastMessageAt || 0).getTime());

    return res.json({
      sessions: sessionItems,
      totalSessions: sessionItems.length,
      totalMessages: messages.length,
      messages
    });
  } catch (error) {
    console.error('Error fetching user messages (admin)', error);
    return res.status(500).json({ error: 'Error fetching user history' });
  }
}

export async function listAdminUserSessions(req: any, res: any) {
  try {
    const userId = Number(req.params.userId);
    if (!userId) return res.status(400).json({ error: 'User ID required' });

    const sessionRepo = AppDataSource.getRepository(ChatSession);
    const msgRepo = AppDataSource.getRepository(ChatMessage);

    const sessions = await sessionRepo.find({
      where: { userId },
      order: { createdAt: 'DESC' },
      take: 200
    });

    const sessionIds = sessions.map((s) => Number(s.id)).filter((id) => Number.isFinite(id));
    let messageCountBySession = new Map<number, number>();

    if (sessionIds.length) {
      const rows = await msgRepo
        .createQueryBuilder('msg')
        .select('msg.sessionId', 'sessionId')
        .addSelect('COUNT(msg.id)', 'total')
        .where('msg.userId = :userId', { userId })
        .andWhere('msg.sessionId IN (:...sessionIds)', { sessionIds })
        .groupBy('msg.sessionId')
        .getRawMany();

      messageCountBySession = new Map(rows.map((r: any) => [Number(r.sessionId), Number(r.total) || 0]));
    }

    const mapped = sessions.map((s) => ({
      id: s.id,
      userId: s.userId,
      title: s.title,
      createdAt: s.createdAt,
      deletedByUserAt: s.deletedByUserAt || null,
      messageCount: messageCountBySession.get(Number(s.id)) || 0
    }));

    return res.json({ sessions: mapped, total: mapped.length });
  } catch (error) {
    console.error('Error fetching admin user sessions', error);
    return res.status(500).json({ error: 'Error fetching user sessions' });
  }
}

export async function getAdminUserSessionMessages(req: any, res: any) {
  try {
    const userId = Number(req.params.userId);
    const sessionId = Number(req.params.sessionId);
    if (!userId || !sessionId) return res.status(400).json({ error: 'User ID and session ID are required' });

    const sessionRepo = AppDataSource.getRepository(ChatSession);
    const msgRepo = AppDataSource.getRepository(ChatMessage);

    const session = await sessionRepo.findOne({ where: { id: sessionId, userId } });
    if (!session) return res.status(404).json({ error: 'Session not found' });

    const messages = await msgRepo.find({
      where: { userId, sessionId },
      order: { createdAt: 'ASC' }
    });

    return res.json({
      session: {
        id: session.id,
        title: session.title,
        createdAt: session.createdAt,
        deletedByUserAt: session.deletedByUserAt || null
      },
      messages,
      messageCount: messages.length
    });
  } catch (error) {
    console.error('Error fetching admin session messages', error);
    return res.status(500).json({ error: 'Error fetching session messages' });
  }
}
// -------------------------------------------------------------------------
// BÚSQUEDA GLOBAL (Endpoint Nuevo) - MEJORADO CON RELEVANCIA Y PAGINACIÓN
// -------------------------------------------------------------------------
export async function searchUserMessages(req: any, res: any) {
  const userId = req.session?.userId;
  const { query, offset = 0, limit = 12 } = req.query;

  if (!userId) return res.status(401).json({ error: 'unauthenticated' });
  if (!query || String(query).trim().length < 2) return res.json({ results: [], total: 0, hasMore: false });

  try {
    // Verificar cache primero
    const cacheKey = `search:${userId}:${query}:${offset}:${limit}`;
    const cached = _searchCache.get(cacheKey);
    const now = Date.now();
    
    if (cached && now - cached.ts < 60000) { // Cache de 1 minuto
      return res.json({ ...cached.results, cached: true });
    }

    const msgRepo = AppDataSource.getRepository(ChatMessage);
    const pageOffset = Math.max(0, Number(offset) || 0);
    const pageLimit = Math.min(Number(limit) || 12, 50); // Máx 50 por página

    // Primero obtenemos más registros para filtrarlos después
    const messages = await msgRepo.createQueryBuilder('msg')
      .leftJoinAndSelect('msg.session', 'session')
      .where('msg.userId = :userId', { userId })
      .andWhere('msg.deletedByUserAt IS NULL')
      .andWhere('(msg.sessionId IS NULL OR session.deletedByUserAt IS NULL)')
      .andWhere('LOWER(msg.content) LIKE LOWER(:query)', { query: `%${query}%` })
      .select(['msg.id', 'msg.content', 'msg.role', 'msg.createdAt', 'msg.sessionId', 'session.title'])
      .orderBy('msg.createdAt', 'DESC')
      .take(pageLimit * 2) // Traemos el doble para filtrar tablas/listados
      .getMany();

    // Filtrar mensajes que son principalmente tablas y calcular relevancia
    const filtered = messages
      .filter(m => !isTableOrListMessage(m.content))
      .map(m => ({
        msg: m,
        relevance: calculateRelevance(m.content, String(query))
      }))
      .sort((a, b) => b.relevance - a.relevance) // Ordenar por relevancia
      .slice(0, pageLimit)
      .map(({ msg }) => ({
        chatId: String(msg.sessionId),
        chatTitle: (msg as any).session?.title || 'Chat sin título',
        chatTimestamp: new Date(msg.createdAt).toLocaleDateString(),
        messageId: msg.id,
        messageRole: msg.role,
        messageContent: msg.content,
        matchType: 'message'
      }));

    // Obtener total para saber si hay más resultados
    const total = await msgRepo.createQueryBuilder('msg')
      .leftJoin('msg.session', 'session')
      .where('msg.userId = :userId', { userId })
      .andWhere('msg.deletedByUserAt IS NULL')
      .andWhere('(msg.sessionId IS NULL OR session.deletedByUserAt IS NULL)')
      .andWhere('LOWER(msg.content) LIKE LOWER(:query)', { query: `%${query}%` })
      .getCount();

    const response = {
      results: filtered,
      total,
      offset: pageOffset,
      limit: pageLimit,
      hasMore: pageOffset + filtered.length < total
    };

    // Guardar en cache
    _searchCache.set(cacheKey, { ts: now, results: response });

    return res.json(response);
  } catch (error) {
    console.error('Search error:', error);
    return res.status(500).json({ error: 'Error en búsqueda' });
  }
}
// -------------------------------------------------------------------------
// OBTENER MENSAJES (Modificado para Contexto y Paginación Optimizada)
// -------------------------------------------------------------------------
export async function getSessionMessages(req: any, res: any) {
  const userId = req.session?.userId;
  const { sessionId } = req.params;
  const { limit = 20, aroundId, beforeId } = req.query;

  if (!userId) return res.status(401).json({ error: 'unauthenticated' });

  try {
    const msgRepo = AppDataSource.getRepository(ChatMessage);

    // Validar que la sesión exista y pertenezca al usuario
    const sessionRepo = AppDataSource.getRepository(ChatSession);
    const session = await sessionRepo.findOne({
      where: { id: Number(sessionId), userId: Number(userId), deletedByUserAt: IsNull() }
    });

    if (!session) {
      return res.json({ messages: [], sessionExists: false });
    }

    let messages: any[] = [];
    const take = Math.min(Number(limit), 100); // Máx 100 por solicitud

    // 2. Lógica de Contexto (Saltar al mensaje) - OPTIMIZADA
    if (aroundId) {
      const targetId = Number(aroundId);

      // Usar una sola query con ranges en lugar de dos queries
      const results = await msgRepo.createQueryBuilder('msg')
        .where('msg.sessionId = :sid', { sid: sessionId })
        .andWhere('msg.userId = :userId', { userId: Number(userId) })
        .andWhere('msg.deletedByUserAt IS NULL')
        .andWhere('msg.id >= :minId', { minId: targetId - Math.ceil(take / 2) })
        .andWhere('msg.id <= :maxId', { maxId: targetId + Math.ceil(take / 2) })
        .orderBy('msg.createdAt', 'ASC')
        .take(take)
        .getMany();

      messages = results;
    }
    // 3. Lógica de Paginación (Scroll hacia arriba) - OPTIMIZADA
    else if (beforeId) {
      const targetId = Number(beforeId);

      messages = await msgRepo.createQueryBuilder('msg')
        .where('msg.sessionId = :sid', { sid: sessionId })
        .andWhere('msg.userId = :userId', { userId: Number(userId) })
        .andWhere('msg.deletedByUserAt IS NULL')
        .andWhere('msg.id < :bid', { bid: targetId })
        .orderBy('msg.createdAt', 'DESC')
        .take(take)
        .getMany();

      messages.reverse();
    }
    // 4. Lógica Inicial (Últimos mensajes)
    else {
      messages = await msgRepo.find({
        where: { sessionId: Number(sessionId), userId: Number(userId), deletedByUserAt: IsNull() },
        order: { createdAt: 'DESC' },
        take: take
      });
      messages.reverse();
    }

    return res.json({ 
      messages,
      sessionExists: true,
      messageCount: messages.length
    });
  } catch (error: any) {
    console.error("Error en getSessionMessages:", error);
    return res.status(500).json({ error: error.message });
  }
}