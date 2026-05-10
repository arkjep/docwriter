let currentDocument = null;
let currentPatch = null;
let selectedParagraphIndex = null;

const statusEl = document.querySelector("#status");
const docInput = document.querySelector("#doc-input");
const parsedDocIdEl = document.querySelector("#parsed-doc-id");
const outlineEl = document.querySelector("#outline");
const docTitleEl = document.querySelector("#doc-title");
const recentDocsEl = document.querySelector("#recent-docs");
const chatLogEl = document.querySelector("#chat-log");
const messageEl = document.querySelector("#message");
const previewEl = document.querySelector("#preview");
const applyButton = document.querySelector("#apply");
const dryRunEl = document.querySelector("#dry-run");
const copilotPanelEl = document.querySelector("#copilot-panel");
const copilotDeviceEl = document.querySelector("#copilot-device");
const copilotTokenEl = document.querySelector("#copilot-token");

document.querySelector("#load-doc").addEventListener("click", () => loadDocument());
docInput.addEventListener("input", previewParsedDocId);
document.querySelector("#list-docs").addEventListener("click", listRecentDocs);
document.querySelector("#send").addEventListener("click", generateEdits);
document.querySelector("#connect-copilot").addEventListener("click", () => copilotPanelEl.classList.remove("hidden"));
document.querySelector("#close-copilot").addEventListener("click", () => copilotPanelEl.classList.add("hidden"));
document.querySelector("#save-copilot-token").addEventListener("click", saveCopilotToken);
document.querySelector("#start-copilot-device").addEventListener("click", startCopilotDeviceLogin);
applyButton.addEventListener("click", applyPatch);

init();

async function init() {
  const status = await api("/api/status");
  statusEl.textContent = status.googleConnected
    ? `Google connected. AI: ${status.aiProvider} / ${status.aiModel}${status.githubCopilotConnected ? " / Copilot connected" : ""}`
    : `Google not connected. AI: ${status.aiProvider} / ${status.aiModel}${status.githubCopilotConnected ? " / Copilot connected" : ""}`;
  document.querySelector("#list-docs").disabled = !status.driveListingEnabled;
  dryRunEl.checked = Boolean(status.dryRunDefault);
}

async function saveCopilotToken() {
  const token = copilotTokenEl.value.trim();
  if (!token) throwToast("Paste a GitHub token first.");
  await api("/auth/github-copilot/token", {
    method: "POST",
    body: JSON.stringify({ token })
  });
  copilotTokenEl.value = "";
  addChat("System", "GitHub Copilot token saved and exchanged successfully.");
  await init();
}

async function startCopilotDeviceLogin() {
  const data = await api("/auth/github-copilot/device/start", { method: "POST" });
  copilotDeviceEl.classList.remove("hidden");
  copilotDeviceEl.innerHTML = `
    <div>Enter code <strong>${escapeHtml(data.user_code)}</strong> at <a href="${escapeHtml(data.verification_uri)}" target="_blank" rel="noreferrer">${escapeHtml(data.verification_uri)}</a>.</div>
    <div>Waiting for authorization...</div>
  `;
  pollCopilotDevice(data.device_code, data.interval || 5);
}

async function pollCopilotDevice(deviceCode, intervalSeconds) {
  const timer = window.setInterval(async () => {
    try {
      const data = await api("/auth/github-copilot/device/poll", {
        method: "POST",
        body: JSON.stringify({ deviceCode })
      });
      if (data.authorized) {
        window.clearInterval(timer);
        copilotDeviceEl.textContent = "GitHub Copilot connected.";
        await init();
      }
    } catch (error) {
      window.clearInterval(timer);
      copilotDeviceEl.textContent = error.message;
    }
  }, intervalSeconds * 1000);
}

async function loadDocument(documentIdOrUrl = docInput.value) {
  documentIdOrUrl = String(documentIdOrUrl).trim();
  await previewParsedDocId();
  clearPatch();
  const data = await api("/api/docs/read", {
    method: "POST",
    body: JSON.stringify({ documentIdOrUrl })
  });
  currentDocument = data.document;
  selectedParagraphIndex = null;
  docTitleEl.textContent = currentDocument.title;
  renderOutline();
  addChat("System", `Loaded "${currentDocument.title}" with ${currentDocument.paragraphs.length} paragraphs.`);
}

async function previewParsedDocId() {
  const value = docInput.value.trim();
  if (!value) {
    parsedDocIdEl.textContent = "Paste a Docs URL or raw document ID.";
    return;
  }

  const data = await api("/api/docs/parse-id", {
    method: "POST",
    body: JSON.stringify({ documentIdOrUrl: value })
  });
  parsedDocIdEl.textContent = data.valid
    ? `Parsed document ID: ${data.documentId}`
    : `Could not parse a valid document ID from: ${data.documentId}`;
}

async function listRecentDocs() {
  const data = await api("/api/docs/recent");
  recentDocsEl.classList.remove("hidden");
  recentDocsEl.innerHTML = "";
  for (const file of data.files) {
    const button = document.createElement("button");
    button.className = "secondary";
    button.textContent = `${file.name} (${new Date(file.modifiedTime).toLocaleString()})`;
    button.addEventListener("click", () => {
      docInput.value = file.id;
      loadDocument(file.id);
    });
    recentDocsEl.append(button);
  }
}

function renderOutline() {
  outlineEl.classList.remove("empty");
  outlineEl.innerHTML = "";
  for (const paragraph of currentDocument.paragraphs) {
    const item = document.createElement("article");
    item.className = "paragraph";
    item.dataset.index = String(paragraph.paragraphIndex);
    item.innerHTML = `
      <div class="paragraph-meta">Paragraph ${paragraph.paragraphIndex} - indexes ${paragraph.startIndex}-${paragraph.endIndex}</div>
      <div>${escapeHtml(paragraph.text.trim() || "[empty paragraph]")}</div>
    `;
    item.addEventListener("click", () => {
      selectedParagraphIndex = paragraph.paragraphIndex;
      document.querySelectorAll(".paragraph").forEach((el) => el.classList.remove("selected"));
      item.classList.add("selected");
    });
    outlineEl.append(item);
  }
}

async function generateEdits() {
  if (!currentDocument) throwToast("Load a document first.");
  const message = messageEl.value.trim();
  if (!message) throwToast("Enter a writing request.");
  addChat("You", message);
  messageEl.value = "";
  const data = await api("/api/ai/propose", {
    method: "POST",
    body: JSON.stringify({
      document: currentDocument,
      selectedParagraphIndex,
      message
    })
  });
  currentPatch = data.patch;
  addChat("Assistant", currentPatch.summary);
  renderPreview();
}

function renderPreview() {
  applyButton.disabled = !currentPatch || currentPatch.edits.length === 0;
  previewEl.classList.remove("empty");
  if (!currentPatch.edits.length) {
    previewEl.textContent = currentPatch.summary;
    return;
  }

  previewEl.innerHTML = `<p>${escapeHtml(currentPatch.summary)}</p>`;
  for (const edit of currentPatch.edits) {
    const div = document.createElement("article");
    div.className = "edit";
    div.innerHTML = `
      <strong>Paragraph ${edit.target.paragraphIndex} - ${edit.target.startIndex}-${edit.target.endIndex}</strong>
      <div class="diff">
        <pre class="before">${escapeHtml(edit.target.currentText)}</pre>
        <pre class="after">${escapeHtml(edit.replacementText)}</pre>
      </div>
    `;
    previewEl.append(div);
  }
}

async function applyPatch() {
  if (!currentDocument || !currentPatch) return;
  const result = await api("/api/patch/apply", {
    method: "POST",
    body: JSON.stringify({
      documentId: currentDocument.documentId,
      patch: currentPatch,
      dryRun: dryRunEl.checked
    })
  });
  addChat("System", result.dryRun ? "Dry run succeeded. No changes were sent to Google Docs." : "Patch applied to Google Docs.");
  await loadDocument(currentDocument.documentId);
}

function clearPatch() {
  currentPatch = null;
  applyButton.disabled = true;
  previewEl.className = "preview empty";
  previewEl.textContent = "AI edit proposals will appear here before anything is applied.";
}

function addChat(role, text) {
  const div = document.createElement("div");
  div.className = "message";
  div.innerHTML = `<strong>${escapeHtml(role)}</strong>${escapeHtml(text)}`;
  chatLogEl.append(div);
  chatLogEl.scrollTop = chatLogEl.scrollHeight;
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    headers: { "content-type": "application/json", ...(options.headers ?? {}) },
    ...options
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throwToast(data.error || `Request failed: ${response.status}`);
  }
  return data;
}

function throwToast(message) {
  alert(message);
  throw new Error(message);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  })[char]);
}
