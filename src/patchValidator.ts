import type { NormalizedDocument, PatchEdit, PatchProposal, ReplaceTextEdit, ValidationResult } from "./patchTypes.js";
import { patchProposalSchema } from "./patchTypes.js";

export function validatePatchProposal(document: NormalizedDocument, proposal: unknown): ValidationResult {
  const parsed = patchProposalSchema.safeParse(proposal);
  if (!parsed.success) {
    return { ok: false, reason: parsed.error.message };
  }

  const insertedRanges: Array<{ tabId?: string; paragraphIndex: number; startIndex: number; endIndex: number }> = [];
  for (const edit of parsed.data.edits) {
    const validation = validatePatchEdit(document, edit, insertedRanges);
    if (!validation.ok) return validation;
    if (edit.type === "replace_text" && edit.replacementText.length > 0) {
      insertedRanges.push({
        tabId: edit.target.tabId,
        paragraphIndex: edit.target.paragraphIndex,
        startIndex: edit.target.startIndex,
        endIndex: edit.target.startIndex + edit.replacementText.length
      });
    }
  }

  return { ok: true };
}

export function validatePatchEdit(
  document: NormalizedDocument,
  edit: PatchEdit,
  insertedRanges: Array<{ tabId?: string; paragraphIndex: number; startIndex: number; endIndex: number }> = []
): ValidationResult {
  if (edit.type === "replace_text") return validateReplaceTextEdit(document, edit);
  const paragraph = resolveParagraphForRange(document, edit.target);
  if (!paragraph && !rangeIsCoveredByInsertedText(edit.target, insertedRanges)) {
    return { ok: false, reason: `Could not find a paragraph containing the requested edit range.`, edit: undefined };
  }
  return { ok: true };
}

export function validateReplaceTextEdit(document: NormalizedDocument, edit: ReplaceTextEdit): ValidationResult {
  if (edit.target.endIndex < edit.target.startIndex) {
    return { ok: false, reason: "Edit endIndex must be greater than or equal to startIndex.", edit };
  }

  if (edit.target.endIndex === edit.target.startIndex && edit.target.currentText.length > 0) {
    return { ok: false, reason: "Zero-length edits can only insert text with an empty currentText value.", edit };
  }

  const paragraph = resolveParagraphForRange(document, edit.target);
  if (!paragraph) {
    return { ok: false, reason: "Could not find a paragraph containing the requested edit range.", edit };
  }

  const relativeStart = edit.target.startIndex - paragraph.startIndex;
  const relativeEnd = edit.target.endIndex - paragraph.startIndex;
  const currentText = paragraph.text.slice(relativeStart, relativeEnd);
  if (currentText !== edit.target.currentText) {
    return {
      ok: false,
      reason: "The Google Doc has changed since this edit was proposed. Refresh the document before applying.",
      edit
    };
  }

  return { ok: true };
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

function rangeIsCoveredByInsertedText(
  target: { tabId?: string; paragraphIndex: number; startIndex: number; endIndex: number },
  insertedRanges: Array<{ tabId?: string; paragraphIndex: number; startIndex: number; endIndex: number }>
) {
  return insertedRanges.some((range) =>
    range.paragraphIndex === target.paragraphIndex &&
    (target.tabId == null || range.tabId == null || target.tabId === range.tabId) &&
    target.startIndex >= range.startIndex &&
    target.endIndex <= range.endIndex
  );
}
