let running = false;
let abortRequested = false;
let currentTabId = null;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === "start") {
    if (running) {
      sendResponse({ ok: false, msg: "already running" });
      return;
    }
    running = true;
    abortRequested = false;
    runOrchestrator();
    sendResponse({ ok: true });
    return true;
  } else if (msg.action === "stop") {
    abortRequested = true;
    running = false;
    // notify active content script to cancel current work
    if (currentTabId) {
      try {
        chrome.tabs.sendMessage(currentTabId, { type: "cancel" });
      } catch (_) {}
    }
    sendResponse({ ok: true });
    return true;
  }
});

async function runOrchestrator() {
  chrome.runtime.sendMessage({ type: "status", status: "running" });
  const storage = await chrome.storage.local.get([
    "prompts",
    "settings",
    "checkpoint",
  ]);
  const prompts = storage.prompts || [];
  const settings = storage.settings || {};
  let checkpoint = storage.checkpoint || 0;
  const total = prompts.length;

  // Query tất cả tab labs.google, sau đó lọc lại đúng whisk; nếu không có thì tự mở
  let tabs = await chrome.tabs.query({ url: "https://labs.google/fx/tools*" });
  let tab = tabs.find(
    (t) => t.url && t.url.startsWith("https://labs.google/fx/tools/whisk/")
  );
  if (!tab) {
    chrome.runtime.sendMessage({
      type: "log",
      text: "Whisk tab not found. Opening a new one...",
    });
    try {
      tab = await chrome.tabs.create({
        url: "https://labs.google/fx/tools/whisk/",
      });
      // wait a moment for the page to load
      await delay(1500);
    } catch (e) {
      chrome.runtime.sendMessage({
        type: "log",
        text: "Failed to open Whisk tab: " + e.message,
      });
      chrome.runtime.sendMessage({ type: "status", status: "idle" });
      running = false;
      return;
    }
  }
  try {
    await chrome.tabs.update(tab.id, { active: true });
  } catch (_) {}
  currentTabId = tab.id;

  // Inject content script once at the beginning
  try {
    chrome.runtime.sendMessage({
      type: "log",
      text: "Injecting content script...",
    });

    // Validate tab is still active and accessible
    const currentTab = await new Promise((resolve) => {
      chrome.tabs.get(tab.id, (t) => {
        if (chrome.runtime.lastError) {
          resolve(null);
        } else {
          resolve(t);
        }
      });
    });

    if (!currentTab) {
      throw new Error("Tab is no longer accessible");
    }

    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content.js"],
    });

    // Wait longer for content script to initialize properly
    await delay(3000); // Increased from 1000ms to 3000ms

    // Test connection with a ping message
    const pingResult = await sendMessageToTab(tab.id, { type: "ping" });
    if (pingResult.status === "error") {
      throw new Error("Content script ping failed: " + pingResult.message);
    }

    console.log("[INJECT] Content script successfully injected and responding");

  } catch (e) {
    chrome.runtime.sendMessage({
      type: "log",
      text: "Failed to inject content script: " + e.message,
    });
    chrome.runtime.sendMessage({ type: "status", status: "idle" });
    running = false;
    return;
  }

  let i = checkpoint;
  const maxRetries = Math.max(1, Number(settings.maxRetries) || 3);
  const retryDelayMs = Math.max(500, Number(settings.retryDelayMs) || 3000);
  const imagesPerPrompt = Number(settings.imagesPerPrompt) || 1;

  // Determine if this is the start of a new session
  const isNewSession = checkpoint === 0;

  while (i < prompts.length) {
    if (abortRequested) {
      chrome.runtime.sendMessage({ type: "log", text: "Abort requested" });
      break;
    }

    const p = prompts[i];
    const promptText = composePrompt(p);
    chrome.runtime.sendMessage({
      type: "log",
      text: `Processing ${i + 1}/${total}: ${promptText}`,
    });

    let attempt = 0;
    let success = false;

    while (attempt < maxRetries && !success && !abortRequested) {
      attempt++;
      chrome.runtime.sendMessage({
        type: "log",
        text: `Submit attempt ${attempt} for prompt ${i + 1}`,
      });

      try {
        // Process complete prompt (submit + wait for images + download)
        let resp = await sendMessageToTab(tab.id, {
          type: "processPrompt",
          prompt: promptText,
          promptIndex: i + 1,
          clearCache: isNewSession && i === 0 // Only clear cache for very first prompt of new session
        });

        // If connection error, try one more time after re-injection
        if (resp && resp.status === "error" && resp.message.includes("Content script injection failed")) {
          chrome.runtime.sendMessage({
            type: "log",
            text: `Connection lost for prompt ${i + 1}, retrying...`,
          });
          await delay(3000); // Wait for re-injection

          resp = await sendMessageToTab(tab.id, {
            type: "processPrompt",
            prompt: promptText,
            promptIndex: i + 1,
            clearCache: false // Don't clear cache on retry
          });
        }

        if (resp && resp.status === "completed") {
          chrome.runtime.sendMessage({
            type: "log",
            text: `Prompt ${i + 1} completed successfully`,
          });
          success = true;
        } else if (resp && resp.status === "busy") {
          chrome.runtime.sendMessage({
            type: "log",
            text: `Prompt ${i + 1} skipped - content script busy`,
          });
          if (attempt < maxRetries) {
            await delay(retryDelayMs);
          }
        } else {
          chrome.runtime.sendMessage({
            type: "log",
            text: `Prompt ${i + 1} failed: ${resp && resp.message}`,
          });
          if (attempt < maxRetries) {
            await delay(retryDelayMs);
          }
        }

      } catch (e) {
        chrome.runtime.sendMessage({
          type: "log",
          text: `Error on prompt ${i + 1} attempt ${attempt}: ${e.message}`,
        });
        if (attempt < maxRetries) {
          await delay(retryDelayMs);
        }
      }
    }

    if (success) {
      // Step 3: Mandatory 2 second delay after download
      chrome.runtime.sendMessage({
        type: "log",
        text: `Prompt ${i + 1} completed. Waiting 2 seconds after download...`,
      });
      await delay(2000);

      // Update checkpoint
      await chrome.storage.local.set({ checkpoint: i + 1 });
      chrome.runtime.sendMessage({ type: "progress", done: i + 1, total });

      // Step 4: Wait before next prompt to ensure proper sequencing
      const betweenPromptsWait = Number(settings.betweenPromptsMs) || 1000;
      chrome.runtime.sendMessage({
        type: "log",
        text: `Moving to next prompt in ${betweenPromptsWait}ms...`,
      });
      await delay(betweenPromptsWait);

      i++;
    } else {
      chrome.runtime.sendMessage({
        type: "log",
        text: `Skipping prompt ${i + 1} after ${maxRetries} failed attempts`,
      });
      i++;
    }
  }

  running = false;
  chrome.runtime.sendMessage({ type: "status", status: "idle" });
  currentTabId = null;
}

function composePrompt(p) {
  const parts = [];
  if (p.context) parts.push(p.context);
  return parts.join(". ");
}

function sendMessageToTab(tabId, msg) {
  return new Promise((res, rej) => {
    // First check if tab still exists
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError || !tab) {
        console.error("[TAB_MESSAGE] Tab not found:", chrome.runtime.lastError?.message);
        return res({
          status: "error",
          message: "Tab not found or closed",
        });
      }

      const timeout = setTimeout(() => {
        console.error("[TAB_MESSAGE] Timeout - no response within 30 seconds");
        res({
          status: "error",
          message: "Message timeout - no response within 30 seconds"
        });
      }, 30000); // 30 second timeout

      chrome.tabs.sendMessage(tabId, msg, (r) => {
        clearTimeout(timeout);
        if (chrome.runtime.lastError) {
          console.error("[TAB_MESSAGE] Error:", chrome.runtime.lastError.message);

          // If connection failed, try to re-inject content script
          if (chrome.runtime.lastError.message.includes("Receiving end does not exist")) {
            console.log("[TAB_MESSAGE] Re-injecting content script...");
            chrome.scripting.executeScript({
              target: { tabId: tabId },
              files: ["content.js"],
            }, (result) => {
              if (chrome.runtime.lastError) {
                console.error("[TAB_MESSAGE] Re-injection failed:", chrome.runtime.lastError.message);
                return res({
                  status: "error",
                  message: "Content script injection failed: " + chrome.runtime.lastError.message,
                });
              } else {
                console.log("[TAB_MESSAGE] Content script re-injected, retrying message...");
                // Wait a bit for script to initialize then retry
                setTimeout(() => {
                  chrome.tabs.sendMessage(tabId, msg, (retryResponse) => {
                    if (chrome.runtime.lastError) {
                      return res({
                        status: "error",
                        message: "Retry failed: " + chrome.runtime.lastError.message,
                      });
                    }
                    res(retryResponse);
                  });
                }, 2000);
              }
            });
          } else {
            return res({
              status: "error",
              message: chrome.runtime.lastError.message,
            });
          }
        } else {
          res(r);
        }
      });
    });
  });
}function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function downloadViaBackground(url, filename) {
  return new Promise((res, rej) => {
    chrome.runtime.sendMessage(
      { type: "downloadImage", url, filename },
      (r) => {
        res(true);
      }
    );
    // no callback expected; resolve quickly
    setTimeout(() => res(true), 500);
  });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "downloadSingleImage") {
    const { dataUrl, filename } = msg;
    console.log(`[BACKGROUND][SINGLE_DOWNLOAD] Downloading: ${filename}`);

    chrome.downloads.download(
      {
        url: dataUrl,
        filename: filename,
        conflictAction: "uniquify",
        saveAs: false,
      },
      (id) => {
        if (chrome.runtime.lastError) {
          console.error("[DOWNLOAD][ERROR]", chrome.runtime.lastError.message);
          sendResponse({ ok: false, error: chrome.runtime.lastError.message });
        } else {
          console.log(`[DOWNLOAD][SUCCESS] Downloaded ${filename} with id: ${id}`);
          sendResponse({ ok: true, downloadId: id });
        }
      }
    );
    return true;
  }
});
