# MhatSu

MhatSu is a polished NotebookLM-style AI document research app built with Next.js, TypeScript, Tailwind CSS, shadcn-style UI primitives, Lucide icons, React PDF/PDF.js, Gemini 2.5 Flash, and a pgvector-ready retrieval layer.

## Local Setup

```bash
npm install
cp .env.example .env.local
npm run dev
```

Open `http://localhost:3000`.

For prototype mode, paste a Gemini API key into the sidebar and click **Test**. The key is held only in React state for the current browser session. It is sent to server routes in an HTTPS request header and is not stored in localStorage, cookies, URLs, or logs.

For production mode, set this in `.env.local` or Vercel:

```bash
GEMINI_API_KEY=your_server_side_key
```

Optional Supabase persistence:

```bash
NEXT_PUBLIC_SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...
```

Run `supabase/schema.sql` in Supabase SQL Editor to create the `mhatsu_chunks` pgvector table and match function.

## Vercel Deployment

1. Push this project to GitHub.
2. Import it in Vercel.
3. Add `GEMINI_API_KEY` as a Production environment variable.
4. Optionally add `NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`.
5. Deploy.

The app uses standard Next.js API routes and is Vercel-ready without custom server configuration.

## Architecture

- `app/page.tsx`: full-screen three-panel workspace, uploads, PDF reader, chat, citations, dark mode, and responsive mobile tabs.
- `app/api/process`: extracts PDF text page by page with PDF.js.
- `app/api/embeddings`: creates Gemini embeddings for chunks and questions.
- `app/api/chat`: streams Gemini 2.5 Flash answers using only retrieved excerpts.
- `app/api/study`: generates grounded mind maps, flashcards, quizzes, and slide outlines from selected source chunks.
- `app/api/supabase/upsert`: stores chunk vectors in Supabase pgvector when configured.
- `lib/rag.ts`: chunking, cosine similarity, retrieval, excerpt creation, and no-answer constant.

The MVP keeps an in-memory session vector store in the browser so it works immediately in prototype mode. Supabase pgvector support is included for production persistence and server-side retrieval.

## Study Tools

The right panel includes grounded study tools for the selected document:

- Mind map
- Flashcards
- Quiz
- Slides

Each tool sends only indexed document chunks to Gemini 2.5 Flash and asks for structured JSON. The UI renders each artifact with source chips that navigate back to the cited document page.

## Citation Generation

MhatSu extracts text page by page, chunks each page, and stores metadata with every chunk:

- `documentId`
- `documentName`
- `pageNumber`
- `chunkIndex`
- `text`
- `embedding`

When a question is asked, MhatSu embeds the question, retrieves relevant stored chunks, and sends only those excerpts to Gemini. Gemini is instructed to cite answers using `[Document Name, p. 12]`. The UI then verifies citations against retrieved chunk metadata before making them clickable and before showing the Sources section. Clicking a citation opens the matching PDF page and highlights it.

If no relevant source is found, the assistant replies exactly:

```text
I could not find a confirmed answer in your uploaded sources.
```

## Prototype API Key Security

Prototype mode exists so a user can test MhatSu without provisioning server secrets. It has limitations:

- The key is entered in the browser UI.
- The key remains only in memory for the current session.
- The key is sent to Next.js API routes in a request header.
- The key is never intentionally logged, persisted, or placed in URLs.

For real deployments, use server-side `GEMINI_API_KEY` and avoid user-entered keys unless you intentionally support bring-your-own-key workflows.
