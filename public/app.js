let currentDocument = null;
let currentPatch = null;
let selectedParagraphIndex = null;
let selectedText = "";
let selectedRange = null;
let savedTextSelectionRange = null;
let activeTabId = null;
let virtualParagraphCounter = 0;
let displayParagraphCounter = 1;
const draftEdits = new Map();
const indexDraftEdits = new Map();
const formatDraftEdits = new Map();
const pendingInlineStyle = {
  bold: null,
  italic: null,
  underline: null
};
const pendingInlineStyleStart = {
  bold: null,
  italic: null,
  underline: null
};
let lastHandledTextStyleShortcut = null;
const PAGE_THEME_STORAGE_KEY = "docs-assistant-page-theme";

const docInput = document.querySelector("#doc-input");
const parsedDocIdEl = document.querySelector("#parsed-doc-id");
const outlineEl = document.querySelector("#outline");
const docTitleEl = document.querySelector("#doc-title");
const tabStripEl = document.querySelector("#tab-strip");
const formatToolbarEl = document.querySelector("#format-toolbar");
const fontFamilyEl = document.querySelector("#font-family");
const fontSizeEl = document.querySelector("#font-size");
const recentDocsEl = document.querySelector("#recent-docs");
const chatLogEl = document.querySelector("#chat-log");
const messageEl = document.querySelector("#message");
const previewEl = document.querySelector("#preview");
const applyButton = document.querySelector("#apply");
const dryRunEl = document.querySelector("#dry-run");
const copilotPanelEl = document.querySelector("#copilot-panel");
const copilotDeviceEl = document.querySelector("#copilot-device");
const copilotTokenEl = document.querySelector("#copilot-token");
const providerBadgeEl = document.querySelector("#provider-badge");
const googleStatusEl = document.querySelector("#google-status");
const copilotStatusEl = document.querySelector("#copilot-status");
const documentModalEl = document.querySelector("#document-modal");
const connectionsModalEl = document.querySelector("#connections-modal");

document.querySelector("#load-doc").addEventListener("click", () => loadDocument());
docInput.addEventListener("input", previewParsedDocId);
document.querySelector("#open-doc-modal").addEventListener("click", openDocumentPicker);
document.querySelector("#refresh-recent-docs").addEventListener("click", listRecentDocs);
document.querySelector("#open-connections-modal").addEventListener("click", () => openModal(connectionsModalEl));
document.querySelectorAll("[data-close-modal]").forEach((button) => {
  button.addEventListener("click", closeModals);
});
document.querySelectorAll(".modal").forEach((modal) => {
  modal.addEventListener("click", (event) => {
    if (event.target === modal) closeModals();
  });
});
document.querySelector("#send").addEventListener("click", generateEdits);
document.querySelector("#toggle-page-theme").addEventListener("click", () => {
  setPageTheme(outlineEl.classList.contains("dark-page") ? "light" : "dark");
});
document.querySelectorAll("[data-command]").forEach((button) => {
  button.addEventListener("mousedown", (event) => event.preventDefault());
  button.addEventListener("click", () => runFormatCommand(button.dataset.command));
});
document.querySelectorAll("[data-paragraph-action]").forEach((button) => {
  button.addEventListener("click", () => queueParagraphFormatAction(button.dataset.paragraphAction));
});
fontFamilyEl.addEventListener("change", () => runFormatCommand("fontName", fontFamilyEl.value));
fontSizeEl.addEventListener("change", () => applyFontSize(fontSizeEl.value));
document.querySelector("#connect-copilot").addEventListener("click", () => copilotPanelEl.classList.remove("hidden"));
document.querySelector("#save-copilot-token").addEventListener("click", saveCopilotToken);
document.querySelector("#start-copilot-device").addEventListener("click", startCopilotDeviceLogin);
applyButton.addEventListener("click", applyPatch);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeModals();
});
document.addEventListener("keydown", handleFormattingShortcut, true);
document.addEventListener("selectionchange", captureDocumentSelection);
outlineEl.addEventListener("keyup", updateToolbarState);
outlineEl.addEventListener("mouseup", updateToolbarState);
outlineEl.addEventListener("click", updateActiveLineFromEvent);
outlineEl.addEventListener("beforeinput", handleEditorBeforeInput, true);

init();

async function init() {
  const status = await api("/api/status");
  restorePageTheme();
  providerBadgeEl.textContent = `${status.aiProvider} / ${status.aiModel}`;
  googleStatusEl.classList.toggle("connected", Boolean(status.googleConnected));
  googleStatusEl.title = status.googleConnected ? "Google connected" : "Google not connected";
  copilotStatusEl.classList.toggle("connected", Boolean(status.githubCopilotConnected));
  copilotStatusEl.title = status.githubCopilotConnected ? "Copilot connected" : "Copilot not connected";
  document.querySelector("#refresh-recent-docs").disabled = !status.driveListingEnabled;
  recentDocsEl.innerHTML = status.driveListingEnabled
    ? `<div class="empty">Open this picker to load recent Docs.</div>`
    : `<div class="empty">Recent Docs requires Drive metadata scope.</div>`;
  dryRunEl.checked = Boolean(status.dryRunDefault);
}

function restorePageTheme() {
  setPageTheme(localStorage.getItem(PAGE_THEME_STORAGE_KEY) || "light", { persist: false });
}

function setPageTheme(theme, options = { persist: true }) {
  const dark = theme === "dark";
  outlineEl.classList.toggle("dark-page", dark);
  document.querySelector("#toggle-page-theme").classList.toggle("active", dark);
  if (options.persist) localStorage.setItem(PAGE_THEME_STORAGE_KEY, dark ? "dark" : "light");
}

function openModal(modal) {
  closeModals();
  modal.classList.remove("hidden");
}

function closeModals() {
  document.querySelectorAll(".modal").forEach((modal) => modal.classList.add("hidden"));
}

async function openDocumentPicker() {
  openModal(documentModalEl);
  await listRecentDocs();
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
  draftEdits.clear();
  indexDraftEdits.clear();
  formatDraftEdits.clear();
  resetPendingInlineStyles();
  selectedText = "";
  selectedRange = null;
  activeTabId = currentDocument.tabs?.[0]?.tabId ?? "";
  selectedParagraphIndex = null;
  docTitleEl.textContent = currentDocument.title;
  renderTabStrip();
  renderFormatToolbar();
  renderDraftBar();
  renderOutline();
  addChat("System", `Loaded "${currentDocument.title}" with ${currentDocument.paragraphs.length} paragraphs.`);
  closeModals();
}

async function refreshDocumentPreservingSuggestions() {
  if (!currentDocument) return;
  const documentId = currentDocument.documentId;
  const remainingPatch = currentPatch;
  const data = await api("/api/docs/read", {
    method: "POST",
    body: JSON.stringify({ documentIdOrUrl: documentId })
  });
  currentDocument = data.document;
  activeTabId = currentDocument.tabs?.some((tab) => tab.tabId === activeTabId)
    ? activeTabId
    : currentDocument.tabs?.[0]?.tabId ?? "";
  docTitleEl.textContent = currentDocument.title;
  renderTabStrip();
  renderFormatToolbar();
  renderOutline();
  currentPatch = remainingPatch;
  rebuildDraftStateFromPatch();
  repaintDraftVisualsFromPatch();
  renderDraftBar();
  renderPreview();
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
  recentDocsEl.innerHTML = "";
  for (const file of data.files) {
    const button = document.createElement("button");
    button.className = "secondary";
    button.textContent = file.name;
    button.addEventListener("click", () => {
      docInput.value = file.id;
      loadDocument(file.id);
    });
    recentDocsEl.append(button);
  }
  if (!data.files.length) {
    recentDocsEl.innerHTML = `<div class="empty">No recent Google Docs found.</div>`;
  }
}

function renderOutline() {
  outlineEl.classList.remove("empty");
  outlineEl.setAttribute("contenteditable", "true");
  outlineEl.setAttribute("spellcheck", "true");
  outlineEl.innerHTML = "";
  displayParagraphCounter = 1;
  const activeTab = getActiveTab();
  const paragraphs = activeTab?.paragraphs ?? currentDocument.paragraphs;
  outlineEl.append(renderLinearDocument(paragraphs));
  if (!paragraphs.length) {
    outlineEl.classList.add("empty");
    outlineEl.textContent = "This tab has no body paragraphs.";
  }
  outlineEl.removeEventListener("input", syncDraftEditsFromDom);
  outlineEl.addEventListener("input", syncDraftEditsFromDom);
  outlineEl.removeEventListener("keydown", handleEditorKeydown);
  outlineEl.addEventListener("keydown", handleEditorKeydown);
}

function renderLinearDocument(paragraphs) {
  const fragment = document.createDocumentFragment();
  const listCounters = new Map();
  for (const paragraph of paragraphs) {
    if (draftEdits.get(paragraph.paragraphIndex)?.delete) continue;
    const row = document.createElement("div");
    row.className = "doc-line";
    row.dataset.paragraphIndex = String(paragraph.paragraphIndex);
    row.dataset.tabId = paragraph.tabId ?? "";
    row.dataset.startIndex = String(paragraph.startIndex);
    row.dataset.endIndex = String(paragraph.endIndex);
    row.style.cssText = paragraphRowStyle(paragraph);

    const gutter = document.createElement("span");
    gutter.className = "paragraph-number";
    gutter.contentEditable = "false";
    gutter.title = `Paragraph ${displayParagraphCounter}`;
    gutter.textContent = String(displayParagraphCounter++);
    row.append(gutter);

    const body = document.createElement("span");
    body.className = "doc-line-body";
    body.style.cssText = paragraphBodyStyle(paragraph);

    const marker = document.createElement("span");
    marker.className = "list-marker";
    marker.contentEditable = "false";
    marker.textContent = listMarker(paragraph, listCounters);
    row.classList.toggle("list-line", Boolean(paragraph.bullet));
    body.append(marker);

    const content = document.createElement("span");
    content.className = "doc-line-content";
    content.innerHTML = renderIndexedParagraphContent(paragraph);
    body.append(content);
    row.append(body);
    fragment.append(row);
  }
  return fragment;
}

function renderIndexedParagraphContent(paragraph) {
  const runs = paragraph.textRuns?.length
    ? paragraph.textRuns
    : [{ startIndex: paragraph.startIndex, endIndex: paragraph.endIndex, text: paragraph.text, style: {} }];
  return runs.map((run) => {
    const text = stripParagraphBreak(run.text);
    if (!text) return `<span class="doc-char empty-paragraph" ${spanIndexData(paragraph, run.startIndex, run.startIndex)}><br></span>`;
    const style = textRunStyle(run.style);
    return [...text].map((char, offset) => {
      const start = run.startIndex + offset;
      return `<span class="doc-char" ${spanIndexData(paragraph, start, start + 1)}${style ? ` style="${style}"` : ""}>${escapeHtml(char)}</span>`;
    }).join("");
  }).join("");
}

function renderIndexedParagraphSlice(paragraph, sliceStart, sliceEnd) {
  const runs = paragraph.textRuns?.length
    ? paragraph.textRuns
    : [{ startIndex: paragraph.startIndex, endIndex: paragraph.endIndex, text: paragraph.text, style: {} }];
  return runs.map((run) => {
    const text = stripParagraphBreak(run.text);
    if (!text) return "";
    const style = textRunStyle(run.style);
    return [...text].map((char, offset) => {
      const start = run.startIndex + offset;
      const paragraphOffset = start - paragraph.startIndex;
      if (paragraphOffset < sliceStart || paragraphOffset >= sliceEnd) return "";
      return `<span class="doc-char" ${spanIndexData(paragraph, start, start + 1)}${style ? ` style="${style}"` : ""}>${escapeHtml(char)}</span>`;
    }).join("");
  }).join("");
}

function spanIndexData(paragraph, startIndex, endIndex) {
  return `data-tab-id="${escapeHtml(paragraph.tabId ?? "")}" data-paragraph-index="${paragraph.paragraphIndex}" data-start-index="${startIndex}" data-end-index="${endIndex}"`;
}

function renderParagraphContent(paragraph, text) {
  if (draftEdits.has(paragraph.paragraphIndex)) return escapeHtml(text);
  const runs = paragraph.textRuns ?? [];
  if (!runs.length) return escapeHtml(text);
  return runs.map((run) => {
    const runText = stripParagraphBreak(run.text);
    if (!runText) return "";
    const style = textRunStyle(run.style);
    return `<span${style ? ` style="${style}"` : ""}>${escapeHtml(runText)}</span>`;
  }).join("");
}

function textRunStyle(style = {}) {
  const declarations = [];
  if (style.bold) declarations.push("font-weight:700");
  if (style.italic) declarations.push("font-style:italic");
  if (style.underline) declarations.push("text-decoration:underline");
  if (style.fontSize?.magnitude) declarations.push(`font-size:${Number(style.fontSize.magnitude)}pt`);
  if (style.weightedFontFamily?.fontFamily) declarations.push(`font-family:${cssString(style.weightedFontFamily.fontFamily)}`);
  const color = style.foregroundColor?.color?.rgbColor;
  if (color) declarations.push(`color:${rgbColor(color)}`);
  return declarations.join(";");
}

function paragraphRowStyle(paragraph) {
  const declarations = [];
  const spaceAbove = dimensionToPt(paragraph.style?.spaceAbove);
  const spaceBelow = dimensionToPt(paragraph.style?.spaceBelow);
  if (spaceAbove) declarations.push(`margin-top:${spaceAbove}pt`);
  if (spaceBelow) declarations.push(`margin-bottom:${spaceBelow}pt`);
  return declarations.join(";");
}

function paragraphBodyStyle(paragraph, overrides = {}) {
  const declarations = [];
  const alignment = paragraph.style?.alignment;
  if (alignment) declarations.push(`text-align:${cssAlignment(alignment)}`);
  const indentStart = overrides.indentStart ?? dimensionToPt(paragraph.style?.indentStart);
  const indentEnd = dimensionToPt(paragraph.style?.indentEnd);
  const indentFirstLine = dimensionToPt(paragraph.style?.indentFirstLine);
  if (indentStart) declarations.push(`margin-left:${indentStart}pt`);
  if (indentEnd) declarations.push(`margin-right:${indentEnd}pt`);
  if (indentFirstLine) declarations.push(`text-indent:${indentFirstLine}pt`);
  return declarations.join(";");
}

function paragraphStyle(paragraph) {
  return `${paragraphRowStyle(paragraph)};${paragraphBodyStyle(paragraph)}`;
}

function inheritedParagraphBodyStyle(paragraph) {
  return paragraphBodyStyle(paragraph, { indentStart: currentDraftIndentStart(paragraph) });
}

function cssAlignment(alignment) {
  const value = String(alignment).toUpperCase();
  if (value === "CENTER") return "center";
  if (value === "END") return "right";
  if (value === "JUSTIFIED") return "justify";
  return "left";
}

function dimensionToPt(dimension) {
  if (!dimension?.magnitude) return 0;
  const unit = String(dimension.unit ?? "PT").toUpperCase();
  const magnitude = Number(dimension.magnitude);
  if (unit === "PT") return magnitude;
  return magnitude;
}

function listMarker(paragraph, counters) {
  const bullet = paragraph.bullet;
  if (!bullet) return "";
  const key = `${bullet.listId ?? "list"}:${bullet.nestingLevel ?? 0}`;
  const glyphType = String(bullet.glyphType ?? "").toUpperCase();
  if (bullet.glyphSymbol && !String(bullet.glyphSymbol).includes("%")) return bullet.glyphSymbol;
  if (!isNumberedParagraph(paragraph)) return ["•", "◦", "▪"][Math.min(bullet.nestingLevel ?? 0, 2)];
  const next = (counters.get(key) ?? (bullet.startNumber ?? 1) - 1) + 1;
  counters.set(key, next);
  return formatListNumber(next, glyphType);
}

function formatListNumber(number, glyphType = "") {
  const normalized = String(glyphType).toUpperCase();
  if (normalized.includes("ALPHA")) return `${numberToAlpha(number, normalized.includes("UPPER"))}.`;
  if (normalized.includes("ROMAN")) return `${numberToRoman(number, normalized.includes("UPPER"))}.`;
  return `${number}.`;
}

function continuationListMarker(paragraph, sourceLine) {
  if (!paragraph.bullet) return "";
  const marker = sourceLine?.querySelector(".list-marker")?.textContent?.trim() ?? "";
  if (!isNumberedParagraph(paragraph)) {
    return marker || ["•", "◦", "▪"][Math.min(paragraph.bullet.nestingLevel ?? 0, 2)];
  }
  const numeric = marker.match(/^(\d+)([.)])?$/);
  if (numeric) return `${Number(numeric[1]) + 1}${numeric[2] ?? "."}`;
  return formatListNumber((paragraph.bullet.startNumber ?? 1) + 1, paragraph.bullet.glyphType);
}

function numberToAlpha(number, upper = false) {
  let n = number;
  let label = "";
  while (n > 0) {
    n -= 1;
    label = String.fromCharCode(97 + (n % 26)) + label;
    n = Math.floor(n / 26);
  }
  return upper ? label.toUpperCase() : label;
}

function numberToRoman(number, upper = false) {
  const numerals = [
    [1000, "m"], [900, "cm"], [500, "d"], [400, "cd"], [100, "c"], [90, "xc"],
    [50, "l"], [40, "xl"], [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"]
  ];
  let n = number;
  let result = "";
  for (const [value, symbol] of numerals) {
    while (n >= value) {
      result += symbol;
      n -= value;
    }
  }
  return upper ? result.toUpperCase() : result;
}

function editableParagraphText(paragraph) {
  return stripParagraphBreak(paragraph.text);
}

function stripParagraphBreak(text) {
  return String(text ?? "").replace(/\n$/, "");
}

function cssString(value) {
  return `"${String(value).replace(/["\\]/g, "")}"`;
}

function rgbColor(color) {
  const red = Math.round((color.red ?? 0) * 255);
  const green = Math.round((color.green ?? 0) * 255);
  const blue = Math.round((color.blue ?? 0) * 255);
  return `rgb(${red}, ${green}, ${blue})`;
}

function renderDraftBar() {
  // Draft state is surfaced in the editor gutter and Preview panel.
}

function syncDraftEditsFromDom(event) {
  const line = findLineFromEventOrSelection(event);
  if (line) syncLineDraftEdit(line);
  renderDraftBar();
  syncDraftPreview();
}

function findLineFromEventOrSelection(event) {
  const eventNode = event?.target?.nodeType === Node.TEXT_NODE
    ? event.target.parentElement
    : event?.target;
  const eventLine = eventNode?.closest?.(".doc-line");
  if (eventLine) return eventLine;

  const selection = window.getSelection();
  if (!selection?.rangeCount) return null;
  const range = selection.getRangeAt(0);
  const node = range.startContainer?.nodeType === Node.TEXT_NODE
    ? range.startContainer.parentElement
    : range.startContainer;
  return node?.closest?.(".doc-line") ?? null;
}

function syncLineDraftEdit(line) {
  stripNativeInlineFormatting(line);
  const paragraphIndex = Number(line.dataset.paragraphIndex);
  const paragraph = currentDocument?.paragraphs[paragraphIndex];
  if (!paragraph) {
    const virtualKey = line.dataset.draftKey;
    if (virtualKey && indexDraftEdits.has(virtualKey)) {
      const splitReplacement = composeSplitReplacement(line, virtualKey);
      indexDraftEdits.get(virtualKey).replacementText = splitReplacement ?? getLineEditableText(line);
    }
    return;
  }

  const currentText = editableParagraphText(paragraph);
  const nextText = getLineEditableText(line);
  const key = `replace-${paragraph.tabId}-${paragraph.startIndex}-${paragraph.startIndex + currentText.length}`;
  if (nextText === currentText) {
    const content = line.querySelector(".doc-line-content");
    const caretOffset = content ? getCaretTextOffset(content) : currentText.length;
    removeDraftTextEditForParagraph(paragraph);
    removePendingInlineStyleDraftsForParagraph(paragraph);
    clearInlineDiff(line, currentText);
    placeCaretAtTextOffset(content, Math.min(caretOffset, currentText.length));
    return;
  }

  const replacementText = composeSplitReplacement(line, key) ?? nextText;
  const minimal = minimalTextReplacement(currentText, replacementText, paragraph.startIndex);
  removeDraftTextEditForParagraph(paragraph);
  const minimalKey = `replace-${paragraph.tabId}-${minimal.startIndex}-${minimal.endIndex}`;
  indexDraftEdits.set(minimalKey, {
    paragraph,
    startIndex: minimal.startIndex,
    endIndex: minimal.endIndex,
    currentText: minimal.currentText,
    replacementText: minimal.replacementText
  });
  queuePendingInlineStyleForReplacement(paragraph, minimal);
  updateInlineDiff(line, currentText, replacementText);
}

function stripNativeInlineFormatting(line) {
  const content = line?.querySelector(".doc-line-content");
  if (!content) return;

  for (const element of [...content.querySelectorAll("b, strong, i, em, u, font")]) {
    element.replaceWith(...element.childNodes);
  }

  for (const element of [...content.querySelectorAll("[style]")]) {
    if (element.classList.contains("doc-char") || element.classList.contains("doc-insert")) continue;
    element.style.fontWeight = "";
    element.style.fontStyle = "";
    element.style.textDecoration = "";
    if (!element.getAttribute("style")) element.removeAttribute("style");
  }
}

function minimalTextReplacement(before, after, baseIndex) {
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) {
    prefix += 1;
  }

  let suffix = 0;
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const beforeEnd = before.length - suffix;
  const afterEnd = after.length - suffix;
  return {
    startIndex: baseIndex + prefix,
    endIndex: baseIndex + beforeEnd,
    currentText: before.slice(prefix, beforeEnd),
    replacementText: after.slice(prefix, afterEnd)
  };
}

function composeSplitReplacement(line, draftKey) {
  if (!line || !draftKey) return null;
  if (line.dataset.splitReplacement === "true") {
    const previous = line.previousElementSibling?.classList?.contains("doc-line")
      ? line.previousElementSibling
      : null;
    return `${getLineEditableText(previous)}\n${getLineEditableText(line)}`;
  }
  const next = line.nextElementSibling?.dataset?.draftKey === draftKey
    ? line.nextElementSibling
    : null;
  if (next?.dataset.splitReplacement === "true") {
    return `${getLineEditableText(line)}\n${getLineEditableText(next)}`;
  }
  return null;
}

function updateInlineDiff(line, before, after) {
  if (!line) return;
  line.querySelector(".inline-diff")?.remove();
  const parts = computeTokenDiff(before, after);
  const content = line.querySelector(".doc-line-content");
  const caretOffset = content ? getCaretTextOffset(content) : null;
  const paragraph = currentDocument?.paragraphs[Number(line.dataset.paragraphIndex)];
  if (content) {
    content.innerHTML = paragraph
      ? renderEditorInlineDiff(parts, paragraph)
      : renderEditorInlineDiff(parts);
    placeCaretAtTextOffset(content, Math.min(caretOffset ?? after.length, after.length));
  }
  line.classList.add("has-diff");
  line.classList.toggle("has-insert", parts.some((part) => part.type === "insert"));
  line.classList.toggle("has-delete", parts.some((part) => part.type === "delete"));
}

function clearInlineDiff(line, resetText = null) {
  line?.querySelector(".inline-diff")?.remove();
  line?.querySelector(".format-indicator")?.remove();
  line?.classList.remove("has-diff", "has-insert", "has-delete", "has-format-change");
  if (resetText != null) {
    const content = line?.querySelector(".doc-line-content");
    if (content) content.textContent = resetText;
  }
}

function setFormatIndicator(line, label) {
  if (!line) return;
  let indicator = line.querySelector(".format-indicator");
  if (!indicator) {
    indicator = document.createElement("div");
    indicator.className = "format-indicator";
    indicator.contentEditable = "false";
    line.append(indicator);
  }
  indicator.textContent = label;
  line.classList.add("has-diff", "has-format-change");
}

function computeTokenDiff(before, after) {
  const oldTokens = diffTokens(before);
  const newTokens = diffTokens(after);
  const rows = Array.from({ length: oldTokens.length + 1 }, () => Array(newTokens.length + 1).fill(0));
  for (let i = oldTokens.length - 1; i >= 0; i -= 1) {
    for (let j = newTokens.length - 1; j >= 0; j -= 1) {
      rows[i][j] = oldTokens[i] === newTokens[j]
        ? rows[i + 1][j + 1] + 1
        : Math.max(rows[i + 1][j], rows[i][j + 1]);
    }
  }

  const parts = [];
  let i = 0;
  let j = 0;
  while (i < oldTokens.length && j < newTokens.length) {
    if (oldTokens[i] === newTokens[j]) {
      pushDiffPart(parts, "equal", oldTokens[i]);
      i += 1;
      j += 1;
    } else if (rows[i + 1][j] >= rows[i][j + 1]) {
      pushDiffPart(parts, "delete", oldTokens[i]);
      i += 1;
    } else {
      pushDiffPart(parts, "insert", newTokens[j]);
      j += 1;
    }
  }
  while (i < oldTokens.length) pushDiffPart(parts, "delete", oldTokens[i++]);
  while (j < newTokens.length) pushDiffPart(parts, "insert", newTokens[j++]);
  return parts;
}

function diffTokens(text) {
  return Array.from(String(text ?? ""));
}

function pushDiffPart(parts, type, value) {
  if (!value) return;
  const last = parts.at(-1);
  if (last?.type === type) {
    last.value += value;
  } else {
    parts.push({ type, value });
  }
}

function renderTokenDiff(before, after, options = {}) {
  const parts = computeTokenDiff(before, after);
  const html = parts.map((part, index) => {
    if (part.type === "equal") {
      const value = options.compactEquals && part.value.length > 90
        ? compactEqualText(part.value, index === 0, index === parts.length - 1)
        : part.value;
      return `<span class="diff-equal">${escapeHtml(options.visibleWhitespace ? visibleWhitespace(value) : value)}</span>`;
    }
    const value = options.visibleWhitespace ? visibleWhitespace(part.value) : part.value;
    return `<span class="diff-${part.type}">${escapeHtml(value)}</span>`;
  }).join("");
  return html || `<span class="diff-equal">No textual change</span>`;
}

function renderEditorInlineDiff(parts, paragraph = null) {
  let originalOffset = 0;
  return parts
    .filter((part) => part.type !== "delete")
    .map((part) => {
      if (part.type === "insert") {
        const insertionIndex = paragraph ? paragraph.startIndex + originalOffset : null;
        return [...part.value].map((char, offset) => {
          const absoluteIndex = insertionIndex == null ? null : insertionIndex + offset;
          const style = absoluteIndex == null ? pendingInlineStyleCss() : draftTextStyleCssAtIndex(absoluteIndex, paragraph);
          const data = absoluteIndex == null
            ? ""
            : ` ${spanIndexData(paragraph, absoluteIndex, absoluteIndex + 1)}`;
          return `<span class="doc-insert"${data}${style ? ` style="${style}"` : ""}>${escapeHtml(char)}</span>`;
        }).join("");
      }
      const html = [...part.value].map((char) => renderOriginalStyledChar(paragraph, originalOffset++, char)).join("");
      return html;
    })
    .join("");
}

function draftTextStyleCssAtIndex(index, paragraph = null) {
  const declarations = [];
  for (const edit of formatDraftEdits.values()) {
    if (edit.type !== "update_text_style") continue;
    if (paragraph && edit.target.paragraphIndex !== paragraph.paragraphIndex) continue;
    if (paragraph && (edit.target.tabId ?? "") !== (paragraph.tabId ?? "")) continue;
    if (index < edit.target.startIndex || index >= edit.target.endIndex) continue;
    if (edit.fields === "bold") declarations.push(`font-weight:${edit.textStyle?.bold ? "700" : "400"}`);
    if (edit.fields === "italic") declarations.push(`font-style:${edit.textStyle?.italic ? "italic" : "normal"}`);
    if (edit.fields === "underline") declarations.push(`text-decoration:${edit.textStyle?.underline ? "underline" : "none"}`);
  }
  return declarations.join(";");
}

function pendingInlineStyleCss() {
  const declarations = [];
  if (pendingInlineStyle.bold != null) declarations.push(`font-weight:${pendingInlineStyle.bold ? "700" : "400"}`);
  if (pendingInlineStyle.italic != null) declarations.push(`font-style:${pendingInlineStyle.italic ? "italic" : "normal"}`);
  if (pendingInlineStyle.underline != null) declarations.push(`text-decoration:${pendingInlineStyle.underline ? "underline" : "none"}`);
  return declarations.join(";");
}

function renderOriginalStyledChar(paragraph, offset, char) {
  if (!paragraph) return escapeHtml(char);
  const index = paragraph.startIndex + offset;
  const run = paragraph.textRuns?.find((candidate) => index >= candidate.startIndex && index < candidate.endIndex);
  const style = textRunStyle(run?.style ?? {});
  return `<span class="doc-char" ${spanIndexData(paragraph, index, index + 1)}${style ? ` style="${style}"` : ""}>${escapeHtml(char)}</span>`;
}

function visibleWhitespace(value) {
  return String(value)
    .replace(/ /g, "·")
    .replace(/\t/g, "⇥")
    .replace(/\n/g, "↵\n");
}

function compactEqualText(value, atStart, atEnd) {
  const compacted = value.replace(/\s+/g, " ");
  if (compacted.length <= 90) return value;
  const head = atStart ? compacted.slice(0, 32) : "";
  const tail = atEnd ? compacted.slice(-32) : "";
  return `${head} … ${tail}`;
}

function runFormatCommand(command, value = null) {
  const textStyleField = textStyleFieldForCommand(command);
  if (textStyleField && queueSelectedTextStyle(textStyleField, { allowSavedSelection: true })) return;
  if (textStyleField && togglePendingInlineStyle(textStyleField)) return;
  if (textStyleField) return;
  outlineEl.focus();
  document.execCommand(command, false, value);
  syncDraftEditsFromDom();
  updateToolbarState();
}

function handleFormattingShortcut(event) {
  const key = String(event.key).toLowerCase();
  if (!(event.ctrlKey || event.metaKey) || event.altKey || !["b", "i", "u"].includes(key)) return;
  if (!editorEventIsInsideOutline(event)) return;
  event.preventDefault();
  event.stopPropagation();
  const field = key === "b" ? "bold" : key === "i" ? "italic" : "underline";
  if (window.getSelection()?.toString()) {
    if (!queueSelectedTextStyle(field, { allowSavedSelection: false })) togglePendingInlineStyle(field);
    lastHandledTextStyleShortcut = { field, time: Date.now() };
    return;
  }
  togglePendingInlineStyle(field);
  lastHandledTextStyleShortcut = { field, time: Date.now() };
}

function handleEditorBeforeInput(event) {
  const field = inputTypeToTextStyleField(event.inputType);
  if (!field) return;
  event.preventDefault();
  event.stopPropagation();
  if (lastHandledTextStyleShortcut?.field === field && Date.now() - lastHandledTextStyleShortcut.time < 1000) {
    lastHandledTextStyleShortcut = null;
    return;
  }
  if (window.getSelection()?.toString()) {
    queueSelectedTextStyle(field, { allowSavedSelection: false });
  } else {
    togglePendingInlineStyle(field);
  }
}

function inputTypeToTextStyleField(inputType) {
  if (inputType === "formatBold") return "bold";
  if (inputType === "formatItalic") return "italic";
  if (inputType === "formatUnderline") return "underline";
  return null;
}

function selectionIsInsideOutline() {
  const selection = window.getSelection();
  if (!selection?.rangeCount) return false;
  const range = selection.getRangeAt(0);
  const start = range.startContainer?.nodeType === Node.TEXT_NODE
    ? range.startContainer.parentElement
    : range.startContainer;
  const end = range.endContainer?.nodeType === Node.TEXT_NODE
    ? range.endContainer.parentElement
    : range.endContainer;
  return Boolean(start && end && outlineEl.contains(start) && outlineEl.contains(end));
}

function editorEventIsInsideOutline(event) {
  const target = event.target?.nodeType === Node.TEXT_NODE ? event.target.parentElement : event.target;
  return Boolean(target && outlineEl.contains(target)) || selectionIsInsideOutline();
}

function queueSelectedTextStyle(field, options = {}) {
  const range = getSelectionIndexRangeForStyle({ allowSavedSelection: Boolean(options.allowSavedSelection) });
  if (!range || range.startIndex === range.endIndex) return false;
  pendingInlineStyle[field] = null;
  pendingInlineStyleStart[field] = null;
  const enable = !selectionHasUniformTextStyle(field, true, range);
  for (const segment of selectionSegments(range)) {
    const paragraph = segment.paragraph;
    const startIndex = segment.startIndex;
    const endIndex = segment.endIndex;
    if (startIndex >= endIndex) continue;
    const key = `text-style-${field}-${paragraph.tabId}-${startIndex}-${endIndex}`;
    formatDraftEdits.set(key, {
      type: "update_text_style",
      target: {
        tabId: paragraph.tabId,
        paragraphIndex: paragraph.paragraphIndex,
        startIndex,
        endIndex
      },
      textStyle: { [field]: enable },
      fields: field
    });
  }
  paintTextStyleDraft(range, field, enable);
  syncDraftPreview();
  updateToolbarState();
  return true;
}

function selectionSegments(range) {
  if (range.segments?.length) return range.segments;
  return paragraphsIntersectingRange(range).map((paragraph) => ({
    paragraph,
    startIndex: Math.max(range.startIndex, paragraph.startIndex),
    endIndex: Math.min(range.endIndex, paragraph.endIndex)
  }));
}

function togglePendingInlineStyle(field) {
  const range = getSelectionIndexRange() ?? getCaretFallbackRange();
  if (!range || range.startIndex !== range.endIndex) return false;
  const next = pendingInlineStyle[field] !== true;
  pendingInlineStyle[field] = next ? true : null;
  pendingInlineStyleStart[field] = next
    ? {
        tabId: range.paragraph?.tabId,
        paragraphIndex: range.paragraph?.paragraphIndex,
        startIndex: range.startIndex
      }
    : null;
  updateToolbarState();
  return true;
}

function resetPendingInlineStyles() {
  for (const field of Object.keys(pendingInlineStyle)) {
    pendingInlineStyle[field] = null;
    pendingInlineStyleStart[field] = null;
  }
}

function isInlineStyleActiveAtCaret(field, index = null, paragraph = null) {
  if (pendingInlineStyle[field] != null) return pendingInlineStyle[field];
  const targetParagraph = paragraph ?? (index == null ? findParagraphFromSelection() : findParagraphForIndex(index));
  if (!targetParagraph) return false;
  const styleIndex = Math.max(targetParagraph.startIndex, (index ?? targetParagraph.startIndex) - 1);
  return Boolean(effectiveTextStyleAtIndex(field, styleIndex, targetParagraph));
}

function textStyleFieldForCommand(command) {
  if (command === "bold") return "bold";
  if (command === "italic") return "italic";
  if (command === "underline") return "underline";
  return null;
}

function getSelectionIndexRangeForStyle(options = {}) {
  const range = getSelectionIndexRange();
  if (range && range.startIndex !== range.endIndex) return range;
  return options.allowSavedSelection ? savedTextSelectionRange : null;
}

function paragraphsIntersectingRange(range) {
  return (currentDocument?.paragraphs ?? []).filter((paragraph) =>
    range.endIndex > paragraph.startIndex && range.startIndex < paragraph.endIndex
  );
}

function selectionHasUniformTextStyle(field, expected, range) {
  const segments = selectionSegments(range);
  const indexed = indexedTextSpans().filter((span) => segments.some((segment) => spanIsInsideSegment(span, segment)));
  if (indexed.length) {
    return indexed.every((span) => {
      const paragraph = currentDocument?.paragraphs[Number(span.dataset.paragraphIndex)];
      return Boolean(effectiveTextStyleAtIndex(field, Number(span.dataset.startIndex), paragraph)) === expected;
    });
  }

  const touchedRuns = [];
  for (const segment of segments) {
    const paragraph = segment.paragraph;
    for (const run of paragraph.textRuns ?? []) {
      if (run.endIndex <= segment.startIndex || run.startIndex >= segment.endIndex) continue;
      if (!stripParagraphBreak(run.text)) continue;
      touchedRuns.push(run);
    }
  }
  return touchedRuns.length > 0 && touchedRuns.every((run) => Boolean(run.style?.[field]) === expected);
}

function effectiveTextStyleAtIndex(field, index, paragraph = null) {
  const targetParagraph = paragraph ?? findParagraphForIndex(index);
  let value = Boolean(targetParagraph ? findTextRunStyleAtIndex(targetParagraph, index)?.[field] : false);
  for (const edit of formatDraftEdits.values()) {
    if (edit.type !== "update_text_style") continue;
    if (edit.fields !== field) continue;
    if (targetParagraph && edit.target.paragraphIndex !== targetParagraph.paragraphIndex) continue;
    if (targetParagraph && (edit.target.tabId ?? "") !== (targetParagraph.tabId ?? "")) continue;
    if (index >= edit.target.startIndex && index < edit.target.endIndex) {
      value = Boolean(edit.textStyle?.[field]);
    }
  }
  return value;
}

function paintTextStyleDraft(range, field, enable) {
  const segments = selectionSegments(range);
  for (const char of indexedTextSpans()) {
    if (segments.some((segment) => spanIsInsideSegment(char, segment))) {
      if (field === "bold") char.style.fontWeight = enable ? "700" : "400";
      if (field === "italic") char.style.fontStyle = enable ? "italic" : "normal";
      if (field === "underline") char.style.textDecoration = enable ? "underline" : "none";
      char.classList.add("style-suggested");
    }
  }
  for (const segment of segments) {
    outlineEl.querySelector(`.doc-line[data-paragraph-index="${segment.paragraph.paragraphIndex}"]`)?.classList.add("has-diff", "has-format-change");
  }
}

function spanIsInsideSegment(span, segment) {
  const start = Number(span.dataset.startIndex);
  return (
    start >= segment.startIndex &&
    start < segment.endIndex &&
    Number(span.dataset.paragraphIndex) === segment.paragraph.paragraphIndex &&
    (span.dataset.tabId ?? "") === (segment.paragraph.tabId ?? "")
  );
}

function applyFontSize(size) {
  outlineEl.focus();
  document.execCommand("fontSize", false, "7");
  for (const font of outlineEl.querySelectorAll("font[size='7']")) {
    font.removeAttribute("size");
    font.style.fontSize = `${Number(size)}pt`;
  }
  syncDraftEditsFromDom();
  updateToolbarState();
}

function queueParagraphFormatAction(action) {
  const paragraph = findParagraphFromSelection()
    ?? (selectedParagraphIndex != null ? currentDocument?.paragraphs[selectedParagraphIndex] : null);
  if (!paragraph) return;
  const line = outlineEl.querySelector(`.doc-line[data-paragraph-index="${paragraph.paragraphIndex}"]`);
  const range = paragraphTarget(paragraph);

  if (action === "indent" || action === "outdent") {
    const currentIndent = currentDraftIndentStart(paragraph);
    const nextIndent = Math.max(0, currentIndent + (action === "indent" ? 18 : -18));
    const key = `style-indent-${paragraph.tabId}-${paragraph.paragraphIndex}`;
    formatDraftEdits.set(key, {
      type: "update_paragraph_style",
      target: range,
      paragraphStyle: { indentStart: { magnitude: nextIndent, unit: "PT" } },
      fields: "indentStart"
    });
    if (line) {
      line.querySelector(".doc-line-body").style.marginLeft = `${nextIndent}pt`;
      setFormatIndicator(line, `Indent ${Math.round(nextIndent)}pt`);
    }
  }

  if (action === "bullet" || action === "number") {
    const key = `list-${paragraph.tabId}-${paragraph.paragraphIndex}`;
    const sameListKind = action === "number" ? isNumberedParagraph(paragraph) : paragraph.bullet && !isNumberedParagraph(paragraph);
    const edit = sameListKind
      ? {
          type: "delete_paragraph_bullets",
          target: range
        }
      : {
          type: "create_paragraph_bullets",
          target: range,
          bulletPreset: action === "bullet" ? "BULLET_DISC_CIRCLE_SQUARE" : "NUMBERED_DECIMAL_ALPHA_ROMAN"
        };
    formatDraftEdits.set(key, edit);
    if (line) {
      setFormatIndicator(line, sameListKind ? "Remove list" : action === "bullet" ? "Bullets" : "Numbering");
      line.classList.toggle("list-line", !sameListKind);
      line.querySelector(".list-marker").textContent = sameListKind ? "" : action === "bullet" ? "•" : "1.";
    }
  }

  renderDraftBar();
  syncDraftPreview();
  updateToolbarState();
}

function currentDraftIndentStart(paragraph) {
  const key = `style-indent-${paragraph.tabId}-${paragraph.paragraphIndex}`;
  const draft = formatDraftEdits.get(key);
  const draftIndent = draft?.type === "update_paragraph_style"
    ? draft.paragraphStyle?.indentStart?.magnitude
    : undefined;
  return Number.isFinite(Number(draftIndent)) ? Number(draftIndent) : dimensionToPt(paragraph.style?.indentStart);
}

function isNumberedParagraph(paragraph) {
  const glyphType = String(paragraph.bullet?.glyphType ?? "").toUpperCase();
  const glyphSymbol = String(paragraph.bullet?.glyphSymbol ?? "");
  return Boolean(glyphType && !glyphType.includes("BULLET")) || glyphSymbol.includes("%");
}

function paragraphTarget(paragraph) {
  return {
    tabId: paragraph.tabId,
    paragraphIndex: paragraph.paragraphIndex,
    startIndex: paragraph.startIndex,
    endIndex: paragraph.endIndex
  };
}

function handleParagraphKeydown(event, paragraph) {
  if (event.key === "Backspace") {
    const textEl = event.currentTarget.querySelector(".paragraph-text");
    if (editableParagraphText(paragraph).length === 0 && textEl.innerText.trim().length === 0) {
      event.preventDefault();
      draftEdits.set(paragraph.paragraphIndex, {
        replacementText: "",
        delete: true
      });
      event.currentTarget.classList.add("deleted");
      renderDraftBar();
      syncDraftPreview();
    }
  }

  if (event.key === "Enter") {
    handleParagraphEnter(event, paragraph);
  }
}

function handleEditorKeydown(event) {
  if (event.key === "Backspace" && handleEmptyLineBackspace(event)) return;
  if (event.key !== "Enter") return;
  event.preventDefault();
  event.stopPropagation();
  const line = findLineFromEventOrSelection(event);
  const paragraph = paragraphFromLine(line) ?? findParagraphFromSelection();

  if (!paragraph && line?.dataset.draftKey) {
    splitVirtualParagraphAtCaret(line);
    return;
  }

  const range = getSelectionIndexRange() ?? getCaretFallbackRange();
  if (!range || !paragraph) return;

  if (range.startIndex === range.endIndex) {
    splitParagraphAtCaret(paragraph, range.startIndex, line);
    return;
  }

  const key = `replace-${paragraph.tabId}-${range.startIndex}-${range.endIndex}`;
  indexDraftEdits.set(key, {
    paragraph,
    startIndex: range.startIndex,
    endIndex: range.endIndex,
    currentText: range.currentText,
    replacementText: "\n"
  });
  insertSuggestedParagraphAfter(paragraph, "", key, { inheritFormatting: true });
  selectedRange = null;
  clearSelectionPaint();
  renderDraftBar();
  syncDraftPreview();
}

function paragraphFromLine(line) {
  if (!line) return null;
  const index = Number(line.dataset.paragraphIndex);
  return Number.isInteger(index) ? currentDocument?.paragraphs[index] : null;
}

function splitParagraphAtCaret(paragraph, caretIndex, line = null) {
  const currentText = editableParagraphText(paragraph);
  const sourceLine = line ?? outlineEl.querySelector(`.doc-line[data-paragraph-index="${paragraph.paragraphIndex}"]`);
  const content = sourceLine?.querySelector(".doc-line-content");
  const draftText = sourceLine ? getLineEditableText(sourceLine) : currentText;
  const fallbackOffset = caretIndex - paragraph.startIndex;
  const splitOffset = Math.max(0, Math.min(draftText.length, content ? getCaretTextOffset(content) : fallbackOffset));
  const before = draftText.slice(0, splitOffset);
  const after = draftText.slice(splitOffset);
  const draftChangedText = draftText !== currentText;
  const key = draftChangedText
    ? `replace-${paragraph.tabId}-${paragraph.startIndex}-${paragraph.startIndex + currentText.length}`
    : `insert-${paragraph.tabId}-${paragraph.startIndex + splitOffset}-${virtualParagraphCounter++}`;
  indexDraftEdits.set(key, {
    paragraph,
    startIndex: draftChangedText ? paragraph.startIndex : paragraph.startIndex + splitOffset,
    endIndex: draftChangedText ? paragraph.startIndex + currentText.length : paragraph.startIndex + splitOffset,
    currentText: draftChangedText ? currentText : "",
    replacementText: draftChangedText ? `${before}\n${after}` : "\n"
  });

  if (content) {
    if (draftChangedText) {
      content.textContent = before;
      updateInlineDiff(sourceLine, currentText, `${before}\n${after}`);
    } else {
      content.innerHTML = renderIndexedParagraphSlice(paragraph, 0, splitOffset);
      sourceLine.classList.add("has-diff", "has-insert");
    }
  }
  insertSuggestedParagraphAfter(paragraph, after, key, {
    splitReplacement: true,
    inheritFormatting: true,
    htmlContent: draftChangedText ? null : renderIndexedParagraphSlice(paragraph, splitOffset, currentText.length)
  });
  selectedRange = null;
  clearSelectionPaint();
  renderDraftBar();
  syncDraftPreview();
}

function splitVirtualParagraphAtCaret(line) {
  const draftKey = line.dataset.draftKey;
  const draft = draftKey ? indexDraftEdits.get(draftKey) : null;
  const paragraph = draft?.paragraph;
  if (!draftKey || !draft || !paragraph) return;

  const content = line.querySelector(".doc-line-content");
  const text = getLineEditableText(line);
  const offset = Math.max(0, Math.min(text.length, getCaretTextOffset(content)));
  const before = text.slice(0, offset);
  const after = text.slice(offset);
  if (content) content.textContent = before;

  if (draft.startIndex === draft.endIndex && draft.currentText === "" && offset === 0) {
    draft.replacementText = `${draft.replacementText}\n`;
    insertSuggestedParagraphAfterLine(line, paragraph, after, draftKey, { inheritFormatting: true });
    renderDraftBar();
    syncDraftPreview();
    return;
  }

  const newKey = `insert-${paragraph.tabId}-${draft.startIndex}-${virtualParagraphCounter++}`;
  indexDraftEdits.set(newKey, {
    paragraph,
    startIndex: draft.startIndex,
    endIndex: draft.startIndex,
    currentText: "",
    replacementText: `\n${after}`
  });
  insertSuggestedParagraphAfterLine(line, paragraph, after, newKey, { inheritFormatting: true });
  syncLineDraftEdit(line);
  renderDraftBar();
  syncDraftPreview();
}

function handleEmptyLineBackspace(event) {
  const line = findLineFromEventOrSelection(event);
  if (!line) return false;
  const text = getLineEditableText(line);
  if (text.length > 0) return false;

  event.preventDefault();
  event.stopPropagation();

  const virtualKey = line.dataset.draftKey;
  const previousLine = line.previousElementSibling?.classList?.contains("doc-line")
    ? line.previousElementSibling
    : null;
  if (virtualKey) {
    indexDraftEdits.delete(virtualKey);
    line.remove();
    renumberVisibleParagraphs();
    placeCaretAtEnd(previousLine?.querySelector(".doc-line-content"));
    renderDraftBar();
    syncDraftPreview();
    return true;
  }

  const paragraph = currentDocument?.paragraphs[Number(line.dataset.paragraphIndex)];
  if (!paragraph || !previousLine) return false;
  removeDraftTextEditForParagraph(paragraph);
  const key = `delete-${paragraph.tabId}-${paragraph.startIndex}-${paragraph.endIndex}`;
  indexDraftEdits.set(key, {
    paragraph,
    startIndex: paragraph.startIndex,
    endIndex: paragraph.endIndex,
    currentText: paragraph.text,
    replacementText: ""
  });
  line.remove();
  renumberVisibleParagraphs();
  placeCaretAtEnd(previousLine?.querySelector(".doc-line-content"));
  renderDraftBar();
  syncDraftPreview();
  return true;
}

function removeDraftTextEditForParagraph(paragraph) {
  for (const [key, draft] of indexDraftEdits) {
    if (draft.paragraph.paragraphIndex === paragraph.paragraphIndex && draft.paragraph.tabId === paragraph.tabId) {
      indexDraftEdits.delete(key);
    }
  }
}

function queuePendingInlineStyleForReplacement(paragraph, replacement) {
  if (!replacement.replacementText) return;
  const fields = Object.entries(pendingInlineStyle).filter(([, value]) => value === true);
  if (!fields.length) return;
  removePendingInlineStyleDraftsForParagraph(paragraph);
  for (const [field, value] of fields) {
    const styleStart = pendingInlineStyleStart[field];
    const replacementStart = replacement.startIndex;
    const replacementEnd = replacement.startIndex + replacement.replacementText.length;
    const startIndex = styleStartBelongsToParagraph(styleStart, paragraph)
      ? Math.max(replacementStart, styleStart.startIndex)
      : replacementStart;
    const endIndex = replacementEnd;
    if (startIndex >= endIndex) continue;
    const key = `typing-style-${field}-${paragraph.tabId}-${startIndex}-${endIndex}`;
    formatDraftEdits.set(key, {
      type: "update_text_style",
      target: {
        tabId: paragraph.tabId,
        paragraphIndex: paragraph.paragraphIndex,
        startIndex,
        endIndex
      },
      textStyle: { [field]: value },
      fields: field
    });
  }
}

function styleStartBelongsToParagraph(styleStart, paragraph) {
  if (!styleStart) return false;
  return (
    styleStart.paragraphIndex === paragraph.paragraphIndex &&
    (styleStart.tabId ?? "") === (paragraph.tabId ?? "")
  );
}

function removePendingInlineStyleDraftsForParagraph(paragraph) {
  for (const [key, edit] of formatDraftEdits) {
    if (!key.startsWith("typing-style-")) continue;
    if (edit.target.paragraphIndex === paragraph.paragraphIndex && edit.target.tabId === paragraph.tabId) {
      formatDraftEdits.delete(key);
    }
  }
}

function insertSuggestedParagraphAfter(paragraph, text, draftKey, options = {}) {
  const line = outlineEl.querySelector(`.doc-line[data-paragraph-index="${paragraph.paragraphIndex}"]`);
  if (!line) return;
  insertSuggestedParagraphAfterLine(line, paragraph, text, draftKey, options);
}

function insertSuggestedParagraphAfterLine(line, paragraph, text, draftKey, options = {}) {
  const virtualId = draftKey ?? `virtual-${virtualParagraphCounter++}`;
  const next = document.createElement("div");
  next.className = "doc-line suggested-line";
  next.classList.toggle("list-line", Boolean(options.inheritFormatting && paragraph.bullet));
  next.dataset.paragraphIndex = virtualId;
  next.dataset.draftKey = draftKey ?? virtualId;
  next.dataset.originalAfterParagraphIndex = String(paragraph.paragraphIndex);
  if (options.splitReplacement) next.dataset.splitReplacement = "true";
  next.innerHTML = `
    <span class="paragraph-number" contenteditable="false" title="Suggested paragraph">${displayParagraphCounter++}</span>
    <span class="doc-line-body" style="${options.inheritFormatting ? inheritedParagraphBodyStyle(paragraph) : ""}">
      <span class="list-marker" contenteditable="false">${options.inheritFormatting ? escapeHtml(continuationListMarker(paragraph, line)) : ""}</span>
      <span class="doc-line-content">${options.htmlContent ?? escapeHtml(text)}</span>
    </span>
  `;
  line.after(next);
  if (text) updateInlineDiff(next, "", text);
  renumberVisibleParagraphs();
  const nextContent = next.querySelector(".doc-line-content");
  placeCaretAtStart(nextContent);
}

function renumberVisibleParagraphs() {
  let number = 1;
  for (const gutter of outlineEl.querySelectorAll(".paragraph-number")) {
    gutter.textContent = String(number);
    gutter.title = `Paragraph ${number}`;
    number += 1;
  }
}

function getLineEditableText(line) {
  const content = line?.querySelector(".doc-line-content");
  if (!content) return "";
  if (content.querySelector(".empty-paragraph") && content.textContent.trim() === "") return "";
  const text = content.innerText.replace(/\r\n/g, "\n").replace(/\u200B/g, "");
  return text === "\n" ? "" : text;
}

function handleParagraphEnter(event, paragraph) {
  event.preventDefault();
  event.stopPropagation();

  const paragraphEl = event.currentTarget;
  const textEl = paragraphEl.querySelector(".paragraph-text");
  const currentText = textEl.innerText.replace(/\r\n/g, "\n");
  const caretOffset = getCaretTextOffset(textEl);
  const before = currentText.slice(0, caretOffset);
  const after = currentText.slice(caretOffset);

  draftEdits.set(paragraph.paragraphIndex, {
    replacementText: before
  });

  const virtualId = `virtual-${virtualParagraphCounter++}`;
  const next = document.createElement("article");
  next.className = "paragraph dirty";
  next.dataset.index = virtualId;
  next.dataset.tabId = paragraph.tabId ?? "";
  next.innerHTML = `
    <div class="paragraph-gutter" contenteditable="false"><span class="paragraph-number" title="New paragraph">+</span></div>
    <div class="paragraph-text" style="${paragraphStyle(paragraph)}">${escapeHtml(after)}</div>
  `;
  next.addEventListener("keydown", (nextEvent) => {
    if (nextEvent.key === "Enter") nextEvent.preventDefault();
  });
  next.addEventListener("input", () => {
    const text = next.querySelector(".paragraph-text").innerText.replace(/\r\n/g, "\n");
    draftEdits.set(virtualId, {
      insertAfterParagraphIndex: paragraph.paragraphIndex,
      paragraph,
      replacementText: text
    });
    renderDraftBar();
    syncDraftPreview();
  });

  textEl.textContent = before;
  paragraphEl.classList.add("dirty");
  paragraphEl.after(next);
  draftEdits.set(virtualId, {
    insertAfterParagraphIndex: paragraph.paragraphIndex,
    paragraph,
    replacementText: after
  });
  placeCaretAtStart(next.querySelector(".paragraph-text"));
  renderDraftBar();
  syncDraftPreview();
}

function getCaretTextOffset(container) {
  const selection = window.getSelection();
  if (!selection?.rangeCount) return container.innerText.length;
  const range = selection.getRangeAt(0);
  if (!container.contains(range.startContainer)) return container.innerText.length;
  const preCaretRange = range.cloneRange();
  preCaretRange.selectNodeContents(container);
  preCaretRange.setEnd(range.startContainer, range.startOffset);
  return preCaretRange.toString().length;
}

function placeCaretAtStart(element) {
  if (!element) return;
  element.focus();
  const range = document.createRange();
  range.selectNodeContents(element);
  range.collapse(true);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}

function placeCaretAtEnd(element) {
  if (!element) return;
  element.focus();
  const range = document.createRange();
  range.selectNodeContents(element);
  range.collapse(false);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}

function placeCaretAtTextOffset(element, offset) {
  if (!element) return;
  element.focus();
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let remaining = Math.max(0, offset);
  let node = walker.nextNode();
  while (node) {
    if (remaining <= node.textContent.length) {
      const range = document.createRange();
      range.setStart(node, remaining);
      range.collapse(true);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      return;
    }
    remaining -= node.textContent.length;
    node = walker.nextNode();
  }
  placeCaretAtEnd(element);
}

function discardDraftEdits() {
  draftEdits.clear();
  indexDraftEdits.clear();
  formatDraftEdits.clear();
  renderDraftBar();
  renderOutline();
  clearPatch();
}

function reviewDraftEdits() {
  if (!currentDocument || (draftEdits.size === 0 && indexDraftEdits.size === 0 && formatDraftEdits.size === 0)) return;
  const edits = [];
  for (const draft of indexDraftEdits.values()) {
    edits.push({
      type: "replace_text",
      target: {
        tabId: draft.paragraph.tabId,
        paragraphIndex: draft.paragraph.paragraphIndex,
        startIndex: draft.startIndex,
        endIndex: draft.endIndex,
        currentText: draft.currentText
      },
      replacementText: draft.replacementText
    });
  }
  for (const [paragraphIndex, draft] of draftEdits) {
    if (typeof paragraphIndex === "string") {
      const paragraph = draft.paragraph;
      if (!paragraph || !draft.replacementText) continue;
      edits.push({
        type: "replace_text",
        target: {
          tabId: paragraph.tabId,
          paragraphIndex: paragraph.paragraphIndex,
          startIndex: paragraph.endIndex - 1,
          endIndex: paragraph.endIndex - 1,
          currentText: ""
        },
        replacementText: `\n${draft.replacementText}`
      });
      continue;
    }
    const paragraph = currentDocument.paragraphs[paragraphIndex];
    if (!paragraph) continue;
    const deletingEmptyParagraph = draft.delete && editableParagraphText(paragraph).length === 0;
    const currentText = deletingEmptyParagraph ? paragraph.text : editableParagraphText(paragraph);
    const endIndex = deletingEmptyParagraph
      ? paragraph.endIndex
      : currentText.length === 0 ? paragraph.startIndex : paragraph.startIndex + currentText.length;
    edits.push({
      type: "replace_text",
      target: {
        tabId: paragraph.tabId,
        paragraphIndex,
        startIndex: paragraph.startIndex,
        endIndex,
        currentText
      },
      replacementText: draft.replacementText
    });
  }
  for (const edit of formatDraftEdits.values()) {
    edits.push(edit);
  }
  currentPatch = {
    summary: `Apply ${edits.length === 1 ? "1 manual draft edit" : `${edits.length} manual draft edits`}.`,
    edits
  };
  renderPreview();
  addChat("System", "Manual draft edits are ready to preview.");
}

function syncDraftPreview() {
  if (draftEdits.size === 0 && indexDraftEdits.size === 0 && formatDraftEdits.size === 0) {
    clearPatch();
    return;
  }
  const previousChatCount = chatLogEl.children.length;
  reviewDraftEdits();
  while (chatLogEl.children.length > previousChatCount) {
    chatLogEl.removeChild(chatLogEl.lastChild);
  }
}

window.__docwriterDebug = () => ({
  pendingInlineStyle: { ...pendingInlineStyle },
  pendingInlineStyleStart: { ...pendingInlineStyleStart },
  selectedRange,
  selectedText,
  indexDraftEdits: [...indexDraftEdits.values()].map((draft) => ({
    paragraphIndex: draft.paragraph?.paragraphIndex,
    startIndex: draft.startIndex,
    endIndex: draft.endIndex,
    currentText: draft.currentText,
    replacementText: draft.replacementText
  })),
  formatDraftEdits: [...formatDraftEdits.values()]
});

function captureDocumentSelection() {
  const selection = window.getSelection();
  if (!selection?.rangeCount || !selectionIsInsideOutline()) return;

  const text = selection?.toString().trim() ?? "";
  const indexRange = getSelectionIndexRange();
  if (!text) {
    selectedText = "";
    selectedRange = indexRange;
    savedTextSelectionRange = null;
    const paragraph = indexRange ? findParagraphForIndex(indexRange.startIndex) : findParagraphFromSelection();
    selectedParagraphIndex = paragraph?.paragraphIndex ?? null;
    clearSelectionPaint();
    updateToolbarState();
    return;
  }
  if (!indexRange) return;
  selectedText = text;
  selectedRange = indexRange;
  savedTextSelectionRange = indexRange;
  const paragraph = findParagraphForIndex(indexRange.startIndex);
  selectedParagraphIndex = paragraph?.paragraphIndex ?? null;
  paintSelectedRange(indexRange);
  updateToolbarState();
}

function updateActiveLineFromEvent(event) {
  const line = event.target?.closest?.(".doc-line");
  const paragraph = line ? currentDocument?.paragraphs[Number(line.dataset.paragraphIndex)] : null;
  selectedParagraphIndex = paragraph?.paragraphIndex ?? selectedParagraphIndex;
  updateToolbarState();
}

function getSelectionIndexRange() {
  const selection = window.getSelection();
  if (!selection?.rangeCount) return null;
  const range = selection.getRangeAt(0);
  if (range.collapsed) return getCollapsedCaretIndexRange(range);

  const chars = indexedTextSpans();
  const selected = chars.filter((char) => range.intersectsNode(char));
  if (!selected.length) {
    return getPlainTextSelectionIndexRange(range) ?? getCollapsedCaretIndexRange(range);
  }
  const segments = buildSelectionSegments(selected);
  const startIndex = Math.min(...segments.map((segment) => segment.startIndex));
  const endIndex = Math.max(...segments.map((segment) => segment.endIndex));
  return {
    startIndex,
    endIndex,
    segments,
    currentText: selected.map((char) => char.textContent).join("")
  };
}

function indexedTextSpans() {
  return [...outlineEl.querySelectorAll(".doc-char[data-start-index], .doc-insert[data-start-index]")];
}

function getPlainTextSelectionIndexRange(range) {
  const startLine = lineFromNode(range.startContainer);
  const endLine = lineFromNode(range.endContainer);
  if (!startLine || !endLine || startLine !== endLine) return null;

  const paragraph = currentDocument?.paragraphs[Number(startLine.dataset.paragraphIndex)];
  const content = startLine.querySelector(".doc-line-content");
  if (!paragraph || !content || !content.contains(range.startContainer) || !content.contains(range.endContainer)) return null;

  const startOffset = textOffsetWithinContent(content, range.startContainer, range.startOffset);
  const endOffset = textOffsetWithinContent(content, range.endContainer, range.endOffset);
  const startIndex = paragraph.startIndex + Math.min(startOffset, endOffset);
  const endIndex = paragraph.startIndex + Math.max(startOffset, endOffset);
  if (startIndex === endIndex) return null;

  return {
    startIndex,
    endIndex,
    segments: [{ paragraph, startIndex, endIndex }],
    currentText: range.toString()
  };
}

function lineFromNode(node) {
  const element = node?.nodeType === Node.TEXT_NODE ? node.parentElement : node;
  return element?.closest?.(".doc-line") ?? null;
}

function textOffsetWithinContent(content, node, offset) {
  const probe = document.createRange();
  probe.selectNodeContents(content);
  probe.setEnd(node, offset);
  return probe.toString().length;
}

function buildSelectionSegments(selectedSpans) {
  const groups = new Map();
  for (const span of selectedSpans) {
    const paragraphIndex = Number(span.dataset.paragraphIndex);
    const paragraph = currentDocument?.paragraphs[paragraphIndex];
    if (!paragraph) continue;
    const key = `${paragraph.tabId ?? ""}:${paragraph.paragraphIndex}`;
    const start = Number(span.dataset.startIndex);
    const end = Number(span.dataset.endIndex);
    const existing = groups.get(key);
    if (existing) {
      existing.startIndex = Math.min(existing.startIndex, start);
      existing.endIndex = Math.max(existing.endIndex, end);
    } else {
      groups.set(key, { paragraph, startIndex: start, endIndex: end });
    }
  }
  return [...groups.values()];
}

function getCollapsedCaretIndexRange(range) {
  const node = range.startContainer?.nodeType === Node.TEXT_NODE
    ? range.startContainer.parentElement
    : range.startContainer;
  const line = node?.closest?.(".doc-line");
  const paragraph = line ? currentDocument?.paragraphs[Number(line.dataset.paragraphIndex)] : null;
  if (!paragraph) return null;
  const content = line.querySelector(".doc-line-content");
  const offset = getCaretTextOffset(content);
  const index = paragraph.startIndex + offset;
  return {
    startIndex: index,
    endIndex: index,
    paragraph,
    currentText: ""
  };
}

function findParagraphForIndex(index) {
  return currentDocument?.paragraphs.find((paragraph) => {
    const textEnd = paragraph.startIndex + editableParagraphText(paragraph).length;
    return index >= paragraph.startIndex && index <= textEnd;
  });
}

function paintSelectedRange(range) {
  clearSelectionPaint();
  const segments = selectionSegments(range);
  for (const char of indexedTextSpans()) {
    if (segments.some((segment) => spanIsInsideSegment(char, segment))) {
      char.classList.add("selected");
    }
  }
}

function clearSelectionPaint() {
  outlineEl.querySelectorAll(".doc-char.selected, .doc-insert.selected").forEach((char) => char.classList.remove("selected"));
}

function getCaretFallbackRange() {
  const paragraph = findParagraphFromSelection();
  if (!paragraph) return null;
  return {
    startIndex: paragraph.startIndex,
    endIndex: paragraph.startIndex,
    paragraph,
    currentText: ""
  };
}

function findParagraphFromSelection() {
  const selection = window.getSelection();
  if (!selection?.rangeCount) return null;
  const range = selection.getRangeAt(0);
  const node = range.startContainer?.nodeType === Node.TEXT_NODE
    ? range.startContainer.parentElement
    : range.startContainer;
  const line = node?.closest?.(".doc-line");
  return line ? currentDocument?.paragraphs[Number(line.dataset.paragraphIndex)] : null;
}

function paintIndexSuggestions() {
  outlineEl.querySelectorAll(".doc-char.suggested, .doc-insert.suggested").forEach((char) => char.classList.remove("suggested"));
  for (const draft of indexDraftEdits.values()) {
    const segment = {
      paragraph: draft.paragraph,
      startIndex: draft.startIndex,
      endIndex: draft.endIndex
    };
    for (const char of indexedTextSpans()) {
      if (spanIsInsideSegment(char, segment)) char.classList.add("suggested");
    }
  }
}

function updateToolbarState() {
  for (const command of ["bold", "italic", "underline"]) {
    const button = document.querySelector(`[data-command="${command}"]`);
    if (!button) continue;
    const range = getSelectionIndexRange();
    const active = range && range.startIndex !== range.endIndex
      ? selectionHasUniformTextStyle(command, true, range)
      : isInlineStyleActiveAtCaret(command, range?.startIndex, range?.paragraph);
    button.classList.toggle("active", active);
  }
  for (const command of ["justifyLeft", "justifyCenter", "justifyRight"]) {
    document.querySelector(`[data-command="${command}"]`)?.classList.remove("active");
  }

  const active = getActiveParagraphAndStyle();
  const paragraph = active?.paragraph;
  if (paragraph) {
    selectedParagraphIndex = paragraph.paragraphIndex;
    const alignment = normalizedParagraphAlignment(paragraph);
    document.querySelector('[data-command="justifyLeft"]')?.classList.toggle("active", alignment === "left");
    document.querySelector('[data-command="justifyCenter"]')?.classList.toggle("active", alignment === "center");
    document.querySelector('[data-command="justifyRight"]')?.classList.toggle("active", alignment === "right");
    document.querySelector('[data-paragraph-action="bullet"]')?.classList.toggle("active", Boolean(paragraph.bullet && !isNumberedParagraph(paragraph)));
    document.querySelector('[data-paragraph-action="number"]')?.classList.toggle("active", isNumberedParagraph(paragraph));
    const style = active.style;
    const domStyle = getActiveDomTextStyle();
    if (style?.weightedFontFamily?.fontFamily) {
      fontFamilyEl.value = style.weightedFontFamily.fontFamily;
    } else if (domStyle?.fontFamily) {
      setFontFamilyControl(domStyle.fontFamily);
    }
    const fontSize = style?.fontSize?.magnitude ?? domStyle?.fontSize;
    if (fontSize) setFontSizeControl(fontSize);
  }
}

function getActiveParagraphAndStyle() {
  const selectedLineParagraph = findParagraphFromSelectionLine();
  const range = getSelectionIndexRange();
  const paragraph = selectedLineParagraph ?? (range
    ? findParagraphForIndex(range.startIndex)
    : selectedParagraphIndex != null ? currentDocument?.paragraphs[selectedParagraphIndex] : findParagraphFromSelection());
  if (!paragraph) return null;
  return {
    paragraph,
    style: findTextRunStyleAtIndex(paragraph, range?.startIndex)
  };
}

function findParagraphFromSelectionLine() {
  const selection = window.getSelection();
  if (!selection?.rangeCount) return null;
  const range = selection.getRangeAt(0);
  const node = range.startContainer?.nodeType === Node.TEXT_NODE
    ? range.startContainer.parentElement
    : range.startContainer;
  const line = node?.closest?.(".doc-line");
  return line ? currentDocument?.paragraphs[Number(line.dataset.paragraphIndex)] : null;
}

function normalizedParagraphAlignment(paragraph) {
  const value = String(paragraph.style?.alignment ?? "START").toUpperCase();
  if (value === "CENTER") return "center";
  if (value === "END" || value === "RIGHT") return "right";
  return "left";
}

function findTextRunStyleAtIndex(paragraph, index) {
  const runs = paragraph.textRuns ?? [];
  if (!runs.length) return undefined;
  if (index == null) return runs.find((run) => stripParagraphBreak(run.text))?.style;

  const runAtCaret = runs.find((run) => {
    const runStart = Number(run.startIndex);
    const runEnd = Number(run.endIndex);
    return index >= runStart && index < runEnd && stripParagraphBreak(run.text);
  });
  if (runAtCaret?.style) return runAtCaret.style;

  const previousRun = [...runs].reverse().find((run) => {
    const runStart = Number(run.startIndex);
    return index >= runStart && stripParagraphBreak(run.text);
  });
  return previousRun?.style ?? runs.find((run) => stripParagraphBreak(run.text))?.style;
}

function setFontSizeControl(size) {
  const raw = String(size);
  const numeric = Number.parseFloat(raw);
  const points = raw.trim().toLowerCase().endsWith("px") ? numeric * 0.75 : numeric;
  const rounded = String(Math.round(points));
  if (!Number.isFinite(Number(rounded))) return;
  if (![...fontSizeEl.options].some((option) => option.value === rounded)) {
    const option = document.createElement("option");
    option.value = rounded;
    option.textContent = rounded;
    fontSizeEl.append(option);
    [...fontSizeEl.options]
      .sort((a, b) => Number(a.value) - Number(b.value))
      .forEach((option) => fontSizeEl.append(option));
  }
  fontSizeEl.value = rounded;
}

function setFontFamilyControl(fontFamily) {
  const family = String(fontFamily).split(",")[0]?.replace(/^["']|["']$/g, "").trim();
  if (!family) return;
  if (![...fontFamilyEl.options].some((option) => option.value === family)) {
    const option = document.createElement("option");
    option.value = family;
    option.textContent = family;
    fontFamilyEl.append(option);
  }
  fontFamilyEl.value = family;
}

function getActiveDomTextStyle() {
  const selection = window.getSelection();
  if (!selection?.rangeCount) return null;
  const range = selection.getRangeAt(0);
  const node = range.startContainer?.nodeType === Node.TEXT_NODE
    ? range.startContainer.parentElement
    : range.startContainer;
  const element = node?.closest?.(".doc-char") ?? node?.closest?.(".doc-line-content");
  if (!element || !outlineEl.contains(element)) return null;
  const style = window.getComputedStyle(element);
  return {
    fontSize: style.fontSize,
    fontFamily: style.fontFamily
  };
}

function renderTabStrip() {
  const tabs = currentDocument.tabs ?? [];
  tabStripEl.innerHTML = "";
  tabStripEl.classList.toggle("hidden", tabs.length <= 1);
  for (const tab of tabs) {
    const button = document.createElement("button");
    button.className = `tab-button${tab.tabId === activeTabId ? " active" : ""}`;
    button.textContent = `${"  ".repeat(tab.depth || 0)}${tab.title}`;
    button.addEventListener("click", () => {
      activeTabId = tab.tabId;
      selectedParagraphIndex = null;
      renderTabStrip();
      renderOutline();
    });
    tabStripEl.append(button);
  }
}

function renderFormatToolbar() {
  formatToolbarEl.classList.toggle("hidden", !currentDocument);
  const fonts = new Set(["Arial", "Times New Roman", "Georgia", "Courier New"]);
  for (const paragraph of currentDocument?.paragraphs ?? []) {
    for (const run of paragraph.textRuns ?? []) {
      const font = run.style?.weightedFontFamily?.fontFamily;
      if (font) fonts.add(font);
    }
  }
  fontFamilyEl.innerHTML = "";
  for (const font of [...fonts].sort()) {
    const option = document.createElement("option");
    option.value = font;
    option.textContent = font;
    fontFamilyEl.append(option);
  }
}

function getActiveTab() {
  return (currentDocument.tabs ?? []).find((tab) => tab.tabId === activeTabId);
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
      activeTabId,
      selectedParagraphIndex,
      selectedText,
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

  previewEl.innerHTML = `
    <div class="preview-actions"><button id="clear-preview" class="secondary">Clear All</button></div>
    <p class="preview-summary">${escapeHtml(currentPatch.summary)}</p>
  `;
  currentPatch.edits.forEach((edit, index) => {
    const div = document.createElement("article");
    div.className = "edit";
    div.innerHTML = renderEditPreview(edit, index);
    previewEl.append(div);
  });
  document.querySelector("#clear-preview").addEventListener("click", clearAllSuggestions);
  previewEl.querySelectorAll("[data-remove-edit]").forEach((button) => {
    button.addEventListener("click", () => removeSuggestion(Number(button.dataset.removeEdit)));
  });
  previewEl.querySelectorAll("[data-apply-edit]").forEach((button) => {
    button.addEventListener("click", () => applySingleEdit(Number(button.dataset.applyEdit)));
  });
}

function renderEditPreview(edit, index) {
  const title = `
    <div class="edit-header">
      <strong>Paragraph ${edit.target.paragraphIndex + 1}</strong>
      <div class="edit-actions">
        <button type="button" class="secondary edit-apply" data-apply-edit="${index}">Apply</button>
        <button type="button" class="icon-button edit-remove" data-remove-edit="${index}" aria-label="Remove edit" title="Remove edit">×</button>
      </div>
    </div>`;
  if (edit.type === "replace_text") {
    return `
      ${title}
      <div class="diff diff-unified">
        ${renderTokenDiff(edit.target.currentText, edit.replacementText, { visibleWhitespace: true })}
      </div>
    `;
  }
  if (edit.type === "update_paragraph_style") {
    return `
      ${title}
      <div class="format-preview">${escapeHtml(formatStyleChange(edit))}</div>
    `;
  }
  if (edit.type === "update_text_style") {
    return `
      ${title}
      <div class="format-preview">${escapeHtml(formatTextStyleChange(edit))}</div>
    `;
  }
  if (edit.type === "create_paragraph_bullets") {
    return `
      ${title}
      <div class="format-preview">${edit.bulletPreset.includes("NUMBERED") ? "Apply numbered list" : "Apply bulleted list"}</div>
    `;
  }
  return `
    ${title}
    <div class="format-preview">Remove list formatting.</div>
  `;
}

function formatStyleChange(edit) {
  const style = edit.paragraphStyle ?? {};
  if (style.indentStart?.magnitude != null) return `Set left indent to ${Math.round(Number(style.indentStart.magnitude))}pt`;
  if (style.alignment) return `Align ${String(style.alignment).toLowerCase()}`;
  return `Update ${edit.fields}`;
}

function formatTextStyleChange(edit) {
  if (edit.fields === "bold") return edit.textStyle?.bold ? "Make selection bold" : "Remove bold from selection";
  if (edit.fields === "italic") return edit.textStyle?.italic ? "Italicize selection" : "Remove italic from selection";
  if (edit.fields === "underline") return edit.textStyle?.underline ? "Underline selection" : "Remove underline from selection";
  return `Update text style: ${edit.fields}`;
}

function clearAllSuggestions() {
  draftEdits.clear();
  indexDraftEdits.clear();
  formatDraftEdits.clear();
  clearPatch();
  renderDraftBar();
  renderOutline();
}

function rebuildDraftStateFromPatch() {
  draftEdits.clear();
  indexDraftEdits.clear();
  formatDraftEdits.clear();
  for (const edit of currentPatch?.edits ?? []) {
    const paragraph = findParagraphForEdit(edit);
    if (!paragraph) continue;
    edit.target.paragraphIndex = paragraph.paragraphIndex;
    edit.target.tabId = paragraph.tabId;
    if (edit.type === "replace_text") {
      indexDraftEdits.set(`replace-${paragraph.tabId}-${edit.target.startIndex}-${edit.target.endIndex}`, {
        paragraph,
        startIndex: edit.target.startIndex,
        endIndex: edit.target.endIndex,
        currentText: edit.target.currentText,
        replacementText: edit.replacementText
      });
    } else {
      formatDraftEdits.set(`format-${edit.type}-${paragraph.tabId}-${edit.target.startIndex}-${edit.target.endIndex}`, edit);
    }
  }
}

function repaintDraftVisualsFromPatch() {
  for (const edit of currentPatch?.edits ?? []) {
    const paragraph = findParagraphForEdit(edit);
    const line = paragraph ? outlineEl.querySelector(`.doc-line[data-paragraph-index="${paragraph.paragraphIndex}"]`) : null;
    if (!line) continue;
    if (edit.type === "replace_text") {
      updateInlineDiff(line, edit.target.currentText, edit.replacementText);
    } else if (edit.type === "update_text_style") {
      const field = edit.fields;
      paintTextStyleDraft(
        { startIndex: edit.target.startIndex, endIndex: edit.target.endIndex },
        field,
        Boolean(edit.textStyle?.[field])
      );
    } else {
      setFormatIndicator(line, edit.type === "update_paragraph_style" ? formatStyleChange(edit) : edit.type === "create_paragraph_bullets" ? "List formatting" : "Remove list");
    }
  }
}

function findParagraphForEdit(edit) {
  const indexed = currentDocument?.paragraphs[edit.target.paragraphIndex];
  if (indexed && paragraphContainsEditRange(indexed, edit)) return indexed;
  return currentDocument?.paragraphs.find((paragraph) => paragraphContainsEditRange(paragraph, edit)) ?? null;
}

function paragraphContainsEditRange(paragraph, edit) {
  if (edit.target.tabId && paragraph.tabId !== edit.target.tabId) return false;
  return edit.target.startIndex >= paragraph.startIndex && edit.target.endIndex <= paragraph.endIndex;
}

function removeSuggestion(index) {
  if (!currentPatch?.edits[index]) return;
  const edit = currentPatch.edits[index];
  removeEditFromDraftState(edit);
  currentPatch.edits.splice(index, 1);
  if (currentPatch.edits.length === 0) {
    clearAllSuggestions();
    return;
  }
  clearEditorVisualForEdit(edit);
  renderDraftBar();
  renderPreview();
}

function removeEditFromDraftState(edit) {
  draftEdits.delete(edit.target.paragraphIndex);
  for (const [key, draft] of formatDraftEdits) {
    if (
      draft.target.startIndex === edit.target.startIndex &&
      draft.target.endIndex === edit.target.endIndex &&
      draft.target.paragraphIndex === edit.target.paragraphIndex &&
      draft.type === edit.type
    ) {
      formatDraftEdits.delete(key);
    }
  }
  for (const [key, draft] of indexDraftEdits) {
    if (edit.type !== "replace_text") continue;
    if (
      draft.startIndex === edit.target.startIndex &&
      draft.endIndex === edit.target.endIndex &&
      draft.paragraph.paragraphIndex === edit.target.paragraphIndex
    ) {
      indexDraftEdits.delete(key);
    }
  }
}

function clearEditorVisualForEdit(edit) {
  const line = outlineEl.querySelector(`.doc-line[data-paragraph-index="${edit.target.paragraphIndex}"]`);
  const remainingForLine = currentPatch?.edits.some((remaining) =>
    remaining.target.paragraphIndex === edit.target.paragraphIndex &&
    remaining.target.startIndex === edit.target.startIndex &&
    remaining.target.endIndex === edit.target.endIndex &&
    remaining.type === edit.type
  );
  if (remainingForLine) return;

  if (edit.type === "replace_text") {
    clearInlineDiff(line, edit.target.currentText);
    outlineEl.querySelector(`.doc-line[data-draft-key*="${edit.target.startIndex}"]`)?.remove();
    renumberVisibleParagraphs();
    return;
  }

  if (edit.type === "update_text_style") {
    clearTextStyleVisualForEdit(edit);
    return;
  }

  clearInlineDiff(line);
  if (line) {
    line.classList.remove("has-format-change");
    line.style.cssText = paragraphRowStyle(currentDocument.paragraphs[edit.target.paragraphIndex]);
    const body = line.querySelector(".doc-line-body");
    if (body) body.style.cssText = paragraphBodyStyle(currentDocument.paragraphs[edit.target.paragraphIndex]);
  }
}

function clearTextStyleVisualForEdit(edit) {
  const paragraph = currentDocument?.paragraphs[edit.target.paragraphIndex];
  const line = outlineEl.querySelector(`.doc-line[data-paragraph-index="${edit.target.paragraphIndex}"]`);
  if (!paragraph || !line) return;
  for (const char of line.querySelectorAll(".doc-char, .doc-insert")) {
    const start = Number(char.dataset.startIndex);
    if (start < edit.target.startIndex || start >= edit.target.endIndex) continue;
    restoreCharStyleFromRuns(char, paragraph, start);
    char.classList.remove("style-suggested");
  }
  const stillHasSuggestion = currentPatch?.edits.some((remaining) =>
    remaining.target.paragraphIndex === edit.target.paragraphIndex &&
    remaining.type !== "replace_text"
  );
  if (!stillHasSuggestion) {
    line.classList.remove("has-format-change", "has-diff");
  }
}

function restoreCharStyleFromRuns(char, paragraph, index) {
  const run = paragraph.textRuns?.find((candidate) => index >= candidate.startIndex && index < candidate.endIndex);
  const style = run?.style ?? {};
  char.style.fontWeight = style.bold ? "700" : "";
  char.style.fontStyle = style.italic ? "italic" : "";
  char.style.textDecoration = style.underline ? "underline" : "";
}

async function applySingleEdit(index) {
  if (!currentDocument || !currentPatch?.edits[index]) return;
  const edit = currentPatch.edits[index];
  const result = await api("/api/patch/apply", {
    method: "POST",
    body: JSON.stringify({
      documentId: currentDocument.documentId,
      patch: {
        summary: `Apply one approved edit.`,
        edits: [edit]
      },
      dryRun: dryRunEl.checked
    })
  });
  if (result.dryRun) {
    addChat("System", "Dry run succeeded for that edit.");
    return;
  }

  removeEditFromDraftState(edit);
  currentPatch.edits.splice(index, 1);
  if (editChangesParagraphStructure(edit)) {
    rebaseRemainingEdits(edit);
    if (currentPatch.edits.length === 0) {
      await loadDocument(currentDocument.documentId);
    } else {
      await refreshDocumentPreservingSuggestions();
    }
    addChat("System", "Applied that edit to Google Docs.");
    return;
  }

  acceptSingleEditLocally(edit);
  if (currentPatch.edits.length === 0) {
    clearPatch();
  } else {
    renderPreview();
  }
  renderDraftBar();
  addChat("System", "Applied that edit to Google Docs.");
}

function editChangesParagraphStructure(edit) {
  return edit.type === "replace_text" && (
    edit.replacementText.includes("\n") ||
    edit.target.currentText.includes("\n")
  );
}

function acceptSingleEditLocally(edit) {
  if (edit.type === "replace_text") {
    acceptTextEditLocally(edit);
    rebaseRemainingEdits(edit);
    return;
  }
  const paragraph = currentDocument.paragraphs[edit.target.paragraphIndex];
  const line = outlineEl.querySelector(`.doc-line[data-paragraph-index="${edit.target.paragraphIndex}"]`);
  if (edit.type === "update_paragraph_style") {
    paragraph.style = { ...(paragraph.style ?? {}), ...(edit.paragraphStyle ?? {}) };
  }
  if (edit.type === "update_text_style") {
    applyTextStyleToLocalRuns(paragraph, edit);
    clearTextStyleVisualForEdit(edit);
    renderParagraphLine(paragraph);
    return;
  }
  if (edit.type === "create_paragraph_bullets") {
    paragraph.bullet = paragraph.bullet ?? { nestingLevel: 0 };
  }
  if (edit.type === "delete_paragraph_bullets") {
    paragraph.bullet = undefined;
  }
  clearInlineDiff(line);
  line?.classList.remove("has-format-change", "has-diff");
}

function acceptTextEditLocally(edit) {
  const paragraph = currentDocument.paragraphs[edit.target.paragraphIndex];
  const relativeStart = edit.target.startIndex - paragraph.startIndex;
  const relativeEnd = edit.target.endIndex - paragraph.startIndex;
  paragraph.textRuns = replaceLocalTextRunRange(paragraph, edit);
  paragraph.text = `${paragraph.text.slice(0, relativeStart)}${edit.replacementText}${paragraph.text.slice(relativeEnd)}`;
  const delta = edit.replacementText.length - (edit.target.endIndex - edit.target.startIndex);
  paragraph.endIndex += delta;

  renderParagraphLine(paragraph);
  const line = outlineEl.querySelector(`.doc-line[data-paragraph-index="${edit.target.paragraphIndex}"]`);
  clearInlineDiff(line);
  outlineEl.querySelector(`.doc-line[data-draft-key*="${edit.target.startIndex}"]`)?.remove();
  renumberVisibleParagraphs();
}

function renderParagraphLine(paragraph) {
  const line = outlineEl.querySelector(`.doc-line[data-paragraph-index="${paragraph.paragraphIndex}"]`);
  const content = line?.querySelector(".doc-line-content");
  if (!content) return;
  content.innerHTML = renderIndexedParagraphContent(paragraph);
}

function replaceLocalTextRunRange(paragraph, edit) {
  const chars = expandTextRunsToChars(paragraph);
  const relativeStart = edit.target.startIndex - paragraph.startIndex;
  const relativeEnd = edit.target.endIndex - paragraph.startIndex;
  const insertionStyle = styleAtLocalOffset(paragraph, relativeStart);
  const replacementChars = [...edit.replacementText].map((char) => ({
    char,
    style: { ...insertionStyle }
  }));
  const nextChars = [
    ...chars.slice(0, relativeStart),
    ...replacementChars,
    ...chars.slice(relativeEnd)
  ];
  return collapseCharsToTextRuns(paragraph, nextChars);
}

function applyTextStyleToLocalRuns(paragraph, edit) {
  const chars = expandTextRunsToChars(paragraph);
  const relativeStart = edit.target.startIndex - paragraph.startIndex;
  const relativeEnd = edit.target.endIndex - paragraph.startIndex;
  for (let index = relativeStart; index < relativeEnd && index < chars.length; index += 1) {
    chars[index].style = {
      ...(chars[index].style ?? {}),
      ...(edit.textStyle ?? {})
    };
  }
  paragraph.textRuns = collapseCharsToTextRuns(paragraph, chars);
}

function expandTextRunsToChars(paragraph) {
  const runs = paragraph.textRuns?.length
    ? paragraph.textRuns
    : [{ startIndex: paragraph.startIndex, endIndex: paragraph.endIndex, text: paragraph.text, style: {} }];
  const chars = [];
  for (const run of runs) {
    for (const char of [...stripParagraphBreak(run.text)]) {
      chars.push({ char, style: { ...(run.style ?? {}) } });
    }
  }
  return chars;
}

function collapseCharsToTextRuns(paragraph, chars) {
  if (!chars.length) {
    return [{
      tabId: paragraph.tabId,
      startIndex: paragraph.startIndex,
      endIndex: paragraph.startIndex,
      text: "",
      style: {}
    }];
  }
  const runs = [];
  let current = null;
  chars.forEach((item, offset) => {
    const key = JSON.stringify(item.style ?? {});
    if (!current || current.key !== key) {
      current = {
        key,
        tabId: paragraph.tabId,
        startIndex: paragraph.startIndex + offset,
        endIndex: paragraph.startIndex + offset,
        text: "",
        style: { ...(item.style ?? {}) }
      };
      runs.push(current);
    }
    current.text += item.char;
    current.endIndex = paragraph.startIndex + offset + 1;
  });
  return runs.map(({ key, ...run }) => run);
}

function styleAtLocalOffset(paragraph, offset) {
  const absolute = paragraph.startIndex + Math.max(0, offset - 1);
  const previousRun = paragraph.textRuns?.find((run) => absolute >= run.startIndex && absolute < run.endIndex);
  if (previousRun?.style) return previousRun.style;
  const nextAbsolute = paragraph.startIndex + offset;
  const nextRun = paragraph.textRuns?.find((run) => nextAbsolute >= run.startIndex && nextAbsolute < run.endIndex);
  return nextRun?.style ?? paragraph.textRuns?.[0]?.style ?? {};
}

function rebaseRemainingEdits(appliedEdit) {
  const delta = appliedEdit.replacementText.length - (appliedEdit.target.endIndex - appliedEdit.target.startIndex);
  if (!delta) return;
  const sameTab = (target) => (target.tabId ?? "") === (appliedEdit.target.tabId ?? "");
  for (const paragraph of currentDocument.paragraphs) {
    if ((paragraph.tabId ?? "") !== (appliedEdit.target.tabId ?? "")) continue;
    if (paragraph.paragraphIndex !== appliedEdit.target.paragraphIndex && paragraph.startIndex > appliedEdit.target.startIndex) {
      paragraph.startIndex += delta;
      paragraph.endIndex += delta;
      for (const run of paragraph.textRuns ?? []) {
        run.startIndex += delta;
        run.endIndex += delta;
      }
    }
  }
  for (const edit of currentPatch?.edits ?? []) {
    if (!sameTab(edit.target)) continue;
    if (edit.target.startIndex > appliedEdit.target.startIndex) {
      edit.target.startIndex += delta;
      edit.target.endIndex += delta;
    }
  }
  for (const draft of indexDraftEdits.values()) {
    if ((draft.paragraph.tabId ?? "") !== (appliedEdit.target.tabId ?? "")) continue;
    if (draft.startIndex > appliedEdit.target.startIndex) {
      draft.startIndex += delta;
      draft.endIndex += delta;
    }
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
