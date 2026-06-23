import { NextResponse } from "next/server";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { PageText } from "@/lib/types";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const file = formData.get("file");

    if (!(file instanceof File)) {
      return NextResponse.json({ error: "No file supplied" }, { status: 400 });
    }

    const extension = file.name.split(".").pop()?.toLowerCase();
    if (!["pdf", "txt"].includes(extension ?? "")) {
      return NextResponse.json(
        { error: "This file type is not supported yet. Please upload a PDF, TXT, or DOCX file." },
        { status: 415 }
      );
    }

    if (extension === "txt") {
      const text = await file.text();
      return NextResponse.json({ pageCount: 1, pages: [{ pageNumber: 1, text }] satisfies PageText[] });
    }

    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const workerPath = path.join(process.cwd(), "node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs");
    pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(workerPath).href;
    const data = new Uint8Array(await file.arrayBuffer());
    const pdf = await pdfjs.getDocument({ data }).promise;
    const pages: PageText[] = [];

    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      const text = content.items
        .map((item) => ("str" in item ? item.str : ""))
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();

      pages.push({ pageNumber, text });
    }

    return NextResponse.json({ pageCount: pdf.numPages, pages });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Reading and indexing document failed" },
      { status: 500 }
    );
  }
}
