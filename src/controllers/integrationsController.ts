import { Request, Response } from 'express';
import axios from 'axios';
import { checkHealth, getLastFullSyncAt } from '../services/wisphubClient';
import { SMARTOLT } from '../config';
// syncRawToColumns endpoint removed; keep startup auto-sync only

export async function getStatus(req: Request, res: Response) {
  const wisphub = await checkHealth();

  let smartolt: { ok: boolean; latencyMs?: number; error?: string } = { ok: false };
  if (SMARTOLT.baseUrl) {
    const start = Date.now();
    try {
      await axios.get(SMARTOLT.baseUrl, { timeout: 5000, headers: SMARTOLT.apiKey ? { Authorization: SMARTOLT.apiKey } : undefined });
      smartolt = { ok: true, latencyMs: Date.now() - start };
    } catch (err: any) {
      smartolt = { ok: false, latencyMs: Date.now() - start, error: err?.message || 'SmartOLT unreachable' };
    }
  } else {
    smartolt = { ok: false, error: 'SMARTOLT_BASE_URL not configured' };
  }

  return res.json({
    wisphub: { ...wisphub },
    smartolt,
    meta: {
      wisphubLastFullSyncAt: getLastFullSyncAt() || null
    }
  });
}

