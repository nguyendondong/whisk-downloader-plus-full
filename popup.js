// popup.js - handles UI, CSV import, settings, and messaging to background/content scripts
const fileInput = document.getElementById("fileInput");
const rowsCount = document.getElementById("rowsCount");
const previewBox = document.getElementById("previewBox");
const previewLines = document.getElementById("previewLines");
const imagesPerPrompt = document.getElementById("imagesPerPrompt");
const imageIndex = document.getElementById("imageIndex");

const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const resetBtn = document.getElementById("resetBtn");
const statusLabel = document.getElementById("statusLabel");
const progressLabel = document.getElementById("progressLabel");
const logBox = document.getElementById("logBox");
const clearLogs = document.getElementById("clearLogs");
const exportLog = document.getElementById("exportLog");

let prompts = [];
let running = false;

function setStatus(s) {
  statusLabel.textContent = s;
}
function setProgress(done, total) {
  progressLabel.textContent = `${done}/${total}`;
}

fileInput.addEventListener("change", async (ev) => {
  const f = ev.target.files[0];
  if (!f) return;
  const text = await f.text();
  prompts = CSVPARSER.csvToPromptObjects(text);
  rowsCount.textContent = prompts.length;
  populatePreview();
  await chrome.storage.local.set({ prompts });
  appendLog(`Imported ${prompts.length} prompts from ${f.name}`);
});

function populatePreview() {
  const n = Number(previewLines.value) || 10;
  previewBox.value = prompts
    .slice(0, n)
    .map(
      (p, i) =>
        `${p.index ?? i + 1}. ${p.scene || ""} | ${p.context || ""} | ${
          p.style || ""
        }`
    )
    .join("\n");
}

previewLines.addEventListener("change", populatePreview);

function appendLog(s) {
  const now = new Date().toLocaleString();
  const line = `[${now}] ${s}`;
  logBox.value = (logBox.value ? logBox.value + "\n" : "") + line;
  logBox.scrollTop = logBox.scrollHeight;
  const lines = logBox.value.split("\n").slice(-1000);
  chrome.storage.local.set({ logs: lines });
}

clearLogs.addEventListener("click", () => {
  logBox.value = "";
  chrome.storage.local.set({ logs: [] });
});
exportLog.addEventListener("click", () => {
  const blob = new Blob([logBox.value], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  chrome.downloads.download({ url, filename: "whisk_logs.txt" });
});

startBtn.addEventListener("click", async () => {
  if (prompts.length === 0) {
    appendLog("No prompts loaded");
    return;
  }
  const settings = {
    imagesPerPrompt: Number(imagesPerPrompt.value),
    imageIndex: Number(imageIndex.value),
    prefix: document.getElementById("prefixInput").value,
    template: document.getElementById("fileTemplate").value,
    minWaitMs: Number(document.getElementById("minWaitMs").value),
    timeoutMs: Number(document.getElementById("timeoutMs").value),
    afterRenderWaitMs: Number(
      document.getElementById("afterRenderWaitMs").value
    ),
    betweenPromptsMs: Number(document.getElementById("betweenPromptsMs").value),
    maxRetries: Number(document.getElementById("maxRetries").value) || 3,
    retryDelayMs: Number(document.getElementById("retryDelayMs").value) || 3000,
    downloadZip: document.getElementById("downloadZip").checked,
  };
  await chrome.storage.local.set({ settings, prompts });
  running = true;
  startBtn.disabled = true;
  stopBtn.disabled = false;
  setStatus("running");
  appendLog("Start requested");
  // send start message to background to orchestrate using active Whisk tab
  chrome.runtime.sendMessage({ action: "start" });
});

stopBtn.addEventListener("click", () => {
  running = false;
  startBtn.disabled = false;
  stopBtn.disabled = true;
  setStatus("stopping");
  chrome.runtime.sendMessage({ action: "stop" });
  appendLog("Stop requested");
});

resetBtn.addEventListener("click", async () => {
  if (confirm("Reset prompts and counters?")) {
    prompts = [];
    rowsCount.textContent = "0";
    previewBox.value = "";
    await chrome.storage.local.set({
      prompts: [],
      checkpoint: 0,
      downloadedImages: [],
    });
    appendLog("Reset done");
    // ensure any running session is stopped
    chrome.runtime.sendMessage({ action: "stop" });
  }
});

// tabs
document
  .getElementById("tab-source")
  .addEventListener("click", () => showPanel("source"));
document
  .getElementById("tab-download")
  .addEventListener("click", () => showPanel("download"));
document
  .getElementById("tab-timing")
  .addEventListener("click", () => showPanel("timing"));
document
  .getElementById("tab-logs")
  .addEventListener("click", () => showPanel("logs"));

function showPanel(name) {
  document
    .getElementById("panel-source")
    .classList.toggle("hidden", name !== "source");
  document
    .getElementById("panel-download")
    .classList.toggle("hidden", name !== "download");
  document
    .getElementById("panel-timing")
    .classList.toggle("hidden", name !== "timing");
  document
    .getElementById("panel-logs")
    .classList.toggle("hidden", name !== "logs");
  document
    .querySelectorAll(".tab")
    .forEach((t) => t.classList.remove("active"));
  document.getElementById("tab-" + name).classList.add("active");
}

// restore state
(async function restore() {
  const res = await chrome.storage.local.get([
    "prompts",
    "settings",
    "logs",
    "checkpoint",
  ]);
  if (res.prompts) {
    prompts = res.prompts;
    rowsCount.textContent = prompts.length;
    populatePreview();
  }
  if (res.settings) {
    document.getElementById("prefixInput").value =
      res.settings.prefix || "whisk_full";
    document.getElementById("fileTemplate").value = res.settings.template || "";
    document.getElementById("minWaitMs").value = res.settings.minWaitMs || 1500;
    document.getElementById("timeoutMs").value =
      res.settings.timeoutMs || 25000;
    document.getElementById("afterRenderWaitMs").value =
      res.settings.afterRenderWaitMs || 3000;
    document.getElementById("betweenPromptsMs").value =
      res.settings.betweenPromptsMs || 2500;
    document.getElementById("maxRetries").value = res.settings.maxRetries || 3;
    document.getElementById("retryDelayMs").value =
      res.settings.retryDelayMs || 3000;
    document.getElementById("imagesPerPrompt").value =
      res.settings.imagesPerPrompt || 4;
    document.getElementById("imageIndex").value = res.settings.imageIndex || 1;
    document.getElementById("downloadZip").checked =
      res.settings.downloadZip || false;
  }
  if (res.logs) logBox.value = res.logs.join("\n");
})();

// receive progress/status messages from background
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "progress") {
    setProgress(msg.done, msg.total);
    appendLog(msg.text || `Progress ${msg.done}/${msg.total}`);
    if (msg.done >= msg.total) {
      setStatus("idle");
      startBtn.disabled = false;
      stopBtn.disabled = true;
    }
  } else if (msg.type === "status") {
    setStatus(msg.status);
    appendLog("Status: " + msg.status);
  } else if (msg.type === "log") {
    appendLog(msg.text);
  }
});

previewBox.addEventListener("input", () => {
  const lines = previewBox.value.split("\n");
  prompts = lines
    .map((line) => {
      const parts = line
        .replace(/^[0-9]+\.\s*/, "")
        .split("|")
        .map((s) => s.trim());
      return {
        scene: parts[0] || "",
        context: parts[1] || "",
        style: parts[2] || "",
      };
    })
    .filter((p) => p.scene || p.context || p.style);
  rowsCount.textContent = prompts.length;
  chrome.storage.local.set({ prompts });
});
