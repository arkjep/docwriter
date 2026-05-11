import { describe, expect, it } from "vitest";
import { normalizeDocument } from "../src/googleDocs.js";

describe("normalizeDocument tabs", () => {
  it("flattens Google Docs tabs and child tabs into tab-aware paragraphs", () => {
    const document = normalizeDocument({
      documentId: "doc-1",
      title: "Tabbed Doc",
      tabs: [
        {
          tabProperties: { tabId: "tab-a", title: "Tab A" },
          documentTab: {
            body: {
              content: [
                {
                  startIndex: 1,
                  endIndex: 8,
                  paragraph: {
                    elements: [
                      { startIndex: 1, endIndex: 8, textRun: { content: "Alpha\n" } }
                    ]
                  }
                }
              ]
            }
          },
          childTabs: [
            {
              tabProperties: { tabId: "tab-b", title: "Tab B" },
              documentTab: {
                body: {
                  content: [
                    {
                      startIndex: 1,
                      endIndex: 7,
                      paragraph: {
                        elements: [
                          { startIndex: 1, endIndex: 7, textRun: { content: "Beta\n" } }
                        ]
                      }
                    }
                  ]
                }
              }
            }
          ]
        }
      ]
    } as never);

    expect(document.tabs.map((tab) => [tab.tabId, tab.title, tab.depth])).toEqual([
      ["tab-a", "Tab A", 0],
      ["tab-b", "Tab B", 1]
    ]);
    expect(document.paragraphs.map((paragraph) => [paragraph.tabId, paragraph.paragraphIndex, paragraph.text])).toEqual([
      ["tab-a", 0, "Alpha\n"],
      ["tab-b", 1, "Beta\n"]
    ]);
  });
});
