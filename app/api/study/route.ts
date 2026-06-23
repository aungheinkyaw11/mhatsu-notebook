import { getGeminiClient, getRequestApiKey } from "@/lib/gemini";
import { buildExcerpt, NO_ANSWER } from "@/lib/rag";
import type { SourceChunk, StudyArtifact, StudyTool } from "@/lib/types";

export const runtime = "nodejs";

const toolInstructions: Record<StudyTool, string> = {
  mindmap:
    "Create a concise mind map with 4 to 6 primary nodes. Each node should have 2 to 4 children that explain relationships, causes, findings, or implications.",
  flashcards:
    "Create 8 to 12 study flashcards. Each front should be a focused recall question or term. Each back should be a clear answer grounded in the excerpts.",
  quiz:
    "Create 6 multiple-choice quiz questions with 4 options each. Include the correct zero-based answerIndex and a short explanation.",
  slides:
    "Prepare a 6 to 8 slide presentation outline. Each slide should have a strong title, 3 to 5 bullets, and concise speaker notes."
};

function parseJson(text: string) {
  const cleaned = text
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim();
  return JSON.parse(cleaned);
}

function fallbackArtifact(type: StudyTool, chunks: SourceChunk[]): StudyArtifact {
  const sources = chunks.slice(0, 4).map((chunk) => ({
    documentName: chunk.documentName,
    pageNumber: chunk.pageNumber,
    excerpt: buildExcerpt(chunk.text)
  }));

  return {
    type,
    title: "Not enough confirmed source material",
    summary: NO_ANSWER,
    ...(type === "mindmap" ? { mindMap: [{ title: "Source coverage", summary: NO_ANSWER, sources, children: [] }] } : {}),
    ...(type === "flashcards" ? { flashcards: [] } : {}),
    ...(type === "quiz" ? { quiz: [] } : {}),
    ...(type === "slides" ? { slides: [] } : {})
  };
}

export async function POST(request: Request) {
  try {
    const { type, chunks } = (await request.json()) as {
      type?: StudyTool;
      chunks?: SourceChunk[];
    };

    if (!type || !["mindmap", "flashcards", "quiz", "slides"].includes(type)) {
      return Response.json({ error: "Unsupported study tool" }, { status: 400 });
    }

    if (!chunks?.length) {
      return Response.json(fallbackArtifact(type, []));
    }

    const selectedChunks = chunks.slice(0, 18);
    const excerpts = selectedChunks
      .map(
        (chunk, index) =>
          `[S${index + 1}] Document: ${chunk.documentName}\nPage: ${chunk.pageNumber}\nExcerpt: ${chunk.text}`
      )
      .join("\n\n");

    const prompt = `You are MhatSu, a document study assistant. Use only the supplied source excerpts.
If the source excerpts do not contain enough information, set summary to exactly "${NO_ANSWER}" and return empty arrays for generated items.
Never use general knowledge. Never invent facts, document names, page numbers, or sources.

Task: ${toolInstructions[type]}

Return valid JSON only. Match this schema:
{
  "type": "${type}",
  "title": "short artifact title",
  "summary": "one sentence grounded summary",
  "mindMap": [{"title":"", "summary":"", "sources":[{"documentName":"", "pageNumber":1, "excerpt":""}], "children":[{"title":"", "detail":"", "sources":[{"documentName":"", "pageNumber":1, "excerpt":""}]}]}],
  "flashcards": [{"front":"", "back":"", "sources":[{"documentName":"", "pageNumber":1, "excerpt":""}]}],
  "quiz": [{"question":"", "options":["","","",""], "answerIndex":0, "explanation":"", "sources":[{"documentName":"", "pageNumber":1, "excerpt":""}]}],
  "slides": [{"title":"", "bullets":[""], "speakerNotes":"", "sources":[{"documentName":"", "pageNumber":1, "excerpt":""}]}]
}

Only populate the array for the requested type. Include at least one source object for each generated item.

Source excerpts:
${excerpts}`;

    const ai = getGeminiClient(getRequestApiKey(request));
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: prompt,
      config: {
        temperature: 0.2,
        responseMimeType: "application/json"
      }
    });

    const parsed = parseJson(response.text ?? "");
    return Response.json(parsed);
  } catch {
    return Response.json({ error: "Could not generate a grounded study artifact" }, { status: 500 });
  }
}
