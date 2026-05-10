import express from "express";
import path from "node:path";
import { ZodError } from "zod";
import { config } from "./config.js";
import { clearStoredTokens, getAuthUrl, getAuthorizedClient, handleOAuthCallback, hasStoredTokens } from "./googleAuth.js";
import { extractGoogleDocId, getDocument, listRecentDocs } from "./googleDocs.js";
import { proposePatch } from "./aiClient.js";
import { patchProposalSchema } from "./patchTypes.js";
import { validatePatchProposal } from "./patchValidator.js";
import { applyPatch } from "./patchApplier.js";
import { getDb, logPatch } from "./db.js";
import {
  diagnoseGitHubCopilotToken,
  importGitHubCopilotToken,
  isGitHubCopilotConfigured,
  isGitHubCopilotConnected,
  listGitHubCopilotModels,
  pollGitHubCopilotDeviceLogin,
  startGitHubCopilotDeviceLogin
} from "./githubCopilot.js";

const publicDir = path.resolve(process.cwd(), "public");

const app = express();
app.use(express.json({ limit: "3mb" }));
app.use(express.static(publicDir));

app.get("/api/status", async (_req, res, next) => {
  try {
    await getDb();
    res.json({
      googleConnected: await hasStoredTokens(),
      driveListingEnabled: config.google.scopeMode === "with_drive",
      dryRunDefault: config.dryRun,
      aiProvider: config.ai.provider,
      aiModel: config.ai.model,
      mongodb: config.mongodb.dbName,
      githubCopilotConfigured: isGitHubCopilotConfigured(),
      githubCopilotConnected: await isGitHubCopilotConnected()
    });
  } catch (error) {
    next(error);
  }
});

app.get("/auth/google", (_req, res, next) => {
  try {
    res.redirect(getAuthUrl());
  } catch (error) {
    next(error);
  }
});

app.get("/auth/google/switch", async (_req, res, next) => {
  try {
    await clearStoredTokens();
    res.redirect(getAuthUrl({ selectAccount: true }));
  } catch (error) {
    next(error);
  }
});

app.get("/auth/google/callback", async (req, res, next) => {
  try {
    const code = String(req.query.code ?? "");
    if (!code) throw new Error("OAuth callback did not include a code.");
    await handleOAuthCallback(code);
    res.redirect("/?connected=1");
  } catch (error) {
    next(error);
  }
});

app.post("/auth/github-copilot/device/start", async (_req, res, next) => {
  try {
    res.json(await startGitHubCopilotDeviceLogin());
  } catch (error) {
    next(error);
  }
});

app.post("/auth/github-copilot/device/poll", async (req, res, next) => {
  try {
    const deviceCode = String(req.body.deviceCode ?? "");
    if (!deviceCode) throw new Error("Missing GitHub device code.");
    res.json(await pollGitHubCopilotDeviceLogin(deviceCode));
  } catch (error) {
    next(error);
  }
});

app.post("/auth/github-copilot/token", async (req, res, next) => {
  try {
    const token = String(req.body.token ?? "");
    if (!token) throw new Error("Missing GitHub Copilot token.");
    await importGitHubCopilotToken(token);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.get("/api/github-copilot/models", async (_req, res, next) => {
  try {
    res.json(await listGitHubCopilotModels());
  } catch (error) {
    next(error);
  }
});

app.get("/api/github-copilot/diagnose", async (_req, res, next) => {
  try {
    res.json(await diagnoseGitHubCopilotToken());
  } catch (error) {
    next(error);
  }
});

app.get("/api/docs/recent", async (_req, res, next) => {
  try {
    if (config.google.scopeMode !== "with_drive") {
      res.status(403).json({ error: "Drive listing is disabled. Set GOOGLE_SCOPE_MODE=with_drive." });
      return;
    }
    const auth = await getAuthorizedClient();
    res.json({ files: await listRecentDocs(auth) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/docs/parse-id", (req, res, next) => {
  try {
    const documentIdOrUrl = String(req.body.documentIdOrUrl ?? "");
    const documentId = extractGoogleDocId(documentIdOrUrl);
    const valid = /^[a-zA-Z0-9_-]+$/.test(documentId);
    res.json({ documentId, valid });
  } catch (error) {
    next(error);
  }
});

app.post("/api/docs/read", async (req, res, next) => {
  try {
    const documentIdOrUrl = String(req.body.documentIdOrUrl ?? "");
    if (!documentIdOrUrl.trim()) throw new Error("Paste a Google Doc ID or URL.");
    const auth = await getAuthorizedClient();
    res.json({ document: await getDocument(auth, documentIdOrUrl) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/ai/propose", async (req, res, next) => {
  try {
    const document = req.body.document;
    const message = String(req.body.message ?? "");
    const selectedParagraphIndex = req.body.selectedParagraphIndex;
    if (!document?.documentId) throw new Error("Load a document before chatting.");
    if (!message.trim()) throw new Error("Enter a writing request.");

    const patch = await proposePatch({ document, message, selectedParagraphIndex });
    const validation = validatePatchProposal(document, patch);
    if (!validation.ok) throw new Error(validation.reason);
    await logPatch({ documentId: document.documentId, kind: "proposal", patch });
    res.json({ patch });
  } catch (error) {
    next(error);
  }
});

app.post("/api/patch/apply", async (req, res, next) => {
  try {
    const documentId = String(req.body.documentId ?? "");
    const patch = patchProposalSchema.parse(req.body.patch);
    const dryRun = Boolean(req.body.dryRun);
    if (!documentId) throw new Error("Missing documentId.");
    const auth = await getAuthorizedClient();
    const result = await applyPatch(auth, documentId, patch, { dryRun });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const status = String((error as Error).message).includes("permission") ? 403 : 400;
  const message = error instanceof ZodError ? error.message : (error as Error).message;
  console.error(error);
  res.status(status).json({ error: message || "Unexpected server error." });
});

app.listen(config.port, () => {
  console.log(`Google Docs AI writing assistant running at http://localhost:${config.port}`);
});
