import { google, type docs_v1 } from "googleapis";
import type { OAuth2Client } from "google-auth-library";
import type { NormalizedDocument, ParagraphModel, TextRunModel } from "./patchTypes.js";

export function extractGoogleDocId(input: string) {
  const trimmed = normalizePastedDocInput(input);

  try {
    const url = new URL(trimmed);
    const pathParts = url.pathname.split("/").filter(Boolean);
    const documentIndex = pathParts.findIndex((part) => part === "document");
    if (documentIndex >= 0 && pathParts[documentIndex + 1] === "d" && pathParts[documentIndex + 2]) {
      return pathParts[documentIndex + 2];
    }

    const id = url.searchParams.get("id");
    if (id) return id;
  } catch {
    // Plain document IDs are expected to fail URL parsing.
  }

  const match = trimmed.match(/\/document\/d\/([a-zA-Z0-9_-]+)/);
  if (match?.[1]) return match[1];

  return trimmed.replace(/[?#].*$/, "");
}

function normalizePastedDocInput(input: string) {
  let normalized = input.trim().replace(/^["'<]+|[>"']+$/g, "");
  for (let index = 0; index < 2; index += 1) {
    try {
      const decoded = decodeURIComponent(normalized);
      if (decoded === normalized) break;
      normalized = decoded;
    } catch {
      break;
    }
  }
  return normalized.trim();
}

export async function getDocument(auth: OAuth2Client, documentIdOrUrl: string) {
  const documentId = extractGoogleDocId(documentIdOrUrl);
  if (!/^[a-zA-Z0-9_-]+$/.test(documentId)) {
    throw new Error("That does not look like a Google Doc ID or editable Google Docs URL.");
  }
  const docs = google.docs({ version: "v1", auth });
  try {
    const response = await docs.documents.get({ documentId });
    return normalizeDocument(response.data, documentId);
  } catch (error) {
    throw new Error(buildDocsReadErrorMessage(error, documentId));
  }
}

function buildDocsReadErrorMessage(error: unknown, documentId: string) {
  const err = error as { code?: number; response?: { status?: number; data?: { error?: { message?: string } } }; message?: string };
  const status = err.code ?? err.response?.status;
  const rawMessage = err.response?.data?.error?.message ?? err.message ?? "Google Docs API request failed.";

  if (status === 404 || /requested entity was not found/i.test(rawMessage)) {
    return [
      `Google Docs could not find document "${documentId}" for the currently connected Google account.`,
      "Confirm the pasted value is the editable Docs URL with /document/d/<id>/, not a published /document/d/e/... URL.",
      "If the doc opens in another Google account, use Switch Google and authorize that account.",
      "Also confirm the file is a native Google Doc, not a PDF/Word file in Drive."
    ].join(" ");
  }

  if (status === 403) {
    return "Google refused access to this doc. Reconnect Google, confirm the account has edit access, and verify the OAuth consent includes the Google Docs scope.";
  }

  return rawMessage;
}

export async function listRecentDocs(auth: OAuth2Client) {
  const drive = google.drive({ version: "v3", auth });
  const response = await drive.files.list({
    q: "mimeType='application/vnd.google-apps.document' and trashed=false",
    orderBy: "modifiedTime desc",
    pageSize: 10,
    fields: "files(id,name,modifiedTime,webViewLink)"
  });
  return response.data.files ?? [];
}

export function normalizeDocument(
  doc: docs_v1.Schema$Document,
  fallbackDocumentId = ""
): NormalizedDocument {
  const paragraphs: ParagraphModel[] = [];
  const content = doc.body?.content ?? [];

  for (const element of content) {
    const paragraph = element.paragraph;
    if (!paragraph) continue;

    const textRuns: TextRunModel[] = [];
    let text = "";

    for (const paragraphElement of paragraph.elements ?? []) {
      const run = paragraphElement.textRun;
      if (!run?.content) continue;
      const startIndex = paragraphElement.startIndex ?? element.startIndex ?? 0;
      const endIndex = paragraphElement.endIndex ?? startIndex + run.content.length;
      textRuns.push({
        startIndex,
        endIndex,
        text: run.content,
        style: run.textStyle as Record<string, unknown> | undefined
      });
      text += run.content;
    }

    paragraphs.push({
      paragraphIndex: paragraphs.length,
      startIndex: element.startIndex ?? textRuns[0]?.startIndex ?? 0,
      endIndex: element.endIndex ?? textRuns.at(-1)?.endIndex ?? 0,
      text,
      textRuns,
      style: paragraph.paragraphStyle as Record<string, unknown> | undefined
    });
  }

  return {
    documentId: doc.documentId ?? fallbackDocumentId,
    title: doc.title ?? "Untitled Google Doc",
    paragraphs,
    fullText: paragraphs.map((paragraph) => paragraph.text).join("")
  };
}
