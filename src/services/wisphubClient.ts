import axios, { AxiosHeaders } from 'axios';
import puppeteer, { Browser, Page, Protocol, ElementHandle } from 'puppeteer-core';
import { AppDataSource } from '../datasource';
import { Client } from '../models/Client';
import { WISPHUB } from '../config';
import { parseRaw, asString, asDateString, stripHtml } from './rawParser';
import * as fs from 'fs';
import * as path from 'path';
import { ensureRequestDelay } from '../utils/apiThrottle';
import { authorizeOnu, getOnuBySerial, updateOnuSn, changeOnuType, updateOnuLocation } from './smartoltClient';

// --- CONFIGURACIÓN PUPPETEER / BROWSERLESS ---
// Asegúrate de que esta URL apunta a tu servicio 'browser' en docker-compose
const BROWSER_WS = process.env.BROWSER_WS_ENDPOINT || 'ws://browser:3000';
const GEONET_BASE_URL = 'https://admin.geonet.cl';

// Cache de cookies en memoria. 
// Usamos 'any[]' para evitar el error de TypeScript TS2322/TS2305 entre Protocol y Puppeteer
let cachedCookies: any[] | null = null;
let cookiesTimestamp: number = 0;

// --- CONFIGURACIÓN WISPHUB (API REST) - SE MANTIENE CON AXIOS ---
// (Esta parte no toca Geonet, así que sigue igual para mantener velocidad y compatibilidad)

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

ensureRequestDelay(http);

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

// --- TIPOS ---

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

// --- HELPERS DE PUPPETEER ---

/**
 * Conecta al contenedor Browserless
 */
async function getBrowser(): Promise<Browser> {
  // Reutilizar una única conexión a Browserless para evitar overhead de conectar/desconectar
  // Implementamos reintentos y sobreescribimos `disconnect` para que sea no-op
  // (usar `shutdownBrowser()` para cerrar realmente la conexión en shutdown)
  if ((global as any).__sharedBrowser) {
    try {
      return (global as any).__sharedBrowser as Browser;
    } catch {
      // continue to reconnect
    }
  }

  const MAX_ATTEMPTS = 3;
  let lastErr: any = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      console.log(`[Puppeteer] Conectando a ${BROWSER_WS} (intento ${attempt})...`);
      const browser = await puppeteer.connect({
        browserWSEndpoint: BROWSER_WS,
        defaultViewport: { width: 1920, height: 1080 }
      });

      // Guardar el disconnect real y reemplazar por noop para reutilización
      (browser as any).__realDisconnect = (browser as any).disconnect?.bind(browser) || null;
      (browser as any).disconnect = async () => { /* noop: conexión compartida */ };

      (global as any).__sharedBrowser = browser;
      return browser;
    } catch (err: any) {
      lastErr = err;
      console.warn(`[Puppeteer] Error conectando a browserless: ${err.message || err}. Reintentando...`);
      await new Promise((res) => setTimeout(res, 1000 * attempt));
    }
  }
  throw new Error(`No se pudo conectar a Browserless: ${lastErr?.message || lastErr}`);
}

/** Cierra la conexión compartida al browser (usar en shutdown del proceso) */
export async function shutdownBrowser(): Promise<void> {
  const shared = (global as any).__sharedBrowser as Browser | undefined;
  if (!shared) return;
  const real = (shared as any).__realDisconnect;
  try {
    if (real) await real();
  } catch (e: any) {
    console.warn('[Puppeteer] Error cerrando browser:', e?.message || e);
  }
  (global as any).__sharedBrowser = null;
}

/**
 * Abre una nueva pestaña (Page) con reintentos si el browser compartido está caído.
 * Retorna tanto el `browser` como el `page` para permitir el cierre/`disconnect` desde el caller.
 */
export async function openPage(): Promise<{ browser: Browser; page: Page }> {
  let browser = await getBrowser();
  try {
    const page = await browser.newPage();

    // Set a reasonable default navigation timeout
    page.setDefaultNavigationTimeout(45000);

    // Intercept requests to block images, fonts, styles and tracking scripts
    try {
      await page.setRequestInterception(true);
      const blockedResourceTypes = new Set(['image', 'stylesheet', 'font']);
      const blockedUrlPatterns = [
        'google-analytics',
        'googletagmanager',
        'doubleclick',
        'analytics.js',
        'gtag/js',
        'adsystem.com',
        'ads.google',
        'facebook.net',
        'connect.facebook.net',
        'hotjar',
        'mixpanel',
        'matomo'
      ];

      page.on('request', (req) => {
        try {
          const url = req.url().toLowerCase();
          const rType = req.resourceType();
          if (blockedResourceTypes.has(rType)) return req.abort();
          for (const p of blockedUrlPatterns) if (url.includes(p)) return req.abort();
          return req.continue();
        } catch (e) {
          try { req.continue(); } catch (_) {}
        }
      });
    } catch (e) {
      // Ignore if interception not available
    }

    return { browser, page };
  } catch (err: any) {
    console.warn('[Puppeteer] newPage falló, intentando reconectar...', err?.message || err);
    try {
      await shutdownBrowser();
    } catch (e) {}
    browser = await getBrowser();
    const page = await browser.newPage();
    return { browser, page };
  }
}

/**
 * Intenta navegar y si somos redirigidos al login hace login y reintenta.
 * Opcional: esperar por un selector tras la navegación.
 */
async function safeGoto(page: Page, url: string, opts?: { waitForSelector?: string; timeout?: number }): Promise<any> {
  const timeout = opts?.timeout ?? 30000;
  let response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout });

  // Si la navegación nos lleva al login, forzamos login y reintentamos
  if (page.url().includes('/accounts/login/')) {
    const ok = await ensureSession(page, { force: true });
    if (!ok) throw new Error('No se pudo autenticar en Geonet');
    response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
  }

  if (opts?.waitForSelector) {
    await page.waitForSelector(opts.waitForSelector, { timeout: 10000 }).catch(() => null);
  }

  return response;
}

/**
 * Gestiona el Login y la sesión en Geonet internamente.
 * Reutiliza cookies para no loguearse en cada petición.
 */
async function ensureSession(page: Page, opts?: { force?: boolean }): Promise<boolean> {
  const start = Date.now();
  try {
    const isCookieFresh = (Date.now() - cookiesTimestamp) < 1000 * 60 * 45; // 45 min

    // 1. Si tenemos cookies frescas y no forzamos, inyectamos y confiamos en ellas (optimistic)
    if (!opts?.force && cachedCookies && cachedCookies.length > 0 && isCookieFresh) {
      await page.setCookie(...cachedCookies);
      return true;
    }

    // 2. Si forzamos o no tenemos cookies válidas, navegar al login y hacer login rápido
    console.log('[Puppeteer] No hay cookie válida o se forzó renovación. Realizando login...');

    // Ir directo a la pantalla de login (más rápido que esperar una redirección desde /panel/)
    await page.goto(`${GEONET_BASE_URL}/accounts/login/`, { waitUntil: 'domcontentloaded', timeout: 15000 });

    // Esperar los inputs de login
    await page.waitForSelector('input[name="login"]', { timeout: 10000 });

    const user = process.env.GEONET_USER || 'Jorgeprac@geonet';
    const pass = process.env.GEONET_PASS || 'JorgePrac';

    await page.evaluate(() => {
      (document.querySelector('input[name="login"]') as HTMLInputElement)?.focus?.();
    }).catch(() => null);

    await page.click('input[name="login"]', { clickCount: 3 });
    await page.type('input[name="login"]', user);
    await page.click('input[name="password"]', { clickCount: 3 });
    await page.type('input[name="password"]', pass);

    // Click en submit y esperar navegación mínima
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => null),
      page.click('button[type="submit"]')
    ]);

    // Verificar éxito aproximado (si estamos en panel o no en login)
    if (!page.url().includes('/accounts/login/')) {
      cachedCookies = await page.cookies();
      cookiesTimestamp = Date.now();
      console.log('[Puppeteer] Login exitoso.');
      return true;
    }

    console.error('[Puppeteer] Login fallido. URL actual: ' + page.url());
    return false;
  } catch (error: any) {
    console.error(`[Puppeteer] Error crítico de sesión: ${error.message}`);
    console.log(`[Puppeteer] ensureSession tiempo (error): ${Date.now() - start}ms`);
    return false;
  }
}

/**
 * Función pública para verificar autenticación (usada por rutas externas como chat.ts).
 */
export async function authenticateGeonet(): Promise<boolean> {
  const { browser, page } = await openPage();
  try {
    // Solo intentamos asegurar sesión. Si retorna true, es que logueó correctamente.
    return await ensureSession(page);
  } catch (error) {
    console.error('[authenticateGeonet] Error:', error);
    return false;
  } finally {
    await page.close();
    await browser.disconnect();
  }
}

/** Formatea una fecha JS a DD/MM/YYYY */
function formatDateCL(date: Date): string {
  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const year = date.getFullYear();
  return `${day}/${month}/${year}`;
}

// --- FUNCIONES WISPHUB (LECTURA API) ---

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

// --- FUNCIONES DB & SYNC (SIN CAMBIOS) ---

let lastFullSyncAt: Date | null = null;
export function getLastFullSyncAt() { return lastFullSyncAt; }

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

// =============================================================================
// SECCIÓN: AUTOMATIZACIÓN GEONET CON PUPPETEER
// =============================================================================

/**
 * Renueva el contrato mediante Puppeteer.
 */
export async function processContractUpdate(instalacionId: number | string): Promise<boolean> {
  const start = Date.now();
  console.log(`[Puppeteer] Iniciando renovación de contrato: ${instalacionId}`);
  const { browser, page } = await openPage();

  try {
    if (!await ensureSession(page)) return false;

    // 1. Ir al formulario
    const url = `${GEONET_BASE_URL}/instalaciones/agregar-contrato/${instalacionId}/`;
    await safeGoto(page, url, { waitForSelector: 'input[name="contrato-fecha_inicio"]', timeout: 60000 });

    // 2. Definir fechas
    const now = new Date();
    const nextYear = new Date();
    nextYear.setFullYear(now.getFullYear() + 1);
    const fechaInicio = formatDateCL(now);
    const fechaFinal = formatDateCL(nextYear);

    // 3. Llenar inputs (Click x3 para seleccionar todo y reemplazar)
    await page.click('input[name="contrato-fecha_inicio"]', { clickCount: 3 });
    await page.type('input[name="contrato-fecha_inicio"]', fechaInicio);

    await page.click('input[name="contrato-fecha_final"]', { clickCount: 3 });
    await page.type('input[name="contrato-fecha_final"]', fechaFinal);

    // 4. Submit
    const submitBtn = await page.$('button[type="submit"]') || await page.$('input[type="submit"]');
    if (!submitBtn) throw new Error('Botón guardar no encontrado');

    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
      submitBtn.click()
    ]);

    console.log(`✅ Contrato actualizado para ${instalacionId}`);
    console.log(`[Puppeteer] processContractUpdate tiempo total: ${Date.now() - start}ms`);
    return true;

  } catch (error: any) {
    console.error(`❌ Error processContractUpdate: ${error.message}`);
    return false;
  } finally {
    await page.close();
    await browser.disconnect();
  }
}

/**
 * Descarga el PDF del contrato
 */
export async function downloadContratoGeonet(instalacionId: number | string): Promise<Buffer> {
  const start = Date.now();
  const { browser, page } = await openPage();
  try {
    if (!await ensureSession(page)) throw new Error('Auth falló');

    const url = `${GEONET_BASE_URL}/instalaciones/imprimir-contrato/${instalacionId}/`;
    const t0 = Date.now();
    const response = await safeGoto(page, url, { timeout: 60000 });
    console.log(`[Puppeteer] downloadContratoGeonet goto time: ${Date.now() - t0}ms`);
    const buffer = await response?.buffer();

    if (!buffer) throw new Error('No se recibió buffer del PDF');
    console.log(`[Puppeteer] downloadContratoGeonet tiempo total: ${Date.now() - start}ms`);
    return buffer;

  } catch (error: any) {
    console.error(`Error descarga contrato: ${error.message}`);
    throw error;
  } finally {
    await page.close();
    await browser.disconnect();
  }
}


export async function activarInstalacionGeonet(
  instalacionId: number | string,
  usuarioInstalacion: string
): Promise<{ ok: boolean; status?: number; error?: string }> {
  const start = Date.now();
  const { browser, page } = await openPage();

  const targetUrl = `${GEONET_BASE_URL}/Instalaciones/${usuarioInstalacion}/${instalacionId}/activar/`;
  console.log(`[Puppeteer] Navegando a: ${targetUrl}`);

  try {
    if (!await ensureSession(page)) throw new Error('Auth falló');

    // 1. Cargar la página
    await safeGoto(page, targetUrl, { timeout: 30000 });

    // 2. PREPARACIÓN DEL TERRENO
    // Borramos el GIF de carga para evitar intercepciones de click
    await page.evaluate(() => {
        const gif = document.getElementById('content-loading-gif');
        if (gif) gif.remove();
        
        const backdrop = document.querySelector('.modal-backdrop');
        if (backdrop) backdrop.remove();
    });

    // 3. BUSCAR EL BOTÓN (Sintaxis compatible Puppeteer reciente)
    // Usamos el prefijo 'xpath/' seguido de '//button...'
    const selectorXpath = "xpath///button[contains(text(), 'Activar Instalación') and not(contains(text(), 'Editar'))]";
    
    const botonActivacion = await page.waitForSelector(selectorXpath, { visible: true, timeout: 5000 });

    if (!botonActivacion) {
        throw new Error("No se encontró el botón específico de activación.");
    }

    console.log('[Puppeteer] Botón encontrado. Haciendo CLICK físico...');

    // 4. CLICK Y CONFIRMACIÓN INMEDIATA
    await Promise.all([
        // Esperamos brevemente por si hay navegación, pero no bloqueamos el éxito
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 5000 }).catch(() => null),
        botonActivacion.click()
    ]);

    // 5. RETORNO DE ÉXITO
    // Si llegamos aquí, el click se realizó sin lanzar error.
    console.log(`✅ Activación enviada correctamente (Click realizado).`);
    return { ok: true, status: 200 };

  } catch (error: any) {
    console.error(`❌ Error activarInstalacionGeonet: ${error.message}`);
    return { ok: false, error: error.message };
  } finally {
    await page.close();
    await browser.disconnect();
  }
}
export async function getAutoLoginContractLink(
  usuarioInstalacion: string, 
  instalacionId: number | string
): Promise<string | null> {
  const { browser, page } = await openPage();
  try {
    if (!await ensureSession(page)) return null;

    const normalizeSpaces = (val: string) => val.trim().replace(/\s+/g, ' ');
    const baseUser = normalizeSpaces(usuarioInstalacion);
    const candidates = Array.from(new Set([baseUser, baseUser.replace(/\s+/g, '-'), baseUser.replace(/\s+/g, '_')]));

    for (const usuario of candidates) {
      const url = `${GEONET_BASE_URL}/clientes/generar-link-contrato/${usuario}/${instalacionId}/`;
      const response = await page.goto(url, { waitUntil: 'domcontentloaded' });
      
      if (response?.status() === 404) continue;

      // Buscamos el elemento y extraemos su atributo href
      const href = await page.$eval('#auto-login', (el) => (el as HTMLAnchorElement).href).catch(() => null);

      if (href) {
        console.log(`✅ Link encontrado para ${usuario}`);
        return href;
      }
    }
    return null;
  } catch (e) {
    console.error(e);
    return null;
  } finally {
    await page.close();
    await browser.disconnect();
  }
}

// --- GESTIÓN DE ONUs ---

const MODEL_MAP: Record<string, string> = {
  'ZXHN F600P': '10008',
  'ZK9014W': '33070',
  'RX8414C6E': '31162',
  'HG15 AX1500': '29374',
  'ZX8404DW': '13899',
  'ZX8202DW': '9723',
  'DEFAULT': '10008'
};

// --- GESTIÓN DE ONUs ---

export async function registrarOnuGeonet(model: string, sn: string, mac: string = ''): Promise<boolean> {
  const start = Date.now();
  const { browser, page } = await openPage();
  try {
    if (!await ensureSession(page)) return false;

    const url = `${GEONET_BASE_URL}/productos-wifi/agregar/`;
    const t0 = Date.now();
    await safeGoto(page, url, { waitForSelector: '#id_dwifi-producto' });
    console.log(`[Puppeteer] registrarOnuGeonet goto time: ${Date.now() - t0}ms`);
    
    // Esperar a que el formulario esté listo
    await page.waitForSelector('#id_dwifi-producto', { visible: true });

    // --- LÓGICA DE SELECCIÓN INTELIGENTE ---
    const selection = await page.evaluate((targetModel) => {
        const productSelect = document.querySelector('#id_dwifi-producto') as HTMLSelectElement;
        const sucursalSelect = document.querySelector('#id_dwifi-sucursal') as HTMLSelectElement;
        const proveedorSelect = document.querySelector('#id_dwifi-proveedor') as HTMLSelectElement;

        let prodVal = "";
        let sucVal = "";
        let provVal = "";

        // 1. PRODUCTO: Buscar exacto o Fallback a "ZXHN F600P"
        // Convertimos las opciones a array para buscar
        const prodOptions = Array.from(productSelect.options);
        
        // Intento 1: Busqueda laxa por el modelo que pasamos
        let foundOption = prodOptions.find(o => o.text.toUpperCase().includes(targetModel.toUpperCase()));
        
        // Intento 2: Fallback a ZXHN F600P (ID 10008 en tu html)
        if (!foundOption) {
            foundOption = prodOptions.find(o => o.text.toUpperCase().includes("ZXHN F600P"));
        }
        // Intento 3: Fallback a F600P genérico
        if (!foundOption) {
            foundOption = prodOptions.find(o => o.text.toUpperCase().includes("F600P"));
        }
        
        if (foundOption) prodVal = foundOption.value;

        // 2. SUCURSAL: Seleccionar la primera opción que tenga valor (ignorar el placeholder)
        for (let i = 0; i < sucursalSelect.options.length; i++) {
            if (sucursalSelect.options[i].value) {
                sucVal = sucursalSelect.options[i].value;
                break; // Usar la primera disponible (Talca 3 Sur...)
            }
        }

        // 3. PROVEEDOR: Buscar "TAC"
        const provOption = Array.from(proveedorSelect.options).find(o => 
            o.text.toUpperCase().includes("TAC")
        );
        // Si encuentra TAC usa ese, sino usa la primera opción válida
        if (provOption) {
            provVal = provOption.value;
        } else {
             for (let i = 0; i < proveedorSelect.options.length; i++) {
                if (proveedorSelect.options[i].value) {
                    provVal = proveedorSelect.options[i].value;
                    break;
                }
            }
        }

        return { prodVal, sucVal, provVal };
    }, model);

    if (!selection.prodVal) {
        console.error(`[Puppeteer] No se pudo encontrar un producto válido para ${model}`);
        return false;
    }

    console.log(`[Puppeteer] Seleccionando: Prod=${selection.prodVal}, Suc=${selection.sucVal}, Prov=${selection.provVal}`);

    // Aplicar selecciones
    await page.select('#id_dwifi-producto', selection.prodVal);
    if (selection.sucVal) await page.select('#id_dwifi-sucursal', selection.sucVal);
    if (selection.provVal) await page.select('#id_dwifi-proveedor', selection.provVal);

    // Escribir Serial (Limpiando primero)
    await page.click('#id_form-0-num_serie', { clickCount: 3 });
    await page.type('#id_form-0-num_serie', sn);

    // Escribir MAC si existe
    if (mac) {
        await page.click('#id_form-0-mac', { clickCount: 3 });
        await page.type('#id_form-0-mac', mac);
    }

    // Click en Guardar (es un <a id="submit-button">)
    await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
        page.click('#submit-button')
    ]);

    // Verificar si seguimos en la misma página (error)
    if (page.url().includes('/agregar/')) {
        console.warn(`⚠️ Geonet no aceptó el registro. Posible serial duplicado.`);
        return false;
    }

    console.log(`✅ ONU ${sn} registrada correctamente.`);
    console.log(`[Puppeteer] registrarOnuGeonet tiempo total: ${Date.now() - start}ms`);
    return true;

  } catch (error: any) {
    console.error(`Error registrarOnuGeonet: ${error.message}`);
    return false;
  } finally {
    await page.close();
    await browser.disconnect();
  }
}

export async function agregarArticuloACliente(
  clienteId: number | string,
  clienteUsuario: string,
  numSerie: string,
  mac: string = '',
  categoria: string = 'Productos Wifi' // Este parámetro es menos relevante ahora porque la API lo decide, pero lo mantenemos por compatibilidad
): Promise<boolean> {
  const start = Date.now();
  const { browser, page } = await openPage();

  try {
    if (!await ensureSession(page)) return false;

    // 1. IR A LA PÁGINA
    // Nota: El HTML sugiere que la URL tiene el formato /clientes/agregar-articulos/USUARIO/ID/
    const url = `${GEONET_BASE_URL}/clientes/agregar-articulos/${clienteUsuario}/${clienteId}/`;
    
    console.log(`[Puppeteer] Navegando a asignar artículo: ${url}`);
    await safeGoto(page, url, { waitForSelector: '.lista-productos-wifi' });

    // 2. INTERACTUAR CON EL BUSCADOR (AUTOCOMPLETE)
    console.log(`[Puppeteer] Buscando equipo por serial: ${numSerie}`);
    
    // Enfocar y limpiar el input por seguridad
    await page.click('.lista-productos-wifi', { clickCount: 3 });
    await page.keyboard.press('Backspace');
    
    // Escribir el serial simulando tipeo humano (delay ayuda a que jQuery UI reaccione)
    await page.type('.lista-productos-wifi', numSerie, { delay: 100 });

    // 3. ESPERAR Y SELECCIONAR DEL DROPDOWN
    // El HTML usa jQuery UI, que genera una lista ul.ui-autocomplete
    try {
      // Esperamos a que aparezca el item del menú que contiene el serial o texto del producto
      const selectorItemMenu = `ul.ui-autocomplete li.ui-menu-item`;
      
      await page.waitForSelector(selectorItemMenu, { visible: true, timeout: 10000 });

      // Buscamos el elemento específico que contenga el serial (para evitar seleccionar otro parecido)
      const itemEncontrado = await page.evaluateHandle((selector, serial) => {
        const items = document.querySelectorAll(selector);
        for (const item of items) {
          // El texto suele ser "Modelo - Serial" o similar según tu script
          if (item.textContent?.toUpperCase().includes(serial.toUpperCase())) {
            return item;
          }
        }
        return items[0]; // Fallback: devolver el primero si no hay coincidencia exacta de texto pero sí resultados
      }, selectorItemMenu, numSerie);

      if (!itemEncontrado) throw new Error("Elemento no encontrado en el dropdown");

      console.log('[Puppeteer] Elemento encontrado en inventario. Haciendo click...');
      const elementHandle = itemEncontrado.asElement() as ElementHandle<Element> | null;
      if (elementHandle) {
        await elementHandle.click();
      } else {
        throw new Error("Elemento no es un ElementHandle<Element>");
      }

    } catch (e) {
      console.error(`❌ No se encontró el equipo ${numSerie} en el autocompletado.`);
      return false;
    }

    // 4. ESPERAR A QUE LA FILA SE AGREGUE Y RELLENE
    // El script de la página hace $(".add-row").click() y luego rellena los campos.
    // Esperamos a que el input de serie tenga valor.
    const inputSerieSelector = 'input[name$="-num_serie"]'; // Selector genérico para formsets (form-0-num_serie, form-1...)
    
    await page.waitForFunction((selector, serial) => {
      const inputs = document.querySelectorAll(selector);
      // Buscamos el último input agregado
      const lastInput = inputs[inputs.length - 1] as HTMLInputElement;
      return lastInput && lastInput.value.includes(serial);
    }, { timeout: 5000 }, inputSerieSelector, numSerie);

    // 5. (OPCIONAL) MODIFICAR MAC SI SE PROVEE
    if (mac) {
      console.log(`[Puppeteer] Sobreescribiendo MAC con: ${mac}`);
      // Buscamos el último input de MAC generado
      await page.evaluate((macVal) => {
        const macInputs = document.querySelectorAll('input.mac-address');
        const lastMacInput = macInputs[macInputs.length - 1] as HTMLInputElement;
        if (lastMacInput) {
          lastMacInput.value = macVal;
          // Disparar eventos para que validadores de JS (si los hay) se enteren
          lastMacInput.dispatchEvent(new Event('change', { bubbles: true }));
          lastMacInput.dispatchEvent(new Event('input', { bubbles: true }));
        }
      }, mac);
    }

    // 6. ENVIAR FORMULARIO
    console.log('[Puppeteer] Guardando asignación...');
    
    const submitBtn = await page.$('#submit-button');
    if (!submitBtn) throw new Error('Botón guardar no encontrado');

    await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
        submitBtn.click()
    ]);

    // 7. VALIDACIÓN FINAL DE ÉXITO
    // Si la URL sigue siendo la de agregar-articulos, algo falló (validación de Django)
    if (page.url().includes('agregar-articulos')) {
        const errorMsg = await page.evaluate(() => {
            // Buscar alertas de error comunes en Django/Bootstrap
            return document.querySelector('.alert-danger')?.textContent?.trim() || 
                   document.querySelector('.errorlist')?.textContent?.trim() ||
                   "Error de validación desconocido";
        });
        console.warn(`⚠️ Geonet rechazó la asignación: ${errorMsg}`);
        return false;
    }

    console.log(`✅ Artículo ${numSerie} asignado correctamente.`);
    console.log(`[Puppeteer] Tiempo total: ${Date.now() - start}ms`);
    return true;

  } catch (error: any) {
    console.error(`❌ Error critico en agregarArticuloACliente: ${error.message}`);
    return false;
  } finally {
    await page.close();
    await browser.disconnect();
  }
}
export async function getWifiProductUuidBySerial(serial: string): Promise<string | null> {
  const start = Date.now();
  const { browser, page } = await openPage();
    try {
        if (!await ensureSession(page)) return null;

        // Usamos el buscador de Geonet
    const t0 = Date.now();
    await safeGoto(page, `${GEONET_BASE_URL}/productos-wifi/?q=${serial}`, { timeout: 20000 });
    console.log(`[Puppeteer] getWifiProductUuidBySerial goto time: ${Date.now() - t0}ms`);
        
        const content = await page.content();
        
        // Regex original
        const esc = serial.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const trRe = new RegExp(`<tr[\\s\\S]*?${esc}[\\s\\S]*?<\/tr>`, 'i');
        const trMatch = content.match(trRe);
        const uuidRe = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

        if (trMatch) {
            const u = trMatch[0].match(uuidRe);
            if (u) return u[0];
            const inputMatch = trMatch[0].match(/<input[^>]+value=["']([0-9a-f-]{36})["'][^>]*>/i);
            if (inputMatch) return inputMatch[1];
        }
        console.log(`[Puppeteer] getWifiProductUuidBySerial tiempo total: ${Date.now() - start}ms`);
        return null;
    } catch {
        return null;
    } finally {
        await page.close();
        await browser.disconnect();
    }
}

export async function deleteWifiProductByUuid(uuid: string): Promise<boolean> {
  const { browser, page } = await openPage();
  try {
    if (!await ensureSession(page)) return false;

    // Hacer POST directo via fetch para borrar.
    const result = await page.evaluate(async (uid) => {
        const getCookie = (name: string) => {
            const v = document.cookie.match('(^|;) ?' + name + '=([^;]*)(;|$)');
            return v ? v[2] : null;
        };
        const csrf = getCookie('csrftoken');
        
        const params = new URLSearchParams();
        params.append('csrfmiddlewaretoken', csrf || '');
        params.append('accion_select', 'delete_selected');
        params.append('lista_productos_wifi', '1');
        params.append('uuid_producto_wifi', uid);
        params.append('form-acciones', '');

        const res = await fetch('/productos-wifi/acciones/', {
            method: 'POST',
            body: params,
            headers: {
                'X-CSRFToken': csrf || '',
                'Content-Type': 'application/x-www-form-urlencoded'
            }
        });
        return res.ok || res.status === 302;
    }, uuid);

    return result;

  } catch (e) {
    return false;
  } finally {
    await page.close();
    await browser.disconnect();
  }
}

export type SmartOltReplaceOptions = {
  authorizeParams?: Parameters<typeof authorizeOnu>[0];
  updateExisting?: {
    onuExternalId?: string | number; 
    newSn?: string;
    newOnuType?: string;
    locationParams?: Record<string, any>;
  };
};

// Coordina SmartOLT y Geonet (Puppeteer)
export async function replaceOnuForClient(
  clienteId: number | string,
  clienteUsuario: string,
  oldSerial: string,
  newModel: string,
  newSn: string,
  newMac: string = '',
  options?: SmartOltReplaceOptions
): Promise<boolean> {
  console.log(`[Puppeteer] replaceOnuForClient: ${clienteId}, old=${oldSerial}, new=${newSn}`);

  // 1. SmartOLT Logic (Intacto)
  try {
    if (options?.updateExisting) {
      let onuExternalId = options.updateExisting.onuExternalId;
      if (!onuExternalId && oldSerial) {
        try {
          const info = await getOnuBySerial(oldSerial);
          onuExternalId = info?.unique_external_id ?? info?.external_id ?? info?.onu_external_id ?? info?.id ?? info?.onu_id;
          if (!onuExternalId && Array.isArray(info) && info.length) {
            const first = info[0] as any;
            onuExternalId = first?.unique_external_id ?? first?.external_id ?? first?.onu_external_id ?? first?.id ?? first?.onu_id;
          }
        } catch (e) {}
      }

      if (onuExternalId) {
        if (options.updateExisting.newSn) await updateOnuSn(onuExternalId, options.updateExisting.newSn);
        if (options.updateExisting.newOnuType) await changeOnuType(onuExternalId, options.updateExisting.newOnuType);
        if (options.updateExisting.locationParams) await updateOnuLocation(String(onuExternalId), options.updateExisting.locationParams);
      }
    }

    if (options?.authorizeParams) {
        await authorizeOnu(options.authorizeParams as any);
    }
  } catch (e) {
      console.warn('SmartOLT warning:', e);
  }

  // 2. Geonet Logic (Puppeteer)
  const uuid = await getWifiProductUuidBySerial(oldSerial);
  if (uuid) {
    console.log(`[Puppeteer] Borrando ONU vieja UUID: ${uuid}`);
    await deleteWifiProductByUuid(uuid);
  }

  const registered = await registrarOnuGeonet(newModel, newSn, newMac);
  if (!registered) {
    console.error('[Puppeteer] Error registrando nueva ONU');
    return false;
  }

  return await agregarArticuloACliente(clienteId, clienteUsuario, newSn, newMac);
}

export async function uploadDocumentoCliente(
  clienteId: number | string,
  clienteUsuario: string,
  filePath: string,
  titulo?: string,
  descripcion: string = 'Carga automática via Bot',
  visible: boolean = true
): Promise<boolean> {
  const { browser, page } = await openPage();
  
  // 1. Resolver y leer el archivo localmente
  let systemPath = filePath;
  if (filePath.startsWith('/')) {
      if (!fs.existsSync(filePath)) {
          const relativePath = filePath.replace(/^\//, '');
          systemPath = path.join(process.cwd(), relativePath);
      }
  } else if (!path.isAbsolute(filePath)) {
      systemPath = path.join(process.cwd(), filePath);
  }

  if (!fs.existsSync(systemPath)) {
    console.error(`❌ Archivo no encontrado en disco: ${systemPath}`);
    await page.close();
    await browser.disconnect();
    return false;
  }

  // Convertimos el archivo a Base64 para inyectarlo en el navegador
  const fileBuffer = fs.readFileSync(systemPath);
  const fileBase64 = fileBuffer.toString('base64');
  const fileName = path.basename(systemPath);
  
  // Adivinar MimeType básico
  let mimeType = 'application/octet-stream';
  const lowerName = fileName.toLowerCase();
  if (lowerName.endsWith('.jpg') || lowerName.endsWith('.jpeg')) mimeType = 'image/jpeg';
  else if (lowerName.endsWith('.png')) mimeType = 'image/png';
  else if (lowerName.endsWith('.pdf')) mimeType = 'application/pdf';

  try {
    if (!await ensureSession(page)) return false;

    const url = `${GEONET_BASE_URL}/clientes/agregar-documento/${clienteUsuario}/`;
    console.log(`[Puppeteer] Accediendo a URL base: ${url}`);

    // Solo esperamos a que cargue el token de seguridad, no importa si la interfaz gráfica termina de renderizar
    await safeGoto(page, url, { waitForSelector: 'input[name="csrfmiddlewaretoken"]', timeout: 30000 });

    console.log('[Puppeteer] Inyectando archivo y forzando envío directo (Fetch)...');

    // 2. SUBIDA DIRECTA VIA FETCH (Ignora todo el código defectuoso de la página web)
    const result = await page.evaluate(async (args) => {
        try {
            // Extraer el token de seguridad obligatorio de Django
            const csrf = (document.querySelector('input[name="csrfmiddlewaretoken"]') as HTMLInputElement)?.value || '';

            // Reconstruir el archivo desde Base64 a un objeto File/Blob en el navegador
            const byteCharacters = atob(args.b64);
            const byteNumbers = new Array(byteCharacters.length);
            for (let i = 0; i < byteCharacters.length; i++) {
                byteNumbers[i] = byteCharacters.charCodeAt(i);
            }
            const byteArray = new Uint8Array(byteNumbers);
            const blob = new Blob([byteArray], { type: args.mime });

            // Construir el formulario invisible
            const formData = new FormData();
            formData.append('csrfmiddlewaretoken', csrf);
            formData.append('titulo', args.title);
            formData.append('descripcion', args.desc);
            formData.append('archivo', blob, args.name);
            
            if (args.isVisible) {
                formData.append('visible', 'on');
            }

            // Disparar la petición directo al backend de Geonet
            const res = await fetch(window.location.href, {
                method: 'POST',
                body: formData,
                redirect: 'follow'
            });

            return {
                ok: res.ok,
                status: res.status,
                url: res.url,
                error: null
            };
        } catch (e: any) {
            return { ok: false, status: 0, url: '', error: e.toString() };
        }
    }, {
        b64: fileBase64,
        name: fileName,
        mime: mimeType,
        title: titulo || fileName,
        desc: descripcion,
        isVisible: visible
    });

    // 3. VALIDAR RESULTADO
    if (result.error) {
        throw new Error(`Error inyectado en Frontend: ${result.error}`);
    }

    // Geonet redirige a la vista del cliente tras una subida exitosa.
    if (result.ok && !result.url.includes('agregar-documento')) {
        console.log(`✅ Documento subido super rápido vía Fetch. Redireccionado a: ${result.url}`);
        return true;
    } else {
        console.error(`⚠️ Fallo la subida en el servidor. Status: ${result.status}, URL: ${result.url}`);
        return false;
    }

  } catch (error: any) {
    console.error(`❌ Error crítico en uploadDocumentoCliente: ${error.message}`);
    return false;
  } finally {
    await page.close();
    await browser.disconnect();
  }
}
// --- BÚSQUEDA LOCAL DB (SIN CAMBIOS) ---

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