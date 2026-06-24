import { getGeminiClient, getRequestApiKey } from "@/lib/gemini";
import { buildExcerpt, NO_ANSWER } from "@/lib/rag";
import type { SourceChunk, StudyArtifact, StudyTool } from "@/lib/types";

export const runtime = "nodejs";

const toolInstructions: Record<StudyTool, string> = {
  mindmap:
    "Read across the supplied excerpts and create a NotebookLM-style mind map with 4 to 6 broad concept nodes. Each node should have 2 to 4 specific children. Use short labels, not full sentences.",
  flashcards:
    "Create 10 to 14 useful study flashcards from the whole source. Each front should ask about a concrete concept, method, result, definition, or relationship from the document. Each back should be a clear grounded answer.",
  quiz:
    "Create 8 to 12 multiple-choice quiz questions that test understanding of the document. Questions must be specific, natural, and based on important concepts, methods, findings, definitions, or implications. Do not use placeholder wording like item 1, key point 1, this statement, source says, or which statement is supported. Include 4 plausible, concrete options drawn from or contradicted by document details, the correct zero-based answerIndex, and a short explanation.",
  slides:
    "Prepare an 8 to 10 slide presentation outline that covers the whole document. Each slide must have a specific title, exactly 4 or 5 grounded bullets with informational detail, and concise speaker notes that explain how to present the slide."
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

function sortChunks(chunks: SourceChunk[]) {
  return [...chunks].sort(
    (a, b) =>
      a.documentName.localeCompare(b.documentName) ||
      a.pageNumber - b.pageNumber ||
      a.chunkIndex - b.chunkIndex
  );
}

function selectStudyChunks(chunks: SourceChunk[], type: StudyTool) {
  const sorted = sortChunks(chunks);
  const maxChunks = type === "slides" || type === "quiz" || type === "flashcards" ? 32 : 26;
  const maxChars = type === "slides" || type === "quiz" || type === "flashcards" ? 36000 : 30000;
  const selected: SourceChunk[] = [];
  const seen = new Set<string>();

  if (sorted.length <= maxChunks) {
    selected.push(...sorted);
  } else {
    for (let index = 0; index < maxChunks; index += 1) {
      const sourceIndex = Math.round((index * (sorted.length - 1)) / (maxChunks - 1));
      const chunk = sorted[sourceIndex];
      if (chunk && !seen.has(chunk.id)) {
        seen.add(chunk.id);
        selected.push(chunk);
      }
    }
  }

  const packed: SourceChunk[] = [];
  let totalChars = 0;
  for (const chunk of selected) {
    const remaining = maxChars - totalChars;
    if (remaining <= 400) break;
    const text = chunk.text.length > remaining ? `${chunk.text.slice(0, remaining).trim()}...` : chunk.text;
    packed.push({ ...chunk, text });
    totalChars += text.length;
  }

  return packed.length ? packed : sorted.slice(0, maxChunks);
}

function sentenceEntries(chunks: SourceChunk[]) {
  return chunks
    .flatMap((chunk) =>
      chunk.text
        .split(/(?<=\.)\s+|(?=\s*[-•]\s+)/)
        .map((line) => line.replace(/^[-•]\s*/, "").replace(/\s+/g, " ").trim())
        .filter((line) => line.length >= 45 && line.length <= 260)
        .map((line) => ({ text: line, chunk }))
    )
    .filter((entry, index, entries) => entries.findIndex((candidate) => candidate.text === entry.text) === index)
    .slice(0, 14);
}

function sourceFromChunk(chunk: SourceChunk) {
  return {
    documentName: chunk.documentName,
    pageNumber: chunk.pageNumber,
    excerpt: buildExcerpt(chunk.text)
  };
}

function questionSubject(text: string, fallback: string) {
  const cleaned = text
    .replace(/\[[^\]]+\]/g, "")
    .replace(/\([^)]{0,40}\)/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const subject = cleaned.split(/[,:;.]/)[0]?.trim();
  return (subject && subject.length > 12 ? subject : fallback).slice(0, 96);
}

function isGenericDistractor(option: string) {
  return /source says|source describes|not discussed|no evidence|opposite relationship|uploaded source|no source/i.test(option);
}

function buildQuizOptions(correct: string, entries: { text: string; chunk?: SourceChunk }[], index: number) {
  const distractors = entries
    .map((entry) => entry.text)
    .filter((text) => text !== correct && text.length > 24)
    .slice(index + 1)
    .concat(entries.map((entry) => entry.text).filter((text) => text !== correct && text.length > 24))
    .filter((text, itemIndex, items) => items.indexOf(text) === itemIndex)
    .slice(0, 3);

  const fallbackDistractors = [
    "The document presents this as a biological tissue-growth process rather than a milling or synthesis process.",
    "The document reports that the material was prepared without titanium oxide or calcium phosphate.",
    "The document concludes that ball milling had no effect on crystallite size or phase formation."
  ];

  const options = [correct, ...distractors, ...fallbackDistractors].slice(0, 4);
  while (options.length < 4) {
    options.push("The document does not support this alternative interpretation.");
  }

  const shift = index % 4;
  const rotated = [...options.slice(shift), ...options.slice(0, shift)];
  return {
    options: rotated,
    answerIndex: rotated.indexOf(correct)
  };
}

function buildSlideBullets(entry: { text: string; chunk?: SourceChunk }, entries: { text: string; chunk?: SourceChunk }[], index: number) {
  const nearby = entries
    .slice(index, index + 5)
    .concat(entries.slice(Math.max(0, index - 2), index))
    .map((candidate) => candidate.text)
    .filter((text, itemIndex, items) => text.length > 24 && items.indexOf(text) === itemIndex)
    .slice(0, 5);

  const bullets = nearby.length >= 3 ? nearby : [entry.text, ...entries.map((candidate) => candidate.text)].filter(Boolean).slice(0, 5);
  return bullets.slice(0, 5);
}

function normalizeBullets(value: unknown, chunks: SourceChunk[], fallbackTitle: string) {
  const parsed = Array.isArray(value) ? value.map(String).map((bullet) => bullet.trim()).filter(Boolean) : [];
  if (parsed.length >= 3) return parsed.slice(0, 5);

  const entries = sentenceEntries(chunks);
  const titleWords = fallbackTitle.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const ranked = entries
    .map((entry) => ({
      entry,
      score: titleWords.reduce((total, word) => total + (entry.text.toLowerCase().includes(word) ? 1 : 0), 0)
    }))
    .sort((a, b) => b.score - a.score)
    .map(({ entry }) => entry.text);

  return [...parsed, ...ranked].filter((text, index, items) => text.length > 24 && items.indexOf(text) === index).slice(0, 5);
}

function fallbackArtifact(type: StudyTool, chunks: SourceChunk[]): StudyArtifact {
  const entries = sentenceEntries(chunks);
  const sources = chunks.slice(0, 4).map(sourceFromChunk);
  const title = chunks[0]?.documentName?.replace(/\.[^/.]+$/, "").replace(/[_-]+/g, " ") || "Study material";
  const usableEntries = entries.length ? entries : [{ text: NO_ANSWER, chunk: chunks[0] }];
  const usablePoints = usableEntries.map((entry) => entry.text);
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
          mindMap: usableEntries.slice(0, 5).map((entry, index) => ({
            title: questionSubject(entry.text, `Topic ${index + 1}`),
            summary: entry.text,
            sources: entry.chunk ? [sourceFromChunk(entry.chunk)] : sources,
            children: usableEntries
              .slice(index + 1, index + 3)
              .map((child) => ({
                title: questionSubject(child.text, "Detail"),
                detail: child.text,
                sources: child.chunk ? [sourceFromChunk(child.chunk)] : sources
              }))
          }))
        }
      : {}),
    ...(type === "flashcards"
      ? {
          flashcards: usableEntries.slice(0, 10).map((entry, index) => ({
            front:
              entry.text === NO_ANSWER
                ? "What could MhatSu confirm from this source?"
                : `What does the source say about ${questionSubject(entry.text, `topic ${index + 1}`)}?`,
            back: entry.text,
            sources: entry.chunk ? [sourceFromChunk(entry.chunk)] : sources
          }))
        }
      : {}),
    ...(type === "quiz"
      ? {
          quiz: usableEntries.slice(0, 8).map((entry, index) => {
            const quizOptions = buildQuizOptions(entry.text, usableEntries, index);
            return {
              question: `What does the document report about ${questionSubject(entry.text, `topic ${index + 1}`)}?`,
              options: quizOptions.options,
              answerIndex: quizOptions.answerIndex,
              explanation: entry.text,
              sources: entry.chunk ? [sourceFromChunk(entry.chunk)] : sources
            };
          })
        }
      : {}),
    ...(type === "slides"
      ? {
          slides: usableEntries.slice(0, 8).map((entry, index) => ({
            title: questionSubject(entry.text, `Topic ${index + 1}`),
            bullets: buildSlideBullets(entry, usableEntries, index),
            speakerNotes: buildSlideBullets(entry, usableEntries, index).join(" "),
            sources: entry.chunk ? [sourceFromChunk(entry.chunk)] : sources
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
      ? parsed.quiz.map((question, index) => {
          const explanation = typeof question.explanation === "string" && question.explanation.trim() ? question.explanation : "";
          const entries = sentenceEntries(chunks);
          const fallbackEntry = entries[index % Math.max(1, entries.length)];
          const correct =
            Array.isArray(question.options) && Number.isFinite(Number(question.answerIndex))
              ? String(question.options[Number(question.answerIndex)] ?? (explanation || fallbackEntry?.text || ""))
              : explanation || fallbackEntry?.text || "";
          const rawOptions = Array.isArray(question.options) ? question.options.map(String).slice(0, 4) : [];
          const needsOptions =
            rawOptions.length < 4 ||
            rawOptions.some(isGenericDistractor) ||
            new Set(rawOptions.map((option) => option.trim().toLowerCase())).size < rawOptions.length;
          const rebuilt = buildQuizOptions(correct || fallbackEntry?.text || "The document supports this answer.", entries, index);
          const options = needsOptions ? rebuilt.options : rawOptions;
          const answerIndex = needsOptions
            ? rebuilt.answerIndex
            : Math.min(Math.max(0, Number(question.answerIndex) || 0), options.length - 1);

          return {
            question:
              typeof question.question === "string" && question.question.trim()
                ? question.question.replace(/which statement is supported by the source/i, "What does the document show")
                : `What does the document report about ${questionSubject(correct || fallbackEntry?.text || "", `topic ${index + 1}`)}?`,
            options,
            answerIndex,
            explanation: explanation || correct,
            sources: normalizeSources(question.sources, chunks)
          };
        })
      : fallbackArtifact(type, chunks).quiz;
  }

  if (type === "slides") {
    artifact.slides = Array.isArray(parsed.slides)
      ? parsed.slides.map((slide) => ({
          title: typeof slide.title === "string" ? slide.title : "Slide",
          bullets: normalizeBullets(slide.bullets, chunks, typeof slide.title === "string" ? slide.title : "Slide"),
          speakerNotes:
            typeof slide.speakerNotes === "string" && slide.speakerNotes.trim()
              ? slide.speakerNotes
              : normalizeBullets(slide.bullets, chunks, typeof slide.title === "string" ? slide.title : "Slide").join(" "),
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

    const selectedChunks = selectStudyChunks(requestedChunks, type);
    const excerpts = selectedChunks
      .map(
        (chunk, index) =>
          `[S${index + 1}] Document: ${chunk.documentName}\nPage: ${chunk.pageNumber}\nExcerpt: ${chunk.text}`
      )
      .join("\n\n");

    const prompt = `You are MhatSu, a document study assistant. Use only the supplied source excerpts.
The excerpts are selected across the uploaded document so the output should cover the full source, not only the first page.
If the source excerpts do not contain enough information, set summary to exactly "${NO_ANSWER}" and return empty arrays for generated items.
Never use general knowledge. Never invent facts, document names, page numbers, or sources.
Avoid generic labels such as "item 1", "key point 1", "statement", "source says", "topic", "detail", or "slide 1" when a real concept name can be used.

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
For quiz, make distractors plausible but clearly wrong according to the document. Do not write generic options like "not discussed", "source says", "no evidence", or "opposite relationship". The correct answer should not always be option A.
For flashcards, write recall questions, not vague prompts.
For slides, cover the document from beginning to end with specific section titles and exactly 4 or 5 useful bullets per slide. Bullets should include concrete details such as methods, materials, results, limitations, comparisons, dates, or conclusions when present.
For mind maps, keep node labels compact so they fit in UI boxes.

Source excerpts:
${excerpts}`;

    const ai = getGeminiClient(getRequestApiKey(request));
    const selectedModel = isSupportedModel(model) ? model : "gemini-2.5-flash";
    const config = {
      temperature: 0.2,
      responseMimeType: "application/json",
      maxOutputTokens: 6000
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
