import axios, { AxiosHeaders } from 'axios';
import { wrapper } from 'axios-cookiejar-support';
import { randomUUID } from 'crypto'; // <--- AGREGADO AQUÍ
import { CookieJar } from 'tough-cookie';
import FormData from 'form-data'; // <--- ASEGURATE DE TENER ESTA LIBRERÍA INSTALADA: npm install form-data
import { AppDataSource } from '../datasource';
import { Client } from '../models/Client';
import { WISPHUB } from '../config';
import { parseRaw, asString, asDateString, stripHtml } from './rawParser';
import * as fs from 'fs';
import * as path from 'path';
// ... tus otros imports (axios, wrapper, CookieJar, FormData, etc.)
// --- UTILIDADES DE FECHA ---

/** Formatea una fecha JS a DD/MM/YYYY (Formato requerido por Geonet) */
function formatDateCL(date: Date): string {
  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0'); // Los meses en JS son 0-11
  const year = date.getFullYear();
  return `${day}/${month}/${year}`;
}

// --- CONFIGURACIÓN WISPHUB (API REST) ---

const CLIENT_FIELD_BLACKLIST = new Set([
  'estado_instalacion','is_preinstallation','descuento','saldo','notificacion_sms','aviso_pantalla',
  'notificaciones_push','auto_activar_servicio','password_servicio','server_hotspot','ip_local','modelo_antena',
  'password_cpe','interfaz_lan','usuario_router_wifi','password_router_wifi','ssid_router_wifi',
  'password_ssid_router_wifi','coordenadas','costo_instalacion','forma_contratacion'
].map((s) => s.toLowerCase()));

const http = axios.create({
  baseURL: WISPHUB.baseUrl.replace(/\/$/, ''),
  timeout: 15000
});

http.interceptors.request.use((config) => {
  if (!config.headers) config.headers = new AxiosHeaders();
  if (WISPHUB.apiKey) {
    if (config.headers instanceof AxiosHeaders) {
      config.headers.set('Authorization', `Api-Key ${WISPHUB.apiKey}`);
    } else {
      (config.headers as any)['Authorization'] = `Api-Key ${WISPHUB.apiKey}`;
    }
  }
  return config;
});

// --- CONFIGURACIÓN GEONET (Web Scraping / Session) ---

const jar = new CookieJar();
const geonetHttp = wrapper(axios.create({
  baseURL: 'https://admin.geonet.cl',
  jar,
  withCredentials: true,
  timeout: 60000, // Timeout extendido para manejar payloads grandes HTML
  headers: {
    'Referer': 'https://admin.geonet.cl/accounts/login/?next=/panel/',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  }
}));

// --- TIPOS Y ESTADO ---

export type WisphubClientListItem = {
  id_servicio: number;
  usuario?: string;
  nombre?: string;
  apellidos?: string;
  email?: string;
  telefono?: string;
  cedula?: string;
  direccion?: string;
  localidad?: string;
  ciudad?: string;
  usuario_rb?: string;
  sn_onu?: string;
  mac_cpe?: string;
  estado?: string | number;
  [key: string]: any;
};

// Tipo para devolver los datos extraídos del contrato
export type ContractData = {
  csrfToken: string;
  htmlContent: string;
};

let lastFullSyncAt: Date | null = null;

export function getLastFullSyncAt() {
  return lastFullSyncAt;
}

// --- FUNCIONES GEONET ---

/** Helper para extraer token CSRF del HTML */
function extractCsrfToken(html: string): string | null {
  const match = html.match(/name=['"]csrfmiddlewaretoken['"]\s+value=['"]([^'"]+)['"]/);
  return match ? match[1] : null;
}

/** Helper para extraer el contenido HTML del Textarea del contrato */
function extractContractHtml(html: string): string | null {
  // Busca el contenido entre <textarea ... name="contrato-contenido" ...> y </textarea>
  // [\s\S]*? captura todo (incluyendo saltos de linea) de forma no codiciosa
  const match = html.match(/<textarea[^>]*name="contrato-contenido"[^>]*>([\s\S]*?)<\/textarea>/i);
  return match ? match[1] : null;
}

/**
 * Realiza el login en Geonet gestionando CSRF y Cookies automáticamente
 */
export async function authenticateGeonet(): Promise<boolean> {
  try {
    // 1. Obtener cookie inicial CSRF visitando el login
    await geonetHttp.get('/accounts/login/');

    const cookies = await jar.getCookies('https://admin.geonet.cl');
    const csrfToken = cookies.find(c => c.key === 'csrftoken')?.value;

    if (!csrfToken) {
      throw new Error('No se pudo obtener el token CSRF de Geonet');
    }

    // 2. Enviar credenciales
    const params = new URLSearchParams();
    params.append('csrfmiddlewaretoken', csrfToken);
    params.append('login', 'Jorgeprac@geonet'); 
    params.append('password', 'JorgePrac');      
    params.append('next', '/panel/');
    params.append('remember', '1');

    await geonetHttp.post('/accounts/login/', params);
    
    console.log('Autenticación exitosa en Geonet');
    return true;
  } catch (error: any) {
    console.error('Error autenticando en Geonet:', error.message);
    return false;
  }
}

/**
 * 1. Obtiene el HTML de la página, extrae el CSRF Token y el HTML actual del contrato.
 */
export async function getContractDataGeonet(instalacionId: number | string): Promise<ContractData | null> {
  try {
    const url = `/instalaciones/agregar-contrato/${instalacionId}/`;
    const response = await geonetHttp.get(url);
    const html = response.data;

    let csrfToken = extractCsrfToken(html);
    
    // Fallback: si no está en el HTML, buscar en las cookies de la sesión
    if (!csrfToken) {
      const cookies = await jar.getCookies('https://admin.geonet.cl');
      csrfToken = cookies.find(c => c.key === 'csrftoken')?.value || null;
    }

    const htmlContent = extractContractHtml(html);

    if (!csrfToken) {
        console.error(`No se encontró token CSRF para instalación ${instalacionId}`);
        return null;
    }

    if (!htmlContent) {
        console.error(`No se encontró contenido HTML del contrato para instalación ${instalacionId}`);
        return null;
    }

    return { csrfToken, htmlContent };

  } catch (error: any) {
    console.error(`Error obteniendo datos del contrato ${instalacionId}:`, error.message);
    return null;
  }
}

/**
 * 2. Guarda el contrato usando las fechas dinámicas (Hoy -> 1 Año) y el HTML extraído.
 */
export async function saveContractGeonet(
  instalacionId: number | string,
  csrfToken: string,
  contractHtml: string
): Promise<boolean> {
  try {
    // Calcular fechas dinámicas
    const now = new Date();
    const nextYear = new Date();
    nextYear.setFullYear(now.getFullYear() + 1);

    const fechaInicio = formatDateCL(now);      // Ej: 28/01/2026
    const fechaFinal = formatDateCL(nextYear);  // Ej: 28/01/2027

    console.log(`Guardando contrato ID: ${instalacionId} | Inicio: ${fechaInicio} | Fin: ${fechaFinal}`);

    const url = `/instalaciones/agregar-contrato/${instalacionId}/`;
    const form = new FormData();

    // Campos de texto y HTML
    form.append('csrfmiddlewaretoken', csrfToken);
    form.append('contrato-fecha_inicio', fechaInicio);
    form.append('contrato-fecha_final', fechaFinal);
    form.append('contrato-contenido', contractHtml); // HTML original extraído
    form.append('contrato-firma', '');
    
    // Campos ocultos requeridos por Django Formsets
    form.append('form-TOTAL_FORMS', '1');
    form.append('form-INITIAL_FORMS', '0');
    form.append('form-MIN_NUM_FORMS', '0');
    form.append('form-MAX_NUM_FORMS', '1000');
    form.append('form-0-titulo', '');
    form.append('form-0-descripcion', '');
    form.append('guardar_contrato', ''); 

    // Simulación de archivos vacíos requeridos para Multipart
    // Django espera un archivo o un campo vacío pero con estructura de archivo
    const emptyFileOptions = { filename: '', contentType: 'application/octet-stream' };
    form.append('archivo', '', emptyFileOptions);
    form.append('form-0-archivo', '', emptyFileOptions);

    // Envío del POST
    const response = await geonetHttp.post(url, form, {
      headers: {
        ...form.getHeaders(), // Genera headers multipart/form-data con boundary correctos
        'Referer': `https://admin.geonet.cl${url}`
      },
      maxBodyLength: Infinity,
      maxContentLength: Infinity
    });

    // Django redirige (302) al éxito, Axios sigue la redirección y devuelve 200 de la página destino
    if (response.status === 200 || response.status === 302) {
      console.log(`✅ Contrato guardado exitosamente para instalación ${instalacionId}`);
      return true;
    }
    
    console.warn(`⚠️ Guardado de contrato respondió status: ${response.status}`);
    return false;

  } catch (error: any) {
    console.error(`❌ Error guardando contrato para ${instalacionId}:`, error.message);
    if (axios.isAxiosError(error) && error.response) {
      console.error('Detalle error servidor:', error.response.status);
    }
    return false;
  }
}

/**
 * Función Principal Wrapper: Ejecuta todo el flujo (Auth -> Get -> Post)
 */
export async function processContractUpdate(instalacionId: number | string): Promise<boolean> {
    console.log(`Iniciando proceso de renovación de contrato para: ${instalacionId}`);
    
    const auth = await authenticateGeonet();
    if (!auth) return false;

    // Obtener HTML actual y Token
    const contractData = await getContractDataGeonet(instalacionId);
    if (!contractData) return false;

    // Guardar con nuevas fechas
    return await saveContractGeonet(instalacionId, contractData.csrfToken, contractData.htmlContent);
}

/**
 * Descarga el contrato de una instalación específica (PDF)
 */
export async function downloadContratoGeonet(instalacionId: number | string): Promise<Buffer> {
  try {
    const response = await geonetHttp.get(`/instalaciones/imprimir-contrato/${instalacionId}/`, {
      responseType: 'arraybuffer'
    });
    
    return Buffer.from(response.data);
  } catch (error: any) {
    console.error(`Error al descargar contrato ${instalacionId}:`, error.message);
    throw error;
  }
}

/**
 * Activa una instalación específica
 */
export async function activarInstalacionGeonet(
  instalacionId: number | string, 
  usuarioInstalacion: string
): Promise<boolean> {
  try {
    const cookies = await jar.getCookies('https://admin.geonet.cl');
    const csrfToken = cookies.find(c => c.key === 'csrftoken')?.value;

    const params = new URLSearchParams();
    params.append('csrfmiddlewaretoken', csrfToken || '');
    params.append('edit_facturacion', '0');

    const response = await geonetHttp.post(
      `/Instalaciones/${usuarioInstalacion}/${instalacionId}/activar/`,
      params,
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Referer': `https://admin.geonet.cl/Instalaciones/${usuarioInstalacion}/${instalacionId}/activar/`,
        }
      }
    );

    console.log(`Petición de activación enviada para ${instalacionId}. Status: ${response.status}`);
    return response.status === 200;
  } catch (error: any) {
    console.error(`Error al activar instalación ${instalacionId}:`, error.message);
    return false;
  }
}

// --- FUNCIONES WISPHUB ---

export async function checkHealth(): Promise<{ ok: boolean; latencyMs?: number; error?: string }>{
  const start = Date.now();
  try {
    await http.get('/api/clientes/', { params: { limit: 1, offset: 0 } });
    return { ok: true, latencyMs: Date.now() - start };
  } catch (err: any) {
    return { ok: false, latencyMs: Date.now() - start, error: err?.message || 'Health check failed' };
  }
}

export async function listClientsPage(params: Record<string, any> = {}) {
  const res = await http.get('/api/clientes/', { params });
  return res.data as { count: number; next: string | null; previous: string | null; results: WisphubClientListItem[] };
}

function mapToEntity(item: WisphubClientListItem): Client {
  const entity = new Client();
  entity.id_servicio = item.id_servicio;
  entity.usuario = item.usuario ?? null;
  entity.nombre = item.nombre ?? null;
  entity.apellidos = item.apellidos ?? null;
  entity.email = item.email ?? null;
  entity.telefono = item.telefono ?? null;
  entity.cedula = item.cedula ?? null;
  entity.direccion = item.direccion ?? null;
  entity.localidad = item.localidad ?? null;
  entity.ciudad = item.ciudad ?? null;
  entity.usuario_rb = item.usuario_rb ?? null;
  entity.sn_onu = item.sn_onu ?? null;
  entity.mac_cpe = item.mac_cpe ?? null;
  entity.estado = (typeof item.estado === 'number' ? String(item.estado) : item.estado) ?? null;

  const rawObj = parseRaw(item);
  entity.raw = rawObj;

  // Mapeo selectivo por campos con blacklist
  if (!CLIENT_FIELD_BLACKLIST.has('email_cc')) entity.email_cc = asString(rawObj, 'email_cc') ?? null;
  if (!CLIENT_FIELD_BLACKLIST.has('razon_social')) entity.razon_social = asString(rawObj, 'razon_social') ?? null;
  if (!CLIENT_FIELD_BLACKLIST.has('tipo_persona')) entity.tipo_persona = asString(rawObj, 'tipo_persona') ?? null;
  if (!CLIENT_FIELD_BLACKLIST.has('rfc')) entity.rfc = asString(rawObj, 'rfc') ?? null;
  if (!CLIENT_FIELD_BLACKLIST.has('informacion_adicional')) entity.informacion_adicional = stripHtml(asString(rawObj, 'informacion_adicional')) ?? null;
  if (!CLIENT_FIELD_BLACKLIST.has('firewall')) entity.firewall = asString(rawObj, 'firewall') ?? null;
  if (!CLIENT_FIELD_BLACKLIST.has('servicio')) entity.servicio = asString(rawObj, 'servicio') ?? null;
  if (!CLIENT_FIELD_BLACKLIST.has('ip')) entity.ip = asString(rawObj, 'ip') ?? null;
  if (!CLIENT_FIELD_BLACKLIST.has('modelo_router_wifi')) entity.modelo_router_wifi = asString(rawObj, 'modelo_router_wifi') ?? null;
  if (!CLIENT_FIELD_BLACKLIST.has('mac_router_wifi')) entity.mac_router_wifi = asString(rawObj, 'mac_router_wifi') ?? null;
  if (!CLIENT_FIELD_BLACKLIST.has('comentarios')) entity.comentarios = stripHtml(asString(rawObj, 'comentarios')) ?? null;
  if (!CLIENT_FIELD_BLACKLIST.has('precio_plan')) entity.precio_plan = asString(rawObj, 'precio_plan') ?? null;
  if (!CLIENT_FIELD_BLACKLIST.has('estado_facturas')) entity.estado_facturas = asString(rawObj, 'estado_facturas') ?? null;
  if (!CLIENT_FIELD_BLACKLIST.has('fecha_instalacion')) entity.fecha_instalacion = asDateString(rawObj, 'fecha_instalacion');
  if (!CLIENT_FIELD_BLACKLIST.has('fecha_cancelacion')) entity.fecha_cancelacion = asDateString(rawObj, 'fecha_cancelacion');
  if (!CLIENT_FIELD_BLACKLIST.has('fecha_corte')) entity.fecha_corte = asDateString(rawObj, 'fecha_corte');
  if (!CLIENT_FIELD_BLACKLIST.has('ultimo_cambio')) entity.ultimo_cambio = asDateString(rawObj, 'ultimo_cambio');
  if (!CLIENT_FIELD_BLACKLIST.has('plan_internet')) entity.plan_internet = asString(rawObj, 'plan_internet') ?? null;
  if (!CLIENT_FIELD_BLACKLIST.has('zona')) entity.zona = asString(rawObj, 'zona') ?? null;
  if (!CLIENT_FIELD_BLACKLIST.has('router')) entity.router = asString(rawObj, 'router') ?? null;
  if (!CLIENT_FIELD_BLACKLIST.has('sectorial')) entity.sectorial = asString(rawObj, 'sectorial') ?? null;
  if (!CLIENT_FIELD_BLACKLIST.has('tecnico')) entity.tecnico = asString(rawObj, 'tecnico') ?? null;

  entity.lastSyncedAt = new Date();
  return entity;
}

export async function upsertClients(items: WisphubClientListItem[]): Promise<number> {
  if (!items.length) return 0;
  const repo = AppDataSource.getRepository(Client);
  const entities = items.map(mapToEntity);
  const CHUNK = 100;
  for (let i = 0; i < entities.length; i += CHUNK) {
    const slice = entities.slice(i, i + CHUNK);
    await repo.save(slice);
  }
  return entities.length;
}

export async function fullSyncClients(batchSize = 200, maxPages = 1000) {
  let offset = 0;
  let processed = 0;
  for (let page = 0; page < maxPages; page++) {
    const data = await listClientsPage({ limit: batchSize, offset });
    const added = await upsertClients(data.results || []);
    processed += added;
    if (!data.next || (data.results || []).length === 0) break;
    offset += batchSize;
  }
  lastFullSyncAt = new Date();
  return { processed, lastFullSyncAt };
}

export { fullSyncInstallations as _placeholder } from './wisphubInstallations';

export async function refreshClientsByTerm(term: string): Promise<number> {
  const filters: Record<string, string>[] = [
    { usuario__contains: term },
    { nombre__contains: term },
    { apellidos__contains: term },
    { cedula__contains: term },
    { telefono__contains: term },
    { email__contains: term }
  ];
  const seen = new Map<number, WisphubClientListItem>();
  for (const f of filters) {
    try {
      const data = await listClientsPage({ ...f, limit: 50, offset: 0 });
      for (const item of data.results || []) {
        seen.set(item.id_servicio, item);
      }
    } catch {
      // ignorar errores de filtros individuales
    }
  }
  return upsertClients([...seen.values()]);
}
/**
 * Obtiene el link de autologin para el contrato desde el panel de clientes.
 * Scrapea el href del botón con id="auto-login".
 * * @param usuarioInstalacion El nombre de usuario técnico (ej: "1193_jorge@geonet")
 * @param instalacionId El ID numérico de la instalación (ej: 1193)
 */
/**
 * Obtiene el enlace "Ir al link del contrato" (Auto-Login) del panel de clientes.
 * Busca específicamente el href del botón con id='auto-login'.
 */
export async function getAutoLoginContractLink(
  usuarioInstalacion: string, 
  instalacionId: number | string
): Promise<string | null> {
  try {
    // 1. URL donde está el botón (Petición GET)
    const url = `/clientes/generar-link-contrato/${usuarioInstalacion}/${instalacionId}/`;
    
    // 2. Realizamos el GET (Cookies de sesión se envían solas)
    const response = await geonetHttp.get(url);
    const html = response.data;

    // 3. EXTRACCIÓN CON REGEX
    // Explicación del Regex: /href="([^"]+)"\s+id='auto-login'/
    // - href="        : Busca literalmente el texto href="
    // - ([^"]+)       : Captura todo lo que NO sea comillas dobles (aquí está tu URL larga)
    // - "\s+          : Busca el cierre de comillas y un espacio
    // - id='auto-login': Se asegura que sea ESTE botón y no otro
  const regex = /<a\b[^>]*?href="([^"]+)"[^>]*?id=['"]auto-login['"]/;
    const match = html.match(regex);

    if (match && match[1]) {
      const link = match[1];
      console.log(`✅ Link de contrato extraído exitosamente para ${usuarioInstalacion}`);
      return link; // Retorna la URL larga (https://clientes.portalinternet.app/login-panel/...)
    }

    console.warn(`⚠️ No se encontró el botón 'auto-login' para ${usuarioInstalacion}`);
    return null;

  } catch (error: any) {
    console.error(`❌ Error obteniendo link contrato ${usuarioInstalacion}:`, error.message);
    return null;
  }
}

// --- CONFIGURACIÓN DE MODELOS ONU ---

// Mapeo de 'Nombre Modelo' -> 'ID Producto Geonet (dwifi-producto)'
// Actualiza estos IDs según los que tengas en tu sistema Geonet (Inspeccionar elemento en el <select> del HTML)
const MODEL_MAP: Record<string, string> = {
  'ZXHN F600P': '10008',       // ID extraído de tu ejemplo curl
  'ZK9014W': '33070',    // Ejemplo: ajusta esto con el ID real
  'RX8414C6E': '31162',
  'HG15 AX1500': '29374',
  'ZX8404DW': '13899',
  'ZX8202DW': '9723',
  'DEFAULT': '10008'    // Fallback por defecto
};
/**
 * Registra una nueva ONU en el inventario de Geonet.
 * Si no hay sesión activa, intenta loguearse automáticamente.
 * * @param model - El modelo de la ONU (ej: 'ZTE', 'Huawei'). Debe existir en MODEL_MAP.
 * @param sn - El número de serie (ej: 'ZTEGDACC6FF4').
 * @param mac - (Opcional) La dirección MAC. Si no se envía, se manda vacía.
 */
export async function registrarOnuGeonet(model: string, sn: string, mac: string = ''): Promise<boolean> {
  const BASE_URL = 'https://admin.geonet.cl';

  // --- HELPER PARA OBTENER TOKEN ---
  const getLocalToken = async () => {
    const cookies = await jar.getCookies(BASE_URL);
    return cookies.find(c => c.key === 'csrftoken')?.value;
  };

  try {
    // 1. INTENTO DE OBTENER TOKEN
    let csrfToken = await getLocalToken();

    // 2. SI NO HAY TOKEN, AUTENTICARSE
    if (!csrfToken) {
      console.log('⚠️ No se detectó sesión activa. Iniciando auto-login en Geonet...');
      const loggedIn = await authenticateGeonet();
      
      if (!loggedIn) {
        console.error('❌ Falló el auto-login. No se puede registrar la ONU.');
        return false;
      }

      // Re-intentar obtener el token después del login
      csrfToken = await getLocalToken();
    }

    // Si aún así no hay token, abortar
    if (!csrfToken) {
      console.error('❌ Error crítico: Se realizó login pero no se obtuvo CSRF Token.');
      return false;
    }

    // 3. PREPARAR DATOS
    const productId = MODEL_MAP[model.toUpperCase()] || MODEL_MAP['DEFAULT'];
    console.log(`Registrando ONU | Modelo: ${model} (ID: ${productId}) | SN: ${sn}`);

    const params = new URLSearchParams();
    params.append('csrfmiddlewaretoken', csrfToken);
    params.append('dwifi-producto', productId); 
    params.append('dwifi-sucursal', '607');
    params.append('dwifi-proveedor', '1944');
    params.append('form-TOTAL_FORMS', '1');
    params.append('form-INITIAL_FORMS', '0');
    params.append('form-MIN_NUM_FORMS', '1');
    params.append('form-MAX_NUM_FORMS', '1000');
    params.append('form-0-num_serie', sn);
    params.append('form-0-mac', mac);

    // 4. ENVIAR PETICIÓN
    const response = await geonetHttp.post(
      '/productos-wifi/agregar/', 
      params, 
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Referer': `${BASE_URL}/productos-wifi/agregar/`,
          'X-CSRFToken': csrfToken
        }
      }
    );

    // 5. VERIFICAR SI LA SESIÓN EXPIRÓ DURANTE EL POST
    // A veces tenemos token, pero es viejo. Geonet redirige al login (status 200, pero URL cambia a /login/)
    const finalUrl = response.request.res.responseUrl || '';
    if (finalUrl.includes('/accounts/login/')) {
       console.warn('⚠️ La sesión expiró durante la petición. Re-intentando operación una vez más...');
       
       // Forzamos re-login
       await authenticateGeonet(); 
       
       // Llamada recursiva (solo un nivel de profundidad para evitar bucles infinitos)
       // Nota: Esto es seguro porque authenticateGeonet renueva las cookies en el 'jar' global
       return await registrarOnuGeonet(model, sn, mac);
    }

    // 6. VALIDAR ÉXITO
    if (response.status === 200 && !finalUrl.includes('agregar')) {
        console.log(`✅ ONU Registrada exitosamente: ${sn}`);
        return true;
    } else if (response.status === 200 && finalUrl.includes('agregar')) {
        console.warn(`⚠️ Posible error de validación (SN duplicado o datos incorrectos) para ${sn}.`);
        return false;
    }

    return true;

  } catch (error: any) {
    console.error(`❌ Error registrando ONU ${sn}:`, error.message);
    return false;
  }
}


/**
 * Asigna un artículo (ONU/Equipo) directamente a la ficha de un cliente en Geonet.
 * URL Base: /clientes/agregar-articulos/{slug}/{id}/
 * * @param clienteId - El ID numérico del cliente (ej: 1195)
 * @param clienteUsuario - El usuario del cliente (ej: "jorge@geonet") para construir el slug.
 * @param numSerie - El número de serie del equipo.
 * @param mac - (Opcional) La MAC del equipo.
 */
// Definimos una interfaz básica para la respuesta del inventario
interface ArticuloInventario {
  value: string;      // Este es el UUID
  label: string;      // Nombre del producto
  num_serie: string;  // Número de serie
  mac?: string;       // MAC address (a veces viene nula)
  categoria: string;
}

export async function agregarArticuloACliente(
  clienteId: number | string,
  clienteUsuario: string,
  numSerie: string,
  mac: string = '',
  categoria: string = 'Productos Wifi'
): Promise<boolean> {
  
  console.log(`Iniciando proceso para agregar artículo a cliente ${clienteId}... Usuario: ${clienteUsuario} | Serie: ${numSerie}`);
  
  const targetUrl = `/clientes/agregar-articulos/${clienteUsuario}/${clienteId}/`;
  const inventoryUrl = '/autocomplete-almacen/?exclude_services'; // URL para buscar el UUID
  const refererUrl = `https://admin.geonet.cl${targetUrl}`;

  try {
    // --------------------------------------------------------------------------------
    // 1. y 2. GESTIÓN DE AUTENTICACIÓN Y CSRF (Igual que tu código original)
    // --------------------------------------------------------------------------------
    const cookies = await jar.getCookies('https://admin.geonet.cl');
    let csrfToken = cookies.find(c => c.key === 'csrftoken')?.value;

    if (!csrfToken) {
      console.log('⚠️ Sin sesión para agregar artículo. Intentando login...');
      const logged = await authenticateGeonet(); // Asumo que esta función existe en tu entorno
      if (!logged) return false;
      const newCookies = await jar.getCookies('https://admin.geonet.cl');
      csrfToken = newCookies.find(c => c.key === 'csrftoken')?.value;
    }

    if (!csrfToken) {
      console.error('❌ Error: No se pudo obtener CSRF Token.');
      return false;
    }

    // --------------------------------------------------------------------------------
    // 2.5. OBTENER EL UUID REAL DEL ALMACÉN (NUEVO PASO CRÍTICO)
    // --------------------------------------------------------------------------------
    console.log(`🔍 Buscando UUID para el número de serie: ${numSerie}...`);
    
    // Hacemos la petición GET al inventario
    const inventoryResponse = await geonetHttp.get<ArticuloInventario[]>(inventoryUrl, {
      headers: {
        'Referer': refererUrl, // Importante para que el servidor sepa de dónde venimos
        'X-CSRFToken': csrfToken
      }
    });

    // Buscamos el objeto que coincida con el número de serie
    const articuloEncontrado = inventoryResponse.data.find(
      (item) => item.num_serie && item.num_serie.trim() === numSerie.trim()
    );

    if (!articuloEncontrado) {
      console.error(`❌ Error: El equipo con serie "${numSerie}" no se encuentra en el Almacén (o ya fue asignado).`);
      return false; 
    }

    const uuidReal = articuloEncontrado.value; // 'value' contiene el UUID en la respuesta de Geonet
    console.log(`✅ Equipo encontrado. UUID: ${uuidReal}`);

    // --------------------------------------------------------------------------------
    // 3. PREPARAR EL PAYLOAD (Formulario)
    // --------------------------------------------------------------------------------
    const form = new URLSearchParams();
    form.append('csrfmiddlewaretoken', csrfToken);
    
    form.append('form-TOTAL_FORMS', '1');
    form.append('form-INITIAL_FORMS', '0');
    form.append('form-MIN_NUM_FORMS', '1');
    form.append('form-MAX_NUM_FORMS', '1000');
    
    // DATOS DINÁMICOS OBTENIDOS
    form.append('form-0-uuid', uuidReal); // <--- AQUI USAMOS EL UUID REAL
    form.append('form-0-categoria', categoria);
    form.append('form-0-num_serie', numSerie);
    
    // Si no pasaste MAC en la función, intentamos usar la que viene del inventario, o vacía.
    const macFinal = mac || articuloEncontrado.mac || ''; 
    form.append('form-0-mac', macFinal);
    
    form.append('form-0-cantidad', '1');
    form.append('form-0-accion_equipo', '0'); 
    form.append('form-0-comentario', 'Asignado via Bot');

    // --------------------------------------------------------------------------------
    // 4. ENVIAR PETICIÓN POST
    // --------------------------------------------------------------------------------
    console.log(`🚀 Asignando artículo ${numSerie} (UUID: ${uuidReal}) a cliente...`);

    const response = await geonetHttp.post(targetUrl, form, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': refererUrl,
        'X-CSRFToken': csrfToken,
        'Origin': 'https://admin.geonet.cl'
      },
      // Evitamos que axios siga el redirect automáticamente para poder analizar la URL de respuesta
      maxRedirects: 5 
    });

    // --------------------------------------------------------------------------------
    // 5. VALIDAR RESPUESTA
    // --------------------------------------------------------------------------------
    const finalUrl = response.request.res.responseUrl || '';
    
    // En Django/WispHub, si hay éxito suele redirigir a la lista de clientes o al perfil (/clientes/1195/...)
    // Si falla, suele devolver 200 OK pero manteniéndose en la misma URL de 'agregar-articulos' pintando el error en HTML.
    
    if (response.status === 200 && !finalUrl.includes('agregar-articulos')) {
      console.log(`✅ ÉXITO: Artículo agregado. Redirigido a: ${finalUrl}`);
      return true;
    } else {
      // Si quieres depurar, podrías imprimir response.data para ver qué error muestra el HTML
      console.warn(`⚠️ FALLO: El servidor no realizó la asignación. URL final: ${finalUrl}`);
      return false;
    }

  } catch (error: any) {
    console.error(`❌ Excepción crítica al agregar artículo:`, error.message);
    if (error.response) {
        console.error('Status:', error.response.status);
        console.error('Data:', error.response.data); // Útil para ver si el servidor devolvió un error específico
    }
    return false;
  }
}


export async function searchLocal(term: string, limit = 50) {
  const repo = AppDataSource.getRepository(Client);
  return repo.createQueryBuilder('c')
    .where('c.usuario LIKE :q', { q: `%${term}%` })
    .orWhere('c.nombre LIKE :q', { q: `%${term}%` })
    .orWhere('c.apellidos LIKE :q', { q: `%${term}%` })
    .orWhere('c.email LIKE :q', { q: `%${term}%` })
    .orWhere('c.telefono LIKE :q', { q: `%${term}%` })
    .orWhere('c.cedula LIKE :q', { q: `%${term}%` })
    .orWhere('c.ciudad LIKE :q', { q: `%${term}%` })
    .orWhere('c.localidad LIKE :q', { q: `%${term}%` })
    .orWhere('c.usuario_rb LIKE :q', { q: `%${term}%` })
    .orWhere('c.sn_onu LIKE :q', { q: `%${term}%` })
    .orWhere('c.mac_cpe LIKE :q', { q: `%${term}%` })
    .limit(limit)
    .getMany();
}
// =============================================================================
// SECCIÓN: SUBIDA DE DOCUMENTOS (GEONET)
// =============================================================================

/**
 * Helper para detectar el tipo MIME correcto del archivo.
 * Vital para evitar el Error 500 en Django.
 */
function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.png': return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.pdf': return 'application/pdf';
    case '.doc':
    case '.docx': return 'application/msword';
    default: return 'application/octet-stream';
  }
}

/**
 * Sube una imagen o documento al perfil de un cliente en Geonet.
 * Replica el comportamiento del formulario "Agregar archivo".
 * * @param clienteId - ID numérico del cliente (ej: 1178)
 * @param clienteUsuario - Slug del usuario (ej: "yanira_1178@geonet")
 * @param filePath - Ruta absoluta o relativa al archivo en tu PC
 * @param titulo - (Opcional) Título del documento. Si no se da, usa el nombre del archivo.
 * @param descripcion - (Opcional) Descripción.
 * @param visible - (Opcional) Si es visible para el cliente (True/False). Default: true.
 */

export async function uploadDocumentoCliente(
  clienteId: number | string,
  clienteUsuario: string,
  filePath: string,
  titulo?: string,
  descripcion: string = 'Carga automática via Bot',
  visible: boolean = true
): Promise<boolean> {

  // --- LÓGICA DE RUTAS DOCKER / LINUX ---
  let systemPath = filePath;

  // 1. Detectamos si es una ruta absoluta que apunta a la raíz '/' 
  // pero que debería estar dentro del WORKDIR del contenedor.
  if (filePath.startsWith('/')) {
      // Verificamos si existe en la raíz absoluta (poco probable en Docker a menos que sea un volumen externo)
      if (!fs.existsSync(filePath)) {
          // Si no existe en raíz, asumimos que es relativa al directorio de trabajo del bot (/app)
          const relativePath = filePath.replace(/^\//, ''); // Quitamos el slash inicial
          systemPath = path.join(process.cwd(), relativePath);
      }
  } 
  // 2. Si es relativa normal
  else if (!path.isAbsolute(filePath)) {
      systemPath = path.join(process.cwd(), filePath);
  }

  // --- DEBUGGING PARA DOCKER ---
  // Esto aparecerá en los logs del contenedor (docker logs <container_id>)
  if (!fs.existsSync(systemPath)) {
    console.error(`❌ [DOCKER ERROR] Archivo no encontrado.`);
    console.error(`   👉 Ruta recibida (BD): ${filePath}`);
    console.error(`   👉 Ruta intentada (Sistema): ${systemPath}`);
    console.error(`   👉 Directorio de trabajo (CWD): ${process.cwd()}`);
    
    // Intento desesperado: Listar carpeta uploads para ver si hay algo
    try {
        const uploadDir = path.join(process.cwd(), 'uploads', 'chat');
        console.error(`   📂 Contenido de ${uploadDir}:`, fs.readdirSync(uploadDir));
    } catch (e) {
        console.error(`   📂 No se pudo leer la carpeta uploads/chat`);
    }
    
    return false;
  }

  // ... (RESTO DEL CÓDIGO IGUAL QUE ANTES: PREPARAR FORMDATA Y POST) ...
  
  const fileName = path.basename(systemPath);
  const mimeType = getMimeType(systemPath);
  const finalTitulo = titulo || fileName;
  const fileSize = fs.statSync(systemPath).size;

  console.log(`🚀 [Geonet] Subiendo desde Docker: ${systemPath}`);

  const targetUrl = `/clientes/agregar-documento/${clienteUsuario}/`;
  const fullUrl = `https://admin.geonet.cl${targetUrl}`;

  try {
    await geonetHttp.get(targetUrl);
    const cookies = await jar.getCookies('https://admin.geonet.cl');
    let csrfToken = cookies.find(c => c.key === 'csrftoken')?.value;

    if (!csrfToken) {
        const logged = await authenticateGeonet();
        if (!logged) return false;
        const newCookies = await jar.getCookies('https://admin.geonet.cl');
        csrfToken = newCookies.find(c => c.key === 'csrftoken')?.value;
    }

    if (!csrfToken) return false;

    const form = new FormData();
    form.append('csrfmiddlewaretoken', csrfToken);
    form.append('titulo', finalTitulo);
    form.append('descripcion', descripcion);
    if (visible) form.append('visible', 'on');

    const fileStream = fs.createReadStream(systemPath);
    form.append('archivo', fileStream, {
      filename: fileName,
      contentType: mimeType,
      knownLength: fileSize
    });

    const response = await geonetHttp.post(targetUrl, form, {
      headers: {
        ...form.getHeaders(),
        'Referer': fullUrl,
        'Origin': 'https://admin.geonet.cl',
        'X-CSRFToken': csrfToken
      },
      maxRedirects: 0, 
      validateStatus: (status) => status >= 200 && status < 400
    });

    if (response.status === 302 || response.status === 200) {
      console.log(`✅ Documento subido exitosamente.`);
      return true;
    }
    return false;

  } catch (error: any) {
    console.error(`❌ Error subiendo documento: ${error.message}`);
    return false;
  }
}


