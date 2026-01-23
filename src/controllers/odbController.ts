import { Request, Response } from 'express';
import { getAvailablePortsForOdb } from '../services/smartoltClient';

// Normalize SmartOLT responses into a simple list of *available* port identifiers
function normalizePorts(raw: any): string[] {
  const pickNumeric = (arr: any[]) =>
    arr
      .map((p) => {
        if (p === null || p === undefined) return null;
        if (typeof p === 'object') {
          const val = p.port ?? p.id ?? p.value ?? p.label ?? p.name ?? p.number;
          return val !== undefined && val !== null ? String(val) : null;
        }
        return String(p);
      })
      .filter((p): p is string => !!p && p.trim() !== '')
      .map((p) => p.trim())
      .filter((p, idx, arr) => arr.indexOf(p) === idx);

  if (Array.isArray(raw?.ports)) return pickNumeric(raw.ports);
  if (Array.isArray(raw?.response)) return pickNumeric(raw.response);
  if (Array.isArray(raw?.available_ports)) return pickNumeric(raw.available_ports);
  if (Array.isArray(raw)) return pickNumeric(raw);

  if (raw && typeof raw === 'object') {
    const values = pickNumeric(Object.values(raw));
    if (values.length) return values;
    const keys = pickNumeric(Object.keys(raw));
    if (keys.length) return keys;
  }

  return [];
}

const FALLBACK_PORTS = Array.from({ length: 16 }, (_, i) => String(i + 1));

export async function getOdbAvailablePorts(req: Request, res: Response) {
  try {
    const { externalId } = req.params;
    if (!externalId) return res.status(400).json({ error: 'externalId is required' });
    const rawPorts = await getAvailablePortsForOdb(externalId);
    const ports = normalizePorts(rawPorts);
    if (ports.length === 0) {
      return res.status(404).json({ ok: false, error: 'No hay puertos disponibles para esta ODB', ports: [] });
    }
    return res.json({ ok: true, ports });
  } catch (err: any) {
    const status = err?.response?.status;
    const msg = err?.response?.data || { error: err?.message || 'Failed to fetch available ports for ODB' };
    console.error('getOdbAvailablePorts failed', { externalId: req.params?.externalId, status, msg });
    if (status === 403) {
      return res.status(403).json({ ok: false, error: 'SmartOLT forbidden', ports: [] });
    }
    // Provide fallback only for generic errors, not for auth issues
    return res.status(500).json({ ok: false, ports: FALLBACK_PORTS, ...msg });
  }
}
