import { AppDataSource } from '../datasource';
import { SmartoltOnuSnapshot } from '../models/SmartoltOnuSnapshot';
import { SmartoltOnuDetail } from '../models/SmartoltOnuDetail';
import { getAllOnusDetailsRaw } from './smartoltClient';

export async function captureSmartoltOnuSnapshot() {
  const repo = AppDataSource.getRepository(SmartoltOnuSnapshot);
  const detailRepo = AppDataSource.getRepository(SmartoltOnuDetail);
  const raw = await getAllOnusDetailsRaw();
  const extractArray = (input: any): any[] => {
    if (Array.isArray(input)) return input;
    if (!input || typeof input !== 'object') return [];
    if (Array.isArray(input.response)) return input.response;
    if (Array.isArray(input.data)) return input.data;
    if (Array.isArray(input.response?.data)) return input.response.data;
    if (Array.isArray(input.response?.response)) return input.response.response;

    const values = Object.values(input);
    for (const v of values) {
      if (Array.isArray(v)) return v;
      if (v && typeof v === 'object') {
        const nested = extractArray(v);
        if (nested.length) return nested;
      }
    }
    return [];
  };

  let data = extractArray(raw);
  if (!data.length && raw && typeof raw === 'object') {
    try {
      console.warn('⚠️ SmartOLT ONU snapshot sin datos. raw keys:', Object.keys(raw));
    } catch {}
  }

  const capturedAt = new Date();
  let savedCount = 0;
  if (Array.isArray(data) && data.length) {
    for (const item of data) {
      try {
        const uniqueId = item?.unique_external_id || item?.onu_external_id || item?.external_id || null;
        const sn = item?.sn || item?.serial || item?.onu_sn || null;
        const ip = item?.ip_address || item?.address || item?.wan_ip || item?.ip || null;

        // Try to find an existing detail row and update it instead of creating duplicates
        let existing: any = null;
        try {
          if (uniqueId) existing = await detailRepo.findOne({ where: { uniqueExternalId: uniqueId } });
          if (!existing && sn) existing = await detailRepo.findOne({ where: { sn: sn } });
        } catch (e) {
          // ignore find errors, we'll create a new row below
        }

        if (existing) {
          existing.capturedAt = capturedAt;
          existing.sn = sn || existing.sn;
          existing.ipAddress = ip || existing.ipAddress;
          existing.name = item?.name || existing.name;
          existing.payload = item;
          await detailRepo.save(existing);
        } else {
          const row = detailRepo.create({
            capturedAt,
            uniqueExternalId: uniqueId,
            sn: sn,
            ipAddress: ip,
            name: item?.name || null,
            payload: item
          });
          await detailRepo.save(row);
        }

        savedCount++;
      } catch (e) {
        console.error('SmartOLT ONU detail save failed:', e);
      }
    }
  }

  // Prepare snapshot payload but avoid storing huge payloads in DB every run
  let payloadStr: string | null = null;
  try {
    payloadStr = Array.isArray(data) && data.length ? JSON.stringify(data) : null;
  } catch (e) {
    payloadStr = null;
  }

  // Upsert behavior: update latest snapshot if it's recent (within 24h), otherwise create new
  const latest = await repo.findOne({ order: { capturedAt: 'DESC' } });
  const maxSize = 200000; // bytes threshold to avoid huge DB fields
  const payloadToStore = payloadStr && payloadStr.length <= maxSize ? payloadStr : null;
  if (payloadStr && !payloadToStore) {
    console.warn('⚠️ Snapshot payload too large, storing without full payload. size=', payloadStr.length);
  }

  if (latest && latest.capturedAt && (Date.now() - new Date(latest.capturedAt).getTime()) < 1000 * 60 * 60 * 24) {
    // update latest snapshot
    latest.capturedAt = capturedAt;
    latest.count = Array.isArray(data) ? data.length : 0;
    latest.payload = payloadToStore;
    await repo.save(latest);
    console.log(`🧾 SmartOLT ONU snapshot actualizado: ${latest.count} registros. Detalles actualizados: ${savedCount}.`);
  } else {
    const snapshot = repo.create({
      capturedAt,
      count: Array.isArray(data) ? data.length : 0,
      payload: payloadToStore
    });
    await repo.save(snapshot);
    console.log(`🧾 SmartOLT ONU snapshot guardado: ${snapshot.count} registros. Detalles guardados: ${savedCount}.`);
  }
  if (!Array.isArray(data) || !data.length) {
    console.warn('⚠️ SmartOLT ONU snapshot vacío. response_code:', (raw as any)?.response_code, 'status:', (raw as any)?.status);
  }
}

export async function getLatestSmartoltOnuSnapshot() {
  const repo = AppDataSource.getRepository(SmartoltOnuSnapshot);
  const latest = await repo.findOne({ order: { capturedAt: 'DESC' } });
  return latest;
}

function scheduleDailyRun(runAtHour = 3, runAtMinute = 15, job: () => Promise<void>) {
  const scheduleNext = () => {
    const now = new Date();
    const next = new Date();
    next.setHours(runAtHour, runAtMinute, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    const delay = next.getTime() - now.getTime();
    setTimeout(async () => {
      try {
        await job();
      } catch (err) {
        console.error('SmartOLT ONU snapshot job failed:', err);
      } finally {
        scheduleNext();
      }
    }, delay);
  };

  scheduleNext();
}

export function scheduleSmartoltOnuSnapshots() {
  // Run once at startup only
  captureSmartoltOnuSnapshot().catch((e) => console.error('Initial SmartOLT ONU snapshot failed:', e));

  // Then run daily (cron-like schedule)
  scheduleDailyRun(3, 15, captureSmartoltOnuSnapshot);
}

export default { scheduleSmartoltOnuSnapshots, captureSmartoltOnuSnapshot };
