import { AppDataSource } from '../datasource';
import { ChatMessage } from '../models/ChatMessage';
import fs from 'fs';
import path from 'path';

export async function addMessage(req: any, res: any) {
  const session = req.session as any;
  const userId = session?.userId;
  if (!userId) return res.status(401).json({ error: 'unauthenticated' });

  const { role, content, imageDataUrl } = req.body as {
    role?: 'user' | 'assistant';
    content?: string;
    imageDataUrl?: string;
  };

  if (!role) return res.status(400).json({ error: 'role required' });
  if (!content && !imageDataUrl) {
    return res.status(400).json({ error: 'content or imageDataUrl required' });
  }

  const repo = AppDataSource.getRepository(ChatMessage);
  let imageUrl: string | null = null;

  if (imageDataUrl && typeof imageDataUrl === 'string') {
    try {
      const matches = imageDataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
      if (matches) {
        const mimeType = matches[1];
        const base64Data = matches[2];

        const ext = mimeType.split('/')[1] || 'png';
        const fileName = `chat_${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`;
        const uploadDir = path.join(process.cwd(), 'uploads', 'chat');

        fs.mkdirSync(uploadDir, { recursive: true });
        const filePath = path.join(uploadDir, fileName);
        fs.writeFileSync(filePath, Buffer.from(base64Data, 'base64'));

        imageUrl = `/uploads/chat/${fileName}`;
      }
    } catch (err) {
      console.error('Failed to store chat image', err);
    }
  }

  const message = repo.create({
    userId: Number(userId),
    role,
    content: content ?? (imageUrl ? '[Imagen enviada]' : ''),
    imageUrl: imageUrl ?? undefined,
  });
  await repo.save(message);

  return res.json({ ok: true, id: message.id, createdAt: message.createdAt, imageUrl: message.imageUrl });
}

export async function listUserMessages(req: any, res: any) {
  const { userId } = req.params;
  if (!userId) return res.status(400).json({ error: 'userId required' });

  const repo = AppDataSource.getRepository(ChatMessage);
  const messages = await repo.find({
    where: { userId: Number(userId) },
    order: { createdAt: 'ASC' },
  });

  return res.json({ messages });
}
