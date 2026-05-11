import { google, type docs_v1 } from "googleapis";
import type { OAuth2Client } from "google-auth-library";
import { config } from "./config.js";
import type { PatchEdit, PatchProposal } from "./patchTypes.js";
import { getDocument } from "./googleDocs.js";
import { validatePatchProposal } from "./patchValidator.js";
import { logPatch } from "./db.js";
import type { NormalizedDocument } from "./patchTypes.js";

export type ApplyPatchResult = {
  dryRun: boolean;
  requests: docs_v1.Schema$Request[];
  replies?: docs_v1.Schema$Response[];
};

export function buildBatchUpdateRequests(
  edits: PatchEdit[],
  document?: NormalizedDocument
): docs_v1.Schema$Request[] {
  // Google Docs indexes are absolute UTF-16 positions in the document. Deleting and
  // inserting from the end of the document backwards keeps earlier replacements from
  // shifting the ranges of edits that have not run yet. Style edits that target
  // text inserted by the same patch are emitted immediately after that insert,
  // because those ranges do not exist in the document before the insert request.
  const requests: docs_v1.Schema$Request[] = [];
  const emitted = new Set<PatchEdit>();
  const normalizedEdits = normalizeReplaceTextEdits(edits, document);
  const sorted = normalizedEdits.sort((a, b) => {
    const byIndex = b.target.startIndex - a.target.startIndex;
    if (byIndex !== 0) return byIndex;
    return editRequestPriority(a) - editRequestPriority(b);
  });

  for (const edit of sorted) {
    if (emitted.has(edit)) continue;
    if (edit.type === "update_text_style" && findCoveringInsertion(edit, sorted)) continue;
    requests.push(...buildRequestsForEdit(edit, document));
    emitted.add(edit);

    if (edit.type === "replace_text" && edit.replacementText.length > 0) {
      const insertedRange = {
        tabId: edit.target.tabId,
        paragraphIndex: edit.target.paragraphIndex,
        startIndex: edit.target.startIndex,
        endIndex: edit.target.startIndex + edit.replacementText.length
      };
      const dependentStyles = sorted.filter((dependent) =>
        !emitted.has(dependent) &&
        dependent.type === "update_text_style" &&
        rangeIsCoveredByRange(dependent.target, insertedRange)
      );
      requests.push(...buildInsertedTextGapResetRequests(insertedRange, dependentStyles, document));
      for (const dependent of dependentStyles) {
        requests.push(...buildRequestsForEdit(dependent, document));
        emitted.add(dependent);
      }
    }
  }

  return requests;
}

export function normalizeReplaceTextEdits(
  edits: PatchEdit[],
  document?: NormalizedDocument
): PatchEdit[] {
  return edits.map((edit) => {
    if (edit.type !== "replace_text") return edit;
    const paragraph = document ? resolveParagraphForRange(document, edit.target) : undefined;
    if (!paragraph) return edit;
    const editsThroughParagraphBreak =
      edit.target.endIndex === paragraph.endIndex &&
      edit.target.currentText.endsWith("\n");
    if (!editsThroughParagraphBreak) return edit;

    return {
      ...edit,
      target: {
        ...edit.target,
        endIndex: edit.target.endIndex - 1,
        currentText: edit.target.currentText.slice(0, -1)
      },
      replacementText: edit.replacementText.endsWith("\n") ? edit.replacementText.slice(0, -1) : edit.replacementText
    };
  });
}

function buildInsertedTextGapResetRequests(
  insertedRange: { tabId?: string; paragraphIndex: number; startIndex: number; endIndex: number },
  dependentStyles: PatchEdit[],
  document?: NormalizedDocument
): docs_v1.Schema$Request[] {
  const requests: docs_v1.Schema$Request[] = [];
  for (const field of ["bold", "italic", "underline"] as const) {
    const trueRanges = dependentStyles
      .filter((edit) => edit.type === "update_text_style" && edit.fields === field && edit.textStyle?.[field] === true)
      .map((edit) => ({
        startIndex: Math.max(insertedRange.startIndex, edit.target.startIndex),
        endIndex: Math.min(insertedRange.endIndex, edit.target.endIndex)
      }))
      .filter((range) => range.startIndex < range.endIndex)
      .sort((a, b) => a.startIndex - b.startIndex);

    if (!trueRanges.length) continue;

    let cursor = insertedRange.startIndex;
    for (const range of mergeRanges(trueRanges)) {
      if (cursor < range.startIndex) {
        requests.push(...buildRequestsForEdit({
          type: "update_text_style",
          target: { ...insertedRange, startIndex: cursor, endIndex: range.startIndex },
          textStyle: { [field]: false },
          fields: field
        }, document));
      }
      cursor = Math.max(cursor, range.endIndex);
    }
    if (cursor < insertedRange.endIndex) {
      requests.push(...buildRequestsForEdit({
        type: "update_text_style",
        target: { ...insertedRange, startIndex: cursor, endIndex: insertedRange.endIndex },
        textStyle: { [field]: false },
        fields: field
      }, document));
    }
  }
  return requests;
}

function mergeRanges(ranges: Array<{ startIndex: number; endIndex: number }>) {
  const merged: Array<{ startIndex: number; endIndex: number }> = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous && range.startIndex <= previous.endIndex) {
      previous.endIndex = Math.max(previous.endIndex, range.endIndex);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

function findCoveringInsertion(edit: PatchEdit, edits: PatchEdit[]) {
  if (edit.type !== "update_text_style") return undefined;
  return edits.find((candidate) => {
    if (candidate.type !== "replace_text" || candidate.replacementText.length === 0) return false;
    return rangeIsCoveredByRange(edit.target, {
      tabId: candidate.target.tabId,
      paragraphIndex: candidate.target.paragraphIndex,
      startIndex: candidate.target.startIndex,
      endIndex: candidate.target.startIndex + candidate.replacementText.length
    });
  });
}

function buildRequestsForEdit(
  edit: PatchEdit,
  document?: NormalizedDocument
): docs_v1.Schema$Request[] {
    const tabId = edit.target.tabId ?? resolveTabIdForRange(document, edit.target);
    const requests: docs_v1.Schema$Request[] = [];

    if (edit.type === "update_paragraph_style") {
      return [{
        updateParagraphStyle: {
          range: {
            ...(tabId ? { tabId } : {}),
            startIndex: edit.target.startIndex,
            endIndex: edit.target.endIndex
          },
          paragraphStyle: edit.paragraphStyle,
          fields: edit.fields
        }
      }];
    }

    if (edit.type === "update_text_style") {
      return [{
        updateTextStyle: {
          range: {
            ...(tabId ? { tabId } : {}),
            startIndex: edit.target.startIndex,
            endIndex: edit.target.endIndex
          },
          textStyle: edit.textStyle,
          fields: edit.fields
        }
      }];
    }

    if (edit.type === "create_paragraph_bullets") {
      return [{
        createParagraphBullets: {
          range: {
            ...(tabId ? { tabId } : {}),
            startIndex: edit.target.startIndex,
            endIndex: edit.target.endIndex
          },
          bulletPreset: edit.bulletPreset
        }
      }];
    }

    if (edit.type === "delete_paragraph_bullets") {
      return [{
        deleteParagraphBullets: {
          range: {
            ...(tabId ? { tabId } : {}),
            startIndex: edit.target.startIndex,
            endIndex: edit.target.endIndex
          }
        }
      }];
    }

    if (edit.target.endIndex > edit.target.startIndex) {
      requests.push({
        deleteContentRange: {
          range: {
            ...(tabId ? { tabId } : {}),
            startIndex: edit.target.startIndex,
            endIndex: edit.target.endIndex
          }
        }
      });
    }

    if (edit.replacementText.length > 0) {
      requests.push({
        insertText: {
          location: { ...(tabId ? { tabId } : {}), index: edit.target.startIndex },
          text: edit.replacementText
        }
      });
    }

    return requests;
}

function rangeIsCoveredByRange(
  target: { tabId?: string; paragraphIndex: number; startIndex: number; endIndex: number },
  range: { tabId?: string; paragraphIndex: number; startIndex: number; endIndex: number }
) {
  return (
    target.paragraphIndex === range.paragraphIndex &&
    (target.tabId == null || range.tabId == null || target.tabId === range.tabId) &&
    target.startIndex >= range.startIndex &&
    target.endIndex <= range.endIndex
  );
}

function editRequestPriority(edit: PatchEdit) {
  if (edit.type === "replace_text") return 0;
  if (edit.type === "update_text_style") return 1;
  return 2;
}

function resolveTabIdForRange(
  document: NormalizedDocument | undefined,
  target: { paragraphIndex: number; startIndex: number; endIndex: number }
) {
  if (!document) return undefined;
  const indexed = document.paragraphs[target.paragraphIndex];
  if (indexed && target.startIndex >= indexed.startIndex && target.endIndex <= indexed.endIndex) {
    return indexed.tabId;
  }
  return document.paragraphs.find((paragraph) =>
    target.startIndex >= paragraph.startIndex && target.endIndex <= paragraph.endIndex
  )?.tabId;
}

function resolveParagraphForRange(
  document: NormalizedDocument,
  target: { tabId?: string; paragraphIndex: number; startIndex: number; endIndex: number }
) {
  const indexed = document.paragraphs[target.paragraphIndex];
  if (indexed && paragraphContainsRange(indexed, target)) return indexed;
  return document.paragraphs.find((paragraph) => paragraphContainsRange(paragraph, target));
}

function paragraphContainsRange(
  paragraph: NormalizedDocument["paragraphs"][number],
  target: { tabId?: string; startIndex: number; endIndex: number }
) {
  if (target.tabId && paragraph.tabId !== target.tabId) return false;
  return target.startIndex >= paragraph.startIndex && target.endIndex <= paragraph.endIndex;
}

export async function applyPatch(
  auth: OAuth2Client,
  documentId: string,
  patch: PatchProposal,
  options?: { dryRun?: boolean }
): Promise<ApplyPatchResult> {
  console.info("Proposed patch before apply:", JSON.stringify(patch, null, 2));
  await logPatch({ documentId, kind: "apply", patch, dryRun: options?.dryRun ?? config.dryRun });
  const freshDocument = await getDocument(auth, documentId);
  const normalizedPatch = { ...patch, edits: normalizeReplaceTextEdits(patch.edits, freshDocument) };
  const validation = validatePatchProposal(freshDocument, normalizedPatch);
  if (!validation.ok) {
    throw new Error(validation.reason);
  }

  const requests = buildBatchUpdateRequests(normalizedPatch.edits, freshDocument);
  const dryRun = options?.dryRun ?? config.dryRun;
  if (dryRun || requests.length === 0) {
    return { dryRun: true, requests };
  }

  const docs = google.docs({ version: "v1", auth });
  const response = await docs.documents.batchUpdate({
    documentId,
    requestBody: { requests }
  });

  return {
    dryRun: false,
    requests,
    replies: response.data.replies ?? []
  };
}
