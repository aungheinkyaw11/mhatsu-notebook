import { NextResponse } from "next/server";
import { embedText, getRequestApiKey } from "@/lib/gemini";
import { getSupabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const supabase = getSupabaseAdmin();
  if (!supabase) {
    return NextResponse.json({ ok: false, skipped: true, reason: "Supabase is not configured" });
  }

  try {
    const { question } = (await request.json()) as { question?: string };
    if (!question) return NextResponse.json({ error: "Question is required" }, { status: 400 });

    const embedding = await embedText(question, getRequestApiKey(request));
    const { data, error } = await supabase.rpc("match_hmatsu_chunks", {
      query_embedding: embedding,
      match_count: 8,
      match_threshold: 0.15
    });

    if (error) throw error;
    return NextResponse.json({ ok: true, chunks: data ?? [] });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Retrieve failed" }, { status: 500 });
  }
}
