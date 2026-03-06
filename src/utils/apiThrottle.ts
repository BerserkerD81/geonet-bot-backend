import type { AxiosInstance } from 'axios';

const DEFAULT_MIN_DELAY_MS = 300;
const DEFAULT_MAX_DELAY_MS = 650;

export async function waitRandomDelay(minMs = DEFAULT_MIN_DELAY_MS, maxMs = DEFAULT_MAX_DELAY_MS): Promise<void> {
  const min = Number.isFinite(minMs) ? Math.max(0, Math.floor(minMs)) : DEFAULT_MIN_DELAY_MS;
  const max = Number.isFinite(maxMs) ? Math.max(0, Math.floor(maxMs)) : DEFAULT_MAX_DELAY_MS;
  const low = Math.min(min, max);
  const high = Math.max(min, max);
  const span = high - low;
  const delay = span > 0 ? low + Math.floor(Math.random() * (span + 1)) : low;

  if (delay > 0) console.log(`[apiThrottle] waiting ${delay}ms (range ${low}-${high})`);

  await new Promise((resolve) => {
    setTimeout(resolve, delay);
  });
}

// ── Cola global que serializa TODAS las peticiones a una instancia Axios ──
// Garantiza que solo haya 1 request en vuelo a la vez, evitando ráfagas
// simultáneas que disparan rate-limits en SmartOLT.
type QueueItem = { resolve: (v: any) => void; reject: (e: any) => void; fn: () => Promise<any> };
const instanceQueues = new WeakMap<AxiosInstance, QueueItem[]>();
const instanceProcessing = new WeakMap<AxiosInstance, boolean>();

async function processQueue(instance: AxiosInstance) {
  if (instanceProcessing.get(instance)) return;
  instanceProcessing.set(instance, true);
  const queue = instanceQueues.get(instance)!;
  while (queue.length > 0) {
    const item = queue.shift()!;
    try {
      const result = await item.fn();
      item.resolve(result);
    } catch (err) {
      item.reject(err);
    }
  }
  instanceProcessing.set(instance, false);
}

export function enqueueRequest<T>(instance: AxiosInstance, fn: () => Promise<T>): Promise<T> {
  if (!instanceQueues.has(instance)) instanceQueues.set(instance, []);
  return new Promise<T>((resolve, reject) => {
    instanceQueues.get(instance)!.push({ resolve, reject, fn });
    processQueue(instance);
  });
}

const throttledInstances = new WeakSet<AxiosInstance>();

export function ensureRequestDelay(instance: AxiosInstance, minMs = DEFAULT_MIN_DELAY_MS, maxMs = DEFAULT_MAX_DELAY_MS): void {
  if (!instance || throttledInstances.has(instance)) return;
  instance.interceptors.request.use(async (config) => {
    await waitRandomDelay(minMs, maxMs);
    return config;
  });
  throttledInstances.add(instance);
}
