import { AppDataSource } from '../datasource';
import { User } from '../models/User';

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
