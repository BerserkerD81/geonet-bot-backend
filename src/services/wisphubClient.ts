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

const SCRAPING_TIMEOUTS = {
  apiHttp: 60000,
  pageNavigationDefault: 90000,
  gotoDefault: 60000,
  waitSelector: 20000,
  loginGoto: 30000,
  loginSelector: 20000,
  loginNavigation: 30000,
  mediumOperation: 60000,
  longOperation: 90000,
  activationWait: 15000,
  activationNavigation: 15000,
  activationConfirmTries: 5,
  activationConfirmDelay: 2200,
  activationApiPollTries: 8,
  activationApiPollDelay: 2500,
  activationApiPrecheckMaxWaitMs: Number(process.env.WISPHUB_ACTIVATION_PRECHECK_WAIT_MS || 8000),
  activationApiQuickConfirmMaxWaitMs: Number(process.env.WISPHUB_ACTIVATION_QUICK_CONFIRM_WAIT_MS || 12000),
  activationApiMaxWaitMs: Number(process.env.WISPHUB_ACTIVATION_MAX_WAIT_MS || 300000)
} as const;

const activationBackgroundJobs = new Map<string, Promise<void>>();

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
  timeout: SCRAPING_TIMEOUTS.apiHttp
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
    page.setDefaultNavigationTimeout(SCRAPING_TIMEOUTS.pageNavigationDefault);

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
  const timeout = opts?.timeout ?? SCRAPING_TIMEOUTS.gotoDefault;
  let response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout });

  // Si la navegación nos lleva al login, forzamos login y reintentamos
  if (page.url().includes('/accounts/login/')) {
    const ok = await ensureSession(page, { force: true });
    if (!ok) throw new Error('No se pudo autenticar en Geonet');
    response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
  }

  if (opts?.waitForSelector) {
    await page.waitForSelector(opts.waitForSelector, { timeout: SCRAPING_TIMEOUTS.waitSelector }).catch(() => null);
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
    await page.goto(`${GEONET_BASE_URL}/accounts/login/`, { waitUntil: 'domcontentloaded', timeout: SCRAPING_TIMEOUTS.loginGoto });

    // Esperar los inputs de login
    await page.waitForSelector('input[name="login"]', { timeout: SCRAPING_TIMEOUTS.loginSelector });

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
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: SCRAPING_TIMEOUTS.loginNavigation }).catch(() => null),
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

function normalizeStatusText(value: unknown): string {
  if (value === undefined || value === null) return '';
  return String(value)
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function isLikelyActiveStatus(value: unknown): boolean {
  const normalized = normalizeStatusText(value);
  if (!normalized) return false;
  if (/^\d+$/.test(normalized)) return normalized === '1';
  if (
    normalized.includes('inactiv') ||
    normalized.includes('desactiv') ||
    normalized.includes('suspend') ||
    normalized.includes('cancel') ||
    normalized.includes('baja')
  ) return false;
  return (
    normalized.includes('activ') ||
    normalized.includes('habil') ||
    normalized.includes('online') ||
    normalized.includes('al dia') ||
    normalized.includes('aldia')
  );
}

function isLikelyInactiveStatus(value: unknown): boolean {
  const normalized = normalizeStatusText(value);
  if (!normalized) return false;
  if (/^\d+$/.test(normalized)) return normalized === '2' || normalized === '3' || normalized === '0';
  return (
    normalized.includes('suspend') ||
    normalized.includes('cort') ||
    normalized.includes('bloq') ||
    normalized.includes('moros') ||
    normalized.includes('cancel') ||
    normalized.includes('baja') ||
    normalized.includes('inactiv')
  );
}

type ActivationUiState = {
  hasActivateButton: boolean;
  hasDeactivateButton: boolean;
  hasActivationForm: boolean;
  hasActivationPrompt: boolean;
  hasSuccessMessage: boolean;
  hasErrorMessage: boolean;
  successText: string;
  errorText: string;
  bodyLooksActive: boolean;
  pageUrl: string;
};

async function readActivationUiState(page: Page): Promise<ActivationUiState> {
  return page.evaluate(() => {
    const normalize = (value: any) => String(value || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    const getElementLabel = (el: Element) => {
      const inputEl = el as HTMLInputElement;
      const value = typeof inputEl.value === 'string' ? inputEl.value : '';
      return `${el.textContent || ''} ${value}`.trim();
    };

    const isVisible = (el: Element) => {
      const rect = (el as HTMLElement).getBoundingClientRect?.();
      const style = window.getComputedStyle(el as HTMLElement);
      const visibleByStyle = style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
      const visibleByRect = !!rect && rect.width > 0 && rect.height > 0;
      return visibleByStyle && visibleByRect;
    };

    const clickable = Array.from(document.querySelectorAll('button, a, input[type="button"], input[type="submit"]'));
    const activationForm = document.querySelector('form#activar_cliente_form, form[action*="/activar/"]');

    const hasActivateButton = clickable.some((el) => {
      if (!isVisible(el)) return false;
      const txt = normalize(getElementLabel(el));
      return txt.includes('activar instalacion') && !txt.includes('editar');
    });

    const hasDeactivateButton = clickable.some((el) => {
      if (!isVisible(el)) return false;
      const txt = normalize(getElementLabel(el));
      return txt.includes('desactivar instalacion') || txt.includes('instalacion activa');
    });

    const successText = Array.from(document.querySelectorAll('.alert-success, .messages .success, .message.success, .toast-success'))
      .map((el) => (el.textContent || '').trim())
      .filter(Boolean)
      .join(' | ');

    const errorText = Array.from(document.querySelectorAll('.alert-danger, .messages .error, .message.error, .errorlist, .alert-warning'))
      .map((el) => (el.textContent || '').trim())
      .filter(Boolean)
      .join(' | ');

    const bodyText = normalize(document.body?.innerText || '');
    const hasActivationPrompt =
      bodyText.includes('estas seguro que desea activar instalacion') ||
      bodyText.includes('estás seguro que desea activar instalación') ||
      bodyText.includes('activar instalacion') ||
      bodyText.includes('activar instalación');

    const bodyLooksActive =
      bodyText.includes('instalacion activa') ||
      bodyText.includes('servicio activado') ||
      bodyText.includes('instalacion activada') ||
      (bodyText.includes('desactivar instalacion') && !bodyText.includes('activar instalacion'));

    return {
      hasActivateButton,
      hasDeactivateButton,
      hasActivationForm: !!activationForm,
      hasActivationPrompt,
      hasSuccessMessage: !!normalize(successText),
      hasErrorMessage: !!normalize(errorText),
      successText: successText || '',
      errorText: errorText || '',
      bodyLooksActive,
      pageUrl: window.location.href
    };
  });
}

async function clickActivateButton(page: Page): Promise<boolean> {
  const directSubmitBtn = await page
    .$('form#activar_cliente_form button[type="submit"], form#activar_cliente_form input[type="submit"]');
  if (directSubmitBtn) {
    await directSubmitBtn.click();
    return true;
  }

  const selectorXpath = "xpath///button[contains(text(), 'Activar Instalación') and not(contains(text(), 'Editar'))]";
  const buttonByXpath = await page.waitForSelector(selectorXpath, {
    visible: true,
    timeout: 3500
  }).catch(() => null);

  if (buttonByXpath) {
    await buttonByXpath.click();
    return true;
  }

  const clickedByDom = await page.evaluate(() => {
    const normalize = (value: any) => String(value || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    const isVisible = (el: Element) => {
      const rect = (el as HTMLElement).getBoundingClientRect?.();
      const style = window.getComputedStyle(el as HTMLElement);
      const visibleByStyle = style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
      const visibleByRect = !!rect && rect.width > 0 && rect.height > 0;
      return visibleByStyle && visibleByRect;
    };

    const nodes = Array.from(document.querySelectorAll('button, a, input[type="button"], input[type="submit"]'));
    for (const node of nodes) {
      if (!isVisible(node)) continue;
      const inputNode = node as HTMLInputElement;
      const label = normalize(`${node.textContent || ''} ${inputNode.value || ''}`);
      if (label.includes('activar instalacion') && !label.includes('editar')) {
        (node as HTMLElement).click();
        return true;
      }
    }
    return false;
  });

  return clickedByDom;
}

async function submitActivationForm(page: Page): Promise<{ submitted: boolean; mode: string; detail?: string }> {
  return page.evaluate(() => {
    const normalize = (value: any) => String(value || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    const form = document.querySelector('form#activar_cliente_form, form[action*="/activar/"]') as HTMLFormElement | null;
    if (!form) {
      return { submitted: false, mode: 'none', detail: 'No se encontró formulario de activación' };
    }

    const editFacturacion = form.querySelector('input[name="edit_facturacion"]') as HTMLInputElement | null;
    if (editFacturacion) editFacturacion.value = '0';

    const submitNodes = Array.from(form.querySelectorAll('button[type="submit"], input[type="submit"]')) as Array<HTMLButtonElement | HTMLInputElement>;
    const preferredSubmit = submitNodes.find((node) => {
      const label = normalize(`${(node as HTMLElement).textContent || ''} ${(node as HTMLInputElement).value || ''}`);
      return label.includes('activar instalacion') && !label.includes('editar');
    }) || submitNodes[0] || null;

    if (preferredSubmit) {
      preferredSubmit.click();
      return { submitted: true, mode: 'button-click' };
    }

    if (typeof form.requestSubmit === 'function') {
      form.requestSubmit();
      return { submitted: true, mode: 'requestSubmit' };
    }

    form.submit();
    return { submitted: true, mode: 'form-submit' };
  });
}

async function buildCookieHeaderFromPage(page: Page, targetUrl: string): Promise<string> {
  try {
    const target = new URL(targetUrl);
    const cookies = await page.cookies(target.origin, targetUrl);
    const pairs = cookies
      .filter((c) => c?.name && typeof c.value === 'string')
      .map((c) => `${c.name}=${c.value}`);
    return pairs.join('; ');
  } catch {
    const cookies = await page.cookies();
    const pairs = cookies
      .filter((c) => c?.name && typeof c.value === 'string')
      .map((c) => `${c.name}=${c.value}`);
    return pairs.join('; ');
  }
}

async function postActivationViaAxios(
  page: Page,
  targetUrl: string,
  logPrefix: string
): Promise<{ ok: boolean; status?: number; detail?: string }> {
  try {
    const csrfFromInput = await page.$eval(
      'input[name="csrfmiddlewaretoken"]',
      (el) => (el as HTMLInputElement).value
    ).catch(() => '');

    const pageCookies = await page.cookies();
    const csrfFromCookie = pageCookies.find((c) => c.name === 'csrftoken')?.value || '';
    const csrfToken = String(csrfFromInput || csrfFromCookie || '').trim();

    if (!csrfToken) {
      return { ok: false, detail: 'No se encontró csrfmiddlewaretoken en la página/sesión.' };
    }

    const cookieHeader = await buildCookieHeaderFromPage(page, targetUrl);
    if (!cookieHeader) {
      return { ok: false, detail: 'No se pudo construir header Cookie desde la sesión Puppeteer.' };
    }

    const body = new URLSearchParams();
    body.set('csrfmiddlewaretoken', csrfToken);
    body.set('edit_facturacion', '0');

    console.log(`${logPrefix} enviando POST axios a ${targetUrl}`);
    const response = await axios.post(targetUrl, body.toString(), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Origin': GEONET_BASE_URL,
        'Referer': targetUrl,
        'Cookie': cookieHeader,
        'X-CSRFToken': csrfToken,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      },
      maxRedirects: 10,
      timeout: SCRAPING_TIMEOUTS.mediumOperation,
      validateStatus: (status) => status >= 200 && status < 400
    });

    console.log(`${logPrefix} POST axios status=${response.status}`);
    return { ok: true, status: response.status, detail: `status=${response.status}` };
  } catch (error: any) {
    return {
      ok: false,
      status: error?.response?.status,
      detail: error?.response?.data?.error || error?.message || 'Error POST axios activación'
    };
  }
}

async function waitForActivationUiConfirmation(page: Page, targetUrl: string): Promise<{ confirmed: boolean; reason: string }> {
  let lastState: ActivationUiState | null = null;

  for (let attempt = 1; attempt <= SCRAPING_TIMEOUTS.activationConfirmTries; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, SCRAPING_TIMEOUTS.activationConfirmDelay));

    const state = await readActivationUiState(page);
    lastState = state;

    const normalizedUrl = normalizeStatusText(state.pageUrl);
    const movedAwayFromActivation =
      normalizedUrl.length > 0 &&
      !normalizedUrl.includes('/activar/') &&
      !normalizedUrl.includes('/accounts/login/');

    const successOrAlreadyActive =
      movedAwayFromActivation ||
      state.hasDeactivateButton ||
      state.bodyLooksActive ||
      (state.hasSuccessMessage && !state.hasActivateButton && !state.hasActivationForm);

    if (successOrAlreadyActive) {
      return {
        confirmed: true,
        reason: state.successText || (movedAwayFromActivation ? `UI redirigió a ${state.pageUrl}` : 'UI indica instalación activa')
      };
    }

    const normalizedError = normalizeStatusText(state.errorText);
    if (normalizedError.includes('ya se encuentra activa') || normalizedError.includes('ya esta activa')) {
      return {
        confirmed: true,
        reason: state.errorText || 'UI indica que ya estaba activa'
      };
    }

    if (attempt < SCRAPING_TIMEOUTS.activationConfirmTries) {
      await safeGoto(page, targetUrl, { timeout: SCRAPING_TIMEOUTS.mediumOperation }).catch(() => null);
    }
  }

  const uiReason = lastState
    ? `UI sin confirmación (activateButton=${lastState.hasActivateButton}, deactivateButton=${lastState.hasDeactivateButton}, activationForm=${lastState.hasActivationForm}, success='${lastState.successText}', error='${lastState.errorText}', url='${lastState.pageUrl}')`
    : 'No se pudo leer estado UI tras click';

  return { confirmed: false, reason: uiReason };
}

async function waitForActivationApiConfirmation(
  instalacionId: number | string,
  usuarioInstalacion?: string,
  opts?: { maxWaitMs?: number; logPrefix?: string }
): Promise<{ confirmed: boolean; reason: string }> {
  return waitForActivationApiConfirmationByClientes(instalacionId, usuarioInstalacion, opts);
}

function buildUsuarioCandidates(usuarioInstalacion?: string): string[] {
  const base = String(usuarioInstalacion || '').trim();
  if (!base) return [];
  const left = base.includes('@') ? base.split('@')[0].trim() : base;
  return Array.from(new Set([base, left].filter(Boolean)));
}

function pickClientEstadoForActivation(payload: Record<string, any> | null | undefined): string {
  if (!payload || typeof payload !== 'object') return '';
  const candidates = [
    payload.estado,
    payload.estado_instalacion,
    payload.status,
    payload?.raw?.estado,
    payload?.raw?.estado_instalacion
  ];
  const observed = candidates.find((value) => {
    const normalized = normalizeStatusText(value);
    return !!normalized;
  });
  return observed === undefined || observed === null ? '' : String(observed);
}

async function findClientForActivationByClientes(
  instalacionId: number | string,
  usuarioInstalacion?: string
): Promise<{ payload: Record<string, any> | null; source: string; debug: string }> {
  const serviceId = String(instalacionId || '').trim();
  const userCandidates = buildUsuarioCandidates(usuarioInstalacion);

  const queries: Array<{ params: Record<string, any>; source: string }> = [];
  if (serviceId) {
    queries.push({ params: { id_servicio: serviceId, limit: 5, offset: 0 }, source: 'id_servicio' });
  }

  for (const user of userCandidates) {
    queries.push({ params: { usuario: user, limit: 5, offset: 0 }, source: 'usuario' });
  }
  for (const user of userCandidates) {
    queries.push({ params: { usuario__contains: user, limit: 5, offset: 0 }, source: 'usuario__contains' });
  }

  let lastDebug = '';
  for (const item of queries) {
    try {
      const data = await listClientsPage(item.params);
      const results = Array.isArray(data?.results) ? data.results : [];
      if (results.length > 0) {
        return {
          payload: (results[0] || null) as Record<string, any> | null,
          source: item.source,
          debug: `match ${item.source} (${results.length} resultados)`
        };
      }
      lastDebug = `sin resultados por ${item.source}`;
    } catch (err: any) {
      lastDebug = `error ${item.source}: ${err?.message || err}`;
    }
  }

  return { payload: null, source: 'none', debug: lastDebug || 'sin resultados en /api/clientes/' };
}

async function waitForActivationApiConfirmationByClientes(
  instalacionId: number | string,
  usuarioInstalacion?: string,
  opts?: { maxWaitMs?: number; logPrefix?: string }
): Promise<{ confirmed: boolean; reason: string }> {
  let lastObserved = '';
  const maxWaitMs = Math.max(10000, Number(opts?.maxWaitMs ?? SCRAPING_TIMEOUTS.activationApiMaxWaitMs));
  const startedAt = Date.now();
  let attempt = 0;
  const logPrefix = opts?.logPrefix || `[Activation:${instalacionId}]`;


  // Para reintentos de POST axios
  let lastAxiosAttempt = 0;
  while ((Date.now() - startedAt) < maxWaitMs) {
    attempt += 1;
    try {
      console.log(`${logPrefix} [API] intento ${attempt}: consultando /api/clientes ...`);
      const found = await findClientForActivationByClientes(instalacionId, usuarioInstalacion);
      if (found.payload) {
        const observed = pickClientEstadoForActivation(found.payload);
        const normalized = normalizeStatusText(observed);
        if (normalized) {
          lastObserved = `API clientes estado=${observed} (source=${found.source})`;
          console.log(`${logPrefix} [API] intento ${attempt}: estado observado=${observed} source=${found.source}`);
          if (isLikelyActiveStatus(observed)) {
            console.log(`${logPrefix} [API] confirmado ACTIVO en intento ${attempt}`);
            return { confirmed: true, reason: `API clientes activo (${observed}, source=${found.source})` };
          }
          if (isLikelyInactiveStatus(observed) || !isLikelyActiveStatus(observed)) {
            lastObserved = `API clientes no-activo (${observed}, source=${found.source})`;
          }
        } else {
          lastObserved = `cliente encontrado sin estado util (source=${found.source})`;
          console.log(`${logPrefix} [API] intento ${attempt}: cliente encontrado pero estado vacío`);
        }
      } else {
        lastObserved = `sin cliente en /api/clientes/ (${found.debug})`;
        console.log(`${logPrefix} [API] intento ${attempt}: ${found.debug}`);
      }
    } catch (err: any) {
      lastObserved = `API clientes error: ${err?.message || err}`;
      console.warn(`${logPrefix} [API] intento ${attempt}: error ${err?.message || err}`);
    }

    // Cada 2 intentos, reintentar el POST axios de activación
    if (attempt % 2 === 0) {
      try {
        console.log(`${logPrefix} [AXIOS-RETRY] Reintentando POST axios de activación en intento ${attempt}`);
        // Usar helpers existentes para obtener la URL y lanzar el POST
        const targetUrl = `${GEONET_BASE_URL}/Instalaciones/${usuarioInstalacion}/${instalacionId}/activar/`;
        // Abrir una nueva página para el POST axios
        const { browser, page } = await openPage();
        try {
          if (await ensureSession(page)) {
            await postActivationViaAxios(page, targetUrl, `${logPrefix} [AXIOS-RETRY]`);
          } else {
            console.warn(`${logPrefix} [AXIOS-RETRY] No se pudo obtener sesión para POST axios`);
          }
        } catch (errAxios: any) {
          console.warn(`${logPrefix} [AXIOS-RETRY] Error en POST axios: ${errAxios?.message || errAxios}`);
        } finally {
          await page.close();
          await browser.disconnect();
        }
      } catch (errOuter: any) {
        console.warn(`${logPrefix} [AXIOS-RETRY] Error general en reintento POST axios: ${errOuter?.message || errOuter}`);
      }
    }

    const elapsed = Date.now() - startedAt;
    const remaining = maxWaitMs - elapsed;
    if (remaining <= 0) break;

    const sleepMs = Math.min(SCRAPING_TIMEOUTS.activationApiPollDelay, remaining);
    await new Promise((resolve) => setTimeout(resolve, sleepMs));
  }

  return {
    confirmed: false,
    reason: `${lastObserved || 'Sin confirmación de estado activo vía /api/clientes/'} (timeout ${Math.round(maxWaitMs / 1000)}s)`
  };
}


// =============================================================================
// AGREGAR AL FINAL DE wisphubClient.ts
// Estas funciones usan los helpers privados ya existentes:
// openPage, ensureSession, safeGoto, GEONET_BASE_URL
// =============================================================================

// ─────────────────────────────────────────────────────────────────────────────
// DICCIONARIOS DE MAPEO (copiados del installationService para ser autónomos)
// ─────────────────────────────────────────────────────────────────────────────

const AP_MAPPING: Record<string, string> = {
  "CTO 1 Z201 - Villa Maule": "CTO 1 Z201 - Villa Maule",
  "CTO 2 Z201 - Villa Maule": "CTO 2 Z201 - Villa Maule",
  "CTO1 - Torre 1- Z13": "CTO1 Z13 - Torre 1 - Brisas Las Rastras",
  "CTO1 - Z10 - Batallas de Lircay": "CTO1 Z10 - Batallas de Lircay",
  "CTO1 - Z11 - Batallas de Lircay": "CTO1 Z11 - Batallas de Lircay",
  "CTO1 - Z12 - Batallas de Lircay": "CTO1 Z12 - Batallas de Lircay",
  "CTO1 - Z203 -16": "CTO1 - Z203 (16)",
  "CTO1 - Z306 - Reserva San Miguel": "CTO 1 - Zona 306 - Reserva San Miguel",
  "CTO1 - Z401 - Parque del Sol": "CTO1 - Z401 - Parque del Sol",
  "CTO1 - Z402 - Parque del Sol": "CTO1 - Z402 - Parque del Sol",
  "CTO1 - Z403 - Parque del Sol": "CTO1 - Z403 - Parque del Sol",
  "CTO1 - Z404 - Parque del Sol": "CTO1 - Z404 - Parque del Sol",
  "CTO1 - Z406 - Valles de Linares": "CTO1 - Z406 - Valles de Linares",
  "CTO1 - Z407 - Dona Agustina IV": "CTO1 - Z407 - Doña Agustina IV",
  "CTO1 - Z9 - Batallas de Lircay": "CTO1 Z9 - Batallas de Lircay",
  "CTO1 - Zona 302 - Empresas 11 Oriente": "CTO1 - Zona 302 - Empresas 11 Oriente",
  "CTO1 Torre A - Z15 - Puertas de Lircay II": "CTO1 Torre A - Z15 - Puertas de Lircay II",
  "CTO1 Z202 - Villa Maule": "CTO1 Z202 - Villa Maule",
  "CTO1 Z204 - Dona Ignacia IX": "CTO1 - Z204 - Doña ignacia IX",
  "CTO1 Z205 - Dona Antonia V": "CTO1 Z205 - Doña Antonia V",
  "CTO1 Z3_16P": "CTO1 Z3",
  "CTO1 Z4_8P": "CTO1 Z4",
  "CTO1 Z7 Torre A_16P": "CTO1 Z7 Torre A (1-16)",
  "CTO1 Z8 Torre E_16P": "CTO1 Z8 Torre E (1-16)",
  "CTO1- Z14": "CTO1 - Z14",
  "CTO1-Z5_8P": "CTO1 Z5 1-8",
  "CTO1-Z6_8P": "CTO1 Z6 1-8",
  "CTO2  Z3_16P": "CTO2 Z3",
  "CTO2 - Torre 1- Z13": "CTO2 Z13 - Torre 1 - Brisas Las Rastras",
  "CTO2 - Z10 - Batallas de Lircay": "CTO2 Z10 - Batallas de Lircay",
  "CTO2 - Z11 - Batallas de Lircay": "CTO2 Z11 - Batallas de Lircay",
  "CTO2 - Z12 - Batallas de Lircay": "CTO2 Z12 - Batallas de Lircay",
  "CTO2 - Z203 -16": "CTO2 - Z203 (16)",
  "CTO2 - Z306 - Reserva San Miguel": "CTO 2 - Zona 306 - Reserva San Miguel",
  "CTO2 - Z401 - Parque del Sol": "CTO2 - Z401 - Parque del Sol",
  "CTO2 - Z402 - Parque del Sol": "CTO2 - Z402 - Parque del Sol",
  "CTO2 - Z403 - Parque del Sol": "CTO2 - Z403 - Parque del Sol",
  "CTO2 - Z404 - Parque del Sol": "CTO2 - Z404 - Parque del Sol",
  "CTO2 - Z406 - Valles de Linares": "CTO2 - Z406 - Valles de Linares",
  "CTO2 - Z407 - Dona Agustina IV": "CTO2 - Z407 - Doña Agustina IV",
  "CTO2 - Z9 - Batallas de Lircay": "CTO2 Z9 - Batallas de Lircay",
  "CTO2 - Zona 302 - Empresas 11 Oriente": "CTO2 - Zona 302 - Empresas 11 Oriente",
  "CTO2 Torre B - Z15 - Puertas de Lircay II": "CTO2 Torre B - Z15 - Puertas de Lircay II",
  "CTO2 Z202 - Villa Maule": "CTO2 Z202 - Villa Maule",
  "CTO2 Z204 - Dona Ignacia IX": "CTO2 - Z204 - Doña Ignacia IX",
  "CTO2 Z205 - Dona Antonia V": "CTO2 Z205 - Doña Antonia V",
  "CTO2 Z4_16P": "CTO2 Z4",
  "CTO2 Z7 Torre B_16P": "CTO2 Z7 Torre B (1-16)",
  "CTO2 Z8 Torre F_16P": "CTO2 Z8 Torre F (1-16)",
  "CTO2- Z14": "CTO2 - Z14",
  "CTO2-Z5_1-16": "CTO2 Z5 1-16",
  "CTO2-Z6_1-16": "CTO2 Z6 1-16",
  "CTO3  Z303 - Centro Comercial": "CTO3  Z303 - Centro Comercial",
  "CTO3 - Z10 - Batallas de Lircay": "CTO3 Z10 - Batallas de Lircay",
  "CTO3 - Z11 - Batallas de Lircay": "CTO3 Z11 - Batallas de Lircay",
  "CTO3 - Z12 - Batallas de Lircay": "CTO3 Z12 - Batallas de Lircay",
  "CTO3 - Z203 -16": "CTO3 - Z203 (16)",
  "CTO3 - Z306 - Reserva San Miguel": "CTO 3 - Zona 306 - Reserva San Miguel",
  "CTO3 - Z401 - Parque del Sol": "CTO3 - Z401 - Parque del Sol",
  "CTO3 - Z402 - Parque del Sol": "CTO3 - Z402 - Parque del Sol",
  "CTO3 - Z403 - Parque del Sol": "CTO3 - Z403 - Parque del Sol",
  "CTO3 - Z404 - Parque del Sol": "CTO3 - Z404 - Parque del Sol",
  "CTO3 - Z406 - Valles de Linares": "CTO3 - Z406 - Valles de Linares",
  "CTO3 - Z407 - Dona Agustina IV": "CTO3 - Z407 - Doña Agustina IV",
  "CTO3 - Z9 - Batallas de Lircay": "CTO3 Z9 - Batallas de Lircay",
  "CTO3 - Zona 302 - Empresas 11 Oriente": "CTO3 - Zona 302 - Empresas 11 Oriente",
  "CTO3 Torre C - Z15 - Puertas de Lircay II": "CTO3 Torre C - Z15 - Puertas de Lircay II",
  "CTO3 Z201 - Villa Maule": "CTO3 Z201 - Villa Maule",
  "CTO3 Z202 - Villa Maule": "CTO3 Z202 - Villa Maule",
  "CTO3 Z204 - Dona Ignacia IX": "CTO3 - Z204 - Doña Ignacia IX",
  "CTO3 Z205 - Dona Antonia V": "CTO3 Z205 - Doña Antonia V",
  "CTO3 Z3_16P": "CTO3 Z3",
  "CTO3 Z4": "CTO3 Z4",
  "CTO3 Z7 Torre C": "CTO3 Z7 Torre C (1-16)",
  "CTO3 Z8 Torre G": "CTO3 Z8 Torre G (1-16)",
  "CTO3- Torre 2- Z13": "CTO3 Z13 - Torre 2 - Brisas Las Rastras",
  "CTO3- Z14": "CTO3 - Z14",
  "CTO3-Z5_1-16": "CTO3 Z5 1-16",
  "CTO4  Z3": "CTO4 Z3",
  "CTO4 - Torre 2- Z13": "CTO4 Z13 - Torre 2 - Brisas Las Rastras",
  "CTO4 - Z10 - Batallas de Lircay": "CTO4 Z10 - Batallas de Lircay",
  "CTO4 - Z11 - Batallas de Lircay": "CTO4 Z11 - Batallas de Lircay",
  "CTO4 - Z12 - Batallas de Lircay": "CTO4 Z12 - Batallas de Lircay",
  "CTO4 - Z203 -16": "CTO4 - Z203 (16)",
  "CTO4 - Z306 - Reserva San Miguel": "CTO 4 - Zona 306 - Reserva San Miguel",
  "CTO4 - Z401 - Parque del Sol": "CTO4 - Z401 - Parque del Sol",
  "CTO4 - Z402 - Parque del Sol": "CTO4 - Z402 - Parque del Sol",
  "CTO4 - Z403 - Parque del Sol": "CTO4 - Z403 - Parque del Sol",
  "CTO4 - Z404 - Parque del Sol": "CTO4 - Z404 - Parque del Sol",
  "CTO4 - Z406 - Valles de Linares": "CTO4 - Z406 - Valles de Linares",
  "CTO4 - Z407 - Dona Agustina IV": "CTO4 - Z407 - Doña Agustina IV",
  "CTO4 - Z9 - Batallas de Lircay": "CTO4 Z9 - Batallas de Lircay",
  "CTO4 - Zona 302 - Empresas 11 Oriente": "CTO4 - Zona 302 - Empresas 11 Oriente",
  "CTO4 Torre D - Z15 - Puertas de Lircay II": "CTO4 Torre D - Z15 - Puertas de Lircay II",
  "CTO4 Z201 - Villa Maule": "CTO4 Z201 - Villa Maule",
  "CTO4 Z202 - Villa Maule": "CTO4 Z202 - Villa Maule",
  "CTO4 Z204 - Dona Ignacia IX": "CTO4 - Z204 - Doña Ignacia IX",
  "CTO4 Z205 - Dona Antonia V": "CTO4 Z205 - Doña Antonia V",
  "CTO4 Z4": "CTO4 Z4",
  "CTO4 Z7 Torre D": "CTO4 Z7 Torre D (1-16)",
  "CTO4 Z8 Torre H": "CTO4 Z8 Torre H (1-16)",
  "CTO4- Z14": "CTO4 - Z14",
  "CTO4-Z5_1-16": "CTO4 Z5 1-16",
  "CTO5 - Torre 3- Z13": "CTO5 Z13 - Torre 3 - Brisas Las Rastras",
  "CTO5 - Z11 - Batallas de Lircay": "CTO5 Z11 - Batallas de Lircay",
  "CTO5 - Z12 - Batallas de Lircay": "CTO5 Z12 - Batallas de Lircay",
  "CTO5 - Z203 -16": "CTO5 - Z203 (16)",
  "CTO5 - Z401 - Parque del Sol": "CTO5 - Z401 - Parque del Sol",
  "CTO5 - Z402 - Parque del Sol": "CTO5 - Z402 - Parque del Sol",
  "CTO5 - Z403 - Parque del Sol": "CTO5 - Z403 - Parque del Sol",
  "CTO5 - Z404 - Parque del Sol": "CTO5 - Z404 - Parque del Sol",
  "CTO5 - Z406 - Valles de Linares": "CTO5 - Z406 - Valles de Linares",
  "CTO5 - Z407 - Dona Agustina IV": "CTO5 - Z407 - Doña Agustina IV",
  "CTO5 - Zona 302 - Empresas 11 Oriente": "CTO5 - Zona 302 - Empresas 11 Oriente",
  "CTO5 Torre E - Z16 - Puertas de Lircay II": "CTO1 Torre E - Z16 - Puertas de Lircay II",
  "CTO5 Z14 - Valles de Talca II": "CTO5 Z14 - Valles de Talca",
  "CTO5 Z201 - Villa Maule": "CTO5 Z201 - Villa Maule",
  "CTO5 Z202 - Villa Maule": "CTO5 Z202 - Villa Maule",
  "CTO5 Z204 - Dona Ignacia IX": "CTO5 - Z204 - Doña Ignacia IX",
  "CTO5 Z4": "CTO5 Z4",
  "CTO5- Z306 - Reserva San Miguel": "CTO 5 - Zona 306 - Reserva San Miguel",
  "CTO6 - Torre 3- Z13": "CTO6 Z13 - Torre 3 - Brisas Las Rastras",
  "CTO6 - Z203 -16": "CTO6 - Z203 (16)",
  "CTO6 - Z306 - Reserva San Miguel": "CTO 6 - Zona 306 - Reserva San Miguel",
  "CTO6 - Z401 - Parque del Sol": "CTO6 - Z401 - Parque del Sol",
  "CTO6 - Z402 - Parque del Sol": "CTO6 - Z402 - Parque del Sol",
  "CTO6 - Z403 - Parque del Sol": "CTO6 - Z403 - Parque del Sol",
  "CTO6 - Z404 - Parque del Sol": "CTO6 - Z404 - Parque del Sol",
  "CTO6 - Z406 - Valles de Linares": "CTO6 - Z406 - Valles de Linares",
  "CTO6 - Z407 - Dona Agustina IV": "CTO6 - Z407 - Doña Agustina IV",
  "CTO6 - Zona 302 - Empresas 11 Oriente": "CTO6 - Zona 302 - Empresas 11 Oriente",
  "CTO6 Torre F - Z16 - Puertas de Lircay II": "CTO2 Torre F - Z16 - Puertas de Lircay II",
  "CTO6 Z14 - Valles de Talca II": "CTO6 Z14 - Valles de Talca.",
  "CTO6 Z201 - Villa Maule": "CTO6 Z201 - Villa Maule",
  "CTO6 Z202 - Villa Maule": "CTO6 Z202 - Villa Maule",
  "CTO6 Z204 - Dona Ignacia IX": "CTO6 - Z204 - Dona Ignacia IX",
  "CTO6 Z4 _8P": "CTO6 Z4",
  "Spliter 1 Torre A - Mirador Urbano": "Edificio Mirador Urbano Torre A",
  "Spliter 1 Torre B - Mirador Urbano": "Edificio Mirador Urbano Torre B",
  "Spliter 1 Torre C - Mirador Urbano": "Edificio Mirador Urbano Torre C",
  "Spliter 1 Torre D - Mirador Urbano": "Edificio Mirador Urbano Torre D",
  "Spliter 2 Torre A - Mirador Urbano": "Edificio Mirador Urbano Torre A",
  "Spliter 2 Torre B - Mirador Urbano": "Edificio Mirador Urbano Torre B",
  "Spliter 2 Torre C - Mirador Urbano": "Edificio Mirador Urbano Torre C",
  "Spliter 2 Torre D - Mirador Urbano": "Edificio Mirador Urbano Torre D",
};

const ZONE_MAPPING: Record<string, string> = {
  "Villa Maule - Z201": "Villa Maule - Zona 201 - Vlan 201",
  "Brisas las Rastras - Z13": "Brisas Las Rastras - Zona 13 - Vlan 112",
  "Batallas de Lircay - Z10": "Batallas de Lircay - Zona 10 - Vlan 109",
  "Batallas de Lircay - Z11": "Batallas de Lircay - Zona 11 - Vlan 110",
  "Batallas de Lircay - Z12": "Batallas de Lircay - Zona 12 - Vlan 111",
  "Portal Maule - Z203": "Portal II Maule - Zona 203 - Vlan 203",
  "Reserva San Miguel - Zona 306 - Vlan 306": "Reserva San Miguel - Zona 306 - Vlan 306",
  "Parque de Sol - Z401": "Parque del Sol - Zona 401 - Vlan 401",
  "Parque de Sol - Z402": "Parque del Sol - Zona 402 - Vlan 402",
  "Parque de Sol - Z403": "Parque del Sol - Zona 403 - Vlan 403",
  "Parque de Sol 4 - Z404": "Parque del Sol 4 - Zona 404 - Vlan 404",
  "Valles de Linares - Z406": "Valles de Linares - Zona 406 - Vlan 406",
  "Dona Agustina IV - Z407": "Doña Agustina IV - Zona 407 - Vlan 407",
  "Batallas de Lircay - Z9": "Batallas de Lircay - Zona 9 - Vlan 108",
  "Empresas 11 Oriente - Z302": "Empresas 11 Oriente - Zona 302 - Vlan 302",
  "Puertas de Lircay II - Torre A-D - Zona 15 - Vlan 114": "Puertas de Lircay II - Zona 15 - Vlan 114",
  "Villa Maule - Z202": "Villa Maule - Zona 202 - Vlan 202",
  "Dona Ignacia IX - Zona 204 - Vlan 204": "Doña Ignacia IX - Zona 204 - Vlan 204",
  "Dona Antonia V - Zona 205 - Vlan 205": "Doña Antonia V - Zona 205 - Vlan 205",
  "Valles de Talca - Z14": "Valles de Talca II - Zona 14 - Vlan 113",
  "Parque_San_Valentin-Z5": "Parque San Valentin - Zona 5 - Vlan 104",
  "Parque_San_Valentin-Z6": "Parque San Valentin - Zona 6 - Vlan 105",
  "Edificio Hacienda Esmeralda lll - Z303": "Edificio Hacienda Esmeralda III - Zona 303 - Vlan 303",
  "Puertas de Lircay II - Torre E-H - Zona 16 - Vlan 115": "Puertas de Lircay II - Zona 16 - Vlan 115",
  "Alto Las Rastras - Z301": "Centro Comercial Alto Las Rastras - Zona 301 - Vlan 301.-",
  "Centro Comercial Casa Boulevard  - Z304 - Vlan 304": "Centro Comercial Casa Boulevard - Zona 304 - Vlan 304",
  "Centro Comercial Paseo Hacienda - Z305 - Vlan 305": "Centro Comercial Pase Hacienda - Zona 305 - Vlan 305",
  "Mirador Urbano A-B": "Condominio Mirador Urbano Torre A y B - Vlan100",
  "Mirador Urbano C-D": "Condominio Mirador Urbano Torre A y B - Vlan100",
  "Parque de Sol 5- Z405": "Parque del Sol 5 - Zona 405 - Vlan 405",
};

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS INTERNOS DE TEXTO (misma lógica que ya usa el archivo)
// ─────────────────────────────────────────────────────────────────────────────

type SelectOption = { value: string; text: string; title?: string; dataEmail?: string };

function _normalizeText(value: string): string {
  return value.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim();
}

function _extractNumericTokens(value: string): string[] {
  return value ? (value.match(/\d+/g) || []) : [];
}

function _extractTowerLetter(s: string): string {
  return s.match(/torre\s*[:#\-]?\s*([A-Za-z0-9])/i)?.[1]?.toLowerCase() || '';
}

function _calcScore(target: string, candidate: string): number {
  if (!target || !candidate) return 0;
  if (candidate.includes(target)) return 1;
  const tTokens = new Set(target.split(' ').filter(Boolean));
  const cTokens = new Set(candidate.split(' ').filter(Boolean));
  if (!tTokens.size || !cTokens.size) return 0;
  let overlap = 0;
  for (const t of tTokens) if (cTokens.has(t)) overlap++;
  return overlap / new Set([...tTokens, ...cTokens]).size;
}

/**
 * Busca el value del <select> cuyo texto más se parece a optionName.
 * Si hay select2/buscador, simula escribir y selecciona la opción sugerida más cercana.
 */
function _findSelectValue(options: SelectOption[], optionName: string): string {
  // Matching flexible: ignora tildes, mayúsculas, paréntesis, guiones y espacios extra
  function clean(s: string) {
    return s
      .toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[\(\)\-]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
  const target = clean(optionName);
  let bestValue = '';
  let bestScore = 0;
  for (const opt of options) {
    const normText = clean(opt.text);
    // Score: coincidencia exacta, incluye, o mayor cantidad de palabras compartidas
    let score = 0;
    if (normText === target) score = 100;
    else if (normText.includes(target)) score = 80;
    else {
      // Palabras compartidas
      const tSet = new Set(target.split(' '));
      const nSet = new Set(normText.split(' '));
      const shared = [...tSet].filter(x => nSet.has(x)).length;
      score = shared * 10 - Math.abs(normText.length - target.length);
    }
    if (score > bestScore) {
      bestScore = score;
      bestValue = opt.value;
    }
  }
  return bestValue;
}

async function _extractSelectOptions(page: any, selector: string): Promise<SelectOption[]> {
  return page.evaluate((sel: string) => {
    const select = document.querySelector(sel) as HTMLSelectElement;
    if (!select) return [];
    return Array.from(select.options).map(opt => ({
      value: opt.value,
      text: opt.textContent?.trim() || '',
      title: opt.getAttribute('title') || '',
      dataEmail: opt.getAttribute('data-email') || ''
    }));
  }, selector);
}

// ─────────────────────────────────────────────────────────────────────────────
// FUNCIÓN PRINCIPAL: editarInstalacionGeonet
// Equivalente al del installationService pero usando los helpers de este archivo
// ─────────────────────────────────────────────────────────────────────────────

export type EditarInstalacionParams = {
  /** username/externalId del cliente en Geonet (ej: "juan.perez_18572016") */
  externalIdOrUser: string;
  /** ID numérico de la instalación en Geonet */
  installationId: string | number;
  updates: {
    /** Nombre del AP/CTO como aparece en SmartOLT o en el diccionario AP_MAPPING */
    apName?: string;
    /** Clave del ZONE_MAPPING (ej: "Parque de Sol - Z402") o nombre libre */
    zonaName?: string;
    /** Nombre del router (opcional) */
    routerName?: string;
    /** Nombre del técnico (opcional) */
    technicianName?: string;
    /** Nota que se agrega a los comentarios existentes */
    comments?: string;
    /** Cualquier otro campo del formulario (clave = nombre del input en Geonet) */
    [key: string]: any;
  };
};

export type EditarInstalacionResult = {
  status: number;
  /** URL final tras el POST (para validar si Geonet redirigió = éxito) */
  location: string;
  /** Errores de validación devueltos por Geonet */
  formErrors: string[];
  /** Campos efectivamente enviados al formulario */
  appliedUpdates: Record<string, string>;
  /** IP que quedó en el formulario tras la edición */
  newIp: string | null;
};

export async function editarInstalacionGeonet(
  params: EditarInstalacionParams
): Promise<EditarInstalacionResult> {
  const { externalIdOrUser, installationId: _installationId, updates } = params;
  console.log('[editarInstalacionGeonet][DEBUG] Params recibidos:', {
    externalIdOrUser,
    installationId: _installationId,
    updates
  });

  if (!externalIdOrUser) {
    throw Object.assign(
      new Error('externalIdOrUser es requerido'),
      { statusCode: 400 }
    );
  }

  // Extraer el primer número de externalIdOrUser como installationId
  const numericMatch = String(externalIdOrUser).match(/\d+/);
  const installationId = numericMatch ? numericMatch[0] : String(_installationId || '');
  if (!installationId) {
    throw Object.assign(
      new Error('No se pudo determinar installationId desde externalIdOrUser'),
      { statusCode: 400 }
    );
  }

  const { browser, page } = await openPage();

  try {
    if (!await ensureSession(page)) throw new Error('Auth falló en Geonet');

    const url = `${GEONET_BASE_URL}/Instalaciones/editar/${encodeURIComponent(externalIdOrUser)}/${installationId}/`;
    console.log(`[editarInstalacionGeonet] Navegando a: ${url}`);

    await safeGoto(page, url, { waitForSelector: 'form#agregar-cliente' });

    // ── Mapear campos simples ─────────────────────────────────────────────
    // (El log de resolvedUpdates se mueve después de su declaración)
    const fieldMap: Record<string, string> = {
      ip: 'cliente-ip',
      mac: 'cliente-mac_cpe',
      estado: 'cliente-estado_instalacion',
      fechaInstalacion: 'cliente-fecha_instalacion',
      fecha_instalacion: 'cliente-fecha_instalacion',
      costo: 'cliente-costo_instalacion',
      firstName: 'usr-first_name',
      lastName: 'usr-last_name',
      ci: 'perfil-cedula',
      email: 'usr-email',
      address: 'perfil-direccion',
      city: 'perfil-ciudad',
      phone: 'perfil-telefono',
    };

    const specialKeys = new Set(['apName', 'zonaName', 'routerName', 'technicianName', 'comments']);
    const resolvedUpdates: Record<string, string> = {};
    console.log('[editarInstalacionGeonet][DEBUG] resolvedUpdates iniciales:', resolvedUpdates);

    for (const [key, value] of Object.entries(updates)) {
      if (value === undefined || value === null) continue;
      if (specialKeys.has(key)) continue;
      resolvedUpdates[fieldMap[key] || key] = String(value);
    }

    // ── Resolver zona con ZONE_MAPPING ───────────────────────────────────
    let planValue: string | null = null;
    if (updates.zonaName) {
      // Guardar el valor actual del plan antes de cambiar la zona
      try {
        planValue = await page.$eval('#id_cliente-plan_internet', (el: any) => el.value || '');
      } catch {}

      const zonaOpts = await _extractSelectOptions(page, '#id_cliente-zona_cliente, select[name*="zona_cliente" i]');
      const mapped = ZONE_MAPPING[String(updates.zonaName).trim()] || updates.zonaName;
      let zonaId = _findSelectValue(zonaOpts, mapped);
      if (!zonaId && mapped !== updates.zonaName) {
        zonaId = _findSelectValue(zonaOpts, updates.zonaName);
      }
      if (!zonaId && typeof page.type === 'function') {
        // Si hay select2/buscador, simula escribir el texto y seleccionar la opción sugerida
        await page.focus('#id_cliente-zona_cliente');
        await page.type('#id_cliente-zona_cliente', mapped, {delay: 30});
        // Espera a que aparezca la opción sugerida y selecciona la primera
        await page.keyboard.press('ArrowDown');
        await page.keyboard.press('Enter');
        // Vuelve a extraer el valor seleccionado
        const selected = await page.$eval('#id_cliente-zona_cliente', el => (el as HTMLSelectElement).value);
        if (selected) zonaId = selected;
      }
      if (!zonaId) {
        console.warn(`[editarInstalacionGeonet] Zona no encontrada. Target: "${mapped}". Opciones disponibles:`);
        zonaOpts.forEach(opt => console.warn(`  - [${opt.value}] ${opt.text}`));
      } else {
        resolvedUpdates['cliente-zona_cliente'] = zonaId;
        console.log(`[editarInstalacionGeonet] Zona resuelta: "${mapped}" → id=${zonaId}`);
      }

      // Validar y restaurar el plan
      let planValid = false;
      let planOptions: {value: string, text: string}[] = [];
      try {
        planOptions = await page.evaluate(() => {
          const sel = document.querySelector('#id_cliente-plan_internet') as HTMLSelectElement | null;
          if (!sel) return [];
          return Array.from(sel.options).map(opt => ({ value: opt.value, text: opt.text }));
        });
        if (planValue && planOptions.some(opt => opt.value === planValue)) {
          planValid = true;
        }
      } catch {}

      if (!planValid && planOptions.length > 0) {
        // Seleccionar el primer plan disponible
        planValue = planOptions[0].value;
        console.warn(`[editarInstalacionGeonet] El plan anterior no es válido para la nueva zona. Se usará el primer plan disponible: ${planValue}`);
      } else if (!planValid) {
        planValue = '';
        console.warn(`[editarInstalacionGeonet] No se pudo determinar un plan válido para la zona seleccionada.`);
      } else {
        console.log(`[editarInstalacionGeonet] Plan restaurado: ${planValue}`);
      }
    }

    // ── Resolver AP con AP_MAPPING ────────────────────────────────────────
    if (updates.apName) {
      const apOpts = await _extractSelectOptions(page, '#id_cliente-ap_cliente, select[name*="ap_cliente" i]');
      const mapped = AP_MAPPING[String(updates.apName).trim()] || updates.apName;
      let apId = _findSelectValue(apOpts, mapped);
      if (!apId && mapped !== updates.apName) {
        apId = _findSelectValue(apOpts, updates.apName);
      }
      if (!apId && typeof page.type === 'function') {
        await page.focus('#id_cliente-ap_cliente');
        await page.type('#id_cliente-ap_cliente', mapped, {delay: 30});
        await page.keyboard.press('ArrowDown');
        await page.keyboard.press('Enter');
        const selected = await page.$eval('#id_cliente-ap_cliente', el => (el as HTMLSelectElement).value);
        if (selected) apId = selected;
      }
      if (!apId) {
        console.warn(`[editarInstalacionGeonet] AP no encontrado. Target: "${mapped}". Opciones disponibles:`);
        apOpts.forEach(opt => console.warn(`  - [${opt.value}] ${opt.text}`));
      } else {
        resolvedUpdates['cliente-ap_cliente'] = apId;
        console.log(`[editarInstalacionGeonet] AP resuelto: "${mapped}" → id=${apId}`);
      }
    }

    // ── Resolver router ──────────────────────────────────────────────────
    // Si no se especifica routerName, usar el mismo valor que zonaName
    let routerToUse = updates.routerName;
    if (!routerToUse && updates.zonaName) {
      routerToUse = updates.zonaName;
    }
    if (routerToUse) {
      const routerOpts = await _extractSelectOptions(page, '#id_cliente-router_cliente, select[name*="router_cliente" i]');
      const routerId = _findSelectValue(routerOpts, String(routerToUse));
      if (routerId) {
        resolvedUpdates['cliente-router_cliente'] = routerId;
        console.log(`[editarInstalacionGeonet] Router resuelto: "${routerToUse}" → id=${routerId}`);
      }
    }

    // ── Resolver técnico ──────────────────────────────────────────────────
    if (updates.technicianName) {
      const techOpts = await _extractSelectOptions(page, '#id_cliente-tecnico, select[name*="tecnico" i]');
      const techId = _findSelectValue(techOpts, String(updates.technicianName));
      if (techId) {
        resolvedUpdates['cliente-tecnico'] = techId;
        console.log(`[editarInstalacionGeonet] Técnico resuelto: "${updates.technicianName}" → id=${techId}`);
      }
    }

    // ── Disparar eventos change para que Geonet refresque las IPs ────────
    // Esto es el paso clave: al cambiar zona/router en el DOM, Geonet
    // recalcula las IPs disponibles igual que en el formulario de activación.
    await page.evaluate((rVal: string, zVal: string, aVal: string) => {
      const triggerChange = (selector: string, val: string) => {
        const el = document.querySelector(selector) as HTMLSelectElement | null;
        if (!el || !val) return;
        el.value = val;
        if (typeof (window as any).jQuery !== 'undefined') {
          (window as any).jQuery(el).trigger('change');
        } else {
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
      };
      triggerChange('#id_cliente-zona_cliente, select[name*="zona_cliente" i]', zVal);
      triggerChange('#id_cliente-router_cliente, select[name*="router_cliente" i]', rVal);
      triggerChange('#id_cliente-ap_cliente, select[name*="ap_cliente" i]', aVal);
    },
      resolvedUpdates['cliente-router_cliente'] || '',
      resolvedUpdates['cliente-zona_cliente'] || '',
      resolvedUpdates['cliente-ap_cliente'] || ''
    );

    // --- Seleccionar el plan SOLO una vez, después de refrescar zona/router/AP ---
    if (updates.planName) {
      // Esperar hasta 10 segundos a que el select tenga opciones válidas (no solo que exista)
      await page.waitForFunction(() => {
        const sel = document.querySelector('#id_cliente-plan_internet') as HTMLSelectElement | null;
        return !!sel && Array.from(sel.options).filter(o => o.value && o.text && o.text.trim().length > 0).length > 0;
      }, { timeout: 10000 }).catch(() => null);

      // Fuzzy match robusto sobre toda la lista de planes
      const planName = String(updates.planName).trim();
      const normalize = (s: string): string => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
      const planTokens: string[] = normalize(planName).split(' ').filter(Boolean);
      const planOptions = await page.evaluate(() => {
        const sel = document.querySelector('#id_cliente-plan_internet') as HTMLSelectElement | null;
        if (!sel) return [];
        return Array.from(sel.options).map(opt => ({ value: opt.value, text: opt.text }));
      });
      console.log('[editarInstalacionGeonet][PLAN] Valor recibido para planName:', planName);
      console.log('[editarInstalacionGeonet][PLAN] Opciones disponibles (detallado):', planOptions);
      if (planOptions.length > 0) {
        for (const opt of planOptions) {
          console.log(`[editarInstalacionGeonet][PLAN] Opción: value="${opt.value}" text="${opt.text}"`);
        }
      }
      if (planOptions.length === 0) {
        const planSelectHtml = await page.evaluate(() => {
          const sel = document.querySelector('#id_cliente-plan_internet');
          return sel ? sel.outerHTML : null;
        });
        console.warn('[editarInstalacionGeonet][PLAN] <select> de plan sigue vacío tras esperar. HTML:', planSelectHtml);
        // No seleccionar ningún plan si el select está vacío
      } else {
        // Fuzzy match: usar la librería Fuse.js si está disponible, si no, usar scoring manual
        let selectedPlanValue = '';
        let bestScore = -1;
        let bestText = '';
        for (const opt of planOptions) {
          const normOpt = normalize(opt.text || '');
          // Score: +20 por cada token del planName que esté en la opción
          let score = 0;
          for (const token of planTokens) {
            if (normOpt.includes(token)) score += 20;
          }
          // Bonus si incluye el precio y la velocidad
          if (planTokens.some((t: string) => /\d+mbps?/.test(t)) && /\d+mbps?/.test(normOpt)) score += 10;
          if (planTokens.some((t: string) => /\$\d+/.test(t)) && /\$\d+/.test(normOpt)) score += 10;
          // Bonus si incluye el nombre completo (sin sufijos)
          if (normOpt.includes(normalize(planName))) score += 30;
          // Penalización si la opción es genérica (menos tokens en común)
          score -= Math.abs(normOpt.length - normalize(planName).length);
          if (score > bestScore) {
            bestScore = score;
            selectedPlanValue = opt.value;
            bestText = opt.text;
          }
        }
        if (selectedPlanValue && bestScore > 0) {
          await page.evaluate((val) => {
            const planEl = document.querySelector('#id_cliente-plan_internet') as HTMLSelectElement | null;
            if (planEl) {
              planEl.value = val;
              if (typeof (window as any).jQuery !== 'undefined') {
                (window as any).jQuery(planEl).trigger('change');
              } else {
                planEl.dispatchEvent(new Event('change', { bubbles: true }));
              }
            }
          }, selectedPlanValue);
          console.log(`[editarInstalacionGeonet][PLAN] Plan seleccionado: input="${planName}" → match="${bestText}" (value=${selectedPlanValue}, score=${bestScore})`);
        } else {
          console.warn(`[editarInstalacionGeonet][PLAN] No se pudo seleccionar un plan por fuzzy match, y no se seleccionó ninguno.`);
        }
      }
    }

    // Esperar a que Geonet cargue IPs disponibles para la nueva zona
    await page.waitForFunction(() => {
      const popover = document.querySelector('#popover-ips-disponibles ul li a');
      if (popover?.textContent && /\b(?:\d{1,3}\.){3}\d{1,3}\b/.test(popover.textContent)) return true;
      const ipInput = document.querySelector('input[name*="ip" i]') as HTMLInputElement | null;
      if (ipInput?.value && /\b(?:\d{1,3}\.){3}\d{1,3}\b/.test(ipInput.value)) return true;
      return false;
    }, { timeout: 4000 }).catch(() => null); // timeout silencioso: puede que ya haya IP

    // ── Leer todas las IPs disponibles del popover ─────────────────────────
    const availableIps: string[] = await page.evaluate(() => {
      const ips: string[] = [];
      const popoverLinks = document.querySelectorAll('#popover-ips-disponibles ul li a');
      popoverLinks.forEach(link => {
        const match = link.textContent?.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/);
        if (match) ips.push(match[0]);
      });
      const ipInput = document.querySelector('input[name*="ip" i]') as HTMLInputElement | null;
      const matchInput = ipInput?.value?.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/);
      if (matchInput) ips.push(matchInput[0]);
      return Array.from(new Set(ips));
    });

    // ── Verificar si la IP ya existe en SmartoltOnuDetail ──────────────────
    let ipToAssign: string | null = null;
    if (availableIps.length > 0) {
      // Importar datasource y modelo
      const { AppDataSource } = require('../datasource');
      const { SmartoltOnuDetail } = require('../models/SmartoltOnuDetail');
      for (const ip of availableIps) {
        // eslint-disable-next-line no-await-in-loop
        const exists = await AppDataSource.getRepository(SmartoltOnuDetail).findOne({ where: { ipAddress: ip } });
        if (!exists) {
          ipToAssign = ip;
          break;
        }
      }
      if (!ipToAssign) {
        console.warn('[editarInstalacionGeonet] Todas las IPs disponibles ya están usadas en SmartoltOnuDetail.');
      } else {
        resolvedUpdates['cliente-ip'] = ipToAssign;
        console.log(`[editarInstalacionGeonet] IP disponible detectada y asignada: ${ipToAssign}`);
      }
    } else {
      console.warn('[editarInstalacionGeonet] No se detectó IP disponible en la UI para esta zona/router.');
    }

    // ── POST del formulario con los cambios ───────────────────────────────
    const result = await page.evaluate(async (args: {
      url: string;
      resolvedUpdates: Record<string, string>;
      newComments?: string;
    }) => {
      try {
        const formEl = document.querySelector('form#agregar-cliente') as HTMLFormElement | null;
        if (!formEl) return { status: 502, url: '', errors: ['Formulario no encontrado en el DOM'] };

        const formData = new (window as any).FormData(formEl);
        const csrf = (document.querySelector('input[name="csrfmiddlewaretoken"]') as HTMLInputElement)?.value || '';
        formData.set('csrfmiddlewaretoken', csrf);

        // Aplicar updates sobre el FormData existente
        for (const [key, value] of Object.entries(args.resolvedUpdates)) {
          formData.set(key, value);
        }

        // Agregar nota a comentarios si se pasa
        if (args.newComments) {
          const commentKey = 'cliente-comentarios';
          let existing = '';
          const ck = (window as any).CKEDITOR;
          if (ck && ck.instances[`id_${commentKey}`]) {
            existing = ck.instances[`id_${commentKey}`].getData();
          } else {
            existing = (document.querySelector(`#id_${commentKey}`) as HTMLTextAreaElement)?.value || '';
          }
          if (!existing.includes(args.newComments)) {
            formData.set(commentKey, `${existing}\n\n[Nota Bot]: ${args.newComments}`.trim());
          }
        }

        const res = await fetch(args.url, { method: 'POST', body: formData });

        let effectiveStatus = res.status;
        if (res.redirected && (res.url.includes('/Instalaciones') || res.url.includes('/clientes'))) {
          effectiveStatus = 200;
        } else if (!res.redirected && res.url.includes('/editar/')) {
          effectiveStatus = 422;
        }

        let errors: string[] = [];
        if (effectiveStatus === 422) {
          const html = await res.text();
          const doc = new DOMParser().parseFromString(html, 'text/html');
          errors = Array.from(doc.querySelectorAll('.alert-danger, .errorlist, .text-danger, .help-block'))
            .map(el => el.textContent?.trim() || '')
            .filter(Boolean);
        }

        return { status: effectiveStatus, url: res.url, errors };
      } catch (e: any) {
        return { status: 500, url: '', errors: [e.toString()] };
      }
    }, { url, resolvedUpdates, newComments: updates.comments });

    if (result.status >= 400) {
      console.warn(`[editarInstalacionGeonet] Geonet rechazó la edición. status=${result.status}, errores=${JSON.stringify(result.errors)}`);
    } else {
      console.log(`[editarInstalacionGeonet] ✓ Éxito. status=${result.status}, ip=${ipToAssign ?? 'N/D'}`);
    }

    return {
      status: result.status,
      location: result.url,
      formErrors: result.errors || [],
      appliedUpdates: resolvedUpdates,
      newIp: ipToAssign,
    };

  } finally {
    await page.close();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// FUNCIÓN DE ALTO NIVEL: autorizar ONU en SmartOLT + corregir IP en WispHub
// ─────────────────────────────────────────────────────────────────────────────

export type AuthorizeAndFixIpParams = {
  /** Parámetros para authorizeOnu() de smartoltClient */
  authorizeParams: Parameters<typeof authorizeOnu>[0];
  /** username/externalId del cliente en Geonet */
  externalIdOrUser: string;
  /** ID de instalación en Geonet */
  installationId: string | number;
  /**
   * Nombre del AP/CTO como viene en SmartOLT.
   * Se buscará en AP_MAPPING para normalizar el nombre antes de enviarlo a Geonet.
   */
  apName: string;
  /**
   * Clave del ZONE_MAPPING (ej: "Parque de Sol - Z402").
   * Si no se pasa, Geonet usará la zona ya seleccionada pero recalculará la IP.
   */
  zonaName?: string;
  /** Nombre del router si también cambió */
  routerName?: string;
  /** Nota opcional que se agrega a comentarios */
  comments?: string;
  /**
   * Si true, autoriza SmartOLT PRIMERO y luego corrige Geonet.
   * Por defecto (false): corrige Geonet primero para tener la IP lista antes de autorizar.
   */
  authorizeFirst?: boolean;
  /** Nombre del plan a seleccionar en Geonet (display name) */
  planName?: string;
};

export type AuthorizeAndFixIpResult = {
  ok: boolean;
  smartoltAuthorized: boolean;
  geonetFixed: boolean;
  newIp: string | null;
  warnings: string[];
  error?: string;
};

export async function authorizeOnuAndFixIp(
  params: AuthorizeAndFixIpParams
): Promise<AuthorizeAndFixIpResult> {
  const {
    authorizeParams,
    externalIdOrUser,
    installationId,
    apName,
    zonaName,
    routerName,
    comments,
    authorizeFirst = false,
  } = params;

  const warnings: string[] = [];
  let smartoltAuthorized = false;
  let geonetFixed = false;
  let newIp: string | null = null;

  const log = (msg: string) => console.log(`[authorizeOnuAndFixIp] ${msg}`);
  const warn = (msg: string) => { console.warn(`[authorizeOnuAndFixIp] ⚠️ ${msg}`); warnings.push(msg); };

  try {
    // ── Paso 1 (opcional): SmartOLT primero ──────────────────────────────
    if (authorizeFirst) {
      log('Autorizando en SmartOLT (authorizeFirst=true)...');
      try {
        await authorizeOnu(authorizeParams as any);
        smartoltAuthorized = true;
        log('SmartOLT autorizado ✓');
      } catch (e: any) {
        warn(`SmartOLT falló: ${e?.message}`);
      }
    }

    // ── Paso 2: Corregir zona/AP/IP en Geonet ────────────────────────────
    log(`Corrigiendo Geonet: ap="${apName}", zona="${zonaName ?? 'N/A'}"...`);
    try {
      // Pasar planName si está presente
      const updates: any = { apName, zonaName, routerName, comments };
      if (typeof params.planName === 'string' && params.planName.trim()) {
        updates.planName = params.planName;
      }
      const editResult = await editarInstalacionGeonet({
        externalIdOrUser,
        installationId,
        updates,
      });

      if (editResult.status < 400) {
        geonetFixed = true;
        newIp = editResult.newIp;
        log(`Geonet corregido ✓ nueva IP: ${newIp ?? 'no detectada en UI'}`);
      } else {
        warn(`Geonet rechazó la edición (status=${editResult.status}): ${editResult.formErrors.join(', ') || 'sin detalle'}`);
      }
    } catch (e: any) {
      warn(`editarInstalacionGeonet error: ${e?.message}`);
    }

    // ── Paso 3 (default): SmartOLT después de tener la IP correcta ───────
    if (!authorizeFirst) {
      log('Autorizando en SmartOLT...');
      try {
        await authorizeOnu(authorizeParams as any);
        smartoltAuthorized = true;
        log('SmartOLT autorizado ✓');
      } catch (e: any) {
        warn(`SmartOLT falló: ${e?.message}`);
      }
    }

    return { ok: geonetFixed || smartoltAuthorized, smartoltAuthorized, geonetFixed, newIp, warnings };

  } catch (error: any) {
    console.error(`[authorizeOnuAndFixIp] Error crítico: ${error?.message}`);
    return { ok: false, smartoltAuthorized, geonetFixed, newIp: null, warnings, error: error?.message };
  }
}

function startActivationBackgroundVerification(instalacionId: number | string, usuarioInstalacion: string): void {
  const key = `${String(instalacionId)}::${String(usuarioInstalacion).toLowerCase()}`;
  if (activationBackgroundJobs.has(key)) {
    console.log(`[Activation:${instalacionId}] [BG] ya existe verificación en segundo plano para ${usuarioInstalacion}`);
    return;
  }

  const job = (async () => {
    const logPrefix = `[Activation:${instalacionId}] [BG]`;
    console.log(`${logPrefix} inicio verificación de activación en segundo plano para ${usuarioInstalacion}`);
    const result = await waitForActivationApiConfirmation(instalacionId, usuarioInstalacion, {
      maxWaitMs: SCRAPING_TIMEOUTS.activationApiMaxWaitMs,
      logPrefix
    });
    if (result.confirmed) {
      console.log(`${logPrefix} ✅ confirmado activo: ${result.reason}`);
    } else {
      console.warn(`${logPrefix} ⚠️ no se confirmó activo: ${result.reason}`);
    }
  })()
    .catch((err: any) => {
      console.error(`[Activation:${instalacionId}] [BG] error en verificación: ${err?.message || err}`);
    })
    .finally(() => {
      activationBackgroundJobs.delete(key);
      console.log(`[Activation:${instalacionId}] [BG] fin de verificación`);
    });

  activationBackgroundJobs.set(key, job);
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

export async function getClientByServiceId(id_servicio: number | string): Promise<Record<string, any> | null> {
  const serviceId = String(id_servicio || '').trim();
  if (!serviceId) return null;
  try {
    const res = await http.get(`/api/clientes/${encodeURIComponent(serviceId)}/`);
    return (res?.data || null) as Record<string, any> | null;
  } catch (err: any) {
    const status = err?.response?.status;
    if (status === 404) return null;
    throw err;
  }
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
    await safeGoto(page, url, { waitForSelector: 'input[name="contrato-fecha_inicio"]', timeout: SCRAPING_TIMEOUTS.longOperation });

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
    const response = await safeGoto(page, url, { timeout: SCRAPING_TIMEOUTS.longOperation });
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
): Promise<{ ok: boolean; status?: number; error?: string; pending?: boolean; detail?: string }> {
  const start = Date.now();
  const { browser, page } = await openPage();
  const logPrefix = `[Activation:${instalacionId}]`;

  const targetUrl = `${GEONET_BASE_URL}/Instalaciones/${usuarioInstalacion}/${instalacionId}/activar/`;
  console.log(`${logPrefix} Paso 1/8 - Navegando a: ${targetUrl}`);

  try {
    if (!await ensureSession(page)) throw new Error('Auth falló');
    console.log(`${logPrefix} Paso 2/8 - Sesión Geonet OK`);

    console.log(`${logPrefix} Paso 3/8 - Cargando página de activación`);
    await safeGoto(page, targetUrl, { timeout: SCRAPING_TIMEOUTS.mediumOperation });

    // 2. PREPARACIÓN DEL TERRENO
    // Borramos el GIF de carga para evitar intercepciones de click
    await page.evaluate(() => {
        const gif = document.getElementById('content-loading-gif');
        if (gif) gif.remove();
        
        const backdrop = document.querySelector('.modal-backdrop');
        if (backdrop) backdrop.remove();
    });

    console.log(`${logPrefix} Paso 4/8 - POST axios obligatorio (primer intento de activación)`);
    const navigationPromise = page
      .waitForNavigation({ waitUntil: 'domcontentloaded', timeout: SCRAPING_TIMEOUTS.activationNavigation })
      .catch(() => null);

    let submitted = false;
    let submitMode = '';

    const axiosPost = await postActivationViaAxios(page, targetUrl, `${logPrefix} [AXIOS-FIRST]`);
    if (axiosPost.ok) {
      submitted = true;
      submitMode = 'axios-post';
      console.log(`${logPrefix} activación enviada por axios (${axiosPost.detail || `status=${axiosPost.status}`})`);
    } else {
      console.warn(`${logPrefix} POST axios obligatorio falló (${axiosPost.detail || 'sin detalle'}). Fallback a submit Puppeteer...`);
    }

    console.log(
      `${logPrefix} Paso 5/8 - ${submitted ? 'POST axios ejecutado correctamente' : 'Ejecutando fallback Puppeteer tras falla de axios'}`
    );

    if (!submitted) {
      const submitResult = await submitActivationForm(page).catch((err: any) => ({
        submitted: false,
        mode: 'error',
        detail: err?.message || String(err)
      }));

      if (submitResult.submitted) {
        submitted = true;
        submitMode = submitResult.mode;
        console.log(`${logPrefix} formulario enviado (${submitResult.mode})`);
      } else {
        console.warn(`${logPrefix} submitActivationForm no logró enviar (${submitResult.detail || 'sin detalle'}). Intentando click fallback...`);
        const clicked = await clickActivateButton(page);
        if (clicked) {
          submitted = true;
          submitMode = 'click-fallback';
          console.log(`${logPrefix} fallback click ejecutado`);
        }
      }
    }

    if (!submitted) {
      console.log(`${logPrefix} Paso 6/8 - No se pudo enviar; verificación API rápida final`);
      const apiWithoutClick = await waitForActivationApiConfirmation(instalacionId, usuarioInstalacion, {
        maxWaitMs: SCRAPING_TIMEOUTS.activationApiQuickConfirmMaxWaitMs,
        logPrefix: `${logPrefix} [NO-SUBMIT]`
      });
      if (apiWithoutClick.confirmed) {
        console.log(`${logPrefix} ✅ confirmada activa sin submit (${apiWithoutClick.reason}).`);
        return { ok: true, status: 200 };
      }
      return {
        ok: false,
        status: 409,
        error: 'No se logró enviar el formulario de activación y la API no confirmó estado activo.'
      };
    }

    console.log(`${logPrefix} Paso 6/8 - Activación enviada (${submitMode}). Confirmación rápida...`);
    await navigationPromise;

    console.log(`${logPrefix} Paso 7/8 - Verificando UI + API clientes`);

    const uiAfter = await waitForActivationUiConfirmation(page, targetUrl);
    if (uiAfter.confirmed) {
      console.log(`${logPrefix} UI reporta activación (${uiAfter.reason}); validando API de clientes...`);
    }

    const apiAfter = await waitForActivationApiConfirmation(instalacionId, usuarioInstalacion, {
      maxWaitMs: SCRAPING_TIMEOUTS.activationApiQuickConfirmMaxWaitMs,
      logPrefix: `${logPrefix} [QUICK]`
    });
    if (apiAfter.confirmed) {
      console.log(`${logPrefix} ✅ activación confirmada por API (${apiAfter.reason}).`);
      console.log(`${logPrefix} Paso 8/8 - Fin en ${Date.now() - start}ms`);
      return { ok: true, status: 200 };
    }

    const pendingReason = `Activación enviada; verificación en segundo plano iniciada. ${apiAfter.reason}`;
    console.warn(`${logPrefix} ⏳ ${pendingReason}`);
    startActivationBackgroundVerification(instalacionId, usuarioInstalacion);
  console.log(`${logPrefix} Paso 8/8 - Retorno no bloqueante (pendiente)`);
    return { ok: true, status: 202, pending: true, detail: pendingReason };

  } catch (error: any) {
    console.error(`${logPrefix} ❌ Error activarInstalacionGeonet: ${error.message}`);
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
  categoria: string = 'Productos Wifi'
): Promise<boolean> {
  const start = Date.now();
  const MAX_ATTEMPTS = 3;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let browser: Browser | undefined;
    let page: Page | undefined;
    
    try {
      const bp = await openPage();
      browser = bp.browser;
      page = bp.page;

      if (!await ensureSession(page)) throw new Error('Auth falló');

      // 1. IR A LA PÁGINA
      const url = `${GEONET_BASE_URL}/clientes/agregar-articulos/${clienteUsuario}/${clienteId}/`;
      console.log(`[Puppeteer] Navegando a asignar artículo: ${url} (Intento ${attempt})`);
      
      // Es crucial esperar por la clase '.add-row', eso nos confirma que el JS de Geonet ya borró la fila inicial y está listo.
      await safeGoto(page, url, { waitForSelector: '.add-row', timeout: SCRAPING_TIMEOUTS.mediumOperation });

      // 2. INYECTAR LÓGICA DIRECTA USANDO EL PROPIO JQUERY DE GEONET
      console.log(`[Puppeteer] Buscando e inyectando equipo ${numSerie}...`);

      const result = await page.evaluate(async (args) => {
        try {
            // A. Consultar el inventario al backend de Geonet
            const res = await fetch('/autocomplete-almacen/?exclude_services');
            if (!res.ok) throw new Error(`HTTP Error backend: ${res.status}`);
            const inventario = await res.json();

            // B. Buscar la ONU por serial
            const item = inventario.find((i: any) => 
                i.num_serie && i.num_serie.toUpperCase() === args.serial.toUpperCase()
            );

            if (!item) {
                return { ok: false, error: `El equipo ${args.serial} no está en el stock del almacén.` };
            }

            // C. Verificar jQuery
            const jq = (window as any).$;
            if (!jq) throw new Error("jQuery no está cargado en la página.");

            // D. Ejecutar la lógica exacta que usa Geonet al seleccionar un item
            jq(".add-row").click(); // Genera la nueva fila de inputs
            
            // Rellenar siempre los últimos elementos generados (como hace su frontend)
            jq(".label-item").last().html(item.nombre);
            jq(".num-serie").last().val(item.num_serie);
            jq(".mac-address").last().val(args.mac || item.mac || '');
            jq(".cantidad").last().val(1);
            jq(".uuid-item").last().val(item.value);
            jq(".categoria").last().val(item.categoria);

            return { ok: true, error: null };
        } catch (e: any) {
            return { ok: false, error: e.toString() };
        }
      }, { serial: numSerie, mac: mac });

      if (!result.ok) {
          throw new Error(`Inyección fallida: ${result.error}`);
      }

      // 3. ENVIAR FORMULARIO
      console.log('[Puppeteer] Datos rellenados con éxito. Guardando asignación...');
      const submitBtn = await page.$('#submit-button');
      if (!submitBtn) throw new Error('Botón guardar no encontrado');

      await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: SCRAPING_TIMEOUTS.mediumOperation }),
        submitBtn.click()
      ]);

      // 4. VALIDACIÓN FINAL DE ÉXITO
      if (page.url().includes('agregar-articulos')) {
        const errorMsg = await page.evaluate(() => {
          return document.querySelector('.alert-danger')?.textContent?.trim() ||
                 document.querySelector('.errorlist')?.textContent?.trim() ||
                 'El equipo ya está asignado o es inválido.';
        });
        throw new Error(`Geonet rechazó la asignación: ${errorMsg}`);
      }

      console.log(`✅ Artículo ${numSerie} asignado correctamente a ${clienteUsuario}.`);
      console.log(`[Puppeteer] Tiempo total agregarArticuloACliente: ${Date.now() - start}ms`);

      try { if (page && !page.isClosed()) await page.close(); } catch (e) {}
      return true;

    } catch (error: any) {
      console.error(`❌ [agregarArticuloACliente] Intento ${attempt} falló: ${error?.message || error}`);
      
      try { if (page && !page.isClosed()) await page.close(); } catch (e) {}

      if (attempt < MAX_ATTEMPTS) {
        console.log(`[agregarArticuloACliente] Esperando para reintentar (${attempt + 1}/${MAX_ATTEMPTS})...`);
        await new Promise((r) => setTimeout(r, 2000 * attempt));
      } else {
        console.error(`[agregarArticuloACliente] Fallaron los ${MAX_ATTEMPTS} intentos.`);
      }
    }
  }
  return false;
}
export async function getWifiProductUuidBySerial(serial: string): Promise<string | null> {
  const start = Date.now();
  const { browser, page } = await openPage();
    try {
        if (!await ensureSession(page)) return null;

        // Usamos el buscador de Geonet
    const t0 = Date.now();
    await safeGoto(page, `${GEONET_BASE_URL}/productos-wifi/?q=${serial}`, { timeout: SCRAPING_TIMEOUTS.mediumOperation });
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
    await safeGoto(page, url, { waitForSelector: 'input[name="csrfmiddlewaretoken"]', timeout: SCRAPING_TIMEOUTS.mediumOperation });

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