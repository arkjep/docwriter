import { config } from "./config.js";
import { patchProposalSchema, type NormalizedDocument, type PatchProposal } from "./patchTypes.js";
import { callGitHubCopilotChat } from "./githubCopilot.js";

type ChatInput = {
  document: NormalizedDocument;
  selectedParagraphIndex?: number;
  message: string;
};

export async function proposePatch(input: ChatInput): Promise<PatchProposal> {
  const system = [
    "You are an AI writing assistant for Google Docs.",
    "Return only strict JSON matching this TypeScript shape:",
    "{ summary: string, edits: Array<{ type: 'replace_text', target: { paragraphIndex: number, startIndex: number, endIndex: number, currentText: string }, replacementText: string }> }.",
    "Only propose edits that preserve the author's intent. Use Google Docs absolute indexes supplied in the paragraph metadata.",
    "If no direct edit is appropriate, return an empty edits array with a useful summary."
  ].join("\n");

  const user = JSON.stringify({
    userRequest: input.message,
    selectedParagraphIndex: input.selectedParagraphIndex,
    document: {
      title: input.document.title,
      fullText: input.document.fullText,
      paragraphs: input.document.paragraphs.map((paragraph) => ({
        paragraphIndex: paragraph.paragraphIndex,
        startIndex: paragraph.startIndex,
        endIndex: paragraph.endIndex,
        text: paragraph.text
      }))
    }
  });

  const raw = await callConfiguredProvider(system, user);

  return parsePatchJson(raw);
}

async function callConfiguredProvider(system: string, user: string) {
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
  const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("AI provider returned no content.");
  return content;
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
      max_tokens: 2000,
      temperature: 0.2,
      system,
      messages: [{ role: "user", content: user }]
    })
  });

  if (!response.ok) {
    throw new Error(`Anthropic error ${response.status}: ${await response.text()}`);
  }
  const data = await response.json() as { content?: Array<{ type: string; text?: string }> };
  const text = data.content?.find((item) => item.type === "text")?.text;
  if (!text) throw new Error("Anthropic returned no text content.");
  return text;
}

export function parsePatchJson(raw: string): PatchProposal {
  const trimmed = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    throw new Error(`Malformed AI JSON: ${(error as Error).message}`);
  }
  return patchProposalSchema.parse(parsed);
}
