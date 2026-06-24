create extension if not exists vector;

create table if not exists hmatsu_chunks (
  id text primary key,
  document_id text not null,
  document_name text not null,
  page_number integer not null,
  chunk_index integer not null,
  content text not null,
  embedding vector(3072) not null,
  created_at timestamptz default now()
);

create index if not exists hmatsu_chunks_embedding_idx
  on hmatsu_chunks using ivfflat (embedding vector_cosine_ops)
  with (lists = 100);

create or replace function match_hmatsu_chunks(
  query_embedding vector(3072),
  match_threshold float,
  match_count int
)
returns table (
  id text,
  document_id text,
  document_name text,
  page_number integer,
  chunk_index integer,
  content text,
  similarity float
)
language sql stable
as $$
  select
    hmatsu_chunks.id,
    hmatsu_chunks.document_id,
    hmatsu_chunks.document_name,
    hmatsu_chunks.page_number,
    hmatsu_chunks.chunk_index,
    hmatsu_chunks.content,
    1 - (hmatsu_chunks.embedding <=> query_embedding) as similarity
  from hmatsu_chunks
  where 1 - (hmatsu_chunks.embedding <=> query_embedding) > match_threshold
  order by hmatsu_chunks.embedding <=> query_embedding
  limit match_count;
$$;
