import axios from 'axios';
import FormData from 'form-data';
import { SMARTOLT } from '../config';
import { ensureRequestDelay } from '../utils/apiThrottle';

ensureRequestDelay(axios);

export type AuthorizeOnuParams = {
  olt_id: number | string;
  pon_type: 'gpon' | 'epon';
  gpon_channel?: 'gpon' | 'xgpon' | 'xgspon';
  epon_channel?: 'epon' | '10gepon';
  board?: number | string;
  port?: number | string;
  sn: string; // ONU serial or MAC
  onu_type: string; // e.g., ZTE-F660V6.0
  custom_profile?: string;
  onu_mode: 'Routing' | 'Bridging';
  cvlan?: number | string;
  svlan?: number | string;
  tag_transform_mode?: 'default' | 'translate' | 'translate-and-add';
  use_other_all_tls_vlan?: 0 | 1;
  vlan?: number | string; // If not specified, SmartOLT uses default PON VLAN
  zone: string;
  odb?: string; // splitter optional
  name: string;
  address_or_comment?: string;
  onu_external_id?: string;
  upload_speed_profile_name?: string;
  download_speed_profile_name?: string;
};

export type OltInfo = {
  id: string;
  name?: string;
  olt_hardware_version?: string;
  ip?: string;
  telnet_port?: string;
  snmp_port?: string;
};

export type SmartOltZone = {
  id: string;
  name?: string;
};

export type SmartOltOnu = {
  sn?: string;
  serial?: string;
  onu_sn?: string;
  mac?: string;
  mac_address?: string;
  pon_type?: string;
  olt_id?: string | number;
  board?: string | number;
  slot?: string | number;
  port?: string | number;
  port_id?: string | number;
  onu_type?: string;
  model?: string;
  onu_type_name?: string;
  onu_type_id?: string | number;
  status?: string;
};

export type SmartOltOnuType = {
  onu_type?: string;
  name?: string;
};

// Shape of the get_all_onus_details response is not strictly documented,
// so we keep it flexible and access fields defensively.
export type SmartOltOnuDetails = {
  sn?: string;
  serial?: string;
  onu_sn?: string;
  mac?: string;
  mac_address?: string;
  pon_type?: string;
  olt_id?: string | number;
  board?: string | number;
  slot?: string | number;
  port?: string | number;
  port_id?: string | number;
  name?: string;
  onu_type?: string;
  unique_external_id?: string | number;
  onu_external_id?: string | number;
  external_id?: string | number;
  onu_id?: string | number;
  id?: string | number;
  [key: string]: any;
};

const baseUrl = SMARTOLT.baseUrl?.replace(/\/$/, '') || '';

type CacheEntry = {
  value: any;
  expires: number;
  pending?: Promise<any>;
};

const smartoltCache = new Map<string, CacheEntry>();

// Session cookie cache for SmartOLT HTML login (fallback when API key returns 403)
const smartoltSessionCache: { cookie?: string; expires?: number } = {};

async function fromCache<T>(key: string, ttlMs: number, loader: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const entry = smartoltCache.get(key);
  if (entry && entry.expires > now) return entry.value as T;
  if (entry?.pending) return entry.pending as Promise<T>;

  const pending = loader()
    .then((val) => {
      smartoltCache.set(key, { value: val, expires: Date.now() + ttlMs });
      return val;
    })
    .catch((err) => {
      smartoltCache.delete(key);
      throw err;
    });

  smartoltCache.set(key, { value: entry?.value, expires: entry?.expires || 0, pending });
  return pending;
}

function getHeaders() {
  if (!SMARTOLT.apiKey) throw new Error('SMARTOLT_API_KEY not configured');
  return {
    'X-Token': SMARTOLT.apiKey
  };
}

// Perform SmartOLT web login to get a session cookie when API key access is forbidden
async function getSmartoltSessionCookie(force?: boolean): Promise<string | null> {
  const identity = process.env.SMARTOLT_IDENTITY || process.env.SMARTOLT_USERNAME || process.env.SMARTOLT_EMAIL;
  const password = process.env.SMARTOLT_PASSWORD;
  if (!identity || !password) return null;
  if (!baseUrl) throw new Error('SMARTOLT_BASE_URL not configured');

  const now = Date.now();
  if (!force && smartoltSessionCache.cookie && smartoltSessionCache.expires && smartoltSessionCache.expires > now) {
    return smartoltSessionCache.cookie;
  }

  const form = new URLSearchParams();
  form.append('identity', identity);
  form.append('password', password);

  const res = await axios.post(`${baseUrl}/auth/login`, form, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    maxRedirects: 5,
    validateStatus: (s) => s >= 200 && s < 400
  });

  const setCookie = res.headers['set-cookie'];
  if (!setCookie || !Array.isArray(setCookie) || !setCookie.length) return null;
  const cookieHeader = setCookie.map((c) => c.split(';')[0]).filter(Boolean).join('; ');
  if (!cookieHeader) return null;

  smartoltSessionCache.cookie = cookieHeader;
  smartoltSessionCache.expires = now + 10 * 60 * 1000; // 10 minutes TTL
  return cookieHeader;
}

async function get<T = any>(path: string) {
  if (!baseUrl) throw new Error('SMARTOLT_BASE_URL not configured');
  const res = await axios.get<T>(`${baseUrl}${path}`, {
    headers: getHeaders(),
    timeout: 15000
  });
  return res.data;
}
export async function getAllOnuTypes(): Promise<string[]> {
  const url = `${baseUrl}/api/system/get_onu_types`;
  const { data } = await axios.get(url, {
    headers: { 'X-Token': SMARTOLT.apiKey || '' },
  });
  if (data && Array.isArray(data.response)) {
    return data.response.map((t: any) => t.name || t.type || t).filter(Boolean);
  }
  return [];
}
export async function getAllZones(): Promise<string[]> {
  const url = `${baseUrl}/api/system/get_zones`;
  const { data } = await axios.get(url, {
    headers: { 'X-Token': SMARTOLT.apiKey || '' },
  });
  if (data && Array.isArray(data.response)) {
    return data.response.map((z: any) => z.name || z.id || z).filter(Boolean);
  }
  return [];
}
export interface OltVlan {
  smartoltId: string;
  vlan: string;
  description: string;
}

export async function getVlansByOltId(
  oltId: string | number
): Promise<OltVlan[]> {
  const url = `${baseUrl}/api/olt/get_vlans/${oltId}`;

  const { data } = await axios.get(url, {
    headers: { 'X-Token': SMARTOLT.apiKey || '' },
  });

  if (data && Array.isArray(data.response)) {
    return data.response.map((v: any) => ({
      smartoltId: String(v.id),
      vlan: String(v.vlan),
      description: v.description || '',
    }));
  }

  return [];
}


// Algunos endpoints de SmartOLT rechazan GET con "Unknown method" y requieren POST.
// Hacemos fallback automático a POST cuando vemos 405 o mensajes similares.
async function getWithPostFallback<T = any>(path: string) {
  try {
    return await get<T>(path);
  } catch (err: any) {
    const status = err?.response?.status;
    const msg = err?.response?.data?.error || err?.response?.data?.response;
    const methodRejected = status === 405 || (typeof msg === 'string' && /method/i.test(msg));
    if (!methodRejected) throw err;

    const res = await axios.post<T>(`${baseUrl}${path}`, undefined, {
      headers: getHeaders(),
      timeout: 15000
    });
    return res.data;
  }
}

async function fetchOlts(): Promise<OltInfo[]> {
  const data = await getWithPostFallback<{ status?: boolean; response?: OltInfo[] } | OltInfo[]>(
    '/api/system/get_olts'
  );

  if (Array.isArray((data as any)?.response)) return (data as any).response as OltInfo[];
  if (Array.isArray(data)) return data as OltInfo[];
  return [];
}

export async function listOlts(options?: { cacheTtlMs?: number }) {
  const ttl = options?.cacheTtlMs ?? 60_000;
  return fromCache('olts', ttl, fetchOlts);
}



async function fetchZones(): Promise<SmartOltZone[]> {
  // Implementación estricta tipo CURL para obtener TODAS las zonas
  const url = `${baseUrl}/api/system/get_zones`;

  try {
    const { data } = await axios.get(url, {
      headers: {
        'X-Token': SMARTOLT.apiKey,
        'Accept': 'application/json'
      },
      timeout: 15000
    });

    // SmartOLT suele devolver: { response: [ ...zonas... ] }
    if (data && Array.isArray(data.response)) {
      return data.response as SmartOltZone[];
    }
    
    // O a veces el array directo
    if (Array.isArray(data)) {
      return data as SmartOltZone[];
    }

    return [];
  } catch (err: any) {
    console.error('❌ Error fetching Zones:', err?.message || err);
    return [];
  }
}

export async function getZones(options?: { cacheTtlMs?: number }) {
  const ttl = options?.cacheTtlMs ?? 5 * 60_000;
  return fromCache('zones', ttl, fetchZones);
}

export async function authorizeOnu(params: AuthorizeOnuParams) {
  if (!baseUrl) throw new Error('SMARTOLT_BASE_URL not configured');
  if (!SMARTOLT.apiKey) throw new Error('SMARTOLT_API_KEY not configured');
  const url = `${baseUrl}/api/onu/authorize_onu`;
  // First try x-www-form-urlencoded (URLSearchParams)
  try {
    const form = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) form.append(key, String(value));
    }
    const res = await axios.post(url, form, {
      headers: {
        ...getHeaders(),
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      timeout: 15000
    });
    return res.data;
  } catch (err) {
    // Some deployments require multipart/form-data; fall back to that.
    try {
      const formData = new FormData();
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null) formData.append(key, String(value));
      }
      const res = await axios.post(url, formData, {
        headers: {
          ...getHeaders(),
          ...(formData as any).getHeaders?.()
        },
        timeout: 15000
      });
      return res.data;
    } catch (err2) {
      // Prefer original error information when available
      throw err2 || err;
    }
  }
}

export async function getOnuBySerial(serial: string) {
  // Returns SN/OLT/slot/port/status
  return get(`/api/onus/${encodeURIComponent(serial)}`);
}

async function fetchVlans(oltId: string | number): Promise<Array<{ vlan_id: string; name?: string }>> {
  const path = `/api/olt/get_vlans/${encodeURIComponent(String(oltId))}`;
  let data: any;
  try {
    data = await getWithPostFallback(path);
  } catch (err) {
    // try alternative forms: POST with form body { olt_id }
    try {
      const form = new URLSearchParams();
      form.append('olt_id', String(oltId));
      const res = await axios.post(`${baseUrl}${path}`, form, { headers: getHeaders(), timeout: 15000 });
      data = res.data;
    } catch (err2) {
      console.warn(`fetchVlans: initial request failed for OLT ${oltId}`, (err2 as any)?.message || err2);
      throw err;
    }
  }

  // Normalize multiple possible response shapes into array of { vlan_id }
  // Common shapes: [{ vlan_id: '100' }], { status: true, response: [...] }, { vlans: [...] }, ['100','200'], { response: ['100','200'] }
  try {
    if (!data) return [];
    if (Array.isArray(data)) {
      // array of strings or objects
      return data.map((it) => {
        if (typeof it === 'string') {
          // try parse "id - description" formats
          const m = it.match(/^\s*(\d+)\s*[-:\s]+(.+)$/);
          if (m) return { vlan_id: m[1], name: m[2].trim() };
          return { vlan_id: String(it) };
        }
        const id = String((it as any).vlan_id ?? (it as any).vlan ?? (it as any).id ?? it);
        const name = (it as any).name ?? (it as any).description ?? (it as any).label ?? (it as any).vlan_name ?? undefined;
        return name ? { vlan_id: id, name: String(name) } : { vlan_id: id };
      });
    }
    if (Array.isArray(data.response)) {
      return (data.response as any[]).map((it: any) => {
        if (typeof it === 'string') {
          const m = it.match(/^\s*(\d+)\s*[-:\s]+(.+)$/);
          if (m) return { vlan_id: m[1], name: m[2].trim() };
          return { vlan_id: String(it) };
        }
        const id = String(it.vlan_id ?? it.vlan ?? it.id ?? it);
        const name = it.name ?? it.description ?? it.label ?? it.vlan_name ?? undefined;
        return name ? { vlan_id: id, name: String(name) } : { vlan_id: id };
      });
    }
    if (Array.isArray(data.vlans)) {
      return (data.vlans as any[]).map((it: any) => {
        if (typeof it === 'string') {
          const m = it.match(/^\s*(\d+)\s*[-:\s]+(.+)$/);
          if (m) return { vlan_id: m[1], name: m[2].trim() };
          return { vlan_id: String(it) };
        }
        const id = String(it.vlan_id ?? it.vlan ?? it.id ?? it);
        const name = it.name ?? it.description ?? it.label ?? it.vlan_name ?? undefined;
        return name ? { vlan_id: id, name: String(name) } : { vlan_id: id };
      });
    }
    // If response contains an object mapping or single object
    if (typeof data === 'object') {
      // e.g., { '100': {...}, '200': {...} }
      const asArray: Array<{ vlan_id: string; name?: string }> = [];
      for (const k of Object.keys(data)) {
        const v = (data as any)[k];
        if (k && /^\d+$/.test(k)) {
          // key is VLAN id, value may contain name
          const name = v && (v.name ?? v.description ?? v.label ?? v.vlan_name) ? String(v.name ?? v.description ?? v.label ?? v.vlan_name) : undefined;
          asArray.push(name ? { vlan_id: k, name } : { vlan_id: k });
        } else if (v && (v.vlan_id || v.vlan || v.id)) {
          const idv = String(v.vlan_id ?? v.vlan ?? v.id);
          const name = v.name ?? v.description ?? v.label ?? v.vlan_name ?? undefined;
          asArray.push(name ? { vlan_id: idv, name: String(name) } : { vlan_id: idv });
        }
      }
      if (asArray.length) return asArray;
    }
  } catch (e) {
    console.warn('fetchVlans: failed to normalize response', (e as any)?.message || e);
  }

  // Last resort: if data is a string with numbers
  try {
    const s = typeof data === 'string' ? data : JSON.stringify(data);
    const matches = s.match(/\b(\d{1,4})\b/g);
    if (matches && matches.length) return Array.from(new Set(matches)).map((v) => ({ vlan_id: v }));
  } catch {}

  return [];
}

export async function getOltVlans(oltId: string | number, options?: { cacheTtlMs?: number }) {
  const ttl = options?.cacheTtlMs ?? 60_000;
  return fromCache(`vlans:${oltId}`, ttl, () => fetchVlans(oltId));
}

async function fetchOnus(oltId: string | number): Promise<SmartOltOnu[]> {
  // Según la documentación oficial, este endpoint es GET puro.
  // Evitamos el fallback a POST porque en este tenant responde 405 "Unknown method".
  try {
    const data = await get<{ status?: boolean; response?: SmartOltOnu[] } | SmartOltOnu[]>(
      `/api/olt/get_onus/${encodeURIComponent(String(oltId))}`
    );

    if (Array.isArray((data as any)?.response)) return (data as any).response as SmartOltOnu[];
    if (Array.isArray(data)) return data as SmartOltOnu[];
    return [];
  } catch (err: any) {
    const status = err?.response?.status;
    const msg = err?.response?.data?.error || err?.response?.data?.response;
    if (status === 405 || (typeof msg === 'string' && /unknown method/i.test(msg))) {
      console.warn(`fetchOnus: SmartOLT rechazó el método para OLT ${oltId}:`, msg || status);
      return [];
    }
    throw err;
  }
}

export async function listOnusByOlt(oltId: string | number, options?: { cacheTtlMs?: number }) {
  const ttl = options?.cacheTtlMs ?? 45_000;
  return fromCache(`onus:${oltId}`, ttl, () => fetchOnus(oltId));
}

async function fetchUnconfiguredOnus(oltId: string | number): Promise<SmartOltOnu[]> {
  // Igual que fetchOnus: usamos solo GET y tratamos 405/"Unknown method" como lista vacía.
  try {
    const data = await get<{ status?: boolean; response?: SmartOltOnu[] } | SmartOltOnu[]>(
      `/api/onu/unconfigured_onus_for_olt/${encodeURIComponent(String(oltId))}`
    );

    if (Array.isArray((data as any)?.response)) return (data as any).response as SmartOltOnu[];
    if (Array.isArray(data)) return data as SmartOltOnu[];
    return [];
  } catch (err: any) {
    const status = err?.response?.status;
    const msg = err?.response?.data?.error || err?.response?.data?.response;
    if (status === 405 || (typeof msg === 'string' && /unknown method/i.test(msg))) {
      console.warn(`fetchUnconfiguredOnus: SmartOLT rechazó el método para OLT ${oltId}:`, msg || status);
      return [];
    }
    throw err;
  }
}

export async function listUnconfiguredOnusByOlt(oltId: string | number, options?: { cacheTtlMs?: number }) {
  const ttl = options?.cacheTtlMs ?? 45_000;
  return fromCache(`unconfigured:${oltId}`, ttl, () => fetchUnconfiguredOnus(oltId));
}

// Versión global: obtiene todas las ONUs sin autorizar para todas las OLTs.
async function fetchGlobalUnconfiguredOnus(): Promise<SmartOltOnu[]> {
  try {
    const data = await getWithPostFallback<{ status?: boolean; response?: SmartOltOnu[] } | SmartOltOnu[]>(
      '/api/onu/unconfigured_onus'
    );

    if (Array.isArray((data as any)?.response)) return (data as any).response as SmartOltOnu[];
    if (Array.isArray(data)) return data as SmartOltOnu[];
    return [];
  } catch (err: any) {
    const status = err?.response?.status;
    const msg = err?.response?.data?.error || err?.response?.data?.response;
    if (status === 405 || (typeof msg === 'string' && /unknown method/i.test(msg))) {
      console.warn('fetchGlobalUnconfiguredOnus: SmartOLT rechazó el método:', msg || status);
      return [];
    }
    throw err;
  }
}

export async function listGlobalUnconfiguredOnus(options?: { cacheTtlMs?: number }) {
  const ttl = options?.cacheTtlMs ?? 45_000;
  return fromCache('unconfigured:global', ttl, () => fetchGlobalUnconfiguredOnus());
}
/**
 * Obtiene TODOS los ODBs (Splitters) del sistema.
 * Replica el comando:
 * curl --location 'https://geonet-cl.smartolt.com/api/system/get_odbs' \
 * --header 'X-Token: ...'
// --- REEMPLAZAR BLOQUE DE ODBs ---

/**
 * Obtiene TODOS los ODBs (Splitters) del sistema.
 * Replica el comando CURL verificado.
 */
async function fetchOdbs(): Promise<Array<{ id?: string; name?: string; zone_id?: string; zone_name?: string }>> {
  if (!baseUrl || !SMARTOLT.apiKey) throw new Error('Config missing');
  
  const url = `${baseUrl}/api/system/get_odbs`;

  try {
    const { data } = await axios.get(url, {
      headers: {
        'X-Token': SMARTOLT.apiKey,
        'Accept': 'application/json'
      },
      timeout: 30000 // Timeout alto por si la lista es grande
    });

    // La respuesta típica es { status: true, response: [...] }
    if (data && Array.isArray(data.response)) {
      return data.response;
    }

    // Por si la API devuelve el array directo
    if (Array.isArray(data)) {
      return data;
    }

    console.warn('fetchOdbs: Respuesta inesperada de SmartOLT', data);
    return [];

  } catch (err: any) {
    console.error('❌ Error fetching ODBs:', err?.message || err);
    return [];
  }
}

export async function getOdbs(options?: { cacheTtlMs?: number }) {
  const ttl = options?.cacheTtlMs ?? 5 * 60_000;
  return fromCache('odbs', ttl, fetchOdbs);
}
async function fetchOnuTypes(ponType: 'gpon' | 'epon'): Promise<string[]> {
  const data = await getWithPostFallback<{ status?: boolean; response?: Array<SmartOltOnuType | string> } | Array<SmartOltOnuType | string>>(
    `/api/system/get_onu_types_by_pon_type/${ponType}`
  );

  const list = Array.isArray((data as any)?.response) ? (data as any).response : Array.isArray(data) ? (data as any) : [];
  return (list as Array<SmartOltOnuType | string>)
    .map((item) => {
      if (typeof item === 'string') return item;
      return item.onu_type || item.name || '';
    })
    .filter((v) => !!v)
    .map((v) => String(v));
}

export async function getOnuTypesByPonType(ponType: 'gpon' | 'epon', options?: { cacheTtlMs?: number }) {
  const ttl = options?.cacheTtlMs ?? 10 * 60_000;
  return fromCache(`onuTypes:${ponType}`, ttl, () => fetchOnuTypes(ponType));
}

export async function getCustomerById(id: string | number) {
  // Returns customer name, address, contact
  return get(`/api/customers/${encodeURIComponent(String(id))}`);
}

export async function getServiceById(id: string | number) {
  // Returns plan speed/profile and VLAN info
  return get(`/api/services/${encodeURIComponent(String(id))}`);
}

export async function getInstallationById(id: string | number) {
  // Returns location/coordinates and install date
  return get(`/api/installations/${encodeURIComponent(String(id))}`);
}

export async function updateOnuLocation(onuExternalId: string, params: Record<string, any>) {
  if (!baseUrl) throw new Error('SMARTOLT_BASE_URL not configured');
  if (!SMARTOLT.apiKey) throw new Error('SMARTOLT_API_KEY not configured');
  if (!onuExternalId) throw new Error('onuExternalId required');

  const url = `${baseUrl}/api/onu/update_location_details/${encodeURIComponent(String(onuExternalId))}`;
  const fd = new FormData();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && String(v).trim() !== '') {
      fd.append(k, String(v));
    }
  }

  const headers = { ...getHeaders(), ...fd.getHeaders() } as Record<string, string>;
  const res = await axios.post(url, fd as any, { headers, timeout: 20000, maxBodyLength: Infinity, maxContentLength: Infinity });
  return res.data;
}

export async function setOnuWanModeStaticIp(onuExternalId: string, ipv4Address: string, subnetMask = '255.255.255.0', gateway?: string, dns1 = '8.8.8.8', dns2 = '8.8.4.4', extras?: Record<string, any>) {
  if (!baseUrl) throw new Error('SMARTOLT_BASE_URL not configured');
  if (!SMARTOLT.apiKey) throw new Error('SMARTOLT_API_KEY not configured');
  if (!onuExternalId) throw new Error('onuExternalId required');
  if (!ipv4Address) throw new Error('ipv4Address required');

  const url = `${baseUrl}/api/onu/set_onu_wan_mode_static_ip/${encodeURIComponent(String(onuExternalId))}`;
  const fd = new FormData();
  fd.append('ipv4_address', String(ipv4Address));
  fd.append('subnet_mask', String(subnetMask));
  if (gateway) fd.append('gateway', String(gateway));
  if (dns1) fd.append('dns1', String(dns1));
  if (dns2) fd.append('dns2', String(dns2));
  // append any extras (e.g., sn, olt_id) to satisfy API required fields
  if (extras && typeof extras === 'object') {
    for (const [k, v] of Object.entries(extras)) {
      if (v !== undefined && v !== null && String(v).trim() !== '') fd.append(k, String(v));
    }
  }

  const headers = { ...getHeaders(), ...fd.getHeaders() } as Record<string, string>;
  const res = await axios.post(url, fd as any, { headers, timeout: 20000, maxBodyLength: Infinity, maxContentLength: Infinity });
  return res.data;
}


/**
 * Fetch available ports for an ODB by its externalId from SmartOLT API.
 * Returns the raw response (array, object, or wrapped in {response}).
 */
export async function getAvailablePortsForOdb(externalId: string | number): Promise<any> {
  if (!baseUrl) throw new Error('SMARTOLT_BASE_URL not configured');
  if (!SMARTOLT.apiKey) throw new Error('SMARTOLT_API_KEY not configured');
  if (!externalId) throw new Error('externalId required');
  // According to SmartOLT, this endpoint lives under /api/onu/
  const path = `/api/onu/fetch_available_ports_for_odb/${encodeURIComponent(String(externalId))}`;

  const unwrap = (data: any) => {
    if (data && typeof data === 'object' && Array.isArray((data as any).response)) return (data as any).response;
    if (data && typeof data === 'object' && (data as any).response) return (data as any).response;
    return data;
  };

  // First try with session cookie + token (mimic browser flow)
  const tryWithCookie = async (force?: boolean) => {
    const cookie = await getSmartoltSessionCookie(force);
    if (!cookie) return null;
    const res = await axios.get(`${baseUrl}${path}`, {
      headers: {
        Cookie: cookie,
        Accept: 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
        'X-Token': SMARTOLT.apiKey
      },
      timeout: 15000
    });
    return unwrap(res.data);
  };

  try {
    // Cookie-first attempt
    const cookieResult = await tryWithCookie(false);
    if (cookieResult) return cookieResult;

    // API-key request (POST fallback)
    const data = await getWithPostFallback<any>(path);
    return unwrap(data);
  } catch (err: any) {
    const status = err?.response?.status;

    // If API key or cookie failed with forbidden, refresh session and retry once
    if (status === 403) {
      try {
        const refreshed = await tryWithCookie(true);
        if (refreshed) return refreshed;
      } catch (err2) {
        // ignore and continue to GET fallback
      }
    }

    // fallback: plain GET with token
    const data = await get<any>(path);
    return unwrap(data);
  }
}

/**
 * Helper interno: Obtiene mapeo data-id vs portIndex.
 * REPARADO: Filtra estrictamente para que data-port incluya 'wifi'
 * para evitar capturar puertos LAN (eth_X) o voz que también tienen data-id.
 */
async function fetchWifiPortsFromPage(onuId: string | number): Promise<Array<{ id: string; portIndex: number }>> {
  if (!baseUrl) throw new Error('SMARTOLT_BASE_URL not configured');

  const endpoint = `${baseUrl}/onu/view/${onuId}`;

  // Helper interno que realiza la petición y el parseo
  const executeScrape = async (forceNewCookie: boolean): Promise<Array<{ id: string; portIndex: number }>> => {
    const cookie = await getSmartoltSessionCookie(forceNewCookie);
    if (!cookie) throw new Error('No se pudo obtener la cookie de sesión');

    let res;
    try {
      res = await axios.get(endpoint, {
        headers: {
          'Cookie': cookie,
          'X-Requested-With': 'XMLHttpRequest',
          'X-Token': SMARTOLT.apiKey || ''
        },
        transformResponse: [(data) => data] // Evitar parseo JSON, queremos texto crudo
      });
    } catch (err: any) {
      throw err;
    }

    const html = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
    const mappedPorts: Array<{ id: string; portIndex: number }> = [];

    // Regex global para capturar data-id y data-port, soportando saltos de línea entre atributos
    const regex = /data-id=["'](\d+)["'][\s\S]*?data-port=["']([^"']+)["']/g;
    
    let match;
    while ((match = regex.exec(html)) !== null) {
      const smartoltId = match[1];      // ej: "100" (Wifi) o "211" (Eth)
      const portLabel = match[2];       // ej: "wifi_0/1" o "eth_1"
      
      // === FILTRO ESTRICTO ===
      // Si el puerto no contiene la palabra "wifi", lo ignoramos. 
      // Esto elimina los puertos LAN/ETH/POTS que estaban ensuciando el array.
      if (!portLabel.toLowerCase().includes('wifi')) {
        continue;
      }

      // Extraemos el número final del puerto (ej: de "wifi_0/1" saca "1")
      const indexMatch = portLabel.match(/(\d+)$/);
      if (indexMatch) {
        mappedPorts.push({
          id: smartoltId,
          portIndex: parseInt(indexMatch[1], 10)
        });
      }
    }
    
    return mappedPorts;
  };

  // 1. Intento inicial
  let resultPorts: Array<{ id: string; portIndex: number }> = [];
  try {
    resultPorts = await executeScrape(false);
  } catch (err: any) {
    // Si falla por autenticación, reintentamos forzando nueva cookie
    if (err?.response?.status === 403 || err?.response?.status === 401) {
      resultPorts = await executeScrape(true);
    } else {
      throw err;
    }
  }

  // 2. Si el array está vacío, es posible que la cookie haya expirado y SmartOLT 
  // devolvió el HTML del Login (status 200) en lugar de un error. Forzamos reintento.
  if (resultPorts.length === 0) {
    console.warn(`fetchWifiPortsFromPage: No se encontraron puertos WiFi para ONU ${onuId}. Posible sesión caducada. Reintentando con cookie nueva...`);
    resultPorts = await executeScrape(true);
  }

  return resultPorts;
}

/**
 * Actualiza la configuración Wifi (SSID y Password) de una ONU.
 * - Si es 2.4GHz -> Busca el puerto físico 1 (wifi_0/1) y usa su data-id (ej. 100).
 * - Si es 5GHz   -> Busca el puerto físico 5 (wifi_0/5) y usa su data-id (ej. 104).
 * * @param onuId - ID interno de la ONU (ej. 1254)
 * @param frequency - '2.4GHz' (Puerto 1) o '5GHz' (Puerto 5)
 * @param ssid - Nuevo nombre de la red
 * @param password - Nueva contraseña
 * @param enable - (Opcional) Habilitar o deshabilitar el puerto. Por defecto true.
 */
export async function updateOnuWifi(
  onuId: string | number,
  frequency: '2.4GHz' | '5GHz',
  ssid: string,
  password: string,
  enable: boolean = true
) {
  if (!baseUrl) throw new Error('SMARTOLT_BASE_URL not configured');

  // 1. Obtener el mapa de puertos disponibles desde el HTML
  const availablePorts = await fetchWifiPortsFromPage(onuId);

  console.log(`updateOnuWifi: Puertos confirmados para ONU ${onuId}:`, availablePorts);

  if (availablePorts.length === 0) {
    throw new Error(`No se encontraron puertos WiFi configurables para la ONU ${onuId}. (Intento de scrape fallido incluso tras renovar cookie)`);
  }

  // 2. Seleccionar el ID correcto (data-id) basado en la frecuencia (portIndex)
  let selectedId: string | undefined;

  if (frequency === '2.4GHz') {
    // Buscamos el que corresponde a wifi_0/1
    const port1 = availablePorts.find(p => p.portIndex === 1);
    selectedId = port1?.id;
  } else {
    // Buscamos el que corresponde a wifi_0/5
    const port5 = availablePorts.find(p => p.portIndex === 5);
    selectedId = port5?.id;
  }

  if (!selectedId) {
    throw new Error(`No se encontró el puerto para ${frequency} en la ONU ${onuId}. 
      (Se buscó índice 1 para 2.4GHz o índice 5 para 5GHz). 
      Puertos detectados: ${availablePorts.map(p => `wifi_0/${p.portIndex}(id:${p.id})`).join(', ')}`);
  }

  // 3. Enviar la configuración usando el ID extraído (100 o 104)
  const form = new URLSearchParams();
  form.append('onu_id', String(onuId));
  form.append('wifi_port_id', selectedId);
  form.append('wifi_port_is_enabled', enable ? '1' : '0');
  form.append('wifi_port_mode', 'LAN'); 
  form.append('ssid', ssid);
  form.append('auth_mode', 'wpa2'); 
  form.append('wifi_password', password);
  form.append('wifi_vlan_dhcp', 'No control'); 

  const endpoint = `${baseUrl}/api/onu/update_wifi_port`;

  const performPost = async (forceCookie: boolean) => {
    const cookie = await getSmartoltSessionCookie(forceCookie);
    if (!cookie) throw new Error('No se pudo obtener la cookie de sesión de SmartOLT');

    return axios.post(endpoint, form, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': cookie,
        'X-Requested-With': 'XMLHttpRequest', 
        'X-Token': SMARTOLT.apiKey || '' 
      },
      timeout: 20000
    });
  };

  try {
    const res = await performPost(false);
    return res.data;
  } catch (err: any) {
    const status = err?.response?.status;
    if (status === 403 || status === 401) {
      console.warn('updateOnuWifi: Cookie expirada durante el POST, regenerando sesión...');
      const retryRes = await performPost(true);
      return retryRes.data;
    }
    throw err;
  }
}

export async function listAllUnconfiguredOnus(): Promise<any[]> {
  const subdomain = process.env.SMARTOLT_BASE_URL;
  const url = `${subdomain}api/onu/unconfigured_onus`;
  const resp = await axios.get(url, {
    headers: { 'X-Token': process.env.SMARTOLT_API_KEY }
  });
  // La respuesta suele estar en resp.data.data o resp.data
  return resp.data?.data || resp.data || [];
}
/**
 * Obtiene el ID numérico interno de la ONU buscando por su Serial Number (SN).
 * Replica el comportamiento de curl + grep buscando el patrón "status_onu_{id}".
 * @param sn - El número de serie de la ONU (ej. HWTC4411D498)
 */
export async function getInternalOnuIdBySn(sn: string): Promise<number | string | null> {
  if (!baseUrl) throw new Error('SMARTOLT_BASE_URL not configured');

  // Endpoint interno usado en el panel web
  const endpoint = `${baseUrl}/onu/get_configured_list`;

  // Función auxiliar para realizar la petición (mismo manejo de cookies que antes)
  const performRequest = async (forceCookie: boolean) => {
    const cookie = await getSmartoltSessionCookie(forceCookie);
    if (!cookie) throw new Error('No se pudo obtener la cookie de sesión de SmartOLT');

    return axios.get(endpoint, {
      params: {
        free_text: sn // Parámetro de búsqueda
      },
      headers: {
        'Cookie': cookie,
        'X-Requested-With': 'XMLHttpRequest', // Requerido para que el backend responda correctamente
        'X-Token': SMARTOLT.apiKey || '',
        'Accept': 'application/json, text/plain, */*' // Aceptamos cualquier formato para poder hacer regex
      },
      timeout: 15000,
      // Importante: No forzar JSON parse si la respuesta es HTML mezclado
      transformResponse: [(data) => data] 
    });
  };

  // Lógica de extracción (El equivalente a tu grep -oP "status_onu_\K\d+")
  const extractId = (data: any): string | null => {
    // Aseguramos que data sea string (axios puede haberlo parseado parcialmente si era JSON)
    const stringData = typeof data === 'object' ? JSON.stringify(data) : String(data);
    
    // Buscamos el patrón status_onu_ seguido de dígitos
    const match = stringData.match(/status_onu_(\d+)/);
    
    if (match && match[1]) {
      return match[1]; // Retorna el grupo de captura (los dígitos)
    }
    return null;
  };

  try {
    // Intento 1: Con cookie actual
    const res = await performRequest(false);
    const id = extractId(res.data);
    
    if (id) return id;

    // Si no encontramos ID, podría ser que la cookie expiró y la respuesta fue una redirección al login
    // o simplemente no hubo resultados. Intentamos regenerar cookie por si acaso.
    // (Opcional: revisar si res.data incluye "login" o status 403 explícito)
    
    return null; 

  } catch (err: any) {
    const status = err?.response?.status;
    
    // Si falla por Auth (403/401), regeneramos cookie y reintentamos una vez
    if (status === 403 || status === 401) {
      try {
        const retryRes = await performRequest(true);
        return extractId(retryRes.data);
      } catch (retryErr) {
        throw retryErr;
      }
    }
    
    throw err;
  }
}

export default {
  authorizeOnu,
  getOnuBySerial,
  listOlts,
  getZones,
  getOltVlans,
  listOnusByOlt,
  listUnconfiguredOnusByOlt,
  listGlobalUnconfiguredOnus,
  getOdbs,
  getOnuTypesByPonType,
  getCustomerById,
  getServiceById,
  getInstallationById,
  setOnuWanModeStaticIp,
  updateOnuLocation,
  getAvailablePortsForOdb,
  listAllUnconfiguredOnus,
  updateOnuWifi,
  getInternalOnuIdBySn
};