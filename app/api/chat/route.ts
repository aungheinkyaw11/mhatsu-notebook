import { getGeminiClient, getRequestApiKey } from "@/lib/gemini";
import { NO_ANSWER } from "@/lib/rag";
import type { SourceChunk } from "@/lib/types";

export const runtime = "nodejs";

const CHAT_MODELS = new Set([
  "gemini-2.5-flash",
  "gemini-2.5-pro",
  "gemini-2.5-flash-lite"
]);

export async function POST(request: Request) {
  try {
    const { question, chunks, model } = (await request.json()) as {
      question?: string;
      chunks?: SourceChunk[];
      model?: string;
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

    const prompt = `You are MhatSu, a document research assistant similar to NotebookLM. Your job is to answer the user's question using the uploaded document excerpts below.

Rules:
- Answer only from the supplied excerpts.
- If the question is related to the uploaded document, answer it even when the user's wording is informal or uses pronouns like "he", "she", "they", "this week", or "this report".
- The user's exact words do not need to appear in the source. Use the meaning of the question.
- If the user asks what a paper, report, or document is about, prioritize abstract, introduction, methods, results, conclusion, and overview excerpts. Do not answer from bibliography/reference-list entries unless the user specifically asks about references.
- If the user asks "what is X" or asks for a definition, define X in the context of the excerpts first, then add concise bullets for evidence, benchmarks, methods, or implications found in the excerpts.
- For summary questions, synthesize the relevant actions, tasks, decisions, risks, or findings from the excerpts.
- If the excerpts are a weekly report, status update, meeting note, resume, or task list, summarize the listed work items and outcomes.
- Every factual bullet or sentence should include a citation in this format: [Document Name, p. 12]
- If and only if the supplied excerpts contain no relevant information, say exactly: '${NO_ANSWER}'
- Never invent facts, citations, document names, or page numbers.

Do not include a Sources section; the application will render verified sources separately.

Source excerpts:
${excerpts}

Question:
${question}`;

    const apiKey = getRequestApiKey(request);
    const ai = getGeminiClient(apiKey);
    const selectedModel = model && CHAT_MODELS.has(model) ? model : "gemini-2.5-flash";
    const config = {
      temperature: 0.2,
      topP: 0.9
    };

    let stream;
    const fallbackModels = [selectedModel, "gemini-2.5-flash", "gemini-2.5-flash-lite"].filter(
      (candidate, index, models) => models.indexOf(candidate) === index
    );

    for (const candidateModel of fallbackModels) {
      try {
        stream = await ai.models.generateContentStream({
          model: candidateModel,
          contents: prompt,
          config
        });
        break;
      } catch {
        stream = undefined;
      }
    }

    if (!stream) {
      throw new Error("Gemini chat generation failed");
    }

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
