import { describe, expect, it } from "vitest";
import { buildBatchUpdateRequests } from "../src/patchApplier.js";
import { validatePatchProposal } from "../src/patchValidator.js";
import type { NormalizedDocument, PatchProposal } from "../src/patchTypes.js";

const document: NormalizedDocument = {
  documentId: "doc-1",
  title: "Test Doc",
  fullText: "First paragraph.\nSecond paragraph.\n",
  paragraphs: [
    {
      paragraphIndex: 0,
      startIndex: 1,
      endIndex: 18,
      text: "First paragraph.\n",
      textRuns: [{ startIndex: 1, endIndex: 18, text: "First paragraph.\n" }]
    },
    {
      paragraphIndex: 1,
      startIndex: 18,
      endIndex: 36,
      text: "Second paragraph.\n",
      textRuns: [{ startIndex: 18, endIndex: 36, text: "Second paragraph.\n" }]
    }
  ]
};

describe("patch validation and request generation", () => {
  it("validates currentText against the paragraph range", () => {
    const patch: PatchProposal = {
      summary: "Replace first word.",
      edits: [
        {
          type: "replace_text",
          target: {
            paragraphIndex: 0,
            startIndex: 1,
            endIndex: 6,
            currentText: "First"
          },
          replacementText: "Opening"
        }
      ]
    };

    expect(validatePatchProposal(document, patch)).toEqual({ ok: true });
  });

  it("refuses stale text before applying", () => {
    const patch: PatchProposal = {
      summary: "Replace stale text.",
      edits: [
        {
          type: "replace_text",
          target: {
            paragraphIndex: 1,
            startIndex: 18,
            endIndex: 24,
            currentText: "Changed"
          },
          replacementText: "Better"
        }
      ]
    };

    expect(validatePatchProposal(document, patch)).toMatchObject({ ok: false });
  });

  it("builds reverse-order delete/insert requests so indexes do not shift", () => {
    const patch: PatchProposal = {
      summary: "Two replacements.",
      edits: [
        {
          type: "replace_text",
          target: { paragraphIndex: 0, startIndex: 1, endIndex: 6, currentText: "First" },
          replacementText: "Opening"
        },
        {
          type: "replace_text",
          target: { paragraphIndex: 1, startIndex: 18, endIndex: 24, currentText: "Second" },
          replacementText: "Closing"
        }
      ]
    };

    const requests = buildBatchUpdateRequests(patch.edits);
    expect(requests[0].deleteContentRange?.range?.startIndex).toBe(18);
    expect(requests[1].insertText?.location?.index).toBe(18);
    expect(requests[2].deleteContentRange?.range?.startIndex).toBe(1);
    expect(requests[3].insertText?.location?.index).toBe(1);
  });
});
