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

function isStudyTool(value: unknown): value is StudyTool {
  return value === "mindmap" || value === "flashcards" || value === "quiz" || value === "slides";
}

function isSupportedModel(value: unknown): value is string {
  return value === "gemini-2.5-flash" || value === "gemini-2.5-pro" || value === "gemini-2.5-flash-lite";
}

function parseJson(text: string) {
  const cleaned = text
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(cleaned.slice(start, end + 1));
    }
    throw new Error("Study response was not valid JSON");
  }
}

function fallbackArtifact(type: StudyTool, chunks: SourceChunk[]): StudyArtifact {
  const sources = chunks.slice(0, 4).map((chunk) => ({
    documentName: chunk.documentName,
    pageNumber: chunk.pageNumber,
    excerpt: buildExcerpt(chunk.text)
  }));
  const title = chunks[0]?.documentName?.replace(/\.[^/.]+$/, "").replace(/[_-]+/g, " ") || "Study material";
  const sourceText = chunks.map((chunk) => chunk.text).join(" ");
  const points = sourceText
    .split(/(?<=\.)\s+|(?=\s*[-•]\s+)/)
    .map((line) => line.replace(/^[-•]\s*/, "").trim())
    .filter((line) => line.length > 24)
    .slice(0, 8);
  const usablePoints = points.length ? points : [NO_ANSWER];
  const artifactTitle =
    type === "mindmap"
      ? `${title} Mind map`
      : type === "flashcards"
        ? `${title} Flashcards`
        : type === "quiz"
          ? `${title} Quiz`
          : `${title} Slides`;

  return {
    type,
    title: artifactTitle,
    summary: usablePoints[0],
    ...(type === "mindmap"
      ? {
          mindMap: usablePoints.slice(0, 5).map((point, index) => ({
            title: point.split(/[:.]/)[0]?.slice(0, 70) || `Topic ${index + 1}`,
            summary: point,
            sources,
            children: usablePoints
              .slice(index + 1, index + 3)
              .map((child) => ({ title: child.slice(0, 56), detail: child, sources }))
          }))
        }
      : {}),
    ...(type === "flashcards"
      ? {
          flashcards: usablePoints.slice(0, 8).map((point, index) => ({
            front: point === NO_ANSWER ? "What could MhatSu confirm from this source?" : `What is key point ${index + 1}?`,
            back: point,
            sources
          }))
        }
      : {}),
    ...(type === "quiz"
      ? {
          quiz: usablePoints.slice(0, 6).map((point, index) => ({
            question: `Which statement is supported by the source for item ${index + 1}?`,
            options: [point, "This is not discussed in the uploaded source.", "The source says the opposite.", "No source was provided."],
            answerIndex: 0,
            explanation: point,
            sources
          }))
        }
      : {}),
    ...(type === "slides"
      ? {
          slides: usablePoints.slice(0, 6).map((point, index) => ({
            title: `Slide ${index + 1}`,
            bullets: [point],
            speakerNotes: point,
            sources
          }))
        }
      : {})
  };
}

function fallbackSources(chunks: SourceChunk[]) {
  return chunks.slice(0, 3).map((chunk) => ({
    documentName: chunk.documentName,
    pageNumber: chunk.pageNumber,
    excerpt: buildExcerpt(chunk.text)
  }));
}

function normalizeSources(value: unknown, chunks: SourceChunk[]) {
  const fallback = fallbackSources(chunks);
  if (!Array.isArray(value)) return fallback;

  const normalized = value
    .map((source) => {
      if (!source || typeof source !== "object") return null;
      const candidate = source as { documentName?: unknown; pageNumber?: unknown; excerpt?: unknown };
      const documentName = typeof candidate.documentName === "string" ? candidate.documentName : fallback[0]?.documentName;
      const pageNumber = Number(candidate.pageNumber ?? fallback[0]?.pageNumber);
      if (!documentName || !Number.isFinite(pageNumber)) return null;
      const matchingChunk = chunks.find((chunk) => chunk.documentName === documentName && chunk.pageNumber === pageNumber);
      return {
        documentName,
        pageNumber,
        excerpt:
          typeof candidate.excerpt === "string" && candidate.excerpt.trim()
            ? candidate.excerpt
            : matchingChunk
              ? buildExcerpt(matchingChunk.text)
              : fallback[0]?.excerpt ?? ""
      };
    })
    .filter((source): source is { documentName: string; pageNumber: number; excerpt: string } => Boolean(source));

  return normalized.length ? normalized : fallback;
}

function normalizeStudyArtifact(value: unknown, type: StudyTool, chunks: SourceChunk[]): StudyArtifact {
  if (!value || typeof value !== "object") return fallbackArtifact(type, chunks);

  const parsed = value as StudyArtifact;
  const artifact: StudyArtifact = {
    type,
    title: typeof parsed.title === "string" && parsed.title.trim() ? parsed.title : fallbackArtifact(type, chunks).title,
    summary: typeof parsed.summary === "string" && parsed.summary.trim() ? parsed.summary : fallbackArtifact(type, chunks).summary
  };

  if (type === "mindmap") {
    artifact.mindMap = Array.isArray(parsed.mindMap)
      ? parsed.mindMap.map((node) => ({
          title: typeof node.title === "string" ? node.title : "Topic",
          summary: typeof node.summary === "string" ? node.summary : "",
          sources: normalizeSources(node.sources, chunks),
          children: Array.isArray(node.children)
            ? node.children.map((child) => ({
                title: typeof child.title === "string" ? child.title : "Detail",
                detail: typeof child.detail === "string" ? child.detail : "",
                sources: normalizeSources(child.sources, chunks)
              }))
            : []
        }))
      : fallbackArtifact(type, chunks).mindMap;
  }

  if (type === "flashcards") {
    artifact.flashcards = Array.isArray(parsed.flashcards)
      ? parsed.flashcards.map((card) => ({
          front: typeof card.front === "string" ? card.front : "Question",
          back: typeof card.back === "string" ? card.back : "",
          sources: normalizeSources(card.sources, chunks)
        }))
      : fallbackArtifact(type, chunks).flashcards;
  }

  if (type === "quiz") {
    artifact.quiz = Array.isArray(parsed.quiz)
      ? parsed.quiz.map((question) => ({
          question: typeof question.question === "string" ? question.question : "Question",
          options: Array.isArray(question.options) ? question.options.map(String).slice(0, 4) : [],
          answerIndex: Number.isFinite(Number(question.answerIndex)) ? Number(question.answerIndex) : 0,
          explanation: typeof question.explanation === "string" ? question.explanation : "",
          sources: normalizeSources(question.sources, chunks)
        }))
      : fallbackArtifact(type, chunks).quiz;
  }

  if (type === "slides") {
    artifact.slides = Array.isArray(parsed.slides)
      ? parsed.slides.map((slide) => ({
          title: typeof slide.title === "string" ? slide.title : "Slide",
          bullets: Array.isArray(slide.bullets) ? slide.bullets.map(String) : [],
          speakerNotes: typeof slide.speakerNotes === "string" ? slide.speakerNotes : "",
          sources: normalizeSources(slide.sources, chunks)
        }))
      : fallbackArtifact(type, chunks).slides;
  }

  return artifact;
}

export async function POST(request: Request) {
  let requestedType: StudyTool = "mindmap";
  let requestedChunks: SourceChunk[] = [];

  try {
    const { type, chunks, model } = (await request.json()) as {
      type?: StudyTool;
      chunks?: SourceChunk[];
      model?: string;
    };

    if (!isStudyTool(type)) {
      return Response.json({ error: "Unsupported study tool" }, { status: 400 });
    }
    requestedType = type;
    requestedChunks = Array.isArray(chunks) ? chunks : [];

    if (!requestedChunks.length) {
      return Response.json(fallbackArtifact(type, []));
    }

    const selectedChunks = requestedChunks.slice(0, 18);
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
    const selectedModel = isSupportedModel(model) ? model : "gemini-2.5-flash";
    const config = {
      temperature: 0.2,
      responseMimeType: "application/json"
    };

    let response;
    try {
      response = await ai.models.generateContent({
        model: selectedModel,
        contents: prompt,
        config
      });
    } catch {
      response = await ai.models.generateContent({
        model: "gemini-2.5-flash",
        contents: prompt,
        config
      });
    }

    const parsed = parseJson(response.text ?? "");
    return Response.json(normalizeStudyArtifact(parsed, type, selectedChunks));
  } catch {
    return Response.json(fallbackArtifact(requestedType, requestedChunks), { status: 200 });
  }
}
