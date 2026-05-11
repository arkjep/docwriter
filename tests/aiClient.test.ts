import { describe, expect, it } from "vitest";
import { parsePatchJson } from "../src/aiClient.js";

describe("parsePatchJson", () => {
  it("parses valid patch JSON", () => {
    const patch = parsePatchJson(JSON.stringify({
      summary: "No changes needed.",
      edits: []
    }));

    expect(patch).toEqual({
      summary: "No changes needed.",
      edits: []
    });
  });

  it("extracts JSON wrapped in provider prose", () => {
    const patch = parsePatchJson(`
      Here is the JSON:
      {"summary":"Replace text.","edits":[{"type":"replace_text","target":{"tabId":"tab-1","paragraphIndex":0,"startIndex":1,"endIndex":6,"currentText":"Hello"},"replacementText":"Hi"}]}
      Thanks.
    `);

    expect(patch.edits).toHaveLength(1);
    expect(patch.edits[0]).toMatchObject({
      type: "replace_text",
      replacementText: "Hi"
    });
  });

  it("parses fenced JSON", () => {
    const patch = parsePatchJson(`
      \`\`\`json
      {"summary":"No direct edit.","edits":[]}
      \`\`\`
    `);

    expect(patch.summary).toBe("No direct edit.");
  });
});
