import { Request, Response } from 'express';
import { AppDataSource } from '../datasource';
import { N8N } from '../config';
import { ChatMessage } from '../models/ChatMessage';

export async function listUserMessages(req: Request, res: Response) {
  const { userId } = req.params;
  if (!userId) return res.status(400).json({ error: 'userId required' });

  const repo = AppDataSource.getRepository(ChatMessage);
  const messages = await repo.find({ where: { userId: Number(userId) }, order: { createdAt: 'ASC' } });
  return res.json({ messages });
}

// Optional: webhook to save chat messages from n8n
export async function saveMessage(req: Request, res: Response) {
  const { userId, role, content, imageUrl, actions, metadata } = req.body || {};
  if (!userId || !role) return res.status(400).json({ error: 'userId and role required' });

  // Allow either session auth or N8N token header
  const hasSession = !!(req.session as any)?.userId;
  const xToken = (req.headers['x-n8n-token'] || req.headers['x-token'] || '') as string;
  const hasToken = !!(N8N.saveToken && xToken && xToken === N8N.saveToken);
  if (!hasSession && !hasToken) return res.status(401).json({ error: 'unauthorized' });

  const repo = AppDataSource.getRepository(ChatMessage);
  const incomingSessionId = (req.body && (req.body.sessionId || req.body.key)) || (req.headers['key'] as string) || (req.headers['x-session-id'] as string) || undefined;
  const mergedMetadata = (() => {
    const m = metadata && typeof metadata === 'object' ? { ...metadata } : {};
    if (incomingSessionId) m.sessionId = String(incomingSessionId);
    return Object.keys(m).length ? m : undefined;
  })();

  const msg = repo.create({
    userId: Number(userId),
    role: role === 'assistant' ? 'assistant' : 'user',
    content: typeof content === 'string' ? content : '',
    imageUrl: typeof imageUrl === 'string' ? imageUrl : undefined,
    actions: Array.isArray(actions) ? actions : undefined,
    metadata: mergedMetadata,
  });
  await repo.save(msg);
  return res.json({ ok: true, id: msg.id, createdAt: msg.createdAt });
}
