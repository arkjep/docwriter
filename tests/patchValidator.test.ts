import { describe, expect, it } from "vitest";
import { buildBatchUpdateRequests, normalizeReplaceTextEdits } from "../src/patchApplier.js";
import { validatePatchProposal } from "../src/patchValidator.js";
import type { NormalizedDocument, PatchProposal } from "../src/patchTypes.js";

const document: NormalizedDocument = {
  documentId: "doc-1",
  title: "Test Doc",
  fullText: "First paragraph.\nSecond paragraph.\n",
  tabs: [
    {
      tabId: "tab-1",
      title: "Main",
      depth: 0,
      paragraphs: []
    }
  ],
  paragraphs: [
    {
      tabId: "tab-1",
      tabTitle: "Main",
      paragraphIndex: 0,
      startIndex: 1,
      endIndex: 18,
      text: "First paragraph.\n",
      textRuns: [{ tabId: "tab-1", startIndex: 1, endIndex: 18, text: "First paragraph.\n" }]
    },
    {
      tabId: "tab-1",
      tabTitle: "Main",
      paragraphIndex: 1,
      startIndex: 18,
      endIndex: 36,
      text: "Second paragraph.\n",
      textRuns: [{ tabId: "tab-1", startIndex: 18, endIndex: 36, text: "Second paragraph.\n" }]
    }
  ]
};
document.tabs[0].paragraphs = document.paragraphs;

describe("patch validation and request generation", () => {
  it("validates currentText against the paragraph range", () => {
    const patch: PatchProposal = {
      summary: "Replace first word.",
      edits: [
        {
          type: "replace_text",
          target: {
            tabId: "tab-1",
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

    const requests = buildBatchUpdateRequests(patch.edits, document);
    expect(requests[0].deleteContentRange?.range?.startIndex).toBe(18);
    expect(requests[0].deleteContentRange?.range?.tabId).toBe("tab-1");
    expect(requests[1].insertText?.location?.index).toBe(18);
    expect(requests[1].insertText?.location?.tabId).toBe("tab-1");
    expect(requests[2].deleteContentRange?.range?.startIndex).toBe(1);
    expect(requests[3].insertText?.location?.index).toBe(1);
  });

  it("omits insertText requests when replacement text is empty", () => {
    const patch: PatchProposal = {
      summary: "Delete a word.",
      edits: [
        {
          type: "replace_text",
          target: { paragraphIndex: 0, startIndex: 1, endIndex: 6, currentText: "First" },
          replacementText: ""
        }
      ]
    };

    const requests = buildBatchUpdateRequests(patch.edits, document);
    expect(requests).toHaveLength(1);
    expect(requests[0].deleteContentRange?.range?.startIndex).toBe(1);
    expect(requests[0].insertText).toBeUndefined();
  });

  it("preserves paragraph-ending newlines when replacing paragraph text", () => {
    const patch: PatchProposal = {
      summary: "Rewrite first paragraph.",
      edits: [
        {
          type: "replace_text",
          target: { tabId: "tab-1", paragraphIndex: 0, startIndex: 1, endIndex: 18, currentText: "First paragraph.\n" },
          replacementText: "Opening paragraph.\n"
        }
      ]
    };

    const [normalized] = normalizeReplaceTextEdits(patch.edits, document);
    expect(normalized).toMatchObject({
      target: { endIndex: 17, currentText: "First paragraph." },
      replacementText: "Opening paragraph."
    });

    const requests = buildBatchUpdateRequests(patch.edits, document);
    expect(requests[0].deleteContentRange?.range?.endIndex).toBe(17);
    expect(requests[1].insertText?.text).toBe("Opening paragraph.");
  });

  it("preserves paragraph-ending newlines when deleting paragraph text", () => {
    const patch: PatchProposal = {
      summary: "Delete first paragraph text.",
      edits: [
        {
          type: "replace_text",
          target: { tabId: "tab-1", paragraphIndex: 0, startIndex: 1, endIndex: 18, currentText: "First paragraph.\n" },
          replacementText: ""
        }
      ]
    };

    const [normalized] = normalizeReplaceTextEdits(patch.edits, document);
    expect(normalized).toMatchObject({
      target: { endIndex: 17, currentText: "First paragraph." },
      replacementText: ""
    });

    const requests = buildBatchUpdateRequests(patch.edits, document);
    expect(requests).toHaveLength(1);
    expect(requests[0].deleteContentRange?.range?.endIndex).toBe(17);
  });

  it("builds insert-only requests for empty paragraph draft edits", () => {
    const patch: PatchProposal = {
      summary: "Insert into an empty paragraph.",
      edits: [
        {
          type: "replace_text",
          target: { tabId: "tab-1", paragraphIndex: 0, startIndex: 1, endIndex: 1, currentText: "" },
          replacementText: "New paragraph text"
        }
      ]
    };

    const requests = buildBatchUpdateRequests(patch.edits, document);
    expect(validatePatchProposal(document, patch)).toEqual({ ok: true });
    expect(requests).toHaveLength(1);
    expect(requests[0].insertText?.location?.index).toBe(1);
    expect(requests[0].insertText?.location?.tabId).toBe("tab-1");
  });

  it("orders typed text insertion before styling the inserted range", () => {
    const patch: PatchProposal = {
      summary: "Insert italic text.",
      edits: [
        {
          type: "replace_text",
          target: { tabId: "tab-1", paragraphIndex: 0, startIndex: 6, endIndex: 6, currentText: "" },
          replacementText: " idea"
        },
        {
          type: "update_text_style",
          target: { tabId: "tab-1", paragraphIndex: 0, startIndex: 6, endIndex: 11 },
          textStyle: { italic: true },
          fields: "italic"
        }
      ]
    };

    const requests = buildBatchUpdateRequests(patch.edits, document);
    expect(validatePatchProposal(document, patch)).toEqual({ ok: true });
    expect(requests[0].insertText?.location?.index).toBe(6);
    expect(requests[0].insertText?.text).toBe(" idea");
    expect(requests[1].updateTextStyle?.range?.startIndex).toBe(6);
    expect(requests[1].updateTextStyle?.range?.endIndex).toBe(11);
    expect(requests[1].updateTextStyle?.textStyle?.italic).toBe(true);
  });

  it("emits insertion before dependent style even when style starts later", () => {
    const patch: PatchProposal = {
      summary: "Insert text and bold the tail.",
      edits: [
        {
          type: "replace_text",
          target: { tabId: "tab-1", paragraphIndex: 0, startIndex: 6, endIndex: 6, currentText: "" },
          replacementText: " plain bold"
        },
        {
          type: "update_text_style",
          target: { tabId: "tab-1", paragraphIndex: 0, startIndex: 13, endIndex: 17 },
          textStyle: { bold: true },
          fields: "bold"
        }
      ]
    };

    const requests = buildBatchUpdateRequests(patch.edits, document);
    expect(validatePatchProposal(document, patch)).toEqual({ ok: true });
    expect(requests[0].insertText?.location?.index).toBe(6);
    expect(requests[0].insertText?.text).toBe(" plain bold");
    expect(requests[1].updateTextStyle?.range?.startIndex).toBe(6);
    expect(requests[1].updateTextStyle?.range?.endIndex).toBe(13);
    expect(requests[1].updateTextStyle?.textStyle?.bold).toBe(false);
    expect(requests[2].updateTextStyle?.range?.startIndex).toBe(13);
    expect(requests[2].updateTextStyle?.range?.endIndex).toBe(17);
    expect(requests[2].updateTextStyle?.textStyle?.bold).toBe(true);
  });

  it("resets only inserted gaps before applying mixed dependent styles", () => {
    const patch: PatchProposal = {
      summary: "Insert text with italic head and bold tail.",
      edits: [
        {
          type: "replace_text",
          target: { tabId: "tab-1", paragraphIndex: 0, startIndex: 6, endIndex: 6, currentText: "" },
          replacementText: "italic bold"
        },
        {
          type: "update_text_style",
          target: { tabId: "tab-1", paragraphIndex: 0, startIndex: 6, endIndex: 12 },
          textStyle: { italic: true },
          fields: "italic"
        },
        {
          type: "update_text_style",
          target: { tabId: "tab-1", paragraphIndex: 0, startIndex: 13, endIndex: 17 },
          textStyle: { bold: true },
          fields: "bold"
        }
      ]
    };

    const requests = buildBatchUpdateRequests(patch.edits, document);
    expect(requests[0].insertText?.text).toBe("italic bold");
    expect(requests[1].updateTextStyle?.range?.startIndex).toBe(6);
    expect(requests[1].updateTextStyle?.range?.endIndex).toBe(13);
    expect(requests[1].updateTextStyle?.textStyle?.bold).toBe(false);
    expect(requests[2].updateTextStyle?.range?.startIndex).toBe(12);
    expect(requests[2].updateTextStyle?.range?.endIndex).toBe(17);
    expect(requests[2].updateTextStyle?.textStyle?.italic).toBe(false);
    expect(requests[3].updateTextStyle?.textStyle?.bold).toBe(true);
    expect(requests[4].updateTextStyle?.textStyle?.italic).toBe(true);
  });

  it("validates by absolute range when paragraphIndex became stale after another edit", () => {
    const patch: PatchProposal = {
      summary: "Replace text after a paragraph split.",
      edits: [
        {
          type: "replace_text",
          target: {
            tabId: "tab-1",
            paragraphIndex: 0,
            startIndex: 18,
            endIndex: 24,
            currentText: "Second"
          },
          replacementText: "Updated"
        }
      ]
    };

    expect(validatePatchProposal(document, patch)).toEqual({ ok: true });
  });
});
