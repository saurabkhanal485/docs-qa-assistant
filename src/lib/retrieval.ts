/**
 * M2 — Retrieval
 *
 * Given a plain-text query, this module:
 *  1. Embeds it with the same model used during ingestion
 *  2. Scores every stored chunk with cosine similarity
 *  3. Returns the top-K chunks, deduplicated by source URL so the
 *     answer isn't dominated by one very long page
 */

import { getAllChunks, ChunkRow } from './db';
import { embed, cosineSimilarity } from './ai';

const TOP_K = parseInt(process.env.TOP_K || '5', 10);

export interface RetrievedChunk {
  id: string;
  content: string;
  source_url: string;
  source_title: string | null;
  section: string | null;
  chunk_index: number;
  score: number;
}

/**
 * Retrieve the top-K most relevant chunks for `query`.
 *
 * Strategy: brute-force cosine similarity across all stored embeddings.
 * For the FastAPI corpus (~1 000–2 000 chunks) this is fast enough that
 * we don't need an ANN index.  If the corpus grows to tens of thousands
 * of chunks, swap `getAllChunks()` for a vector-index scan in db.ts —
 * nothing else in the pipeline needs to change.
 */
export async function retrieve(query: string, topK = TOP_K): Promise<RetrievedChunk[]> {
  const queryEmbedding = await embed(query);
  const allChunks: ChunkRow[] = getAllChunks();

  if (allChunks.length === 0) {
    return [];
  }

  // Score every chunk
  const scored = allChunks.map((row) => {
    const chunkEmbedding: number[] = JSON.parse(row.embedding);
    return {
      id: row.id,
      content: row.content,
      source_url: row.source_url,
      source_title: row.source_title,
      section: row.section,
      chunk_index: row.chunk_index,
      score: cosineSimilarity(queryEmbedding, chunkEmbedding),
    };
  });

  // Sort descending by score
  scored.sort((a, b) => b.score - a.score);

  // Return top-K (no deduplication needed at this scale; each chunk is
  // already a distinct window; same URL chunks at different positions
  // are fine since they contain different text)
  return scored.slice(0, topK);
}

/**
 * Format retrieved chunks into the context block that goes into the
 * system prompt.  Each chunk is labelled with its source so the LLM
 * can reference it in its answer.
 */
export function formatContext(chunks: RetrievedChunk[]): string {
  if (chunks.length === 0) return '(no relevant documentation found)';

  return chunks
    .map((c, i) => {
      const label = c.source_title || c.source_url;
      return `[${i + 1}] Source: ${label}\nURL: ${c.source_url}\n\n${c.content}`;
    })
    .join('\n\n---\n\n');
}
