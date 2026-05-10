import type { NormalizedDocument, PatchProposal, ReplaceTextEdit, ValidationResult } from "./patchTypes.js";
import { patchProposalSchema } from "./patchTypes.js";

export function validatePatchProposal(document: NormalizedDocument, proposal: unknown): ValidationResult {
  const parsed = patchProposalSchema.safeParse(proposal);
  if (!parsed.success) {
    return { ok: false, reason: parsed.error.message };
  }

  for (const edit of parsed.data.edits) {
    const validation = validateReplaceTextEdit(document, edit);
    if (!validation.ok) return validation;
  }

  return { ok: true };
}

export function validateReplaceTextEdit(document: NormalizedDocument, edit: ReplaceTextEdit): ValidationResult {
  if (edit.target.endIndex <= edit.target.startIndex) {
    return { ok: false, reason: "Edit endIndex must be greater than startIndex.", edit };
  }

  const paragraph = document.paragraphs[edit.target.paragraphIndex];
  if (!paragraph) {
    return { ok: false, reason: `Paragraph ${edit.target.paragraphIndex} no longer exists.`, edit };
  }

  if (edit.target.startIndex < paragraph.startIndex || edit.target.endIndex > paragraph.endIndex) {
    return { ok: false, reason: "Edit range is outside the target paragraph.", edit };
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
