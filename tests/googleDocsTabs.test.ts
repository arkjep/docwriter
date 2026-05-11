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

  it("merges named text styles into text runs when Google omits inherited font metadata", () => {
    const document = normalizeDocument({
      documentId: "doc-1",
      title: "Styled Doc",
      namedStyles: {
        styles: [
          {
            namedStyleType: "NORMAL_TEXT",
            textStyle: {
              fontSize: { magnitude: 11, unit: "PT" },
              weightedFontFamily: { fontFamily: "Arial" }
            }
          },
          {
            namedStyleType: "HEADING_1",
            textStyle: {
              fontSize: { magnitude: 20, unit: "PT" },
              weightedFontFamily: { fontFamily: "Georgia" },
              bold: true
            }
          }
        ]
      },
      body: {
        content: [
          {
            startIndex: 1,
            endIndex: 8,
            paragraph: {
              paragraphStyle: { namedStyleType: "NORMAL_TEXT" },
              elements: [
                { startIndex: 1, endIndex: 8, textRun: { content: "Body\n" } }
              ]
            }
          },
          {
            startIndex: 8,
            endIndex: 16,
            paragraph: {
              paragraphStyle: { namedStyleType: "HEADING_1" },
              elements: [
                { startIndex: 8, endIndex: 16, textRun: { content: "Head\n", textStyle: { italic: true } } }
              ]
            }
          }
        ]
      }
    } as never);

    expect(document.paragraphs[0].textRuns[0].style?.fontSize).toEqual({ magnitude: 11, unit: "PT" });
    expect(document.paragraphs[0].textRuns[0].style?.weightedFontFamily).toEqual({ fontFamily: "Arial" });
    expect(document.paragraphs[1].textRuns[0].style).toMatchObject({
      fontSize: { magnitude: 20, unit: "PT" },
      weightedFontFamily: { fontFamily: "Georgia" },
      bold: true,
      italic: true
    });
  });
});
