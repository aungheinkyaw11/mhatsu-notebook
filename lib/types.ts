export type ConnectionStatus = "idle" | "checking" | "connected" | "failed";
export type ProcessingStatus = "queued" | "processing" | "ready" | "failed";

export type SourceDocument = {
  id: string;
  name: string;
  type: string;
  pageCount: number;
  status: ProcessingStatus;
  objectUrl: string;
  createdAt: number;
};

export type PageText = {
  pageNumber: number;
  text: string;
};

export type SourceChunk = {
  id: string;
  documentId: string;
  documentName: string;
  pageNumber: number;
  chunkIndex: number;
  text: string;
  embedding: number[];
};

export type Citation = {
  documentId?: string;
  documentName: string;
  pageNumber: number;
  excerpt: string;
};

export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  citations?: Citation[];
};

export type StudyTool = "mindmap" | "flashcards" | "quiz" | "slides";

export type StudySource = {
  documentName: string;
  pageNumber: number;
  excerpt: string;
};

export type MindMapNode = {
  title: string;
  summary: string;
  sources: StudySource[];
  children: {
    title: string;
    detail: string;
    sources: StudySource[];
  }[];
};

export type Flashcard = {
  front: string;
  back: string;
  sources: StudySource[];
};

export type QuizQuestion = {
  question: string;
  options: string[];
  answerIndex: number;
  explanation: string;
  sources: StudySource[];
};

export type SlideDraft = {
  title: string;
  bullets: string[];
  speakerNotes: string;
  sources: StudySource[];
};

export type StudyArtifact = {
  type: StudyTool;
  title: string;
  summary: string;
  mindMap?: MindMapNode[];
  flashcards?: Flashcard[];
  quiz?: QuizQuestion[];
  slides?: SlideDraft[];
};
