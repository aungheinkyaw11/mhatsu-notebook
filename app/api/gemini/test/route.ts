import { NextResponse } from "next/server";
import { embedText, getGeminiClient, getRequestApiKey } from "@/lib/gemini";

export const runtime = "nodejs";

const TEST_MODELS = new Set(["gemini-2.5-flash", "gemini-2.5-pro", "gemini-2.5-flash-lite"]);

function parseErrorBody(message: string) {
  const jsonStart = message.indexOf("{");
  if (jsonStart < 0) return null;
  try {
    return JSON.parse(message.slice(jsonStart)) as {
      error?: {
        code?: number;
        message?: string;
        details?: Array<{ retryDelay?: string; violations?: Array<{ quotaDimensions?: { model?: string } }> }>;
      };
    };
  } catch {
    return null;
  }
}

function friendlyGeminiError(error: unknown) {
  const rawMessage = error instanceof Error ? error.message : "Gemini connection failed.";
  const parsed = parseErrorBody(rawMessage);
  const apiError = parsed?.error;
  const retryDelay = apiError?.details?.find((detail) => detail.retryDelay)?.retryDelay;
  const quotaModel = apiError?.details
    ?.flatMap((detail) => detail.violations ?? [])
    .find((violation) => violation.quotaDimensions?.model)?.quotaDimensions?.model;

  if (apiError?.code === 429 || /quota|RESOURCE_EXHAUSTED|rate/i.test(rawMessage)) {
    return `Gemini quota reached${quotaModel ? ` for ${quotaModel}` : ""}.${retryDelay ? ` Retry in about ${retryDelay}.` : ""} Try another model/key or wait for quota reset.`;
  }

  if (/api key|permission|unauthorized|forbidden|401|403/i.test(rawMessage)) {
    return "Gemini rejected this API key. Check that the key is copied correctly and enabled for Gemini API.";
  }

  return rawMessage.length > 240 ? "Gemini connection failed. Check your API key, model access, and quota." : `Gemini connection failed: ${rawMessage}`;
}

export async function POST(request: Request) {
  try {
    const { model } = (await request.json().catch(() => ({}))) as { model?: string };
    const apiKey = getRequestApiKey(request);
    if (!apiKey) {
      return NextResponse.json(
        { ok: false, message: "No Gemini API key found. Paste a key or set GEMINI_API_KEY in .env.local." },
        { status: 401 }
      );
    }
    const ai = getGeminiClient(apiKey);
    const selectedModel = model && TEST_MODELS.has(model) ? model : "gemini-2.5-flash";

    await ai.models.generateContent({
      model: selectedModel,
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
        message: friendlyGeminiError(error)
      },
      { status: 401 }
    );
  }
}
