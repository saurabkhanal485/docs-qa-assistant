import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), 'data', 'docs.db');

// Make sure the data/ folder exists before SQLite tries to create the file in it
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// One row per chunk. `embedding` is stored as a JSON-encoded float array —
// this is the "vector" half of "vector + metadata" from the architecture doc.
// `source_url`, `source_title`, and `section` are the metadata half, and are
// what let us turn a retrieved chunk into a clickable citation later.
db.exec(`
  CREATE TABLE IF NOT EXISTS chunks (
    id            TEXT PRIMARY KEY,
    content       TEXT NOT NULL,
    embedding     TEXT NOT NULL,
    source_url    TEXT NOT NULL,
    source_title  TEXT,
    section       TEXT,
    chunk_index   INTEGER NOT NULL,
    token_count   INTEGER NOT NULL,
    created_at    TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_chunks_source ON chunks(source_url);
`);

export interface ChunkRow {
  id: string;
  content: string;
  embedding: string; // JSON-encoded number[]
  source_url: string;
  source_title: string | null;
  section: string | null;
  chunk_index: number;
  token_count: number;
}

export function getChunkCount(): number {
  const row = db.prepare('SELECT COUNT(*) as count FROM chunks').get() as { count: number };
  return row.count;
}

export function getAllChunks(): ChunkRow[] {
  return db.prepare('SELECT * FROM chunks').all() as ChunkRow[];
}

export function clearChunks(): void {
  db.exec('DELETE FROM chunks');
}

export function insertChunk(row: Omit<ChunkRow, 'embedding'> & { embedding: number[] }): void {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO chunks (id, content, embedding, source_url, source_title, section, chunk_index, token_count)
    VALUES (@id, @content, @embedding, @source_url, @source_title, @section, @chunk_index, @token_count)
  `);
  stmt.run({ ...row, embedding: JSON.stringify(row.embedding) });
}
