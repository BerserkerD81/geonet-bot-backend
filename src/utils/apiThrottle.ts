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

const throttledInstances = new WeakSet<AxiosInstance>();

export function ensureRequestDelay(instance: AxiosInstance, minMs = DEFAULT_MIN_DELAY_MS, maxMs = DEFAULT_MAX_DELAY_MS): void {
  if (!instance || throttledInstances.has(instance)) return;
  instance.interceptors.request.use(async (config) => {
    await waitRandomDelay(minMs, maxMs);
    return config;
  });
  throttledInstances.add(instance);
}
