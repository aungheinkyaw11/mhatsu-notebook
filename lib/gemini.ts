import { GoogleGenAI } from "@google/genai";

export function getGeminiClient(apiKey?: string | null) {
  const key = apiKey || process.env.GEMINI_API_KEY;
  if (!key) {
    throw new Error("Missing Gemini API key");
  }
  return new GoogleGenAI({ apiKey: key });
}

export function getRequestApiKey(request: Request) {
  const prototypeKey = request.headers.get("x-gemini-api-key");
  return prototypeKey?.trim() || process.env.GEMINI_API_KEY || "";
}

export async function embedText(text: string, apiKey?: string | null) {
  const ai = getGeminiClient(apiKey);
  const response = await ai.models.embedContent({
    model: "gemini-embedding-001",
    contents: text
  });

  const values = response.embeddings?.[0]?.values;
  if (!values?.length) {
    throw new Error("Gemini returned no embedding");
  }
  return values;
}
