import type { PageText, SourceChunk } from "@/lib/types";

export const NO_ANSWER = "I could not find a confirmed answer in your uploaded sources.";

export function chunkPages(documentId: string, documentName: string, pages: PageText[]): Omit<SourceChunk, "embedding">[] {
  const chunks: Omit<SourceChunk, "embedding">[] = [];

  for (const page of pages) {
    const cleaned = page.text.replace(/\s+/g, " ").trim();
    if (!cleaned) continue;

    const sentences = cleaned.match(/[^.!?]+[.!?]+|\S[^.!?]*$/g) ?? [cleaned];
    let buffer = "";
    let chunkIndex = 0;

    for (const sentence of sentences) {
      const next = `${buffer} ${sentence}`.trim();
      if (next.length > 1100 && buffer.length > 0) {
        chunks.push({
          id: `${documentId}:${page.pageNumber}:${chunkIndex}`,
          documentId,
          documentName,
          pageNumber: page.pageNumber,
          chunkIndex,
          text: buffer
        });
        chunkIndex += 1;
        buffer = sentence.trim();
      } else {
        buffer = next;
      }
    }

    if (buffer) {
      chunks.push({
        id: `${documentId}:${page.pageNumber}:${chunkIndex}`,
        documentId,
        documentName,
        pageNumber: page.pageNumber,
        chunkIndex,
        text: buffer
      });
    }
  }

  return chunks;
}

export function cosineSimilarity(a: number[], b: number[]) {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const length = Math.min(a.length, b.length);

  for (let i = 0; i < length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  if (!normA || !normB) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export function retrieveChunks(chunks: SourceChunk[], questionEmbedding: number[], limit = 8) {
  return chunks
    .map((chunk) => ({ chunk, score: cosineSimilarity(chunk.embedding, questionEmbedding) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .filter((item) => item.score > 0.15)
    .map((item) => item.chunk);
}

export function buildExcerpt(text: string, maxLength = 220) {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (cleaned.length <= maxLength) return cleaned;
  return `${cleaned.slice(0, maxLength).trim()}...`;
}

export function uniqueChunkSources(chunks: SourceChunk[]) {
  const seen = new Set<string>();
  return chunks.filter((chunk) => {
    const key = `${chunk.documentName}:${chunk.pageNumber}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
