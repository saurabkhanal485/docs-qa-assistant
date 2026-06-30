import { NextRequest } from 'next/server';
import { retrieve, formatContext, RetrievedChunk } from '@/lib/retrieval';
import { streamChat, ChatMessage } from '@/lib/ai';

export const runtime = 'nodejs';
export const maxDuration = 60;

// Only chunks scoring above this are considered "relevant"
const MIN_SCORE = parseFloat(process.env.MIN_RETRIEVAL_SCORE || '0.65');

// If the single best chunk doesn't hit this, it's definitely off-topic
const MIN_TOP_SCORE = parseFloat(process.env.MIN_TOP_RETRIEVAL_SCORE || '0.60');

export interface Citation {
  index: number;
  title: string | null;
  url: string;
}

const REFUSAL_TEXT =
  "I can only answer questions about FastAPI based on its official documentation. " +
  "This question isn't covered in the FastAPI docs. " +
  "Please visit https://fastapi.tiangolo.com for the full documentation.";

function buildSystemPrompt(context: string): string {
  return `You are a documentation assistant for FastAPI (the Python web framework).
Answer using ONLY the numbered excerpts below. Cite sources inline like [1] or [2].
If the excerpts don't contain the answer, say you couldn't find it in the FastAPI docs.
Do NOT use any outside knowledge.

FastAPI documentation excerpts:
${context}`;
}

function makeRefusalStream(): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(JSON.stringify({ token: REFUSAL_TEXT }) + '\n'));
      controller.enqueue(encoder.encode(JSON.stringify({ citations: [] }) + '\n'));
      controller.enqueue(encoder.encode(JSON.stringify({ done: true }) + '\n'));
      controller.close();
    },
  });
  return new Response(stream, {
    headers: { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-cache' },
  });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as {
      messages: { role: 'user' | 'assistant'; content: string }[];
    };

    const messages = body.messages ?? [];
    const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user');
    if (!lastUserMsg) {
      return new Response(JSON.stringify({ error: 'No user message found' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // M2: Retrieve top-K chunks
    const chunks: RetrievedChunk[] = await retrieve(lastUserMsg.content);

    // Gate 1: best single chunk must clear MIN_TOP_SCORE
    const topScore = chunks[0]?.score ?? 0;
    if (topScore < MIN_TOP_SCORE) {
      return makeRefusalStream();
    }

    // Gate 2: only keep chunks above MIN_SCORE
    const relevantChunks = chunks.filter((c) => c.score >= MIN_SCORE);
    if (relevantChunks.length === 0) {
      return makeRefusalStream();
    }

    // Build context and citations
    const context = formatContext(relevantChunks);
    const seen = new Set<string>();
    const citations: Citation[] = [];
    relevantChunks.forEach((c, i) => {
      if (!seen.has(c.source_url)) {
        seen.add(c.source_url);
        citations.push({ index: i + 1, title: c.source_title, url: c.source_url });
      }
    });

    // M3: Stream LLM response
    const systemPrompt = buildSystemPrompt(context);
    const ollamaMessages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      ...messages.slice(-6).map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      })),
    ];

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        try {
          for await (const token of streamChat(ollamaMessages)) {
            controller.enqueue(encoder.encode(JSON.stringify({ token }) + '\n'));
          }
          controller.enqueue(encoder.encode(JSON.stringify({ citations }) + '\n'));
          controller.enqueue(encoder.encode(JSON.stringify({ done: true }) + '\n'));
        } catch (err) {
          controller.enqueue(
            encoder.encode(JSON.stringify({ error: (err as Error).message }) + '\n'),
          );
        } finally {
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'application/x-ndjson',
        'Transfer-Encoding': 'chunked',
        'Cache-Control': 'no-cache',
        'X-Accel-Buffering': 'no',
      },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}