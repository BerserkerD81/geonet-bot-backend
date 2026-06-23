import { getGenieDeviceId, setGenieWifi } from './genieacsClient';

// Primeros 18 intentos cada 10s (~3 min), luego cada 30s hasta completar ~5 min total
const FAST_INTERVAL_MS  = 10_000;
const FAST_ATTEMPTS     = 18;
const SLOW_INTERVAL_MS  = 30_000;
const MAX_ATTEMPTS      = 28; // 18×10s + 10×30s = 3min + 5min ≈ 8 min total

interface WifiTask {
  sn: string;
  ssid: string;
  pass: string;
  resolvedIp: string | null;
  attempts: number;
  status: 'pending' | 'success' | 'failed';
  results: string[];
  createdAt: number;
  timer?: NodeJS.Timeout;
}

const tasks = new Map<string, WifiTask>();

export function getWifiTask(sn: string): Omit<WifiTask, 'timer'> | undefined {
  const t = tasks.get(sn.toUpperCase());
  if (!t) return undefined;
  const { timer: _, ...rest } = t;
  return rest;
}

export async function enqueueWifiTask(
  sn: string,
  ssid: string,
  pass: string,
  resolvedIp: string | null,
): Promise<void> {
  const key = sn.toUpperCase();

  const existing = tasks.get(key);
  if (existing?.timer) clearTimeout(existing.timer);

  const task: WifiTask = {
    sn: key, ssid, pass, resolvedIp,
    attempts: 0,
    status: 'pending',
    results: [],
    createdAt: Date.now(),
  };
  tasks.set(key, task);

  console.log(`[wifiTask] Tarea encolada SN=${key} ssid="${ssid}" — polling cada 10s`);
  scheduleRetry(key);
}

function intervalForAttempt(attempt: number): number {
  return attempt <= FAST_ATTEMPTS ? FAST_INTERVAL_MS : SLOW_INTERVAL_MS;
}

function scheduleRetry(key: string): void {
  const task = tasks.get(key);
  if (!task || task.status !== 'pending') return;

  const delay = intervalForAttempt(task.attempts + 1);
  task.timer = setTimeout(async () => {
    const t = tasks.get(key);
    if (!t || t.status !== 'pending') return;

    t.attempts += 1;
    console.log(`[wifiTask] Intento ${t.attempts}/${MAX_ATTEMPTS} (${delay / 1000}s) SN=${key}`);

    try {
      const deviceId = await getGenieDeviceId(t.resolvedIp);
      if (!deviceId) {
        if (t.attempts >= MAX_ATTEMPTS) {
          t.status = 'failed';
          t.results.push('❌ Se agotaron los intentos. Configura WiFi manualmente desde WifiWizard.');
          console.warn(`[wifiTask] Expirada SN=${key}`);
        } else {
          scheduleRetry(key);
        }
        return;
      }

      const genieResult = await setGenieWifi(deviceId, t.ssid, t.pass);
      t.status = 'success';
      if (genieResult?._queued) {
        t.results.push(`✅ Tarea WiFi guardada en GenieACS (intento ${t.attempts}, ~${Math.round((Date.now() - t.createdAt) / 1000)}s) — se aplicará en la próxima sesión TR069`);
      } else {
        t.results.push(`✅ WiFi configurado en intento ${t.attempts} (~${Math.round((Date.now() - t.createdAt) / 1000)}s)`);
      }
      t.results.push(`📶 2.4GHz: "${t.ssid}" | 5GHz: "${t.ssid}_5G"`);
      console.log(`[wifiTask] Éxito SN=${key} intento=${t.attempts}`);
    } catch (e: any) {
      console.warn(`[wifiTask] Intento ${t.attempts} error: ${e?.message}`);
      if (t.attempts >= MAX_ATTEMPTS) {
        t.status = 'failed';
        t.results.push('❌ Se agotaron los intentos. Configura WiFi manualmente desde WifiWizard.');
      } else {
        scheduleRetry(key);
      }
    }
  }, delay);
}
