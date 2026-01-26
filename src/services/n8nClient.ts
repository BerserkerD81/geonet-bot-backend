import axios from 'axios';
import { N8N } from '../config';

export type N8NChatInput = {
  userId: number;
  content?: string;
  imageUrl?: string | null;
  // optional: last messages or extra context
  messages?: Array<{ role: 'user' | 'assistant'; content?: string; imageUrl?: string | null }>;
  metadata?: Record<string, any>;
  // optional session id to keep context across messages in n8n
  sessionId?: string;
};

export type N8NChatOutput = {
  content: string;
  actions?: any[];
  metadata?: Record<string, any> | null;
};

export async function runChatWorkflow(input: N8NChatInput): Promise<N8NChatOutput> {
  const url = N8N.chatWebhook || (N8N.baseUrl ? `${N8N.baseUrl.replace(/\/$/, '')}/webhook/chat` : '');
  if (!url) throw new Error('N8N_CHAT_WEBHOOK_URL or N8N_BASE_URL not configured');

  const payload = {
    userId: input.userId,
    content: input.content ?? '',
    imageUrl: input.imageUrl ?? null,
    messages: input.messages ?? [],
    metadata: input.metadata ?? {},
    // Include sessionId also as 'sessionId' and 'key' for n8n Connected Chat Trigger
    sessionId: input.sessionId ?? undefined,
    key: input.sessionId ?? undefined,
  };

  let res;
  try {
    res = await axios.post(url, payload, {
      timeout: 25000,
      headers: {
        // Provide session id in headers so n8n nodes can read it either from headers or body
        ...(input.sessionId ? { 'X-Session-Id': String(input.sessionId), Key: String(input.sessionId) } : {}),
      },
    });
  } catch (err: any) {
    console.error('[n8n webhook error]', {
      message: err?.message,
      code: err?.code,
      responseStatus: err?.response?.status,
      responseData: err?.response?.data,
    });
    throw err;
  }

  // Expected shape: { content: string, actions?: [...], metadata?: {...} }
  const data = res.data || {};
  console.log('[n8n webhook response]', data);
  const content = typeof data.content === 'string' ? data.content : JSON.stringify(data);
  const actions = Array.isArray(data.actions) ? data.actions : [];
  const metadata = data.metadata ?? null;
  return { content, actions, metadata };
}

export default { runChatWorkflow };
