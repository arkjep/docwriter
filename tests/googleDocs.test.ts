import { describe, expect, it } from "vitest";
import { extractGoogleDocId } from "../src/googleDocs.js";

describe("extractGoogleDocId", () => {
  it("extracts the ID from a full editable Google Docs URL with query params", () => {
    expect(
      extractGoogleDocId("https://docs.google.com/document/d/1pmpFwSrlmcp1qROzJ_Qbmzft_us6A6WHbp9ZacnhmLI/edit?tab=t.0")
    ).toBe("1pmpFwSrlmcp1qROzJ_Qbmzft_us6A6WHbp9ZacnhmLI");
  });

  it("accepts a raw document ID", () => {
    expect(extractGoogleDocId("1pmpFwSrlmcp1qROzJ_Qbmzft_us6A6WHbp9ZacnhmLI")).toBe(
      "1pmpFwSrlmcp1qROzJ_Qbmzft_us6A6WHbp9ZacnhmLI"
    );
  });

  it("extracts the ID from an encoded URL paste", () => {
    expect(
      extractGoogleDocId("https%3A%2F%2Fdocs.google.com%2Fdocument%2Fd%2F1pmpFwSrlmcp1qROzJ_Qbmzft_us6A6WHbp9ZacnhmLI%2Fedit%3Ftab%3Dt.0")
    ).toBe("1pmpFwSrlmcp1qROzJ_Qbmzft_us6A6WHbp9ZacnhmLI");
  });

  it("extracts the ID from a wrapped URL paste", () => {
    expect(
      extractGoogleDocId("<https://docs.google.com/document/d/1pmpFwSrlmcp1qROzJ_Qbmzft_us6A6WHbp9ZacnhmLI/edit?tab=t.0>")
    ).toBe("1pmpFwSrlmcp1qROzJ_Qbmzft_us6A6WHbp9ZacnhmLI");
  });
});
