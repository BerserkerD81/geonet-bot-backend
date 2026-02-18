import axios, { AxiosHeaders } from 'axios';
import puppeteer, { Browser, Page, Protocol } from 'puppeteer-core';
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
 * Gestiona el Login y la sesión en Geonet internamente.
 * Reutiliza cookies para no loguearse en cada petición.
 */
async function ensureSession(page: Page): Promise<boolean> {
  const start = Date.now();
  try {
    const isCookieFresh = (Date.now() - cookiesTimestamp) < 1000 * 60 * 45; // 45 min de validez aprox

    // 1. Inyectar cookies cacheadas si existen
    if (cachedCookies && cachedCookies.length > 0 && isCookieFresh) {
      await page.setCookie(...cachedCookies);
    }

    // 2. Navegar al panel. Si la cookie es válida, entrará directo. Si no, redirige a login.
    await page.goto(`${GEONET_BASE_URL}/panel/`, { waitUntil: 'networkidle2', timeout: 60000 });

    // 3. Detectar si estamos en el login
    if (page.url().includes('/accounts/login/')) {
      console.log('[Puppeteer] Iniciando sesión en Geonet (Credenciales)...');
      
      await page.waitForSelector('input[name="login"]', { timeout: 10000 });
      // Aquí podrías usar process.env.GEONET_USER y process.env.GEONET_PASS
      await page.type('input[name="login"]', 'Jorgeprac@geonet');
      await page.type('input[name="password"]', 'JorgePrac');
      
      // Click en submit y esperar navegación
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle2' }),
        page.click('button[type="submit"]') // Ajustar si Geonet cambia el selector del botón
      ]);

      // Verificar éxito
      if (page.url().includes('/panel/')) {
        console.log('[Puppeteer] Login exitoso.');
        cachedCookies = await page.cookies();
        cookiesTimestamp = Date.now();
        return true;
      } else {
        console.error('[Puppeteer] Login fallido. URL actual: ' + page.url());
        return false;
      }
    }
    console.log(`[Puppeteer] ensureSession tiempo: ${Date.now() - start}ms`);
    return true; // Ya estábamos logueados
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
  const browser = await getBrowser();
  const page = await browser.newPage();
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
  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    if (!await ensureSession(page)) return false;

    // 1. Ir al formulario
    const url = `${GEONET_BASE_URL}/instalaciones/agregar-contrato/${instalacionId}/`;
    await page.goto(url, { waitUntil: 'networkidle2' });

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
      page.waitForNavigation({ waitUntil: 'networkidle2' }),
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
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    if (!await ensureSession(page)) throw new Error('Auth falló');

    const url = `${GEONET_BASE_URL}/instalaciones/imprimir-contrato/${instalacionId}/`;
    const t0 = Date.now();
    const response = await page.goto(url, { waitUntil: 'networkidle2' });
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
  const browser = await getBrowser();
  const page = await browser.newPage();
  
  // URL de la pantalla de confirmación (usar minúsculas para evitar redirecciones inesperadas)
  const targetUrl = `${GEONET_BASE_URL}/instalaciones/${usuarioInstalacion}/${instalacionId}/activar/`;

  try {
    if (!await ensureSession(page)) throw new Error('Auth falló');

    console.log(`[Puppeteer] Navegando a activación: ${instalacionId}`);

    // 1. CARGAR PÁGINA DE CONFIRMACIÓN
    const response = await page.goto(targetUrl, { waitUntil: 'networkidle2' });

    // Validar carga
    if (!response || response.status() >= 400) {
        // Si da 403 aquí, es que el usuario no tiene permisos
        return { ok: false, status: response?.status(), error: `Error cargando página: ${response?.statusText()}` };
    }

    // 2. VERIFICAR FORMULARIO
    // Tu HTML muestra <form id="activar_cliente_form">
    try {
        await page.waitForSelector('#activar_cliente_form', { visible: true, timeout: 5000 });
    } catch (e) {
        // Si no hay formulario, revisamos si ya dice "Activo"
        const text = await page.evaluate(() => document.body.innerText);
        if (text.includes('correctamente') || text.includes('activo')) {
             console.log('✅ Instalación ya estaba activa o se activó previamente.');
             return { ok: true, status: 200 };
        }
        return { ok: false, error: 'Formulario de activación no encontrado.' };
    }

    // 3. HACER CLIC EN EL BOTÓN
    // El botón está dentro del form: <button type="submit" class="btn btn-primary">Activar Instalación</button>
    console.log('[Puppeteer] Confirmando activación...');

    await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle2' }),
        page.click('#activar_cliente_form button[type="submit"]')
    ]);
    console.log(`✅ Activación ${instalacionId} completada.`);
    console.log(`[Puppeteer] activarInstalacionGeonet tiempo total: ${Date.now() - start}ms`);
    return { ok: true, status: 200 };

  } catch (error: any) {
    console.error(`Error activarInstalacionGeonet: ${error.message}`);
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
  const browser = await getBrowser();
  const page = await browser.newPage();
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
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    if (!await ensureSession(page)) return false;

    const url = `${GEONET_BASE_URL}/productos-wifi/agregar/`;
    const t0 = Date.now();
    await page.goto(url, { waitUntil: 'networkidle2' });
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
        page.waitForNavigation({ waitUntil: 'networkidle2' }),
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
  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    if (!await ensureSession(page)) return false;

    console.log(`[Puppeteer] Buscando ${numSerie} en inventario...`);

    // 1. OBTENER DATOS (UUID) VIA API
    const inventoryUrl = `${GEONET_BASE_URL}/autocomplete-almacen/?exclude_services`;
    
    // Hacemos fetch desde el navegador para aprovechar la cookie de sesión
    const itemData = await page.evaluate(async (url, serial) => {
        try {
            const r = await fetch(url);
            const d = await r.json();
            return d.find((i: any) => i.num_serie && i.num_serie.trim().toUpperCase() === serial.trim().toUpperCase());
        } catch (e) { return null; }
    }, inventoryUrl, numSerie);

    if (!itemData) {
        console.error(`❌ Equipo ${numSerie} no disponible en almacén.`);
        return false;
    }

    const uuid = itemData.value;
    const cat = itemData.categoria || categoria;
    const finalMac = mac || itemData.mac || '';

    console.log(`✅ Equipo encontrado: UUID=${uuid}`);

    // 2. IR A LA PÁGINA
    const url = `${GEONET_BASE_URL}/clientes/agregar-articulos/${clienteUsuario}/${clienteId}/`;
    const t0 = Date.now();
    await page.goto(url, { waitUntil: 'networkidle2' });
    console.log(`[Puppeteer] agregarArticuloACliente goto time: ${Date.now() - t0}ms`);

    // 3. REGENERAR FORMULARIO E INYECTAR DATOS (CRÍTICO)
    // El HTML tiene un script que borra la fila al cargar. Debemos recrearla.
    await page.evaluate((uuidVal, catVal, snVal, macVal) => {
        // A. REGENERAR LA FILA (Simulamos lo que hace el autocomplete al seleccionar)
        // Usamos jQuery porque la página lo usa para gestionar el formset
        // @ts-ignore
        if (typeof $ !== 'undefined') {
             // @ts-ignore
             $(".add-row").click(); 
        } else {
             // Fallback nativo por si acaso
             const addBtn = document.querySelector('.add-row') as HTMLElement;
             if(addBtn) addBtn.click();
        }

        // B. ESPERAR UN MICRO-MOMENTO Y LLENAR (Por si la animación tarda)
        // Helper para setear valor y disparar eventos
        const setVal = (selector: string, val: string) => {
            // Buscamos el ÚLTIMO elemento creado (en caso de que haya multiples form-X)
            // Como limpiamos, debería ser form-0, pero por seguridad usamos el ID directo si existe
            const el = document.querySelector(selector) as HTMLInputElement;
            if (el) {
                el.value = val;
                el.dispatchEvent(new Event('change', { bubbles: true }));
                el.dispatchEvent(new Event('input', { bubbles: true }));
            }
        };

        // Inputs Ocultos
        setVal('#id_form-0-uuid', uuidVal);
        setVal('#id_form-0-categoria', catVal);

        // Inputs Visibles
        setVal('#id_form-0-num_serie', snVal);
        setVal('#id_form-0-mac', macVal);
        setVal('#id_form-0-cantidad', '1');
        setVal('#id_form-0-accion_equipo', '0'); // 0=No copiar MAC

        // C. FORZAR CONTADOR DE FORMULARIOS
        const totalForms = document.querySelector('#id_form-TOTAL_FORMS') as HTMLInputElement;
        if(totalForms) totalForms.value = '1';

        // Actualizar visualmente la etiqueta (opcional, para debug visual en browserless)
        const label = document.querySelector('.label-item');
        if(label) label.textContent = `Asignado: ${snVal}`;

    }, uuid, cat, numSerie, finalMac);

    // 4. GUARDAR
    // Intentar múltiples selectores comunes para el botón de guardar
    const submitSelectors = ['#submit-button', 'button[type="submit"]', 'input[type="submit"]', '.btn-primary', 'a.btn.btn-primary', '.submit-button'];
    let submitHandle = null;
    for (const sel of submitSelectors) {
      submitHandle = await page.$(sel);
      if (submitHandle) {
        console.log(`[Puppeteer] Usando selector de submit: ${sel}`);
        break;
      }
    }

    if (submitHandle) {
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle2' }),
        submitHandle.click()
      ]);
    } else if (await page.$('form')) {
      // Fallback: enviar el primer formulario de la página
      console.log('[Puppeteer] Submit no encontrado; enviando formulario vía DOM.submit()');
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle2' }),
        page.evaluate(() => {
          const f = document.querySelector('form') as HTMLFormElement | null;
          if (f) f.submit();
        })
      ]);
    } else {
      // Último recurso: buscar botón por texto y hacer click
      const clicked = await page.evaluate(() => {
        const candidates = Array.from(document.querySelectorAll('button, a, input')) as HTMLElement[];
        const re = /guardar|guardar cambios|save|asignar|assign|submit/i;
        for (const el of candidates) {
          const txt = ((el.textContent || '') + ' ' + ((el as HTMLInputElement).value || '')).trim();
          if (re.test(txt)) {
            el.click();
            return true;
          }
        }
        return false;
      });
      if (!clicked) throw new Error('Botón guardar no encontrado');
      await page.waitForNavigation({ waitUntil: 'networkidle2' });
    }

    // 5. VALIDAR
    if (page.url().includes('agregar-articulos')) {
        // Buscar el mensaje de error específico
        const errorText = await page.evaluate(() => {
            return document.querySelector('.errorlist li')?.textContent || 
                   document.querySelector('.alert-danger')?.textContent ||
                   "Error de validación desconocido";
        });
        console.warn(`⚠️ Fallo asignación en Geonet: ${errorText}`);
        return false;
    }

    console.log(`✅ Artículo asignado correctamente.`);
    console.log(`[Puppeteer] agregarArticuloACliente tiempo total: ${Date.now() - start}ms`);
    return true;

  } catch (error: any) {
    console.error(`Error agregarArticuloACliente: ${error.message}`);
    return false;
  } finally {
    await page.close();
    await browser.disconnect();
  }
}
export async function getWifiProductUuidBySerial(serial: string): Promise<string | null> {
  const start = Date.now();
  const browser = await getBrowser();
  const page = await browser.newPage();
    try {
        if (!await ensureSession(page)) return null;

        // Usamos el buscador de Geonet
    const t0 = Date.now();
    await page.goto(`${GEONET_BASE_URL}/productos-wifi/?q=${serial}`, { waitUntil: 'domcontentloaded' });
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
  const browser = await getBrowser();
  const page = await browser.newPage();
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

// --- SUBIDA DE ARCHIVOS ---

export async function uploadDocumentoCliente(
  clienteId: number | string,
  clienteUsuario: string,
  filePath: string,
  titulo?: string,
  descripcion: string = 'Carga automática via Bot',
  visible: boolean = true
): Promise<boolean> {
  const browser = await getBrowser();
  const page = await browser.newPage();
  
  // Normalizar ruta (Es vital para Docker)
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
    console.error(`❌ Archivo no encontrado: ${systemPath}`);
    return false;
  }

  try {
    if (!await ensureSession(page)) return false;

    const url = `${GEONET_BASE_URL}/clientes/agregar-documento/${clienteUsuario}/`;
    await page.goto(url, { waitUntil: 'networkidle2' });

    await page.type('input[name="titulo"]', titulo || path.basename(systemPath));
    await page.type('textarea[name="descripcion"]', descripcion);
    
    const chk = await page.$('input[name="visible"]');
    if (chk) {
        const isChecked = await (await chk.getProperty('checked')).jsonValue();
        if (visible && !isChecked) await chk.click();
        if (!visible && isChecked) await chk.click();
    }

    // Puppeteer maneja la subida remota mágicamente
    const inputUpload = await page.$('input[type="file"]');
    if (inputUpload) {
        await inputUpload.uploadFile(systemPath);
    } else {
        console.error('No input file found');
        return false;
    }

    const submitBtn = await page.$('button[type="submit"]') || await page.$('input[type="submit"]');
    if (submitBtn) {
        await Promise.all([
            page.waitForNavigation({ waitUntil: 'networkidle2' }),
            submitBtn.click()
        ]);
        console.log('✅ Documento subido.');
        return true;
    }
    return false;

  } catch (error: any) {
    console.error(`Error upload: ${error.message}`);
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