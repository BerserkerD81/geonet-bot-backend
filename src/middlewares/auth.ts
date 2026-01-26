import { AppDataSource } from '../datasource';
import { User } from '../models/User';
import { N8N } from '../config';

export function requireAuth(req: any, res: any, next: any) {
  if (req.session && req.session.userId) return next();
  return res.status(401).json({ error: 'unauthenticated' });
}

export function requirePendingOrAuthed(req: any, res: any, next: any) {
  const s = req.session as any;
  if (s?.userId || s?.pendingUserId) return next();
  return res.status(401).json({ error: 'unauthenticated' });
}

export async function requireAdmin(req: any, res: any, next: any) {
  const s = req.session as any;
  if (!s?.userId) return res.status(401).json({ error: 'unauthenticated' });
  const repo = AppDataSource.getRepository(User);
  const user = await repo.findOne({ where: { id: Number(s.userId) } });
  if (!user) return res.status(401).json({ error: 'unauthenticated' });
  if (user.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
  (req as any).currentUser = user;
  return next();
}

// Allows either a logged-in session or a valid API token (for n8n/m2m).
// The token can be provided via 'X-API-Token' or 'X-N8N-Token'.
export function requireSystemOrAuth(req: any, res: any, next: any) {
  const s = req.session as any;
  if (s?.userId) return next();
  const headerToken = (req.get('x-api-token') || req.get('x-n8n-token') || '').trim();
  const expected = (N8N.apiToken || N8N.saveToken || process.env.API_TOKEN || '').trim();
  if (expected && headerToken && headerToken === expected) return next();
  return res.status(401).json({ error: 'unauthenticated' });
}

// Check N8N API Token from environment variables
export function checkN8NApiToken(req: any, res: any, next: any) {
  const headerToken = (req.get('x-api-token') || req.get('x-n8n-token') || '').trim();
  const expected = (N8N.apiToken || N8N.saveToken || process.env.API_TOKEN || '').trim();
  if (!expected) {
    return res.status(500).json({ error: 'Internal server error: API token not configured' });
  }
  if (headerToken !== expected) {
    return res.status(401).json({ error: 'unauthenticated' });
  }
  next();
}
