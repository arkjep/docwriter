import "dotenv/config";

export type AiProvider = "openai-compatible" | "anthropic" | "local" | "github-copilot";

const mongoHost = process.env.MONGODB_HOST ?? "127.0.0.1";
const mongoPort = process.env.MONGODB_PORT ?? "27017";

export const config = {
  port: Number(process.env.PORT ?? 3000),
  sessionSecret: process.env.SESSION_SECRET ?? "dev-only-change-me",
  appBaseUrl: process.env.APP_BASE_URL ?? "http://localhost:3000",
  dryRun: (process.env.DRY_RUN ?? "false").toLowerCase() === "true",
  mongodb: {
    host: mongoHost,
    port: Number(mongoPort),
    uri: process.env.MONGODB_URI ?? `mongodb://${mongoHost}:${mongoPort}`,
    dbName: process.env.MONGODB_DB ?? "docs_ai_assistant"
  },
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID ?? "",
    clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
    redirectUri:
      process.env.GOOGLE_REDIRECT_URI ??
      `${process.env.APP_BASE_URL ?? "http://localhost:3000"}/auth/google/callback`,
    scopeMode: process.env.GOOGLE_SCOPE_MODE === "with_drive" ? "with_drive" : "docs_only"
  },
  ai: {
    provider: (process.env.AI_PROVIDER ?? "openai-compatible") as AiProvider,
    apiKey: process.env.AI_API_KEY ?? "",
    baseUrl: process.env.AI_BASE_URL ?? "https://api.openai.com/v1",
    model: process.env.AI_MODEL ?? "gpt-4.1-mini",
    maxTokens: Number(process.env.AI_MAX_TOKENS ?? 8192)
  },
  githubCopilot: {
    githubHost: process.env.GITHUB_COPILOT_HOST ?? "github.com",
    clientId: process.env.GITHUB_COPILOT_CLIENT_ID ?? "Iv1.b507a08c87ecfe98",
    token:
      process.env.COPILOT_GITHUB_TOKEN ??
      process.env.GH_TOKEN ??
      process.env.GITHUB_TOKEN ??
      "",
    apiBaseUrl: process.env.GITHUB_COPILOT_API_BASE_URL ?? "",
    useTokenExchange: (process.env.GITHUB_COPILOT_USE_TOKEN_EXCHANGE ?? "false").toLowerCase() === "true"
  }
};

export function requireGoogleConfig() {
  if (!config.google.clientId || !config.google.clientSecret) {
    throw new Error("Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET in .env");
  }
}
