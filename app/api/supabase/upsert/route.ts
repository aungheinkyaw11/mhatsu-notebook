import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import type { SourceChunk } from "@/lib/types";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const supabase = getSupabaseAdmin();
  if (!supabase) {
    return NextResponse.json({ ok: false, skipped: true, reason: "Supabase is not configured" });
  }

  try {
    const { chunks } = (await request.json()) as { chunks?: SourceChunk[] };
    if (!chunks?.length) return NextResponse.json({ ok: true, count: 0 });

    const rows = chunks.map((chunk) => ({
      id: chunk.id,
      document_id: chunk.documentId,
      document_name: chunk.documentName,
      page_number: chunk.pageNumber,
      chunk_index: chunk.chunkIndex,
      content: chunk.text,
      embedding: chunk.embedding
    }));

    const { error } = await supabase.from("hmatsu_chunks").upsert(rows);
    if (error) throw error;

    return NextResponse.json({ ok: true, count: rows.length });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Upsert failed" }, { status: 500 });
  }
}
