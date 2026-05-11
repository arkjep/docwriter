import { config } from "./config.js";
import { patchProposalSchema, type NormalizedDocument, type PatchProposal } from "./patchTypes.js";
import { callGitHubCopilotChat } from "./githubCopilot.js";

type AiChatResponse = {
  content: string;
  finishReason?: string;
};

type ChatInput = {
  document: NormalizedDocument;
  activeTabId?: string;
  selectedParagraphIndex?: number;
  selectedText?: string;
  message: string;
};

export async function proposePatch(input: ChatInput): Promise<PatchProposal> {
  const system = [
    "You are an AI writing assistant for Google Docs.",
    "Return only valid JSON. Do not include markdown, comments, prose, or trailing commas.",
    "Every string value must be valid JSON with internal quotes and newlines escaped.",
    "The summary must be one short plain sentence with no markdown, no bullet or numbered list, no newline characters, and no quotation marks.",
    "The response must match this JSON shape:",
    "{\"summary\":\"Short assistant response.\",\"edits\":[{\"type\":\"replace_text\",\"target\":{\"tabId\":\"tab-id\",\"paragraphIndex\":0,\"startIndex\":1,\"endIndex\":12,\"currentText\":\"Original text\"},\"replacementText\":\"Replacement text\"}]}",
    "Only propose edits that preserve the author's intent. Use Google Docs absolute indexes and tabId values supplied in the paragraph metadata.",
    "If no direct edit is appropriate, return an empty edits array with a short plain summary."
  ].join("\n");

  const user = JSON.stringify({
    userRequest: input.message,
    activeTabId: input.activeTabId,
    selectedParagraphIndex: input.selectedParagraphIndex,
    selectedText: input.selectedText,
    document: {
      title: input.document.title,
      fullText: input.document.fullText,
      tabs: input.document.tabs.map((tab) => ({
        tabId: tab.tabId,
        title: tab.title,
        depth: tab.depth,
        paragraphIndexes: tab.paragraphs.map((paragraph) => paragraph.paragraphIndex)
      })),
      paragraphs: input.document.paragraphs.map((paragraph) => ({
        tabId: paragraph.tabId,
        tabTitle: paragraph.tabTitle,
        paragraphIndex: paragraph.paragraphIndex,
        startIndex: paragraph.startIndex,
        endIndex: paragraph.endIndex,
        text: paragraph.text
      }))
    }
  });

  const response = await callConfiguredProvider(system, user);
  if (isTruncatedAiResponse(response.finishReason)) {
    throw new Error(`AI response was truncated by the provider (${response.finishReason}). Try a smaller request or increase AI_MAX_TOKENS.`);
  }

  try {
    return parsePatchJson(response.content);
  } catch (error) {
    if (!isMalformedJsonError(error)) throw error;
    const repaired = await repairPatchJson(response.content);
    if (isTruncatedAiResponse(repaired.finishReason)) {
      throw new Error(`AI JSON repair response was truncated by the provider (${repaired.finishReason}). Try a smaller request or increase AI_MAX_TOKENS.`);
    }
    return parsePatchJson(repaired.content);
  }
}

async function repairPatchJson(raw: string) {
  const system = [
    "You repair malformed JSON for a Google Docs patch proposal.",
    "Return only valid JSON matching this exact shape:",
    "{\"summary\":\"Short plain sentence\",\"edits\":[]}",
    "Preserve any valid edit objects from the input.",
    "The summary must be one short plain sentence with no markdown, no bullet or numbered list, no newline characters, and no quotation marks.",
    "If you cannot confidently repair the edits, return a valid JSON object with the best short summary and an empty edits array."
  ].join("\n");
  const user = JSON.stringify({
    malformedJson: raw
  });
  return callConfiguredProvider(system, user);
}

async function callConfiguredProvider(system: string, user: string): Promise<AiChatResponse> {
  if (config.ai.provider === "anthropic") return callAnthropic(system, user);
  if (config.ai.provider === "github-copilot") return callGitHubCopilotChat(system, user);
  return callOpenAiCompatible(system, user);
}

async function callOpenAiCompatible(system: string, user: string) {
  const response = await fetch(`${config.ai.baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.ai.apiKey}`
    },
    body: JSON.stringify({
      model: config.ai.model,
      temperature: 0.2,
      max_tokens: config.ai.maxTokens,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user }
      ]
    })
  });

  if (!response.ok) {
    throw new Error(`AI provider error ${response.status}: ${await response.text()}`);
  }
  const data = await response.json() as { choices?: Array<{ finish_reason?: string; message?: { content?: string } }> };
  const choice = data.choices?.[0];
  const content = choice?.message?.content;
  if (!content) throw new Error("AI provider returned no content.");
  return { content, finishReason: choice?.finish_reason };
}

async function callAnthropic(system: string, user: string) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": config.ai.apiKey,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: config.ai.model,
      max_tokens: config.ai.maxTokens,
      temperature: 0.2,
      system,
      messages: [{ role: "user", content: user }]
    })
  });

  if (!response.ok) {
    throw new Error(`Anthropic error ${response.status}: ${await response.text()}`);
  }
  const data = await response.json() as { content?: Array<{ type: string; text?: string }>; stop_reason?: string };
  const text = data.content?.find((item) => item.type === "text")?.text;
  if (!text) throw new Error("Anthropic returned no text content.");
  return { content: text, finishReason: data.stop_reason };
}

export function parsePatchJson(raw: string): PatchProposal {
  const trimmed = extractJsonObject(stripMarkdownFence(raw.trim()));
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    throw new Error(`Malformed AI JSON: ${(error as Error).message}. Raw excerpt: ${formatJsonErrorExcerpt(trimmed, error)}`);
  }
  return patchProposalSchema.parse(parsed);
}

function isTruncatedAiResponse(finishReason?: string) {
  return finishReason === "length" || finishReason === "max_tokens";
}

function isMalformedJsonError(error: unknown) {
  return error instanceof Error && error.message.startsWith("Malformed AI JSON:");
}

function stripMarkdownFence(value: string) {
  return value.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
}

function extractJsonObject(value: string) {
  const firstBrace = value.indexOf("{");
  if (firstBrace === -1) return value;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = firstBrace; index < value.length; index += 1) {
    const char = value[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "\"") {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return value.slice(firstBrace, index + 1);
    }
  }

  return value;
}

function formatJsonErrorExcerpt(value: string, error: unknown) {
  const match = /position (\d+)/.exec((error as Error).message);
  const position = match ? Number(match[1]) : 0;
  const start = Math.max(0, position - 90);
  const end = Math.min(value.length, position + 90);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < value.length ? "..." : "";
  return `${prefix}${value.slice(start, end)}${suffix}`.replace(/\s+/g, " ");
}
