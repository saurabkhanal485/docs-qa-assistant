import 'dotenv/config';
import { getChunkCount } from '../src/lib/db';

const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
const CHAT_MODEL = process.env.GROQ_CHAT_MODEL || 'llama-3.1-8b-instant';

async function main() {
  console.log('Checking project setup...\n');
  let ok = true;

  // 1. Local "vector database" (SQLite)
  try {
    const count = getChunkCount();
    console.log(`[OK]   SQLite database initialized (${count} chunks stored so far)`);
  } catch (err) {
    ok = false;
    console.error('[FAIL] SQLite database failed to initialize:', err);
  }

  // 2. Groq API key present + reachable
  if (!GROQ_API_KEY) {
    ok = false;
    console.log('[FAIL] GROQ_API_KEY is not set.');
    console.log('       Get a free key at https://console.groq.com/keys and add it to .env.local');
  } else {
    try {
      const res = await fetch('https://api.groq.com/openai/v1/models', {
        headers: { Authorization: `Bearer ${GROQ_API_KEY}` },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
      console.log(`[OK]   Groq API key works (chat model: "${CHAT_MODEL}")`);
    } catch (err) {
      ok = false;
      console.error('[FAIL] Could not reach Groq with this API key:', (err as Error).message);
    }
  }

  // 3. Embedding model (downloads on first use, no key needed)
  try {
    const { embed } = await import('../src/lib/ai');
    await embed('setup check');
    console.log('[OK]   Local embedding model loaded (Xenova/all-MiniLM-L6-v2)');
  } catch (err) {
    ok = false;
    console.error('[FAIL] Could not load the embedding model:', (err as Error).message);
  }

  console.log();
  if (ok) {
    console.log('Setup looks good. Ready for ingestion: npm run ingest');
  } else {
    console.log('Fix the items marked [FAIL] above, then re-run: npm run check-setup');
    process.exit(1);
  }
}

main();
