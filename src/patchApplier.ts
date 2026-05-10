import { google, type docs_v1 } from "googleapis";
import type { OAuth2Client } from "google-auth-library";
import { config } from "./config.js";
import type { PatchProposal, ReplaceTextEdit } from "./patchTypes.js";
import { getDocument } from "./googleDocs.js";
import { validatePatchProposal } from "./patchValidator.js";
import { logPatch } from "./db.js";

export type ApplyPatchResult = {
  dryRun: boolean;
  requests: docs_v1.Schema$Request[];
  replies?: docs_v1.Schema$Response[];
};

export function buildBatchUpdateRequests(edits: ReplaceTextEdit[]): docs_v1.Schema$Request[] {
  // Google Docs indexes are absolute UTF-16 positions in the document. Deleting and
  // inserting from the end of the document backwards keeps earlier replacements from
  // shifting the ranges of edits that have not run yet.
  const sorted = [...edits].sort((a, b) => b.target.startIndex - a.target.startIndex);
  return sorted.flatMap((edit) => [
    {
      deleteContentRange: {
        range: {
          startIndex: edit.target.startIndex,
          endIndex: edit.target.endIndex
        }
      }
    },
    {
      insertText: {
        location: { index: edit.target.startIndex },
        text: edit.replacementText
      }
    }
  ]);
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
  const validation = validatePatchProposal(freshDocument, patch);
  if (!validation.ok) {
    throw new Error(validation.reason);
  }

  const requests = buildBatchUpdateRequests(patch.edits);
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
