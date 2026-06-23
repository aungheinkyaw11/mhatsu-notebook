import { NextResponse } from "next/server";
import { embedText, getGeminiClient, getRequestApiKey } from "@/lib/gemini";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const apiKey = getRequestApiKey(request);
    if (!apiKey) {
      return NextResponse.json(
        { ok: false, message: "No Gemini API key found. Paste a key or set GEMINI_API_KEY in .env.local." },
        { status: 401 }
      );
    }
    const ai = getGeminiClient(apiKey);

    await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: "Reply with exactly: connected",
      config: {
        temperature: 0,
        maxOutputTokens: 8
      }
    });
    await embedText("MhatSu embedding connection test", apiKey);

    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        message:
          error instanceof Error
            ? `Gemini connection failed: ${error.message}`
            : "Gemini connection failed. Check your API key and try again."
      },
      { status: 401 }
    );
  }
}
