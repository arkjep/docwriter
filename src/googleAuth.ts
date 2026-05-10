import { google, type Auth } from "googleapis";
import { config, requireGoogleConfig } from "./config.js";
import { deleteGoogleTokens, hasGoogleTokens, loadGoogleTokens, saveGoogleTokens } from "./db.js";

const DOCS_SCOPE = "https://www.googleapis.com/auth/documents";
const DRIVE_METADATA_SCOPE = "https://www.googleapis.com/auth/drive.metadata.readonly";

export function getGoogleScopes() {
  return config.google.scopeMode === "with_drive"
    ? [DOCS_SCOPE, DRIVE_METADATA_SCOPE]
    : [DOCS_SCOPE];
}

export function createOAuthClient() {
  requireGoogleConfig();
  return new google.auth.OAuth2(
    config.google.clientId,
    config.google.clientSecret,
    config.google.redirectUri
  );
}

export function getAuthUrl(options?: { selectAccount?: boolean }) {
  const client = createOAuthClient();
  return client.generateAuthUrl({
    access_type: "offline",
    include_granted_scopes: true,
    prompt: options?.selectAccount ? "consent select_account" : "consent",
    scope: getGoogleScopes()
  });
}

export async function handleOAuthCallback(code: string) {
  const client = createOAuthClient();
  const { tokens } = await client.getToken(code);
  client.setCredentials(tokens);
  await saveTokens(tokens);
}

export async function saveTokens(tokens: Auth.Credentials) {
  await saveGoogleTokens(tokens);
}

export async function hasStoredTokens() {
  return hasGoogleTokens();
}

export async function clearStoredTokens() {
  await deleteGoogleTokens();
}

export async function getAuthorizedClient() {
  const tokens = await loadGoogleTokens();
  if (!tokens) {
    throw new Error("Google account is not connected. Visit /auth/google first.");
  }
  const client = createOAuthClient();
  client.setCredentials(tokens);
  client.on("tokens", (newTokens) => {
    void saveTokens({ ...tokens, ...newTokens });
  });
  return client;
}
