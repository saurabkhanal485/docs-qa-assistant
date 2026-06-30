# Docs Q&A Assistant

A chat interface that answers questions from a specific body of documents and cites
where each answer came from. When it can't find an answer in the source material, it
says so instead of guessing.

**Corpus:** [FastAPI documentation](https://fastapi.tiangolo.com/) (~100–150 English pages)

## Stack

| Layer | Choice |
|---|---|
| Frontend + Backend | Next.js 14 (App Router, TypeScript) |
| Embeddings | `Xenova/all-MiniLM-L6-v2` via `@xenova/transformers` (runs in-process, free, no API key) |
| LLM | `llama-3.1-8b-instant` via [Groq](https://groq.com) (free, hosted API) |
| Vector store | SQLite (single file, brute-force cosine similarity) |
| Hosting | [Vercel](https://vercel.com) free tier |

> This project originally used [Ollama](https://ollama.com) for both the LLM and
> embeddings. Ollama only runs on a machine you control, so it can't be reached by a
> free, always-on web host. It's been swapped for Groq (hosted LLM, free tier) and
> `@xenova/transformers` (embeddings computed locally inside the server — no external
> service or key needed) so the whole thing can be deployed for free.

**Why SQLite instead of Postgres+pgvector?** Same idea — store chunk text, an embedding,
and metadata (source URL, title, section) per row — just without needing a database
server. Swapping in pgvector later only means changing `src/lib/db.ts`.

## Prerequisites

- [Node.js](https://nodejs.org) 18 or newer
- A free [Groq API key](https://console.groq.com/keys)

## Setup & Usage (local)

```bash
npm install
cp .env.example .env.local
# open .env.local and paste your Groq API key into GROQ_API_KEY=

# 1. Verify Groq + the embedding model + the DB are working
npm run check-setup

# 2. Ingest the FastAPI docs (~100 pages, takes a few minutes; downloads the
#    embedding model the first time, ~90MB, then it's cached)
npm run ingest

# 3. Start the chat UI
npm run dev    # http://localhost:3000
```

## Deploying to Vercel (free)

1. **Push this project to GitHub.**
   ```bash
   git init
   git add -A
   git commit -m "Deploy-ready: Groq + local embeddings"
   git branch -M main
   git remote add origin https://github.com/<your-username>/<your-repo>.git
   git push -u origin main
   ```
   The pre-built `data/docs.db` (already ingested) **is committed** — production has
   no way to re-run the ingestion script, so the database ships with the repo.

2. **Import the repo on Vercel.**
   - Go to [vercel.com/new](https://vercel.com/new), sign in with GitHub, and select
     this repository. Vercel auto-detects Next.js — leave the build settings as-is.

3. **Add one environment variable.**
   - In the Vercel project settings → Environment Variables, add:
     `GROQ_API_KEY` = *(your key from console.groq.com/keys)*

4. **Deploy.** Click Deploy. First build takes a few minutes (it also downloads the
   ~90MB embedding model into the serverless function at first request — that request
   may take ~10-20s to "warm up", every request after is fast).

That's it — you'll get a free `your-project.vercel.app` URL.

### If you ever want to re-ingest a different corpus
Run `npm run ingest` locally (it needs your Groq key only for `check-setup`, not for
ingestion itself — embeddings are local), then commit the updated `data/docs.db` and
push again.

## Architecture

```
User question
     │
     ▼
embed(question)          ← Xenova/all-MiniLM-L6-v2, runs in-process
     │
     ▼
cosine_similarity(all chunks)   ← brute-force over SQLite rows
     │
     ▼
top-K chunks + filter(score ≥ MIN_RETRIEVAL_SCORE)
     │
     ▼
system prompt with numbered excerpts
     │
     ▼
streamChat(messages)     ← llama-3.1-8b-instant via Groq
     │
     ▼
NDJSON stream → UI (token by token)
     │
     ▼
Citations appended after stream ends
```

## Key files

| File | What it does |
|---|---|
| `scripts/ingest.ts` | Fetch sitemap → scrape → chunk → embed → store |
| `src/lib/retrieval.ts` | Embed query → cosine search → top-K chunks |
| `src/app/api/chat/route.ts` | POST handler: retrieve + stream LLM response |
| `src/app/page.tsx` | Chat UI with streaming + citations |
| `src/lib/db.ts` | SQLite schema + CRUD helpers |
| `src/lib/ai.ts` | `embed()` (local), `streamChat()` (Groq), `cosineSimilarity()` |

## Env vars

| Variable | Default | Purpose |
|---|---|---|
| `GROQ_API_KEY` | *(required)* | Free key from console.groq.com/keys |
| `GROQ_CHAT_MODEL` | `llama-3.1-8b-instant` | Chat model name |
| `DB_PATH` | `./data/docs.db` | SQLite file path |
| `CORPUS_SITEMAP_URL` | FastAPI sitemap URL | Sitemap to ingest |
| `TOP_K` | `5` | Chunks to retrieve per query |
| `CHUNK_TARGET_TOKENS` | `650` | Target chunk size |
| `CHUNK_OVERLAP_TOKENS` | `80` | Overlap between chunks |
| `MIN_RETRIEVAL_SCORE` | `0.30` | Min cosine score to include a chunk |
| `MIN_TOP_RETRIEVAL_SCORE` | `0.25` | Min score for the single best chunk |
