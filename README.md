# Google Docs AI Writing Assistant MVP

A local development MVP for connecting a Google account, reading a Google Doc through the Google Docs API, chatting with an AI writing assistant, previewing structured edit proposals, and applying approved edits back to the document with `documents.batchUpdate`.

This is not a Chrome extension. It does not use browser automation, DOM scraping, Gemini, or native suggestion mode.

MongoDB is used for local development persistence:

- `google_tokens`: one development user's OAuth tokens
- `patch_logs`: proposed and applied patches for audit/debugging

## Setup

1. Create a Google Cloud project.
2. Enable APIs:
   - Google Docs API
   - Google Drive API only if you set `GOOGLE_SCOPE_MODE=with_drive`
3. Configure OAuth consent screen for a development/test app.
4. Create OAuth 2.0 credentials:
   - Application type: Web application
   - Authorized redirect URI: `http://localhost:3000/auth/google/callback`
5. Copy `.env.example` to `.env` and fill in credentials.
6. Start MongoDB locally, or point `MONGODB_URI` at a development database.
7. Install dependencies:

```bash
npm install
```

8. Run locally:

```bash
npm run dev
```

Open `http://localhost:3000`.

## Google Scopes

Default `GOOGLE_SCOPE_MODE=docs_only` requests:

- `https://www.googleapis.com/auth/documents`

That scope is the minimum for reading and editing Google Docs via the Docs API. If you want the app to list recent documents, set `GOOGLE_SCOPE_MODE=with_drive`; this adds:

- `https://www.googleapis.com/auth/drive.metadata.readonly`

Users can always paste a Google Doc ID or URL, so Drive access is optional.

## MongoDB

Set these values in `.env`:

```bash
PORT=3000
MONGODB_HOST=127.0.0.1
MONGODB_PORT=27017
MONGODB_DB=docs_ai_assistant
```

`PORT` controls the Node/Express server. `MONGODB_PORT` controls the MongoDB connection port. If you need a full custom connection string, set `MONGODB_URI`; it overrides `MONGODB_HOST` and `MONGODB_PORT`.

This MVP intentionally stores one local development Google account token record. Add real sessions and per-user ownership before deploying.

## AI Providers

The AI layer supports:

- `openai-compatible`: `POST {AI_BASE_URL}/chat/completions`
- `anthropic`: `POST https://api.anthropic.com/v1/messages`
- `local`: same OpenAI-compatible protocol with a configurable local/private `AI_BASE_URL`
- `github-copilot`: experimental GitHub Copilot token exchange and chat calls

The assistant prompt requires JSON only. Malformed JSON is rejected.

### Experimental GitHub Copilot Provider

Set:

```bash
AI_PROVIDER=github-copilot
AI_MODEL=claude-sonnet-4
```

Then click **Connect Copilot** in the app and use the GitHub device-login flow. The app uses the public VS Code Copilot OAuth client ID by default:

```bash
GITHUB_COPILOT_CLIENT_ID=Iv1.b507a08c87ecfe98
```

The resulting OAuth token is stored in MongoDB and takes precedence over `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, and `GITHUB_TOKEN`.

If you already have a Copilot OAuth token, you can also provide it through one of:

```bash
COPILOT_GITHUB_TOKEN=gho_or_ghu_oauth_token
GH_TOKEN=gho_or_ghu_oauth_token
GITHUB_TOKEN=gho_or_ghu_oauth_token
```

Fine-grained PATs can access some Copilot account/quota endpoints, but GitHub's chat endpoint rejects PATs directly and `copilot_internal/user` may not return a chat access token. For this integration, use OAuth/device login.

Supported token types are:

- `gho_...`: OAuth token from a Copilot-compatible device login
- `ghu_...`: GitHub App user-to-server token

OAuth tokens are exchanged through `https://api.github.com/copilot_internal/v2/token`. The resulting short-lived Copilot access token is then used with `https://api.githubcopilot.com`.

The older automatic fallback token-exchange behavior can return 403/404 for some accounts/token types, so this app does not use it by default. You can opt into that fallback with `GITHUB_COPILOT_USE_TOKEN_EXCHANGE=true`.

For safe debugging, visit `/api/github-copilot/diagnose`; it reports response shapes and statuses without printing token values.

This provider remains experimental/local-dev only because it relies on Copilot-compatible OAuth/client behavior rather than a broadly documented public SaaS API for arbitrary third-party apps.

## Patch Format

Example response expected from the AI:

```json
{
  "summary": "Tightens the introduction and makes the call to action more direct.",
  "edits": [
    {
      "type": "replace_text",
      "target": {
        "paragraphIndex": 3,
        "startIndex": 142,
        "endIndex": 219,
        "currentText": "original text here"
      },
      "replacementText": "new text here"
    }
  ]
}
```

Before applying, the server reloads the document and verifies that every target paragraph and `currentText` still matches. If the document changed, the app refuses to apply and asks the user to refresh.

## Example Prompts

- "Make paragraph 2 more concise while preserving my tone."
- "Rewrite the introduction for a grant application audience."
- "Find repetitive phrasing and propose replacements only where you are confident."
- "Improve transitions between the final three paragraphs."

## Dry Run

Set `DRY_RUN=true` in `.env` or send `dryRun: true` from the UI apply action. The server validates the patch and returns the Google Docs API requests that would be sent without calling `documents.batchUpdate`.

## Troubleshooting Docs Access

If loading a pasted doc says Google could not find the requested entity:

- Make sure the URL is an editable Google Docs URL like `https://docs.google.com/document/d/<doc-id>/edit`.
- Published URLs like `/document/d/e/.../pub` do not contain the native Docs API document ID.
- Use **Switch Google** in the app if the doc belongs to a different Google account than the one currently stored in MongoDB.
- Confirm the file is a native Google Doc, not a Word/PDF file in Drive.
- Confirm the authorized account has access to the doc.

## Development Notes

Google Docs indexes are absolute UTF-16 document indexes. `batchUpdate` delete/insert requests are applied in reverse order by `startIndex`, so later document ranges are modified before earlier ranges. This prevents earlier edits from shifting the indexes of later edits.

Run tests:

```bash
npm test
```
