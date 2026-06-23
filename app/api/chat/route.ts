import { getGeminiClient, getRequestApiKey } from "@/lib/gemini";
import { NO_ANSWER } from "@/lib/rag";
import type { SourceChunk } from "@/lib/types";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const { question, chunks } = (await request.json()) as {
      question?: string;
      chunks?: SourceChunk[];
    };

    if (!question?.trim()) {
      return Response.json({ error: "Question is required" }, { status: 400 });
    }

    if (!chunks?.length) {
      return new Response(NO_ANSWER, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
    }

    const excerpts = chunks
      .map(
        (chunk, index) =>
          `[S${index + 1}] Document: ${chunk.documentName}\nPage: ${chunk.pageNumber}\nExcerpt: ${chunk.text}`
      )
      .join("\n\n");

    const prompt = `You are MhatSu, a document research assistant. Answer only using the supplied source excerpts. Every factual statement must be supported by a citation containing document name and page number. If the answer is not present in the source excerpts, say: '${NO_ANSWER}' Never invent citations or page numbers.

Use this citation format inline: [Document Name, p. 12]
Do not include a Sources section; the application will render verified sources separately.

Source excerpts:
${excerpts}

Question:
${question}`;

    const apiKey = getRequestApiKey(request);
    const ai = getGeminiClient(apiKey);
    const stream = await ai.models.generateContentStream({
      model: "gemini-2.5-flash",
      contents: prompt,
      config: {
        temperature: 0.15,
        topP: 0.8
      }
    });

    const encoder = new TextEncoder();
    const body = new ReadableStream({
      async start(controller) {
        try {
          for await (const chunk of stream) {
            const text = chunk.text;
            if (text) controller.enqueue(encoder.encode(text));
          }
        } catch {
          controller.enqueue(encoder.encode(NO_ANSWER));
        } finally {
          controller.close();
        }
      }
    });

    return new Response(body, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-cache"
      }
    });
  } catch {
    return new Response(NO_ANSWER, { status: 500, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }
}
