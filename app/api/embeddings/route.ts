import { NextResponse } from "next/server";
import { embedText, getRequestApiKey } from "@/lib/gemini";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const { texts } = (await request.json()) as { texts?: string[] };
    if (!texts?.length) {
      return NextResponse.json({ error: "No text supplied" }, { status: 400 });
    }

    const apiKey = getRequestApiKey(request);
    const embeddings = [];

    for (const text of texts) {
      embeddings.push(await embedText(text.slice(0, 6000), apiKey));
    }

    return NextResponse.json({ embeddings });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Embedding failed";
    const lowerMessage = message.toLowerCase();
    const status =
      lowerMessage.includes("quota") || lowerMessage.includes("rate") || lowerMessage.includes("429")
        ? 429
        : lowerMessage.includes("api key") || lowerMessage.includes("permission") || lowerMessage.includes("unauthorized")
          ? 401
          : 500;

    return NextResponse.json({ error: message }, { status });
  }
}
