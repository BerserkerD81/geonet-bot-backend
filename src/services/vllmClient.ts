import axios from 'axios';
import { ensureRequestDelay } from '../utils/apiThrottle';

ensureRequestDelay(axios);

const VLLM_URL = process.env.VLLM_URL || 'http://localhost:8000';

export async function generateCompletion(prompt: string, options: any = {}) {
  const url = `${VLLM_URL}/v1/generate`;
  const payload = {
    prompt,
    ...options
  };

  const res = await axios.post(url, payload, { timeout: 60000 });
  return res.data;
}
