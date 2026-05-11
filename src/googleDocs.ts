import { google, type docs_v1 } from "googleapis";
import type { OAuth2Client } from "google-auth-library";
import type { NormalizedDocument, ParagraphModel, TabModel, TextRunModel } from "./patchTypes.js";

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
    const response = await docs.documents.get({ documentId, includeTabsContent: true });
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
  const listMetadata = buildListMetadata(doc);
  const tabs = normalizeTabs(doc, listMetadata);
  const paragraphs: ParagraphModel[] = [];
  for (const tab of tabs) paragraphs.push(...tab.paragraphs);

  return {
    documentId: doc.documentId ?? fallbackDocumentId,
    title: doc.title ?? "Untitled Google Doc",
    tabs,
    paragraphs,
    fullText: tabs.map((tab) => `[${tab.title}]\n${tab.paragraphs.map((paragraph) => paragraph.text).join("")}`).join("\n")
  };
}

function normalizeTabs(doc: docs_v1.Schema$Document, listMetadata: Map<string, Map<number, ReturnType<typeof getListLevelMetadata>>>): TabModel[] {
  const rawTabs = (doc as unknown as { tabs?: unknown[] }).tabs ?? [];
  if (rawTabs.length > 0) {
    let paragraphIndex = 0;
    const flattened: TabModel[] = [];
    const visit = (tab: unknown, depth: number) => {
      const typedTab = tab as {
        tabProperties?: { tabId?: string; title?: string };
        documentTab?: { body?: docs_v1.Schema$Body };
        childTabs?: unknown[];
      };
      const tabId = typedTab.tabProperties?.tabId ?? `tab-${flattened.length}`;
      const title = typedTab.tabProperties?.title ?? `Tab ${flattened.length + 1}`;
      const paragraphs = normalizeParagraphs(
        typedTab.documentTab?.body?.content ?? [],
        tabId,
        title,
        listMetadata,
        () => paragraphIndex++
      );
      flattened.push({ tabId, title, depth, paragraphs });
      for (const child of typedTab.childTabs ?? []) visit(child, depth + 1);
    };

    for (const tab of rawTabs) visit(tab, 0);
    return flattened;
  }

  let paragraphIndex = 0;
  return [{
    tabId: "",
    title: "Main",
    depth: 0,
    paragraphs: normalizeParagraphs(doc.body?.content ?? [], "", "Main", listMetadata, () => paragraphIndex++)
  }];
}

function normalizeParagraphs(
  content: docs_v1.Schema$StructuralElement[],
  tabId: string,
  tabTitle: string,
  listMetadata: Map<string, Map<number, ReturnType<typeof getListLevelMetadata>>>,
  nextParagraphIndex: () => number
) {
  const paragraphs: ParagraphModel[] = [];
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
        tabId,
        startIndex,
        endIndex,
        text: run.content,
        style: run.textStyle as Record<string, unknown> | undefined
      });
      text += run.content;
    }

    paragraphs.push({
      tabId,
      tabTitle,
      paragraphIndex: nextParagraphIndex(),
      startIndex: element.startIndex ?? textRuns[0]?.startIndex ?? 0,
      endIndex: element.endIndex ?? textRuns.at(-1)?.endIndex ?? 0,
      text,
      textRuns,
      style: paragraph.paragraphStyle as Record<string, unknown> | undefined,
      bullet: normalizeBullet(paragraph, listMetadata)
    });
  }
  return paragraphs;
}

function normalizeBullet(
  paragraph: docs_v1.Schema$Paragraph,
  listMetadata: Map<string, Map<number, ReturnType<typeof getListLevelMetadata>>>
) {
  const bullet = paragraph.bullet;
  if (!bullet) return undefined;
  const nestingLevel = bullet.nestingLevel ?? 0;
  const level = bullet.listId ? listMetadata.get(bullet.listId)?.get(nestingLevel) : undefined;
  return {
    listId: bullet.listId ?? undefined,
    nestingLevel,
    ...level
  };
}

function buildListMetadata(doc: docs_v1.Schema$Document) {
  const lists = doc.lists ?? {};
  const metadata = new Map<string, Map<number, ReturnType<typeof getListLevelMetadata>>>();
  for (const [listId, list] of Object.entries(lists)) {
    const levels = new Map<number, ReturnType<typeof getListLevelMetadata>>();
    for (const [index, level] of (list.listProperties?.nestingLevels ?? []).entries()) {
      levels.set(index, getListLevelMetadata(level));
    }
    metadata.set(listId, levels);
  }
  return metadata;
}

function getListLevelMetadata(level: docs_v1.Schema$NestingLevel | undefined) {
  return {
    glyphType: level?.glyphType ?? undefined,
    glyphSymbol: level?.glyphSymbol ?? undefined,
    startNumber: level?.startNumber ?? undefined
  };
}
