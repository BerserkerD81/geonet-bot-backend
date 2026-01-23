import { setTimeout } from 'timers';
let scheduled = false;
let timer: NodeJS.Timeout | null = null;

export function scheduleSyncRawToColumns(delayMs = 5000) {
  if (scheduled) return;
  scheduled = true;
  if (timer) clearTimeout(timer);
  timer = setTimeout(async () => {
    try {
      // import dynamically to avoid circular deps at boot
      const mod = await import('../scripts/syncRawToColumns');
      if (mod && typeof mod.default === 'function') {
        await mod.default();
      }
    } catch (e) {
      // ignore errors; will try again on next schedule
      console.error('syncRawToColumns failed', e);
    } finally {
      scheduled = false;
      timer = null;
    }
  }, delayMs);
}

export default { scheduleSyncRawToColumns };
