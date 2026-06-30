// Cloud-friendly replacement for the original ollama.ts.
//
//  - Chat:       Groq (free, hosted, OpenAI-compatible /chat/completions API)
//  - Embeddings: @xenova/transformers, running locally inside the server
//                process. No API key, no external service, free forever.
//                Model weights are downloaded once and cached on disk.

import { pipeline, type FeatureExtractionPipeline } from '@xenova/transformers';

const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
const GROQ_BASE_URL = 'https://api.groq.com/openai/v1';
const CHAT_MODEL = process.env.GROQ_CHAT_MODEL || 'llama-3.1-8b-instant';
const EMBEDDING_MODEL = 'Xenova/all-MiniLM-L6-v2';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** Small retry helper for transient network/5xx errors. */
async function withRetry<T>(fn: () => Promise<T>, attempts = 3, baseDelayMs = 500): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) {
        await new Promise((r) => setTimeout(r, baseDelayMs * 2 ** i));
      }
    }
  }
  throw lastErr;
}

// The feature-extraction pipeline is expensive to create, so we build it
// once per server process and reuse it across requests.
let embedderPromise: Promise<FeatureExtractionPipeline> | null = null;
function getEmbedder(): Promise<FeatureExtractionPipeline> {
  if (!embedderPromise) {
    embedderPromise = pipeline('feature-extraction', EMBEDDING_MODEL) as Promise<FeatureExtractionPipeline>;
  }
  return embedderPromise;
}

export async function embed(text: string): Promise<number[]> {
  const embedder = await getEmbedder();
  const output = await embedder(text, { pooling: 'mean', normalize: true });
  return Array.from(output.data as Float32Array);
}

/** Streams assistant text chunks as they arrive from Groq's chat completions API. */
export async function* streamChat(messages: ChatMessage[]): AsyncGenerator<string> {
  if (!GROQ_API_KEY) {
    throw new Error(
      'GROQ_API_KEY is not set. Get a free key at https://console.groq.com/keys and add it to your environment variables.',
    );
  }

  const res = await withRetry(() =>
    fetch(`${GROQ_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${GROQ_API_KEY}`,
      },
      body: JSON.stringify({ model: CHAT_MODEL, messages, stream: true }),
    }),
  );

  if (!res.ok || !res.body) {
    throw new Error(`Groq chat failed (${res.status}): ${await res.text().catch(() => '')}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split('\n');
    buffer = lines.pop() || ''; // keep the last (possibly incomplete) line

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice('data:'.length).trim();
      if (payload === '[DONE]') return;
      if (!payload) continue;

      const json = JSON.parse(payload) as {
        choices?: { delta?: { content?: string }; finish_reason?: string | null }[];
      };
      const token = json.choices?.[0]?.delta?.content;
      if (token) yield token;
    }
  }
}

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
