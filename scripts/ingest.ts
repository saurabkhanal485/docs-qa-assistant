/**
 * M1 — Ingestion pipeline
 *
 * Usage:  npm run ingest
 *
 * What it does:
 *  1. Fetches the FastAPI sitemap.xml and extracts page URLs
 *  2. Scrapes each page (HTML → clean plain text, strips nav/footer/code noise)
 *  3. Splits text into overlapping token-window chunks
 *  4. Embeds each chunk with nomic-embed-text via Ollama
 *  5. Upserts every chunk into the local SQLite vector store
 *
 * All tunables live in .env.local / environment variables so nothing
 * is hard-coded here beyond sensible defaults that match .env.example.
 */

import 'dotenv/config';
import crypto from 'crypto';
import { insertChunk, clearChunks, getChunkCount } from '../src/lib/db';
import { embed } from '../src/lib/ai';

// ─── Config ──────────────────────────────────────────────────────────────────

const SITEMAP_URL =
  process.env.CORPUS_SITEMAP_URL || 'https://fastapi.tiangolo.com/sitemap.xml';
const CHUNK_TARGET_TOKENS = parseInt(process.env.CHUNK_TARGET_TOKENS || '650', 10);
const CHUNK_OVERLAP_TOKENS = parseInt(process.env.CHUNK_OVERLAP_TOKENS || '80', 10);
// Rough chars-per-token for English prose (good enough without a real tokeniser)
const CHARS_PER_TOKEN = 4;
const CHUNK_TARGET_CHARS = CHUNK_TARGET_TOKENS * CHARS_PER_TOKEN;
const CHUNK_OVERLAP_CHARS = CHUNK_OVERLAP_TOKENS * CHARS_PER_TOKEN;

// How many pages to embed in parallel (Ollama is CPU-bound, keep this low)
const EMBED_CONCURRENCY = 3;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Pull all <loc> values out of a sitemap XML string. */
function parseSitemap(xml: string): string[] {
  const urls: string[] = [];
  const re = /<loc>\s*(https?:\/\/[^<]+)\s*<\/loc>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    urls.push(m[1].trim());
  }
  return urls;
}

/** Very small HTML → plain-text extractor.
 *  Strips scripts, styles, nav, footer, sidebar, and code blocks (which are
 *  mostly noise for a prose-QA system), then collapses whitespace. */
function htmlToText(html: string, url: string): { text: string; title: string } {
  // Remove entire noisy sections
  let s = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<header[\s\S]*?<\/header>/gi, ' ')
    .replace(/<aside[\s\S]*?<\/aside>/gi, ' ')
    // Keep the text inside <code>/<pre> but strip the tags themselves
    // (short inline code is still useful context; long blocks less so)
    .replace(/<pre[\s\S]*?<\/pre>/gi, ' ')
    .replace(/<[^>]+>/g, ' ') // strip remaining tags
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Extract <title> for metadata
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const rawTitle = titleMatch ? titleMatch[1].replace(/\s+/g, ' ').trim() : url;
  // FastAPI docs titles look like "Foo - FastAPI"; keep only the left part
  const title = rawTitle.split(' - ')[0].trim();

  return { text: s, title };
}

/** Split `text` into overlapping chunks, returning each with its char-index offset. */
function chunkText(text: string): string[] {
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + CHUNK_TARGET_CHARS, text.length);
    const chunk = text.slice(start, end).trim();
    if (chunk.length > 50) chunks.push(chunk); // skip tiny trailing fragments
    if (end >= text.length) break;
    start = end - CHUNK_OVERLAP_CHARS;
  }
  return chunks;
}

/** Deterministic ID so re-running ingest is idempotent (upsert, not duplicate). */
function chunkId(sourceUrl: string, index: number): string {
  return crypto
    .createHash('sha1')
    .update(`${sourceUrl}::${index}`)
    .digest('hex')
    .slice(0, 16);
}

/** Rough token count (good enough without a real tokeniser). */
function approxTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** Fetch with a timeout; returns null on failure so we can skip bad pages. */
async function fetchPage(url: string, timeoutMs = 20_000): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'docs-qa-ingest/1.0 (educational project)' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      console.warn(`  [skip] ${url} — HTTP ${res.status}`);
      return null;
    }
    return await res.text();
  } catch (err) {
    console.warn(`  [skip] ${url} — ${(err as Error).message}`);
    return null;
  }
}

/** Run at most `n` promises at a time from an async producer. */
async function withConcurrency<T>(
  items: T[],
  n: number,
  fn: (item: T, i: number) => Promise<void>,
): Promise<void> {
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: n }, worker));
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== M1 Ingestion pipeline ===\n');

  // 1. Fetch sitemap
  console.log(`Fetching sitemap: ${SITEMAP_URL}`);
  const sitemapRes = await fetch(SITEMAP_URL, { signal: AbortSignal.timeout(15_000) });
  if (!sitemapRes.ok) throw new Error(`Sitemap fetch failed: ${sitemapRes.status}`);
  const sitemapXml = await sitemapRes.text();
  const allUrls = parseSitemap(sitemapXml);
  console.log(`Found ${allUrls.length} URLs in sitemap`);

  // Filter to only English docs pages (skip /de/, /es/, /fr/, etc.)
  const urls = allUrls.filter((u) => {
    const path = new URL(u).pathname;
    // Keep root-level paths and /tutorial/, /advanced/, /deployment/, /how-to/
    // Skip locale sub-paths like /de/ /es/ /fr/ /ja/ /ko/ /pt/ /ru/ /tr/ /uk/ /zh/
    return !/^\/[a-z]{2}\//.test(path);
  });
  console.log(`After filtering to English pages: ${urls.length} URLs\n`);

  // 2. Clear existing chunks so re-runs are clean
  console.log('Clearing existing chunks from DB...');
  clearChunks();

  // 3. Scrape → chunk → embed → store, with bounded concurrency
  let pagesOk = 0;
  let chunksTotal = 0;

  await withConcurrency(urls, EMBED_CONCURRENCY, async (url, urlIdx) => {
    process.stdout.write(`[${urlIdx + 1}/${urls.length}] ${url} ... `);

    const html = await fetchPage(url);
    if (!html) return;

    const { text, title } = htmlToText(html, url);
    if (text.length < 100) {
      console.log('(too short, skipped)');
      return;
    }

    // Detect section from URL path for metadata
    const pathname = new URL(url).pathname;
    const section = pathname.split('/').filter(Boolean)[0] || 'root';

    const rawChunks = chunkText(text);
    if (rawChunks.length === 0) {
      console.log('(no chunks)');
      return;
    }

    // Embed all chunks for this page sequentially (Ollama is single-threaded)
    for (let i = 0; i < rawChunks.length; i++) {
      const content = rawChunks[i];
      const embedding = await embed(content);
      insertChunk({
        id: chunkId(url, i),
        content,
        embedding,
        source_url: url,
        source_title: title,
        section,
        chunk_index: i,
        token_count: approxTokens(content),
      });
    }

    chunksTotal += rawChunks.length;
    pagesOk++;
    console.log(`${rawChunks.length} chunks`);
  });

  console.log('\n=== Done ===');
  console.log(`Pages ingested : ${pagesOk} / ${urls.length}`);
  console.log(`Chunks stored  : ${chunksTotal}`);
  console.log(`DB total       : ${getChunkCount()}`);
  console.log('\nReady for M2 (retrieval). Run: npm run dev');
}

main().catch((err) => {
  console.error('\nFatal error during ingestion:', err);
  process.exit(1);
});
