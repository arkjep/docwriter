import { config } from "./config.js";
import {
  deleteGitHubCopilotApiToken,
  hasGitHubCopilotToken,
  loadGitHubCopilotApiToken,
  loadGitHubCopilotToken,
  saveGitHubCopilotApiToken,
  saveGitHubCopilotToken
} from "./db.js";

type DeviceCodeResponse = {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval?: number;
};

type OAuthPollResponse = {
  access_token?: string;
  error?: "authorization_pending" | "slow_down" | "expired_token" | "access_denied";
  error_description?: string;
};

type CopilotTokenResponse = {
  token: string;
  expires_at: number | string;
  endpoints?: {
    api?: string;
    proxy?: string;
  };
};

type CopilotAuth = {
  token: string;
  apiBaseUrl: string;
  source: "github-pat" | "github-oauth" | "copilot-api-token";
};

type CopilotUserResponse = {
  access_token?: string;
  token?: string;
  expires_at?: number | string;
  expires_in?: number;
  endpoints?: {
    api?: string;
    proxy?: string;
  };
};

type JsonObject = Record<string, unknown>;

export function isGitHubCopilotConfigured() {
  return Boolean(config.githubCopilot.token || config.githubCopilot.clientId);
}

export async function isGitHubCopilotConnected() {
  return Boolean(await hasGitHubCopilotToken() || config.githubCopilot.token);
}

export async function startGitHubCopilotDeviceLogin(): Promise<DeviceCodeResponse> {
  if (!config.githubCopilot.clientId) {
    throw new Error("Set GITHUB_COPILOT_CLIENT_ID to enable device login, or provide COPILOT_GITHUB_TOKEN/GH_TOKEN/GITHUB_TOKEN.");
  }

  const response = await fetch(`https://${config.githubCopilot.githubHost}/login/device/code`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "editor-version": "vscode/1.104.0",
      "editor-plugin-version": "copilot-chat/0.37.5",
      "content-type": "application/json"
    },
    body: JSON.stringify({
      client_id: config.githubCopilot.clientId,
      scope: "read:user"
    })
  });

  if (!response.ok) {
    throw new Error(`GitHub device login failed ${response.status}: ${await response.text()}`);
  }

  return response.json() as Promise<DeviceCodeResponse>;
}

export async function pollGitHubCopilotDeviceLogin(deviceCode: string) {
  if (!config.githubCopilot.clientId) {
    throw new Error("Set GITHUB_COPILOT_CLIENT_ID to enable device login.");
  }

  const response = await fetch(`https://${config.githubCopilot.githubHost}/login/oauth/access_token`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "editor-version": "vscode/1.104.0",
      "editor-plugin-version": "copilot-chat/0.37.5",
      "content-type": "application/json"
    },
    body: JSON.stringify({
      client_id: config.githubCopilot.clientId,
      device_code: deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code"
    })
  });

  if (!response.ok) {
    throw new Error(`GitHub device token poll failed ${response.status}: ${await response.text()}`);
  }

  const data = await response.json() as OAuthPollResponse;
  if (data.access_token) {
    await deleteGitHubCopilotApiToken();
    await saveGitHubCopilotToken(data.access_token);
    return { authorized: true };
  }
  if (data.error === "authorization_pending" || data.error === "slow_down") {
    return { authorized: false, pending: true, error: data.error };
  }
  throw new Error(data.error_description ?? data.error ?? "GitHub device authorization failed.");
}

export async function importGitHubCopilotToken(githubToken: string) {
  assertNotClassicPat(githubToken);
  await deleteGitHubCopilotApiToken();
  await saveGitHubCopilotToken(githubToken);
}

export async function getGitHubCopilotAuth(): Promise<CopilotAuth> {
  const githubToken = await loadGitHubCopilotToken() || config.githubCopilot.token;
  if (githubToken) {
    assertNotClassicPat(githubToken);
    if (githubToken.startsWith("github_pat_")) {
      const exchanged = await exchangeGitHubPatForCopilotToken(githubToken);
      return {
        token: exchanged.token,
        apiBaseUrl: exchanged.apiBaseUrl ?? defaultCopilotApiBaseUrl(),
        source: "github-pat"
      };
    }
    if (githubToken.startsWith("gho_") || githubToken.startsWith("ghu_")) {
      const exchanged = await exchangeGitHubTokenForCopilotToken(githubToken);
      return {
        token: exchanged.token,
        apiBaseUrl: exchanged.apiBaseUrl ?? defaultCopilotApiBaseUrl(),
        source: "github-oauth"
      };
    }
    return {
      token: githubToken,
      apiBaseUrl: defaultCopilotApiBaseUrl(),
      source: "copilot-api-token"
    };
  }

  const cached = await loadGitHubCopilotApiToken();
  if (cached) {
    return {
      token: cached.token,
      apiBaseUrl: cached.apiBaseUrl ?? defaultCopilotApiBaseUrl(),
      source: "copilot-api-token"
    };
  }

  throw new Error("GitHub Copilot is not connected. Add COPILOT_GITHUB_TOKEN/GH_TOKEN/GITHUB_TOKEN or use device login.");
}

export async function exchangeGitHubTokenForCopilotToken(githubToken: string, forceRefresh = false) {
  if (!forceRefresh) {
    const cached = await loadGitHubCopilotApiToken();
    if (cached) return cached;
  }

  const endpoint = config.githubCopilot.githubHost === "github.com"
    ? "https://api.github.com/copilot_internal/v2/token"
    : `https://${config.githubCopilot.githubHost}/api/v3/copilot_internal/v2/token`;

  const response = await fetch(endpoint, {
    headers: {
      accept: "application/json",
      authorization: `token ${githubToken}`,
      "user-agent": "docs-ai-writing-assistant"
    }
  });

  if (!response.ok) {
    throw new Error(buildCopilotExchangeError(response.status, await response.text()));
  }

  const data = await response.json() as CopilotTokenResponse;
  const expiresAt = typeof data.expires_at === "number"
    ? new Date(data.expires_at * 1000)
    : new Date(data.expires_at);
  const apiBaseUrl = config.githubCopilot.apiBaseUrl || data.endpoints?.api || defaultCopilotApiBaseUrl();

  const record = { token: data.token, expiresAt, apiBaseUrl };
  await saveGitHubCopilotApiToken(record);
  return record;
}

export async function exchangeGitHubPatForCopilotToken(githubToken: string, forceRefresh = false) {
  if (!forceRefresh) {
    const cached = await loadGitHubCopilotApiToken();
    if (cached) return cached;
  }

  const endpoint = config.githubCopilot.githubHost === "github.com"
    ? "https://api.github.com/copilot_internal/user"
    : `https://${config.githubCopilot.githubHost}/api/v3/copilot_internal/user`;

  const response = await fetch(endpoint, {
    headers: {
      accept: "application/json",
      authorization: `Bearer ${githubToken}`,
      "copilot-integration-id": "vscode-chat",
      "editor-version": "docs-ai-writing-assistant/0.1.0",
      "user-agent": "docs-ai-writing-assistant"
    }
  });

  if (!response.ok) {
    throw new Error(buildCopilotPatExchangeError(response.status, await response.text()));
  }

  const data = await response.json() as CopilotUserResponse;
  const token = data.access_token ?? data.token;
  if (!token) {
    throw new Error([
      "GitHub accepted the fine-grained PAT, but copilot_internal/user did not return a Copilot chat access token.",
      `Response shape: ${JSON.stringify(summarizeJsonShape(data as JsonObject))}.`,
      "This means the PAT can reach Copilot account/quota APIs, but cannot be used directly as a chat bearer token.",
      "Use a Copilot OAuth token from device login (gho_/ghu_) or set AI_PROVIDER=local with a local Copilot proxy that performs the OAuth exchange."
    ].join(" "));
  }

  const expiresAt = data.expires_at
    ? typeof data.expires_at === "number"
      ? new Date(data.expires_at * 1000)
      : new Date(data.expires_at)
    : new Date(Date.now() + (data.expires_in ?? 3600) * 1000);
  const apiBaseUrl = config.githubCopilot.apiBaseUrl || data.endpoints?.api || defaultCopilotApiBaseUrl();

  const record = { token, expiresAt, apiBaseUrl };
  await saveGitHubCopilotApiToken(record);
  return record;
}

export async function diagnoseGitHubCopilotToken() {
  const githubToken = await loadGitHubCopilotToken() || config.githubCopilot.token;
  if (!githubToken) {
    throw new Error("No GitHub Copilot token is configured.");
  }
  assertNotClassicPat(githubToken);

  const userEndpoint = config.githubCopilot.githubHost === "github.com"
    ? "https://api.github.com/copilot_internal/user"
    : `https://${config.githubCopilot.githubHost}/api/v3/copilot_internal/user`;
  const userResponse = await fetch(userEndpoint, {
    headers: {
      accept: "application/json",
      authorization: `Bearer ${githubToken}`,
      "copilot-integration-id": "vscode-chat",
      "editor-version": "docs-ai-writing-assistant/0.1.0",
      "user-agent": "docs-ai-writing-assistant"
    }
  });
  const userBody = await readJsonOrText(userResponse);

  const result: JsonObject = {
    tokenPrefix: tokenPrefix(githubToken),
    userEndpoint: {
      status: userResponse.status,
      shape: typeof userBody === "object" && userBody !== null ? summarizeJsonShape(userBody as JsonObject) : userBody
    }
  };

  if (githubToken.startsWith("gho_") || githubToken.startsWith("ghu_")) {
    const tokenEndpoint = config.githubCopilot.githubHost === "github.com"
      ? "https://api.github.com/copilot_internal/v2/token"
      : `https://${config.githubCopilot.githubHost}/api/v3/copilot_internal/v2/token`;
    const tokenResponse = await fetch(tokenEndpoint, {
      headers: {
        accept: "application/json",
        authorization: `token ${githubToken}`,
        "user-agent": "docs-ai-writing-assistant"
      }
    });
    const tokenBody = await readJsonOrText(tokenResponse);
    result.tokenEndpoint = {
      status: tokenResponse.status,
      shape: typeof tokenBody === "object" && tokenBody !== null ? summarizeJsonShape(tokenBody as JsonObject) : tokenBody
    };
  }

  return result;
}

export async function callGitHubCopilotChat(system: string, user: string) {
  const auth = await getGitHubCopilotAuth();
  const response = await callCopilotChatCompletions(auth, system, user);

  if (
    config.githubCopilot.useTokenExchange &&
    !response.ok &&
    auth.source === "github-oauth" &&
    response.status !== 401 &&
    response.status !== 403
  ) {
    const githubToken = await loadGitHubCopilotToken() || config.githubCopilot.token;
    if (githubToken) {
      const exchanged = await exchangeGitHubTokenForCopilotToken(githubToken, true);
      const retry = await callCopilotChatCompletions(
        { token: exchanged.token, apiBaseUrl: exchanged.apiBaseUrl ?? defaultCopilotApiBaseUrl(), source: "copilot-api-token" },
        system,
        user
      );
      if (retry.ok) return readCopilotChatContent(retry);
      throw new Error(`GitHub Copilot chat failed ${retry.status}: ${await retry.text()}`);
    }
  }

  if (!response.ok) {
    throw new Error(buildCopilotChatError(response.status, await response.text(), auth.source));
  }

  return readCopilotChatContent(response);
}

async function callCopilotChatCompletions(auth: CopilotAuth, system: string, user: string) {
  return fetch(`${auth.apiBaseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      authorization: `Bearer ${auth.token}`,
      "copilot-integration-id": "vscode-chat",
      "editor-version": "docs-ai-writing-assistant/0.1.0",
      "openai-intent": "conversation-edits",
      "x-initiator": "user",
      "user-agent": "docs-ai-writing-assistant"
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
}

async function readCopilotChatContent(response: Response) {
  const data = await response.json() as { choices?: Array<{ finish_reason?: string; message?: { content?: string } }> };
  const choice = data.choices?.[0];
  const content = choice?.message?.content;
  if (!content) throw new Error("GitHub Copilot returned no chat content.");
  return { content, finishReason: choice?.finish_reason };
}

export async function listGitHubCopilotModels() {
  const auth = await getGitHubCopilotAuth();
  const response = await fetch(`${auth.apiBaseUrl.replace(/\/$/, "")}/models`, {
    headers: {
      accept: "application/json",
      authorization: `Bearer ${auth.token}`,
      "editor-version": "docs-ai-writing-assistant/0.1.0",
      "copilot-integration-id": "vscode-chat",
      "openai-intent": "conversation-edits",
      "x-initiator": "user",
      "user-agent": "docs-ai-writing-assistant"
    }
  });

  if (!response.ok) {
    throw new Error(buildCopilotChatError(response.status, await response.text(), auth.source));
  }
  return response.json();
}

function defaultCopilotApiBaseUrl() {
  return config.githubCopilot.apiBaseUrl || "https://api.githubcopilot.com";
}

function assertNotClassicPat(token: string) {
  if (token.startsWith("ghp_")) {
    throw new Error("Classic GitHub PATs (ghp_) are not supported by Copilot. Use a fine-grained github_pat_ token with the Copilot Requests account permission, a gho_ OAuth token, or a ghu_ GitHub App user token.");
  }
}

function buildCopilotExchangeError(status: number, body: string) {
  if (status === 404) {
    return [
      "GitHub Copilot token exchange returned 404. This internal exchange endpoint is unavailable for this token/account.",
      "Use direct Copilot auth instead: set COPILOT_GITHUB_TOKEN/GH_TOKEN/GITHUB_TOKEN to a fine-grained github_pat_ token with the Copilot Requests account permission, then restart the server.",
      `GitHub response: ${body}`
    ].join(" ");
  }
  return `GitHub Copilot token exchange failed ${status}: ${body}`;
}

function buildCopilotChatError(status: number, body: string, source: CopilotAuth["source"]) {
  if (status === 401 || status === 403) {
    return [
      `GitHub Copilot rejected the ${source} (${status}).`,
      "Confirm the token is not a classic ghp_ PAT, belongs to your personal account, has the Copilot Requests account permission, and that your Copilot plan/policy allows Copilot CLI/API requests.",
      `GitHub response: ${body}`
    ].join(" ");
  }
  return `GitHub Copilot chat failed ${status}: ${body}`;
}

function buildCopilotPatExchangeError(status: number, body: string) {
  if (status === 401 || status === 403) {
    return [
      `GitHub rejected the fine-grained PAT at copilot_internal/user (${status}).`,
      "Confirm the token is owned by your personal account, includes the Copilot Requests account permission, and that your Copilot license/policy allows CLI/API requests.",
      `GitHub response: ${body}`
    ].join(" ");
  }
  return `GitHub Copilot PAT exchange failed ${status}: ${body}`;
}

async function readJsonOrText(response: Response) {
  const text = await response.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function summarizeJsonShape(value: JsonObject): JsonObject {
  const summary: JsonObject = {};
  for (const [key, entry] of Object.entries(value)) {
    if (/token|secret|key|authorization/i.test(key)) {
      summary[key] = "[redacted]";
    } else if (Array.isArray(entry)) {
      summary[key] = `array(${entry.length})`;
    } else if (entry && typeof entry === "object") {
      summary[key] = summarizeJsonShape(entry as JsonObject);
    } else {
      summary[key] = typeof entry;
    }
  }
  return summary;
}

function tokenPrefix(token: string) {
  const match = token.match(/^([a-zA-Z_]+)_/);
  return match?.[1] ? `${match[1]}_...` : "unknown";
}
