import { MongoClient, type Collection, type Db } from "mongodb";
import type { Auth } from "googleapis";
import type { PatchProposal } from "./patchTypes.js";
import { config } from "./config.js";

type GoogleTokenRecord = {
  _id: "development-user";
  tokens: Auth.Credentials;
  updatedAt: Date;
};

type PatchLogRecord = {
  documentId: string;
  kind: "proposal" | "apply";
  patch: PatchProposal;
  dryRun?: boolean;
  createdAt: Date;
};

type GitHubCopilotTokenRecord = {
  _id: "development-user";
  githubToken: string;
  updatedAt: Date;
};

type GitHubCopilotApiTokenRecord = {
  _id: "development-user";
  token: string;
  expiresAt: Date;
  apiBaseUrl?: string;
  updatedAt: Date;
};

let clientPromise: Promise<MongoClient> | undefined;

function getClient() {
  clientPromise ??= new MongoClient(config.mongodb.uri).connect();
  return clientPromise;
}

export async function getDb(): Promise<Db> {
  const client = await getClient();
  return client.db(config.mongodb.dbName);
}

async function googleTokens(): Promise<Collection<GoogleTokenRecord>> {
  return (await getDb()).collection<GoogleTokenRecord>("google_tokens");
}

async function patchLogs(): Promise<Collection<PatchLogRecord>> {
  return (await getDb()).collection<PatchLogRecord>("patch_logs");
}

async function githubCopilotTokens(): Promise<Collection<GitHubCopilotTokenRecord>> {
  return (await getDb()).collection<GitHubCopilotTokenRecord>("github_copilot_tokens");
}

async function githubCopilotApiTokens(): Promise<Collection<GitHubCopilotApiTokenRecord>> {
  return (await getDb()).collection<GitHubCopilotApiTokenRecord>("github_copilot_api_tokens");
}

export async function saveGoogleTokens(tokens: Auth.Credentials) {
  await (await googleTokens()).updateOne(
    { _id: "development-user" },
    { $set: { tokens, updatedAt: new Date() } },
    { upsert: true }
  );
}

export async function loadGoogleTokens() {
  const record = await (await googleTokens()).findOne({ _id: "development-user" });
  return record?.tokens;
}

export async function hasGoogleTokens() {
  return Boolean(await loadGoogleTokens());
}

export async function deleteGoogleTokens() {
  await (await googleTokens()).deleteOne({ _id: "development-user" });
}

export async function logPatch(record: Omit<PatchLogRecord, "createdAt">) {
  await (await patchLogs()).insertOne({ ...record, createdAt: new Date() });
}

export async function saveGitHubCopilotToken(githubToken: string) {
  await (await githubCopilotTokens()).updateOne(
    { _id: "development-user" },
    { $set: { githubToken, updatedAt: new Date() } },
    { upsert: true }
  );
}

export async function loadGitHubCopilotToken() {
  const record = await (await githubCopilotTokens()).findOne({ _id: "development-user" });
  return record?.githubToken;
}

export async function hasGitHubCopilotToken() {
  return Boolean(await loadGitHubCopilotToken());
}

export async function saveGitHubCopilotApiToken(record: Omit<GitHubCopilotApiTokenRecord, "_id" | "updatedAt">) {
  await (await githubCopilotApiTokens()).updateOne(
    { _id: "development-user" },
    { $set: { ...record, updatedAt: new Date() } },
    { upsert: true }
  );
}

export async function deleteGitHubCopilotApiToken() {
  await (await githubCopilotApiTokens()).deleteOne({ _id: "development-user" });
}

export async function loadGitHubCopilotApiToken() {
  const record = await (await githubCopilotApiTokens()).findOne({ _id: "development-user" });
  if (!record || record.expiresAt.getTime() <= Date.now() + 60_000) return undefined;
  return record;
}
