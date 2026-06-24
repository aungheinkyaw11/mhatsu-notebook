"use client";

import { FormEvent, KeyboardEvent, PointerEvent, useCallback, useEffect, useRef, useState } from "react";
import { Document, Page, pdfjs } from "react-pdf";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { useTheme } from "next-themes";
import {
  Bot,
  BookOpen,
  BrainCircuit,
  Check,
  ChevronLeft,
  ChevronRight,
  Clipboard,
  Download,
  HelpCircle,
  Eye,
  EyeOff,
  FileText,
  Fullscreen,
  Layers,
  Loader2,
  Maximize2,
  MessageSquare,
  Minimize2,
  Moon,
  Network,
  PanelLeft,
  Presentation,
  RefreshCw,
  Search,
  Send,
  Sun,
  Trash2,
  Upload,
  ZoomIn,
  ZoomOut
} from "lucide-react";
import "react-pdf/dist/Page/AnnotationLayer.css";
import "react-pdf/dist/Page/TextLayer.css";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { buildExcerpt, chunkPages, NO_ANSWER, retrieveChunks, uniqueChunkSources } from "@/lib/rag";
import { cn } from "@/lib/utils";
import type {
  ChatMessage,
  Citation,
  ConnectionStatus,
  PageText,
  SourceChunk,
  SourceDocument,
  StudyArtifact,
  StudySource,
  StudyTool
} from "@/lib/types";

type FullscreenDocument = globalThis.Document & {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void> | void;
};

type FullscreenTarget = HTMLElement & {
  webkitRequestFullscreen?: () => Promise<void> | void;
};

if (typeof window !== "undefined") {
  pdfjs.GlobalWorkerOptions.workerPort = new Worker(
    new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url),
    { type: "module" }
  );
}

const prompts = [
  "Summarize these documents",
  "What are the key findings?",
  "Compare the uploaded sources",
  "What are the main risks?",
  "Create an executive summary"
];

const chatModels = [
  { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash (Fast)" },
  { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro (Deep)" },
  { id: "gemini-2.5-flash-lite", label: "Gemini 2.5 Flash-Lite (Light)" }
];

const studyTools: { type: StudyTool; label: string; icon: typeof Network }[] = [
  { type: "mindmap", label: "Mind map", icon: Network },
  { type: "flashcards", label: "Flashcards", icon: Layers },
  { type: "quiz", label: "Quiz", icon: HelpCircle },
  { type: "slides", label: "Slides", icon: Presentation }
];

function statusCopy(status: SourceDocument["status"]) {
  if (status === "processing") return "Reading and indexing document...";
  if (status === "ready") return "Ready";
  if (status === "failed") return "Failed";
  return "Queued";
}

function connectionCopy(status: ConnectionStatus) {
  if (status === "checking") return "Checking connection";
  if (status === "connected") return "Gemini connected";
  if (status === "failed") return "Connection failed";
  return "Not connected";
}

function ConnectionIndicator({ status, compact = false }: { status: ConnectionStatus; compact?: boolean }) {
  return (
    <div className={cn("flex items-center gap-2 text-xs text-muted-foreground", compact && "gap-1.5")}>
      <span
        className={cn(
          "h-2.5 w-2.5 rounded-full bg-muted-foreground/40",
          status === "checking" && "bg-amber-400",
          status === "connected" && "bg-emerald-500 shadow-[0_0_14px_rgba(16,185,129,0.58)]",
          status === "failed" && "bg-red-500"
        )}
      />
      {!compact && <span>{connectionCopy(status)}</span>}
    </div>
  );
}

function parseCitations(content: string, chunks: SourceChunk[]): Citation[] {
  const matches = [...content.matchAll(/\[([^,\]]+),\s*p\.\s*(\d+)\]/gi)];
  const citations: Citation[] = [];
  const seen = new Set<string>();

  for (const match of matches) {
    const documentName = match[1].trim();
    const pageNumber = Number(match[2]);
    const chunk = chunks.find(
      (candidate) => candidate.documentName === documentName && candidate.pageNumber === pageNumber
    );
    if (!chunk) continue;
    const key = `${chunk.documentId}:${chunk.pageNumber}`;
    if (seen.has(key)) continue;
    seen.add(key);
    citations.push({
      documentId: chunk.documentId,
      documentName: chunk.documentName,
      pageNumber: chunk.pageNumber,
      excerpt: buildExcerpt(chunk.text)
    });
  }

  return citations;
}

function formatDocumentName(name: string) {
  const withoutExtension = name.replace(/\.[^/.]+$/, "");
  return withoutExtension
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\bNVIDIAs\b/gi, "NVIDIA's")
    .replace(/\bAi\b/g, "AI")
    .replace(/\bGpu\b/g, "GPU")
    .replace(/\bCuda\b/g, "CUDA")
    .trim();
}

const fallbackStopWords = new Set([
  "what",
  "which",
  "where",
  "when",
  "why",
  "how",
  "that",
  "this",
  "these",
  "those",
  "about",
  "paper",
  "document",
  "file",
  "research",
  "give",
  "explain",
  "tell",
  "please",
  "the",
  "and",
  "for",
  "with",
  "from",
  "your",
  "uploaded",
  "source",
  "sources"
]);

function questionTerms(question: string) {
  return question
    .toLowerCase()
    .match(/[a-z0-9]+/g)
    ?.filter((term) => term.length > 2 && !fallbackStopWords.has(term)) ?? [];
}

function isBoilerplateSentence(line: string) {
  return /provided proper attribution|google hereby grants permission|@|copyright|all rights reserved|arxiv preprint|proceedings of|conference on|journalistic|scholarly works|^\s*[a-z]+\s+[a-z]+(?:\s+[a-z]+)?\s*(?:\*|google|university)/i.test(
    line
  );
}

function createFallbackSummary(chunks: SourceChunk[], question: string) {
  const terms = questionTerms(question);
  const bulletLines = chunks
    .flatMap((chunk) =>
      chunk.text
        .split(/(?<=\.)\s+|(?=\s*[-•]\s+)/)
        .map((line) => line.replace(/^[-•]\s*/, "").trim())
        .filter((line) => line.length > 36 && !isBoilerplateSentence(line))
        .map((line) => {
          const lower = line.toLowerCase();
          const score = terms.reduce((total, term) => total + (lower.includes(term) ? 1 : 0), 0);
          const sourceBoost = /\b(abstract|introduction|conclusion|we propose|we present|we show|experiments|results|task|model|architecture|method|translation|attention|transformer)\b/i.test(
            line
          )
            ? 1
            : 0;
          return { line, chunk, score: score + sourceBoost };
        })
    )
    .sort((a, b) => b.score - a.score || a.chunk.pageNumber - b.chunk.pageNumber || a.line.length - b.line.length)
    .filter((item, index, items) => items.findIndex((candidate) => candidate.line === item.line) === index)
    .slice(0, 7);

  if (!bulletLines.length) return NO_ANSWER;

  return bulletLines
    .map(({ line, chunk }) => `- ${line} [${chunk.documentName}, p. ${chunk.pageNumber}]`)
    .join("\n");
}

function isOverviewQuestion(question: string) {
  return /\b(about|overview|summari[sz]e|summary|main idea|main point|paper about|research paper|this paper|this document|this report|this file)\b/i.test(
    question
  );
}

function isDefinitionQuestion(question: string) {
  return /\b(what is|what's|define|meaning of|explain)\b/i.test(question);
}

function isReferenceLikeChunk(chunk: SourceChunk) {
  const text = chunk.text.toLowerCase();
  const referenceTerms =
    text.match(
      /\b(references|arxiv|preprint|proceedings|conference|journal|workshop|transactions|doi|volume|pages|et al|bibliography)\b/g
    )?.length ?? 0;
  const citationMarkers = text.match(/\[\d+\]/g)?.length ?? 0;
  const hasContentHeading = /\b(abstract|introduction|method|approach|model|architecture|experiment|result|conclusion)\b/.test(text);

  return !hasContentHeading && (referenceTerms >= 4 || citationMarkers >= 8);
}

function uniqueChunks(chunks: SourceChunk[]) {
  const seen = new Set<string>();
  return chunks.filter((chunk) => {
    if (seen.has(chunk.id)) return false;
    seen.add(chunk.id);
    return true;
  });
}

function selectQuestionChunks(chunks: SourceChunk[], questionEmbedding: number[], question: string) {
  const nonReferenceChunks = chunks.filter((chunk) => !isReferenceLikeChunk(chunk));
  const sourceChunks = nonReferenceChunks.length ? nonReferenceChunks : chunks;
  const overview = isOverviewQuestion(question);
  const definition = isDefinitionQuestion(question);
  const terms = questionTerms(question);
  const termChunks =
    terms.length > 0
      ? sourceChunks
          .map((chunk) => {
            const text = chunk.text.toLowerCase();
            const score = terms.reduce((total, term) => total + (text.includes(term) ? 1 : 0), 0);
            return { chunk, score };
          })
          .filter(({ score }) => score > 0)
          .sort((a, b) => b.score - a.score || a.chunk.pageNumber - b.chunk.pageNumber)
          .map(({ chunk }) => chunk)
      : [];
  const semanticChunks = retrieveChunks(sourceChunks, questionEmbedding, overview ? 12 : 16);

  if (definition) {
    return uniqueChunks([...termChunks.slice(0, 10), ...semanticChunks]).slice(0, 18);
  }

  if (!overview) {
    return semanticChunks.length ? uniqueChunks([...semanticChunks, ...termChunks.slice(0, 6)]).slice(0, 18) : sourceChunks.slice(0, 10);
  }

  const openingChunks = [...sourceChunks]
    .sort((a, b) => a.pageNumber - b.pageNumber || a.chunkIndex - b.chunkIndex)
    .slice(0, 10);

  return uniqueChunks([...openingChunks, ...semanticChunks]).slice(0, 18);
}

async function createEmbeddings(texts: string[], apiKey: string) {
  const trimmedApiKey = apiKey.trim();
  const embeddings: number[][] = [];
  for (let i = 0; i < texts.length; i += 8) {
    const response = await fetch("/api/embeddings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(trimmedApiKey ? { "x-gemini-api-key": trimmedApiKey } : {})
      },
      body: JSON.stringify({ texts: texts.slice(i, i + 8) })
    });

    const data = (await response.json().catch(() => null)) as { embeddings?: number[][]; error?: string } | null;
    if (!response.ok || !data?.embeddings) {
      throw new Error(data?.error ?? "Embedding failed");
    }
    embeddings.push(...data.embeddings);
  }
  return embeddings;
}

export default function Home() {
  const { resolvedTheme, setTheme } = useTheme();
  const [documents, setDocuments] = useState<SourceDocument[]>([]);
  const [chunks, setChunks] = useState<SourceChunk[]>([]);
  const [selectedDocumentId, setSelectedDocumentId] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [connection, setConnection] = useState<ConnectionStatus>("idle");
  const [query, setQuery] = useState("");
  const [pageNumber, setPageNumber] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [highlightPage, setHighlightPage] = useState<number | null>(null);
  const [pageNavigationMode, setPageNavigationMode] = useState<"page" | "citation">("page");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isAnswering, setIsAnswering] = useState(false);
  const [activeStudyTool, setActiveStudyTool] = useState<StudyTool>("mindmap");
  const [studyArtifact, setStudyArtifact] = useState<StudyArtifact | null>(null);
  const [quizAnswers, setQuizAnswers] = useState<Record<number, number>>({});
  const [isGeneratingStudy, setIsGeneratingStudy] = useState(false);
  const [notice, setNotice] = useState("");
  const [isThemeMounted, setIsThemeMounted] = useState(false);
  const [isFocusMode, setIsFocusMode] = useState(false);
  const [isSourceCollapsed, setIsSourceCollapsed] = useState(false);
  const [isReaderFullscreen, setIsReaderFullscreen] = useState(false);
  const [rightPanelMode, setRightPanelMode] = useState<"chat" | "study">("chat");
  const [chatModel, setChatModel] = useState("gemini-2.5-flash");
  const [flashcardIndex, setFlashcardIndex] = useState(0);
  const [isFlashcardFlipped, setIsFlashcardFlipped] = useState(false);
  const [mindMapZoom, setMindMapZoom] = useState(1);
  const [mindMapOffset, setMindMapOffset] = useState({ x: 0, y: 0 });
  const [slideIndex, setSlideIndex] = useState(0);
  const [mobileTab, setMobileTab] = useState<"sources" | "reader" | "chat">("reader");
  const readerRef = useRef<HTMLDivElement | null>(null);
  const pdfScrollRef = useRef<HTMLDivElement | null>(null);
  const pageRefs = useRef<Record<number, HTMLDivElement | null>>({});
  const pendingPageScrollRef = useRef<{ page: number; mode: "page" | "citation" } | null>(null);
  const scrollSyncFrameRef = useRef<number | null>(null);
  const suppressScrollSyncUntilRef = useRef(0);
  const mindMapDragRef = useRef<{ x: number; y: number; offsetX: number; offsetY: number } | null>(null);

  const selectedDocument = documents.find((document) => document.id === selectedDocumentId) ?? null;
  const selectedIsPdf = Boolean(selectedDocument?.name.toLowerCase().endsWith(".pdf") || selectedDocument?.type.includes("pdf"));
  const filteredDocuments = documents.filter((document) => document.name.toLowerCase().includes(query.toLowerCase()));

  const canChat = documents.some((document) => document.status === "ready") && connection === "connected";
  const studyChunks =
    selectedDocumentId && chunks.some((chunk) => chunk.documentId === selectedDocumentId)
      ? chunks.filter((chunk) => chunk.documentId === selectedDocumentId)
      : chunks;
  const canGenerateStudy = studyChunks.length > 0 && connection === "connected";
  const studySourceCount = new Set(studyChunks.map((chunk) => chunk.documentId)).size;
  const flashcards = studyArtifact?.type === "flashcards" ? (studyArtifact.flashcards ?? []) : [];
  const activeFlashcard = flashcards[flashcardIndex] ?? null;
  const slides = studyArtifact?.type === "slides" ? (studyArtifact.slides ?? []) : [];
  const activeSlide = slides[slideIndex] ?? null;
  const mindMapNodes = studyArtifact?.type === "mindmap" ? (studyArtifact.mindMap ?? []).slice(0, 4) : [];
  const mindMapRootTitle =
    studyArtifact?.type === "mindmap"
      ? studyArtifact.title.replace(/\s*mind\s*map\s*$/i, "").replace(/\s+/g, " ").trim()
      : "";
  const trimmedApiKey = apiKey.trim();
  const keyLooksLikeGemini =
    !trimmedApiKey || trimmedApiKey.startsWith("AIza") || trimmedApiKey.startsWith("AQ.");
  const keyStatusText = apiKey.trim()
    ? "Prototype key saved for this browser session."
    : "No UI key. MhatSu will use server GEMINI_API_KEY if configured.";
  const emptyChatReason = !documents.length
    ? "No sources yet. Upload a PDF to start asking questions."
    : connection !== "connected"
      ? "Connect Gemini to enable document chat."
      : "";

  useEffect(() => {
    setIsThemeMounted(true);
    const sessionKey = window.sessionStorage.getItem("mhatsu-gemini-api-key");
    if (sessionKey) {
      setApiKey(sessionKey);
    }
    const sessionModel = window.sessionStorage.getItem("mhatsu-chat-model");
    if (sessionModel && chatModels.some((model) => model.id === sessionModel)) {
      setChatModel(sessionModel);
    }
  }, []);

  useEffect(() => {
    const trimmedApiKey = apiKey.trim();
    if (trimmedApiKey) {
      window.sessionStorage.setItem("mhatsu-gemini-api-key", trimmedApiKey);
    } else {
      window.sessionStorage.removeItem("mhatsu-gemini-api-key");
    }
  }, [apiKey]);

  useEffect(() => {
    window.sessionStorage.setItem("mhatsu-chat-model", chatModel);
  }, [chatModel]);

  useEffect(() => {
    const handleFullscreenChange = () => {
      const fullscreenDocument = document as FullscreenDocument;
      const activeElement = document.fullscreenElement ?? fullscreenDocument.webkitFullscreenElement ?? null;
      const isReaderActive = activeElement === readerRef.current;

      setIsReaderFullscreen(isReaderActive);
      if (!activeElement) setIsFocusMode(false);
    };

    document.addEventListener("fullscreenchange", handleFullscreenChange);
    document.addEventListener("webkitfullscreenchange", handleFullscreenChange);

    return () => {
      document.removeEventListener("fullscreenchange", handleFullscreenChange);
      document.removeEventListener("webkitfullscreenchange", handleFullscreenChange);
    };
  }, []);

  useEffect(() => {
    setFlashcardIndex(0);
    setIsFlashcardFlipped(false);
    setSlideIndex(0);
    setQuizAnswers({});
  }, [studyArtifact?.title, studyArtifact?.type]);

  useEffect(() => {
    return () => {
      if (scrollSyncFrameRef.current !== null) {
        window.cancelAnimationFrame(scrollSyncFrameRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!selectedDocument) return;
    setPageNumber((current) => Math.min(Math.max(1, current), selectedDocument.pageCount || 1));
  }, [selectedDocument]);

  useEffect(() => {
    pageRefs.current = {};
    if (!pendingPageScrollRef.current) {
      pendingPageScrollRef.current = { page: 1, mode: "page" };
    }
    pdfScrollRef.current?.scrollTo({ top: 0, behavior: "auto" });
  }, [selectedDocumentId]);

  useEffect(() => {
    if (rightPanelMode !== "study" || studyArtifact?.type !== "flashcards") return;

    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.code === "Space") {
        event.preventDefault();
        setIsFlashcardFlipped((current) => !current);
      }
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        setFlashcardIndex((current) => (flashcards.length ? (current - 1 + flashcards.length) % flashcards.length : 0));
        setIsFlashcardFlipped(false);
      }
      if (event.key === "ArrowRight") {
        event.preventDefault();
        setFlashcardIndex((current) => (flashcards.length ? (current + 1) % flashcards.length : 0));
        setIsFlashcardFlipped(false);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [flashcards.length, rightPanelMode, studyArtifact?.type]);

  const processFiles = useCallback(
    async (files: FileList | File[]) => {
      setNotice("");
      const accepted = Array.from(files);

      for (const file of accepted) {
        const extension = file.name.split(".").pop()?.toLowerCase();
        if (!["pdf", "txt"].includes(extension ?? "")) {
          setNotice("This file type is not supported yet. Please upload a PDF or TXT file.");
          continue;
        }

        const documentId = crypto.randomUUID();
        const objectUrl = URL.createObjectURL(file);
        const optimisticDocument: SourceDocument = {
          id: documentId,
          name: file.name,
          type: file.type || "application/pdf",
          pageCount: 0,
          status: "processing",
          objectUrl,
          createdAt: Date.now()
        };

        setDocuments((current) => [...current, optimisticDocument]);
        setSelectedDocumentId((current) => current ?? documentId);

        try {
          const body = new FormData();
          body.append("file", file);

          const processResponse = await fetch("/api/process", { method: "POST", body });
          const processed = (await processResponse.json()) as { pageCount?: number; pages?: PageText[]; error?: string };
          if (!processResponse.ok || !processed.pages) throw new Error(processed.error ?? "Processing failed");

          const chunkShells = chunkPages(documentId, file.name, processed.pages);
          const embeddings =
            chunkShells.length > 0 ? await createEmbeddings(chunkShells.map((chunk) => chunk.text), apiKey) : [];
          const embeddedChunks = chunkShells.map((chunk, index) => ({ ...chunk, embedding: embeddings[index] ?? [] }));

          setChunks((current) => [...current, ...embeddedChunks]);
          setDocuments((current) =>
            current.map((document) =>
              document.id === documentId
                ? { ...document, pageCount: processed.pageCount ?? processed.pages!.length, status: "ready" }
                : document
            )
          );

          fetch("/api/supabase/upsert", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chunks: embeddedChunks })
          }).catch(() => undefined);
        } catch (error) {
          setNotice(
            error instanceof Error
              ? `Document indexing failed: ${error.message}`
              : "Reading and indexing document failed"
          );
          setDocuments((current) =>
            current.map((document) => (document.id === documentId ? { ...document, status: "failed" } : document))
          );
        }
      }
    },
    [apiKey]
  );

  const testConnection = async () => {
    setConnection("checking");
    setNotice("");
    const response = await fetch("/api/gemini/test", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(trimmedApiKey ? { "x-gemini-api-key": trimmedApiKey } : {})
      },
      body: JSON.stringify({ model: chatModel })
    });

    setConnection(response.ok ? "connected" : "failed");
    if (!response.ok) {
      const data = (await response.json().catch(() => null)) as { message?: string } | null;
      setNotice(data?.message ?? "Gemini connection failed. Check your API key and try again.");
    }
  };

  const deleteDocument = (documentId: string) => {
    const document = documents.find((candidate) => candidate.id === documentId);
    if (document) URL.revokeObjectURL(document.objectUrl);
    setDocuments((current) => current.filter((candidate) => candidate.id !== documentId));
    setChunks((current) => current.filter((chunk) => chunk.documentId !== documentId));
    setSelectedDocumentId((current) => (current === documentId ? null : current));
  };

  const jumpToCitation = (citation: Citation) => {
    const document = documents.find(
      (candidate) => candidate.id === citation.documentId || candidate.name === citation.documentName
    );
    if (!document) return;
    const nextPage = Math.min(Math.max(1, citation.pageNumber), document.pageCount || citation.pageNumber);
    pendingPageScrollRef.current = { page: nextPage, mode: "citation" };
    setSelectedDocumentId(document.id);
    setPageNavigationMode("citation");
    setPageNumber(nextPage);
    setHighlightPage(nextPage);
    setMobileTab("reader");
  };

  const toggleReaderFullscreen = useCallback(async () => {
    const target = readerRef.current as FullscreenTarget | null;
    if (!target) return;

    setNotice("");

    const fullscreenDocument = document as FullscreenDocument;
    const activeElement = document.fullscreenElement ?? fullscreenDocument.webkitFullscreenElement ?? null;

    try {
      if (activeElement) {
        if (document.exitFullscreen) {
          await document.exitFullscreen();
        } else {
          await fullscreenDocument.webkitExitFullscreen?.();
        }
        setIsFocusMode(false);
        setIsReaderFullscreen(false);
        return;
      }

      setIsFocusMode(true);

      if (target.requestFullscreen) {
        await target.requestFullscreen();
      } else if (target.webkitRequestFullscreen) {
        await target.webkitRequestFullscreen();
      } else {
        setNotice("Fullscreen is not supported in this browser. Reader focus mode is active.");
      }
    } catch {
      setNotice("Browser fullscreen was blocked. Reader focus mode is still active.");
      setIsReaderFullscreen(false);
    }
  }, []);

  const scrollToRenderedPage = useCallback((page: number, mode: "page" | "citation", behavior: ScrollBehavior) => {
    const container = pdfScrollRef.current;
    const target =
      pageRefs.current[page] ??
      (container?.querySelector(`[data-pdf-page="${page}"]`) as HTMLDivElement | null);
    if (!container || !target) return false;

    suppressScrollSyncUntilRef.current = Date.now() + 1200;
    const top =
      mode === "citation"
        ? target.offsetTop - container.clientHeight / 2 + target.offsetHeight / 2
        : target.offsetTop - 24;

    container.scrollTo({ top: Math.max(0, top), behavior });

    window.setTimeout(() => {
      container.scrollTop = Math.max(0, top);
    }, behavior === "smooth" ? 260 : 0);

    return true;
  }, []);

  const syncPageFromScroll = useCallback(() => {
    if (Date.now() < suppressScrollSyncUntilRef.current) return;

    const container = pdfScrollRef.current;
    if (!container || !selectedDocument?.pageCount) return;

    const containerRect = container.getBoundingClientRect();
    const anchor = containerRect.top + Math.min(160, container.clientHeight * 0.28);
    let nearestPage = pageNumber;
    let nearestDistance = Number.POSITIVE_INFINITY;

    for (let page = 1; page <= selectedDocument.pageCount; page += 1) {
      const node = pageRefs.current[page];
      if (!node) continue;
      const rect = node.getBoundingClientRect();
      const distance = Math.abs(rect.top - anchor);
      if (rect.bottom >= containerRect.top + 32 && rect.top <= containerRect.bottom - 32 && distance < nearestDistance) {
        nearestDistance = distance;
        nearestPage = page;
      }
    }

    if (nearestPage !== pageNumber) {
      setPageNavigationMode("page");
      setPageNumber(nearestPage);
      setHighlightPage(null);
    }
  }, [pageNumber, selectedDocument?.pageCount]);

  useEffect(() => {
    const pending = pendingPageScrollRef.current;
    const timers: number[] = [];

    if (pending?.page === pageNumber) {
      [0, 80, 240, 520].forEach((delay, index) => {
        const timer = window.setTimeout(() => {
          const didScroll = scrollToRenderedPage(pending.page, pending.mode, index === 0 ? "smooth" : "auto");
          if (didScroll && index > 0) pendingPageScrollRef.current = null;
        }, delay);
        timers.push(timer);
      });
    }

    if (highlightPage) {
      const timeout = window.setTimeout(() => setHighlightPage(null), pageNavigationMode === "citation" ? 2600 : 1200);
      timers.push(timeout);
    }

    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [highlightPage, pageNavigationMode, pageNumber, scrollToRenderedPage, selectedDocumentId]);

  const askQuestion = async (question: string) => {
    if (!question.trim() || !canChat) return;

    setInput("");
    setIsAnswering(true);
    setNotice("");

    const questionMessage: ChatMessage = { id: crypto.randomUUID(), role: "user", content: question.trim() };
    const answerId = crypto.randomUUID();
    setMessages((current) => [...current, questionMessage, { id: answerId, role: "assistant", content: "" }]);

    let retrieved: SourceChunk[] = [];
    try {
      const [questionEmbedding] = await createEmbeddings([question], apiKey);
      const searchableChunks =
        selectedDocumentId && chunks.some((chunk) => chunk.documentId === selectedDocumentId)
          ? chunks.filter((chunk) => chunk.documentId === selectedDocumentId)
          : chunks;
      retrieved =
        searchableChunks.length <= 20
          ? searchableChunks
          : selectQuestionChunks(searchableChunks, questionEmbedding, question);

      if (!retrieved.length) {
        setMessages((current) =>
          current.map((message) => (message.id === answerId ? { ...message, content: NO_ANSWER, citations: [] } : message))
        );
        return;
      }

      const response = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(apiKey.trim() ? { "x-gemini-api-key": apiKey.trim() } : {})
        },
        body: JSON.stringify({ question, chunks: retrieved, model: chatModel })
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        throw new Error(errorText || "Gemini chat generation failed");
      }
      if (!response.body) throw new Error("No response body");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let content = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        content += decoder.decode(value, { stream: true });
        setMessages((current) =>
          current.map((message) => (message.id === answerId ? { ...message, content } : message))
        );
      }

      const normalizedAnswer = content.replace(/\s+/g, " ").trim();
      const returnedNoAnswer =
        normalizedAnswer === NO_ANSWER ||
        normalizedAnswer.includes(NO_ANSWER) ||
        /could not find a confirmed answer/i.test(normalizedAnswer);
      const finalContent = returnedNoAnswer && retrieved.length ? createFallbackSummary(retrieved, question) : content;
      const verifiedCitations = parseCitations(finalContent, retrieved);
      const fallbackSources = uniqueChunkSources(retrieved).slice(0, 4).map((chunk) => ({
        documentId: chunk.documentId,
        documentName: chunk.documentName,
        pageNumber: chunk.pageNumber,
        excerpt: buildExcerpt(chunk.text)
      }));

      setMessages((current) =>
        current.map((message) =>
          message.id === answerId
            ? {
                ...message,
                content: finalContent || NO_ANSWER,
                citations: verifiedCitations.length ? verifiedCitations : fallbackSources
              }
            : message
        )
      );
    } catch (error) {
      const errorMessage =
        error instanceof Error && error.message.trim()
          ? error.message
          : "I could not generate an answer from Gemini. Try Gemini 2.5 Flash or check your API quota.";
      setMessages((current) =>
        current.map((message) =>
          message.id === answerId
            ? {
                ...message,
                content: errorMessage,
                citations: []
              }
            : message
        )
      );
    } finally {
      setIsAnswering(false);
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void askQuestion(input);
  };

  const handleInputKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void askQuestion(input);
    }
  };

  const generateStudyArtifact = async (type: StudyTool) => {
    if (!canGenerateStudy) return;

    setActiveStudyTool(type);
    setIsGeneratingStudy(true);
    setNotice("");

    try {
      const response = await fetch("/api/study", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(apiKey.trim() ? { "x-gemini-api-key": apiKey.trim() } : {})
        },
        body: JSON.stringify({ type, chunks: studyChunks, model: chatModel })
      });

      const artifact = (await response.json().catch(() => null)) as (StudyArtifact & { error?: string }) | null;
      if (!response.ok || !artifact) {
        throw new Error(artifact?.error ?? "Could not generate study material");
      }
      setStudyArtifact(artifact);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not generate study material");
    } finally {
      setIsGeneratingStudy(false);
    }
  };

  const sourcePanel = (
    <aside className="flex h-full min-h-0 flex-col border-r bg-card/80 backdrop-blur-xl">
      <div className="flex items-center justify-between px-5 py-4">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center overflow-hidden rounded-lg border bg-white shadow-sm">
            <img src="/mhatsu-logo.png" alt="MhatSu" className="h-full w-full object-cover" />
          </div>
          <div>
            <div className="wordmark text-base font-semibold tracking-tight">MhatSu</div>
            <div className="text-xs text-muted-foreground">Source intelligence</div>
          </div>
        </div>
        <Button variant="ghost" size="icon-sm" onClick={() => setIsSourceCollapsed(true)} aria-label="Collapse sources">
          <PanelLeft className="h-4 w-4" />
        </Button>
      </div>

      <div className="space-y-4 px-4">
        <label
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.preventDefault();
            void processFiles(event.dataTransfer.files);
          }}
          className="flex cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed border-border bg-background/70 px-4 py-6 text-center transition-colors hover:border-primary/50 hover:bg-accent/40"
        >
          <Upload className="mb-3 h-5 w-5 text-primary" />
          <span className="text-sm font-medium">Drop PDFs or TXT files here</span>
          <span className="mt-1 text-xs text-muted-foreground">or choose files to upload</span>
          <input
            type="file"
            multiple
            accept=".pdf,.txt,application/pdf,text/plain"
            className="sr-only"
            onChange={(event) => {
              if (event.target.files) void processFiles(event.target.files);
              event.currentTarget.value = "";
            }}
          />
        </label>

        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search sources"
            className="pl-9"
          />
        </div>
      </div>

      <ScrollArea className="mt-4 flex-1 px-3">
        {!documents.length ? (
          <div className="px-2 py-8 text-sm text-muted-foreground">No sources yet. Upload a PDF to start asking questions.</div>
        ) : (
          <div className="space-y-1 pb-4">
            {filteredDocuments.map((document) => (
              <button
                key={document.id}
                onClick={() => {
                  setSelectedDocumentId(document.id);
                  setPageNavigationMode("page");
                  setPageNumber(1);
                  setHighlightPage(null);
                  setMobileTab("reader");
                }}
                className={cn(
                  "group flex w-full items-center gap-3 rounded-lg px-3 py-3 text-left transition-colors hover:bg-accent/70",
                  selectedDocumentId === document.id && "bg-accent text-accent-foreground"
                )}
              >
                <FileText className="h-4 w-4 shrink-0 text-primary" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{document.name}</span>
                  <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                    {document.pageCount || "?"} pages · {statusCopy(document.status)}
                  </span>
                </span>
                {document.status === "processing" && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
                <span
                  role="button"
                  tabIndex={0}
                  onClick={(event) => {
                    event.stopPropagation();
                    deleteDocument(document.id);
                  }}
                  className="rounded-md p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-background hover:text-destructive group-hover:opacity-100"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </span>
              </button>
            ))}
          </div>
        )}
      </ScrollArea>

      <div className="border-t p-4">
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-muted-foreground">Appearance</span>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
              aria-label="Toggle dark mode"
              disabled={!isThemeMounted}
            >
              {isThemeMounted && resolvedTheme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </Button>
          </div>
          <div className="space-y-2">
            <div className="relative">
              <Input
                type={showKey ? "text" : "password"}
                value={apiKey}
                onChange={(event) => {
                  setApiKey(event.target.value);
                  setConnection("idle");
                }}
                placeholder="Paste Gemini API key"
                className="pr-9"
                autoComplete="off"
              />
              <Button
                variant="ghost"
                size="icon-sm"
                className="absolute right-1 top-1"
                onClick={() => setShowKey((current) => !current)}
                aria-label="Show or hide Gemini API key"
              >
                {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </Button>
            </div>
            <div className="rounded-lg border bg-background/70 p-3">
              <div className="flex items-center justify-between gap-3">
                <ConnectionIndicator status={connection} />
                <div className="flex gap-2">
                  {apiKey.trim() && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setApiKey("");
                        setConnection("idle");
                        setNotice("");
                      }}
                    >
                      Clear
                    </Button>
                  )}
                  <Button variant="outline" size="sm" onClick={testConnection} disabled={connection === "checking"}>
                    {connection === "checking" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                    Test
                  </Button>
                </div>
              </div>
              <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{keyStatusText}</p>
              {!keyLooksLikeGemini && (
                <p className="mt-2 rounded-md bg-amber-500/10 px-2 py-1.5 text-xs text-amber-700 dark:text-amber-300">
                  This key format is unusual. Use the Copy key button in Google AI Studio and paste the full value.
                </p>
              )}
              {connection === "failed" && (
                <p className="mt-2 rounded-md bg-destructive/10 px-2 py-1.5 text-xs text-destructive">
                  {notice || "Gemini connection failed. Check your API key and try again."}
                </p>
              )}
              {connection === "connected" && (
                <p className="mt-2 rounded-md bg-emerald-500/10 px-2 py-1.5 text-xs text-emerald-600 dark:text-emerald-400">
                  Gemini is connected. Upload a document to generate embeddings and chat.
                </p>
              )}
            </div>
          </div>
          {notice && connection !== "failed" && <p className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">{notice}</p>}
        </div>
      </div>
    </aside>
  );

  const sourceRail = (
    <aside className="flex h-full min-h-0 flex-col items-center gap-4 border-r bg-card/80 px-2 py-4 backdrop-blur-xl">
      <Button variant="ghost" size="icon-sm" onClick={() => setIsSourceCollapsed(false)} aria-label="Show sources">
        <PanelLeft className="h-4 w-4 rotate-180" />
      </Button>
      <div className="flex h-9 w-9 items-center justify-center overflow-hidden rounded-lg border bg-white shadow-sm">
        <img src="/mhatsu-logo.png" alt="MhatSu" className="h-full w-full object-cover" />
      </div>
      <div className="h-px w-8 bg-border" />
      <div className="text-xs font-medium text-muted-foreground [writing-mode:vertical-rl]">Sources</div>
    </aside>
  );

  const readerPanel = (
    <main
      ref={readerRef}
      data-fullscreen={isReaderFullscreen ? "true" : undefined}
      className="flex h-full min-h-0 flex-col bg-background data-[fullscreen=true]:h-screen data-[fullscreen=true]:w-screen"
    >
      {selectedDocument ? (
        <>
          <div className="flex h-14 shrink-0 items-center justify-between border-b bg-card/70 px-4 backdrop-blur-xl">
            <div className="min-w-0">
              <div className="truncate text-sm font-medium">{selectedDocument.name}</div>
              <div className="text-xs text-muted-foreground">Focused reader</div>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="icon-sm" onClick={() => setZoom((current) => Math.max(0.6, current - 0.1))}>
                <ZoomOut className="h-4 w-4" />
              </Button>
              <span className="w-12 text-center text-xs text-muted-foreground">{Math.round(zoom * 100)}%</span>
              <Button variant="ghost" size="icon-sm" onClick={() => setZoom((current) => Math.min(1.8, current + 0.1))}>
                <ZoomIn className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => void toggleReaderFullscreen()}
                aria-label={isReaderFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
              >
                {isReaderFullscreen ? <Minimize2 className="h-4 w-4" /> : <Fullscreen className="h-4 w-4" />}
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => setIsFocusMode((current) => !current)}
                aria-label={isFocusMode ? "Exit focus mode" : "Enter focus mode"}
              >
                {isFocusMode ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
              </Button>
            </div>
          </div>
          <div className="flex min-h-0 flex-1">
            <div
              ref={pdfScrollRef}
              className="flex-1 overflow-y-auto app-scrollbar reader-rhythm"
              onScroll={() => {
                if (scrollSyncFrameRef.current !== null) return;
                scrollSyncFrameRef.current = window.requestAnimationFrame(() => {
                  scrollSyncFrameRef.current = null;
                  syncPageFromScroll();
                });
              }}
            >
              <div className="relative mx-auto flex max-w-5xl flex-col items-center gap-7 px-6 py-8">
              {selectedIsPdf ? (
                <Document
                  key={selectedDocument.id}
                  file={selectedDocument.objectUrl}
                  loading={<div className="py-20 text-sm text-muted-foreground">Loading document...</div>}
                  error={<div className="py-20 text-sm text-destructive">Unable to render this PDF.</div>}
                  onLoadSuccess={({ numPages }) => {
                    if (!selectedDocument.pageCount && numPages) {
                      setDocuments((current) =>
                        current.map((document) =>
                          document.id === selectedDocument.id ? { ...document, pageCount: numPages } : document
                        )
                      );
                    }
                  }}
                >
                  {Array.from({ length: selectedDocument.pageCount || 1 }, (_, index) => {
                    const page = index + 1;
                    return (
                      <div
                        key={`${selectedDocument.id}-${page}-${zoom}`}
                        data-pdf-page={page}
                        ref={(node) => {
                          pageRefs.current[page] = node;
                        }}
                        className={cn(
                          "pdf-page scroll-mt-6 rounded-sm bg-white p-4 shadow-soft ring-1 ring-black/5 transition-all dark:bg-neutral-100",
                          highlightPage === page && "ring-4 ring-primary/45"
                        )}
                      >
                        <Page pageNumber={page} scale={zoom} width={720} />
                      </div>
                    );
                  })}
                </Document>
              ) : (
                <div
                  ref={(node) => {
                    pageRefs.current[1] = node;
                  }}
                  className={cn(
                    "w-full max-w-3xl rounded-lg border bg-card p-8 text-sm leading-7 shadow-soft transition-all",
                    highlightPage === 1 && "ring-4 ring-primary/45"
                  )}
                >
                  {chunks
                    .filter((chunk) => chunk.documentId === selectedDocument.id)
                    .sort((a, b) => a.chunkIndex - b.chunkIndex)
                    .map((chunk) => chunk.text)
                    .join("\n\n")}
                </div>
              )}
              </div>
            </div>
          </div>
        </>
      ) : (
        <div className="flex h-full items-center justify-center px-6">
          <div className="max-w-sm text-center">
            <div className="mx-auto mb-6 flex h-24 w-20 items-center justify-center rounded-lg border bg-card shadow-soft">
              <FileText className="h-9 w-9 text-primary" />
            </div>
            <h1 className="text-xl font-semibold">Upload a document to begin your research</h1>
            <p className="mt-2 text-sm text-muted-foreground">No sources yet. Upload a PDF to start asking questions.</p>
            <label className="mt-6 inline-flex">
              <input
                type="file"
                multiple
                accept=".pdf,.txt,application/pdf,text/plain"
                className="sr-only"
                onChange={(event) => {
                  if (event.target.files) void processFiles(event.target.files);
                }}
              />
              <span className="inline-flex h-9 cursor-pointer items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground shadow-sm">
                <Upload className="h-4 w-4" />
                Upload document
              </span>
            </label>
          </div>
        </div>
      )}
    </main>
  );

  const renderAnswer = (message: ChatMessage) => {
    const parts = message.content.split(/(\[[^,\]]+,\s*p\.\s*\d+\])/gi);
    return parts.map((part, index) => {
      const match = part.match(/^\[([^,\]]+),\s*p\.\s*(\d+)\]$/i);
      if (!match) return <span key={`${part}-${index}`}>{part}</span>;
      const citation = message.citations?.find(
        (candidate) => candidate.documentName === match[1].trim() && candidate.pageNumber === Number(match[2])
      );
      if (!citation) return <span key={`${part}-${index}`}>{part}</span>;

      return (
        <Tooltip key={`${part}-${index}`}>
          <TooltipTrigger asChild>
            <button onClick={() => jumpToCitation(citation)} className="font-medium text-primary underline-offset-4 hover:underline">
              {part}
            </button>
          </TooltipTrigger>
          <TooltipContent>
            <div className="font-medium">{citation.documentName}</div>
            <div className="text-muted-foreground">Page {citation.pageNumber}</div>
            <p className="mt-2 leading-relaxed">{citation.excerpt}</p>
          </TooltipContent>
        </Tooltip>
      );
    });
  };

  const SourceChips = ({ sources }: { sources: Array<Partial<StudySource> & Partial<Citation>> }) => {
    const validSources = sources
      .filter((source) => source.documentName && Number.isFinite(Number(source.pageNumber)))
      .slice(0, 3)
      .map((source) => ({
        documentId: source.documentId,
        documentName: source.documentName ?? "",
        pageNumber: Number(source.pageNumber),
        excerpt: source.excerpt ?? ""
      }));

    if (!validSources.length) return null;

    return (
      <div className="mt-3 flex flex-wrap gap-1.5">
        {validSources.map((source, index) => (
          <button
            key={`${source.documentName}-${source.pageNumber}-${source.excerpt.slice(0, 12)}-${index}`}
            onClick={(event) => {
              event.stopPropagation();
              jumpToCitation(source);
            }}
            title={`${formatDocumentName(source.documentName)}, page ${source.pageNumber}`}
            className="max-w-full rounded-md border bg-background px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:text-primary"
          >
            <span className="inline-flex max-w-full items-center gap-1">
              <span className="truncate">{formatDocumentName(source.documentName)}</span>
              <span className="shrink-0">p. {source.pageNumber}</span>
            </span>
          </button>
        ))}
      </div>
    );
  };

  const moveFlashcard = (direction: number) => {
    if (!flashcards.length) return;
    setFlashcardIndex((current) => (current + direction + flashcards.length) % flashcards.length);
    setIsFlashcardFlipped(false);
  };

  const jumpToFirstSource = (sources?: StudySource[]) => {
    if (sources?.[0]) jumpToCitation(sources[0]);
  };

  const panMindMap = useCallback((left: number, top: number) => {
    setMindMapOffset((current) => ({ x: current.x - left, y: current.y - top }));
  }, []);

  const startMindMapPan = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest("button")) return;
    mindMapDragRef.current = {
      x: event.clientX,
      y: event.clientY,
      offsetX: mindMapOffset.x,
      offsetY: mindMapOffset.y
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }, [mindMapOffset.x, mindMapOffset.y]);

  const moveMindMapPan = useCallback((event: PointerEvent<HTMLDivElement>) => {
    const drag = mindMapDragRef.current;
    if (!drag) return;
    event.preventDefault();
    setMindMapOffset({
      x: drag.offsetX + event.clientX - drag.x,
      y: drag.offsetY + event.clientY - drag.y
    });
  }, []);

  const stopMindMapPan = useCallback((event: PointerEvent<HTMLDivElement>) => {
    mindMapDragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  const exportSlidesMarkdown = () => {
    if (!slides.length) return;
    const markdown = slides
      .map((slide, index) => {
        const bullets = slide.bullets.map((bullet) => `- ${bullet}`).join("\n");
        const sources = slide.sources
          .map((source) => `${formatDocumentName(source.documentName)}, p. ${source.pageNumber}`)
          .join("; ");
        return `## Slide ${index + 1}: ${slide.title}\n\n${bullets}\n\nSpeaker notes: ${slide.speakerNotes}\n\nSources: ${sources}`;
      })
      .join("\n\n---\n\n");

    void navigator.clipboard.writeText(markdown);
  };

  const studyPanel = (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <BrainCircuit className="h-4 w-4 text-primary" />
          <div>
            <div className="text-xs font-semibold">Study tools</div>
            <div className="text-[11px] text-muted-foreground">Generated only from selected sources</div>
          </div>
        </div>
        {studyArtifact && (
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => navigator.clipboard.writeText(JSON.stringify(studyArtifact, null, 2))}
            aria-label="Copy study artifact"
          >
            <Download className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>

      <div className="grid grid-cols-2 gap-2">
        {studyTools.map((tool) => {
          const Icon = tool.icon;
          return (
            <Button
              key={tool.type}
              variant={activeStudyTool === tool.type ? "secondary" : "outline"}
              size="sm"
              className="justify-start"
              disabled={!canGenerateStudy || isGeneratingStudy}
              onClick={() => void generateStudyArtifact(tool.type)}
            >
              <Icon className="h-3.5 w-3.5" />
              {tool.label}
            </Button>
          );
        })}
      </div>

      {!canGenerateStudy && (
        <div className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
          {connection !== "connected" ? "Connect Gemini to generate study material." : "Upload and select a source first."}
        </div>
      )}

      {isGeneratingStudy && (
        <div className="flex items-center gap-2 rounded-md bg-muted px-3 py-3 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Preparing source-grounded material...
        </div>
      )}

      {studyArtifact && !isGeneratingStudy && (
        <div className="space-y-3">
          {studyArtifact.type === "mindmap" && (
            <div className="overflow-hidden rounded-lg border border-[#30363d] bg-[#1f2328] text-zinc-100 shadow-soft">
              <div className="flex h-11 items-center justify-between border-b border-white/10 px-4">
                <div className="text-sm text-zinc-300">Studio &gt; App</div>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="text-zinc-300 hover:bg-white/10 hover:text-white"
                  onClick={() => setIsFocusMode((current) => !current)}
                  aria-label={isFocusMode ? "Exit focus mode" : "Enter focus mode"}
                >
                  {isFocusMode ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
                </Button>
              </div>

              <div className="px-4 pt-5">
                <h3 className="text-xl font-medium text-zinc-100">{mindMapRootTitle || studyArtifact.title}</h3>
                <button
                  onClick={() => jumpToFirstSource(studyArtifact.mindMap?.[0]?.sources)}
                  className="mt-2 rounded-full border border-white/10 px-4 py-1.5 text-sm font-medium text-zinc-200 transition-colors hover:bg-white/10"
                >
                  View {studySourceCount || 1} source{(studySourceCount || 1) > 1 ? "s" : ""}
                </button>
              </div>

              <div
                className="relative h-[560px] cursor-grab overflow-hidden touch-none active:cursor-grabbing"
                onPointerDown={startMindMapPan}
                onPointerMove={moveMindMapPan}
                onPointerUp={stopMindMapPan}
                onPointerCancel={stopMindMapPan}
                onPointerLeave={stopMindMapPan}
              >
                <div
                  className="relative h-[680px] min-w-[1120px] origin-center"
                  style={{ transform: `translate(${mindMapOffset.x}px, ${mindMapOffset.y}px) scale(${mindMapZoom})` }}
                >
                  <svg className="pointer-events-none absolute inset-0 h-full w-full" viewBox="0 0 1120 680" preserveAspectRatio="none">
                    {mindMapNodes.map((node, index, nodes) => {
                      const primaryY = 160 + index * (nodes.length > 2 ? 120 : 136);
                      return (
                        <path
                          key={`root-${index}-${node.title}`}
                          d={`M 292 354 C 346 ${primaryY + 29}, 370 ${primaryY + 29}, 430 ${primaryY + 29}`}
                          fill="none"
                          stroke="#9aa7ff"
                          strokeWidth="2.4"
                          strokeLinecap="round"
                        />
                      );
                    })}
                    {mindMapNodes.map((node, index, nodes) => {
                      const children = (node.children?.length ? node.children : [{ title: node.summary, detail: node.summary, sources: node.sources }]).slice(0, 3);
                      const primaryY = 160 + index * (nodes.length > 2 ? 120 : 136);
                      return children.map((child, childIndex) => {
                        const childY = primaryY + 29 + (childIndex - (children.length - 1) / 2) * 64;
                        return (
                          <path
                            key={`child-line-${index}-${childIndex}-${child.title}`}
                            d={`M 650 ${primaryY + 29} C 710 ${childY}, 730 ${childY}, 780 ${childY}`}
                            fill="none"
                            stroke="#9aa7ff"
                            strokeWidth="2.1"
                            strokeLinecap="round"
                          />
                        );
                      });
                    })}
                  </svg>

                  <button
                    onClick={() => jumpToFirstSource(studyArtifact.mindMap?.[0]?.sources)}
                    className="absolute left-6 top-[322px] flex h-16 w-[250px] items-center rounded-lg bg-[#5f607e] px-5 text-left text-lg font-semibold leading-tight text-white shadow-[0_18px_50px_rgba(0,0,0,0.25)] transition-colors hover:bg-[#696a8b]"
                  >
                    <span className="line-clamp-2">{mindMapRootTitle || studyArtifact.title}</span>
                  </button>
                  <button
                    onClick={() => jumpToFirstSource(studyArtifact.mindMap?.[0]?.sources)}
                    className="absolute left-[284px] top-[340px] flex h-8 w-8 items-center justify-center rounded-full bg-[#4a5563] text-base font-semibold text-zinc-100 shadow"
                    aria-label="Open root source"
                  >
                    &lt;
                  </button>

                  {mindMapNodes.map((node, index, nodes) => {
                    const primaryY = 160 + index * (nodes.length > 2 ? 120 : 136);
                    const children = (node.children?.length ? node.children : [{ title: node.summary, detail: node.summary, sources: node.sources }]).slice(0, 3);
                    return (
                      <div key={`node-${index}-${node.title}`}>
                        <button
                          onClick={() => jumpToFirstSource(node.sources)}
                          className="absolute left-[430px] flex h-[58px] w-[220px] items-center rounded-lg bg-[#46515d] px-4 text-left text-base font-semibold leading-snug text-zinc-100 shadow-[0_14px_36px_rgba(0,0,0,0.22)] transition-colors hover:bg-[#515d6a]"
                          style={{ top: primaryY }}
                        >
                          <span className="line-clamp-2">{node.title}</span>
                        </button>
                        <button
                          onClick={() => jumpToFirstSource(node.sources)}
                          className="absolute left-[670px] flex h-8 w-8 items-center justify-center rounded-full bg-[#4a5563] text-base font-semibold text-zinc-100 shadow"
                          style={{ top: primaryY + 13 }}
                          aria-label={`Open source for ${node.title}`}
                        >
                          &gt;
                        </button>

                        {children.map((child, childIndex) => {
                          const childY = primaryY + (childIndex - (children.length - 1) / 2) * 64;
                          return (
                            <button
                              key={`leaf-${index}-${childIndex}-${child.title}`}
                              onClick={() => jumpToFirstSource(child.sources)}
                              className="absolute left-[780px] flex h-[58px] w-[270px] items-center rounded-lg bg-[#344d47] px-4 text-left text-base font-medium leading-snug text-zinc-100 shadow-[0_14px_36px_rgba(0,0,0,0.22)] transition-colors hover:bg-[#3d5a53]"
                              style={{ top: childY }}
                            >
                              <span className="line-clamp-2">{child.title}</span>
                            </button>
                          );
                        })}
                      </div>
                    );
                  })}

                  {!mindMapNodes.length && (
                    <div className="absolute left-6 top-[320px] max-w-md rounded-lg border border-white/10 bg-[#2d343c] px-4 py-3 text-sm text-zinc-300">
                      Generate a mind map to populate this canvas.
                    </div>
                  )}
                </div>

                <div className="absolute bottom-6 right-6 flex flex-col items-center gap-3">
                  <div className="grid grid-cols-3 gap-1 rounded-full border border-white/10 bg-[#242a31] p-1 shadow-lg">
                    <span />
                    <button
                      onClick={() => panMindMap(0, -180)}
                      className="flex h-8 w-8 items-center justify-center rounded-full text-zinc-100 hover:bg-white/10"
                      aria-label="Pan up"
                    >
                      <ChevronLeft className="h-4 w-4 rotate-90" />
                    </button>
                    <span />
                    <button
                      onClick={() => panMindMap(-220, 0)}
                      className="flex h-8 w-8 items-center justify-center rounded-full text-zinc-100 hover:bg-white/10"
                      aria-label="Pan left"
                    >
                      <ChevronLeft className="h-4 w-4" />
                    </button>
                    <button
                      onClick={() => {
                        setMindMapOffset({ x: 0, y: 0 });
                        setMindMapZoom(1);
                      }}
                      className="flex h-8 w-8 items-center justify-center rounded-full text-xs font-semibold text-zinc-100 hover:bg-white/10"
                      aria-label="Reset mind map position"
                    >
                      1:1
                    </button>
                    <button
                      onClick={() => panMindMap(220, 0)}
                      className="flex h-8 w-8 items-center justify-center rounded-full text-zinc-100 hover:bg-white/10"
                      aria-label="Pan right"
                    >
                      <ChevronRight className="h-4 w-4" />
                    </button>
                    <span />
                    <button
                      onClick={() => panMindMap(0, 180)}
                      className="flex h-8 w-8 items-center justify-center rounded-full text-zinc-100 hover:bg-white/10"
                      aria-label="Pan down"
                    >
                      <ChevronRight className="h-4 w-4 rotate-90" />
                    </button>
                    <span />
                  </div>
                  <div className="overflow-hidden rounded-full border border-white/10 bg-[#242a31] shadow-lg">
                    <button
                      onClick={() => setMindMapZoom((current) => Math.min(1.25, current + 0.08))}
                      className="flex h-10 w-10 items-center justify-center text-xl text-zinc-100 hover:bg-white/10"
                      aria-label="Zoom in"
                    >
                      +
                    </button>
                    <div className="h-px bg-white/10" />
                    <button
                      onClick={() => setMindMapZoom((current) => Math.max(0.76, current - 0.08))}
                      className="flex h-10 w-10 items-center justify-center text-xl text-zinc-100 hover:bg-white/10"
                      aria-label="Zoom out"
                    >
                      -
                    </button>
                  </div>
                  <button
                    onClick={() => navigator.clipboard.writeText(JSON.stringify(studyArtifact, null, 2))}
                    className="flex h-10 w-10 items-center justify-center rounded-full border border-white/10 bg-[#242a31] text-zinc-100 shadow-lg hover:bg-white/10"
                    aria-label="Copy mind map JSON"
                  >
                    <Download className="h-4 w-4" />
                  </button>
                </div>
              </div>

              <div className="flex gap-3 border-t border-white/10 px-4 py-4">
                <button className="rounded-full border border-white/10 px-5 py-2 text-sm font-medium text-zinc-200 hover:bg-white/10">
                  Good content
                </button>
                <button className="rounded-full border border-white/10 px-5 py-2 text-sm font-medium text-zinc-200 hover:bg-white/10">
                  Bad content
                </button>
              </div>
            </div>
          )}

          {studyArtifact.type === "flashcards" && (
            <div className="overflow-hidden rounded-xl border bg-[#1f2328] text-zinc-100 shadow-soft">
              <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
                <div className="text-sm text-zinc-300">Studio &gt; App</div>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="text-zinc-300 hover:bg-white/10 hover:text-white"
                  onClick={() => setIsFocusMode((current) => !current)}
                >
                  {isFocusMode ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
                </Button>
              </div>
              <div className="px-4 pt-4">
                <div className="text-2xl font-medium tracking-tight text-white">{studyArtifact.title}</div>
                <button
                  onClick={() => jumpToFirstSource(activeFlashcard?.sources)}
                  className="mt-3 rounded-full border border-white/10 px-4 py-2 text-sm font-medium text-zinc-200 transition-colors hover:bg-white/10"
                >
                  View {studySourceCount || 1} source{(studySourceCount || 1) > 1 ? "s" : ""}
                </button>
                <p className="mt-8 text-center text-sm font-medium text-zinc-500">
                  Press Space to flip, left/right arrows to navigate
                </p>
              </div>

              <div className="px-5 py-10">
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => setIsFlashcardFlipped((current) => !current)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") setIsFlashcardFlipped((current) => !current);
                  }}
                  className="flashcard-scene mx-auto block h-[390px] w-full max-w-[760px] text-left"
                >
                  <div className={cn("flashcard-inner relative h-full w-full", isFlashcardFlipped && "is-flipped")}>
                    <div className="flashcard-face rounded-[32px] bg-[#292b2d] p-8 shadow-[0_22px_80px_rgba(0,0,0,0.28)]">
                      <div className="text-lg font-semibold text-zinc-500">
                        {flashcards.length ? `${flashcardIndex + 1} / ${flashcards.length}` : "0 / 0"}
                      </div>
                      <div className="flex h-full items-center pb-8">
                        <div className="text-3xl font-semibold leading-tight text-white">
                          {activeFlashcard?.front ?? "Generate flashcards to begin."}
                        </div>
                      </div>
                      <div className="absolute bottom-8 left-0 right-0 text-center text-sm font-medium text-zinc-500">
                        See answer
                      </div>
                    </div>
                    <div className="flashcard-face flashcard-back overflow-hidden rounded-[32px] bg-[#2b3035] p-8 shadow-[0_22px_80px_rgba(0,0,0,0.28)]">
                      <div className="text-lg font-semibold text-emerald-400">Answer</div>
                      <div className="flex h-[270px] items-center overflow-y-auto pb-4 pr-2">
                        <div className="text-balance text-2xl font-medium leading-relaxed text-white">
                          {activeFlashcard?.back ?? "No answer available."}
                        </div>
                      </div>
                      <div className="absolute bottom-6 left-8 right-8 max-w-[calc(100%-4rem)]">
                        {activeFlashcard?.sources ? <SourceChips sources={activeFlashcard.sources} /> : null}
                      </div>
                    </div>
                  </div>
                </div>

                <div className="mt-6 flex items-center justify-center gap-5">
                  <button
                    onClick={() => moveFlashcard(-1)}
                    className="flex h-16 w-16 items-center justify-center rounded-full border border-white/10 text-zinc-300 hover:bg-white/10"
                  >
                    <ChevronLeft className="h-6 w-6" />
                  </button>
                  <button
                    onClick={() => setIsFlashcardFlipped((current) => !current)}
                    className="h-16 min-w-28 rounded-full border border-white/20 px-6 text-sm font-semibold text-zinc-200 hover:bg-white/10"
                  >
                    Flip
                  </button>
                  <button
                    onClick={() => moveFlashcard(1)}
                    className="flex h-16 w-16 items-center justify-center rounded-full border border-white/10 text-zinc-300 hover:bg-white/10"
                  >
                    <ChevronRight className="h-6 w-6" />
                  </button>
                </div>
              </div>

              <div className="flex gap-3 border-t border-white/10 px-4 py-4">
                <button className="rounded-full border border-white/10 px-5 py-2 text-sm font-medium text-zinc-200 hover:bg-white/10">
                  Good content
                </button>
                <button className="rounded-full border border-white/10 px-5 py-2 text-sm font-medium text-zinc-200 hover:bg-white/10">
                  Bad content
                </button>
              </div>
            </div>
          )}

          {studyArtifact.type === "quiz" && (
            <div className="space-y-2">
              {studyArtifact.quiz?.map((question, index) => {
                const selectedAnswer = quizAnswers[index];
                const hasAnswered = selectedAnswer !== undefined;
                const isCorrect = selectedAnswer === question.answerIndex;

                return (
                  <div key={`${question.question}-${index}`} className="rounded-lg border bg-card p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="text-sm font-medium">
                        {index + 1}. {question.question}
                      </div>
                      {hasAnswered && (
                        <span
                          className={cn(
                            "shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium",
                            isCorrect
                              ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                              : "bg-destructive/10 text-destructive"
                          )}
                        >
                          {isCorrect ? "Correct" : "Try again"}
                        </span>
                      )}
                    </div>
                    <div className="mt-2 space-y-1.5">
                      {question.options.map((option, optionIndex) => {
                        const isSelected = selectedAnswer === optionIndex;
                        const isRightAnswer = optionIndex === question.answerIndex;
                        return (
                          <button
                            key={`${option}-${optionIndex}`}
                            type="button"
                            onClick={() => setQuizAnswers((current) => ({ ...current, [index]: optionIndex }))}
                            className={cn(
                              "flex w-full items-start gap-2 rounded-md border bg-background px-2.5 py-2 text-left text-xs transition-colors hover:border-primary/40 hover:bg-accent/40",
                              hasAnswered && isRightAnswer && "border-emerald-500/50 bg-emerald-500/10",
                              hasAnswered && isSelected && !isRightAnswer && "border-destructive/50 bg-destructive/10"
                            )}
                          >
                            <span
                              className={cn(
                                "mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[11px] font-semibold",
                                hasAnswered && isRightAnswer && "border-emerald-500 bg-emerald-500 text-white",
                                hasAnswered && isSelected && !isRightAnswer && "border-destructive bg-destructive text-destructive-foreground"
                              )}
                            >
                              {String.fromCharCode(65 + optionIndex)}
                            </span>
                            <span>{option}</span>
                          </button>
                        );
                      })}
                    </div>
                    {hasAnswered && (
                      <>
                        <p className="mt-2 text-xs text-muted-foreground">{question.explanation}</p>
                        <SourceChips sources={question.sources} />
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {studyArtifact.type === "slides" && (
            <div className="overflow-hidden rounded-xl border bg-[#1f2328] text-zinc-100 shadow-soft">
              <div className="flex items-center justify-between border-b border-white/10 px-3 py-2.5">
                <div>
                  <div className="text-sm font-medium text-white">Slides</div>
                  <div className="text-[11px] text-zinc-500">
                    {slides.length ? `${slideIndex + 1} of ${slides.length}` : "No slides yet"}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="text-zinc-300 hover:bg-white/10 hover:text-white"
                    onClick={() => activeSlide && navigator.clipboard.writeText(JSON.stringify(activeSlide, null, 2))}
                    aria-label="Copy current slide"
                  >
                    <Clipboard className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="text-zinc-300 hover:bg-white/10 hover:text-white"
                    onClick={exportSlidesMarkdown}
                    aria-label="Export slides"
                  >
                    <Download className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>

              <div className="space-y-4 p-3">
                <div className="flex items-center gap-1.5 overflow-x-auto pb-1">
                  {slides.map((slide, index) => (
                    <button
                      key={`${slide.title}-${index}`}
                      onClick={() => setSlideIndex(index)}
                      className={cn(
                        "flex h-7 min-w-7 items-center justify-center rounded-full border border-white/10 text-[11px] font-medium text-zinc-500 transition-colors hover:bg-white/10 hover:text-zinc-200",
                        slideIndex === index && "border-[#9ca3ff] bg-[#9ca3ff]/20 text-white"
                      )}
                      title={slide.title}
                    >
                      {index + 1}
                    </button>
                  ))}
                </div>

                <div className="aspect-video rounded-xl border border-white/10 bg-[#24272c] p-5">
                  <div className="flex h-full flex-col">
                    <div className="text-[11px] font-semibold uppercase tracking-wide text-[#9ca3ff]">
                      Slide {slideIndex + 1}
                    </div>
                    <h3 className="mt-3 text-balance text-xl font-semibold leading-tight text-white">
                      {activeSlide?.title ?? "Generate slides to begin."}
                    </h3>
                    <ul className="mt-5 space-y-2 text-sm leading-relaxed text-zinc-300">
                      {(activeSlide?.bullets ?? []).slice(0, 5).map((bullet) => (
                        <li key={bullet} className="flex gap-2.5">
                          <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-400" />
                          <span className="line-clamp-2">{bullet}</span>
                        </li>
                      ))}
                    </ul>
                    <div className="mt-auto flex items-center justify-between gap-3 pt-4">
                      <div className="text-[11px] text-zinc-500">{studyArtifact.title}</div>
                      {activeSlide?.sources?.[0] && (
                        <button
                          onClick={() => jumpToFirstSource(activeSlide.sources)}
                          className="max-w-[48%] rounded-full border border-white/10 px-2.5 py-1 text-[11px] text-zinc-400 hover:bg-white/10"
                        >
                          <span className="inline-flex max-w-full gap-1">
                            <span className="truncate">{formatDocumentName(activeSlide.sources[0].documentName)}</span>
                            <span className="shrink-0">p. {activeSlide.sources[0].pageNumber}</span>
                          </span>
                        </button>
                      )}
                    </div>
                  </div>
                </div>

                <div className="flex items-center justify-between gap-3">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-zinc-300 hover:bg-white/10 hover:text-white"
                    onClick={() => setSlideIndex((current) => (slides.length ? (current - 1 + slides.length) % slides.length : 0))}
                  >
                    <ChevronLeft className="h-4 w-4" />
                    Previous
                  </Button>
                  <div className="text-xs font-medium text-zinc-500">
                    {slides.length ? slideIndex + 1 : 0} / {slides.length}
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-zinc-300 hover:bg-white/10 hover:text-white"
                    onClick={() => setSlideIndex((current) => (slides.length ? (current + 1) % slides.length : 0))}
                  >
                    Next
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                </div>

                <div className="rounded-lg border border-white/10 bg-white/[0.03] p-3">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">Speaker notes</div>
                  <p className="mt-1.5 line-clamp-3 text-xs leading-relaxed text-zinc-400">
                    {activeSlide?.speakerNotes ?? "Speaker notes will appear here."}
                  </p>
                  {activeSlide?.sources ? <SourceChips sources={activeSlide.sources} /> : null}
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );

  const chatPanel = (
    <section className="flex h-full min-h-0 flex-col border-l bg-card/80 backdrop-blur-xl">
      <div className="border-b px-5 py-4">
        <div className="space-y-3">
          <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold">Ask MhatSu</h2>
            <p className="mt-1 text-xs text-muted-foreground">Answers are based only on your uploaded sources</p>
          </div>
          <ConnectionIndicator status={connection} compact />
          </div>
          <div className="flex items-center gap-2">
            <label className="sr-only" htmlFor="header-chat-model">
              Gemini model
            </label>
            <select
              id="header-chat-model"
              value={chatModel}
              onChange={(event) => setChatModel(event.target.value)}
              className="h-8 min-w-0 flex-1 rounded-md border bg-background px-2 text-xs text-foreground shadow-sm outline-none transition-colors focus:border-primary"
              disabled={isAnswering}
            >
              {chatModels.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.label}
                </option>
              ))}
            </select>
            <div
              className={cn(
                "flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-[11px] font-medium",
                connection === "connected"
                  ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                  : "border-border bg-background text-muted-foreground"
              )}
            >
              <ConnectionIndicator status={connection} compact />
              <span className="hidden sm:inline">{connection === "connected" ? "API Connected" : connectionCopy(connection)}</span>
            </div>
          </div>
        </div>
        <div className="mt-4 grid grid-cols-2 rounded-lg bg-muted p-1">
          <button
            onClick={() => setRightPanelMode("chat")}
            className={cn(
              "flex h-8 items-center justify-center gap-2 rounded-md text-xs font-medium text-muted-foreground transition-colors",
              rightPanelMode === "chat" && "bg-card text-foreground shadow-sm"
            )}
          >
            <MessageSquare className="h-3.5 w-3.5" />
            Chat
          </button>
          <button
            onClick={() => setRightPanelMode("study")}
            className={cn(
              "flex h-8 items-center justify-center gap-2 rounded-md text-xs font-medium text-muted-foreground transition-colors",
              rightPanelMode === "study" && "bg-card text-foreground shadow-sm"
            )}
          >
            <BookOpen className="h-3.5 w-3.5" />
            Study
          </button>
        </div>
      </div>

      <ScrollArea className="flex-1 px-5 py-4">
        {rightPanelMode === "study" ? (
          studyPanel
        ) : (
          <div className="space-y-4">
            {!messages.length ? (
            <>
            {emptyChatReason && <div className="rounded-lg bg-muted px-3 py-2 text-sm text-muted-foreground">{emptyChatReason}</div>}
            <div className="space-y-2">
              {prompts.map((prompt) => (
                <button
                  key={prompt}
                  disabled={!canChat}
                  onClick={() => void askQuestion(prompt)}
                  className="block w-full rounded-lg border bg-background/70 px-3 py-2 text-left text-sm transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {prompt}
                </button>
              ))}
            </div>
            </>
          ) : (
            <div className="space-y-4 pb-4">
            {messages.map((message) => (
              <div key={message.id} className={cn("flex", message.role === "user" ? "justify-end" : "justify-start")}>
                <div
                  className={cn(
                    "max-w-[88%] rounded-lg px-3 py-2 text-sm leading-relaxed",
                    message.role === "user" ? "bg-primary text-primary-foreground" : "border bg-background"
                  )}
                >
                  {message.role === "assistant" && !message.content ? (
                    <div className="flex items-center gap-2 text-muted-foreground">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      Thinking from sources...
                    </div>
                  ) : message.role === "assistant" ? (
                    <>
                      <div>{renderAnswer(message)}</div>
                      {message.citations?.length ? (
                        <div className="mt-3 border-t pt-3">
                          <div className="mb-2 text-xs font-semibold text-muted-foreground">Sources</div>
                          <SourceChips sources={message.citations} />
                        </div>
                      ) : null}
                      <div className="mt-3 flex gap-1">
                        <Button variant="ghost" size="icon-sm" onClick={() => navigator.clipboard.writeText(message.content)}>
                          <Clipboard className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          disabled={isAnswering}
                          onClick={() => {
                            const lastUser = [...messages].reverse().find((candidate) => candidate.role === "user");
                            if (lastUser) void askQuestion(lastUser.content);
                          }}
                        >
                          <RefreshCw className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </>
                  ) : (
                    message.content
                  )}
                </div>
              </div>
            ))}
            </div>
          )}
          </div>
        )}
      </ScrollArea>

      {rightPanelMode === "chat" && (
      <div className="border-t p-4">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Bot className="h-3.5 w-3.5" />
            Grounded chat
          </div>
          <Button variant="ghost" size="sm" onClick={() => setMessages([])} disabled={!messages.length}>
            Clear
          </Button>
        </div>
        <form onSubmit={submit} className="flex gap-2">
          <Textarea
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={handleInputKeyDown}
            placeholder="Ask something about your sources..."
            disabled={!canChat || isAnswering}
            className="min-h-[76px]"
          />
          <Button type="submit" size="icon" disabled={!input.trim() || !canChat || isAnswering} aria-label="Send message">
            {isAnswering ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          </Button>
        </form>
      </div>
      )}
    </section>
  );

  const mobileTabs = (
    <div className="grid grid-cols-3 border-b bg-card md:hidden">
      {(["sources", "reader", "chat"] as const).map((tab) => (
        <button
          key={tab}
          onClick={() => setMobileTab(tab)}
          className={cn("px-3 py-3 text-sm capitalize text-muted-foreground", mobileTab === tab && "text-foreground")}
        >
          {tab}
        </button>
      ))}
    </div>
  );

  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex h-screen flex-col overflow-hidden bg-background text-foreground transition-colors duration-200">
        {mobileTabs}
        <PanelGroup direction="horizontal" className="hidden h-full min-h-0 md:flex">
          {!isFocusMode && (
            <>
              <Panel
                key={isSourceCollapsed ? "sources-collapsed" : "sources-expanded"}
                defaultSize={isSourceCollapsed ? 4 : 22}
                minSize={isSourceCollapsed ? 4 : 18}
                maxSize={isSourceCollapsed ? 5 : 32}
              >
                {isSourceCollapsed ? sourceRail : sourcePanel}
              </Panel>
              <PanelResizeHandle className="w-px bg-border transition-colors hover:bg-primary/40" />
            </>
          )}
          <Panel defaultSize={isFocusMode ? 100 : 51} minSize={34}>
            {readerPanel}
          </Panel>
          {!isFocusMode && (
            <>
              <PanelResizeHandle className="w-px bg-border transition-colors hover:bg-primary/40" />
              <Panel defaultSize={27} minSize={22} maxSize={38}>
                {chatPanel}
              </Panel>
            </>
          )}
        </PanelGroup>
        <div className="min-h-0 flex-1 md:hidden">
          {mobileTab === "sources" && sourcePanel}
          {mobileTab === "reader" && readerPanel}
          {mobileTab === "chat" && chatPanel}
        </div>
      </div>
    </TooltipProvider>
  );
}
