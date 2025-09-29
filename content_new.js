// === GRID IMAGE FUNCTIONS ===
async function getGridImages() {
  const gridContainer = document.querySelector('div.joaCbM');
  if (!gridContainer) {
    console.log("[GRID] Container div.joaCbM not found");
    return [];
  }

  // Get all image containers in the correct visual order
  const imageContainers = Array.from(gridContainer.querySelectorAll("div.sc-12e568c9-0.dKRdkO"));
  console.log(`[GRID] Found ${imageContainers.length} image containers`);

  const validImages = [];

  for (const container of imageContainers) {
    const img = container.querySelector("img.sc-3c44e5a1-0.hYIeMY");
    if (img &&
        img.src &&
        img.width > 20 &&
        img.height > 20 &&
        img.src.startsWith("blob:") &&
        img.src.includes("labs.google") &&
        img.complete) {
      validImages.push(img.src);
    }
  }

  console.log(`[GRID] Found ${validImages.length} valid images in correct order`);
  console.log(`[GRID] Image URLs:`, validImages.map(url => url.substring(url.length - 20)));
  return validImages;
}

async function getFirstGridImage() {
  const gridImages = await getGridImages();
  if (gridImages.length === 0) {
    throw new Error("No images found in grid");
  }

  console.log(`[GRID] Selecting FIRST image from ${gridImages.length} total images`);
  console.log(`[GRID] First image URL ending: ...${gridImages[0].substring(gridImages[0].length - 20)}`);
  return gridImages[0]; // Always return the first image in visual order
}

// === UTILITY FUNCTIONS ===
async function blobUrlToDataUrl(blobUrl) {
  const response = await fetch(blobUrl);
  const blob = await response.blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function createFilename(promptIndex, settings) {
  const prefix = settings?.prefix || "whisk";
  const template = settings?.template || "{prefix}_{n}.png";
  const padIndex = String(promptIndex).padStart(4, "0");

  let filename = template
    .replace("{prefix}", prefix)
    .replace("{n}", padIndex)
    .replace(/\{[^}]+\}/g, ""); // Remove any other template variables

  // Ensure it has .png extension
  if (!/\.(png|jpg|jpeg|webp|gif)$/i.test(filename)) {
    filename += ".png";
  }

  return filename;
}

// === URL TRACKING FUNCTIONS ===
async function getDownloadedUrls() {
  return new Promise((resolve) => {
    chrome.storage.local.get(["downloadedUrls"], (result) => {
      resolve(result.downloadedUrls || []);
    });
  });
}

async function addDownloadedUrl(url) {
  const current = await getDownloadedUrls();
  const updated = Array.from(new Set([...current, url]));
  return new Promise((resolve) => {
    chrome.storage.local.set({ downloadedUrls: updated }, () => {
      console.log(`[TRACKING] Added URL to downloaded list: ...${url.substring(url.length - 20)}`);
      resolve();
    });
  });
}

async function clearDownloadedUrls() {
  return new Promise((resolve) => {
    chrome.storage.local.set({ downloadedUrls: [] }, () => {
      console.log(`[TRACKING] Cleared downloaded URLs list`);
      resolve();
    });
  });
}

// === DOWNLOAD FUNCTION ===
async function downloadSingleImage(promptIndex) {
  try {
    console.log(`[DOWNLOAD] Starting download for prompt ${promptIndex}`);

    // Get first image from grid
    const blobUrl = await getFirstGridImage();
    console.log(`[DOWNLOAD] Got first image URL: ${blobUrl.substring(0, 50)}...`);

    // Check if this image was already downloaded to prevent duplicates
    const downloadedUrls = await getDownloadedUrls();
    if (downloadedUrls.includes(blobUrl)) {
      console.log(`[DOWNLOAD] Image already downloaded, skipping: ...${blobUrl.substring(blobUrl.length - 20)}`);
      return { status: "duplicate", message: "Image already downloaded" };
    }

    // Convert blob to data URL
    const dataUrl = await blobUrlToDataUrl(blobUrl);
    console.log(`[DOWNLOAD] Converted to data URL: ${dataUrl.substring(0, 50)}...`);

    // Get settings and create filename
    const { settings } = await chrome.storage.local.get(["settings"]);
    const filename = createFilename(promptIndex, settings);
    console.log(`[DOWNLOAD] Generated filename: ${filename}`);

    // Send to background for download
    const downloadResult = await new Promise((resolve) => {
      chrome.runtime.sendMessage(
        {
          type: "downloadSingleImage",
          dataUrl: dataUrl,
          filename: filename
        },
        (response) => resolve(response)
      );
    });

    if (downloadResult && downloadResult.ok) {
      // Mark this URL as downloaded
      await addDownloadedUrl(blobUrl);
      console.log(`[DOWNLOAD] Successfully downloaded: ${filename}`);
      return { status: "downloaded", filename: filename };
    } else {
      throw new Error(downloadResult?.error || "Download failed");
    }

  } catch (error) {
    console.error(`[DOWNLOAD] Error downloading image for prompt ${promptIndex}:`, error);
    return { status: "error", message: error.message };
  }
}

// === IMAGE WAITING FUNCTIONS ===
async function waitForImagesInGrid(timeout = 30000, targetCount = 2) {
  const startTime = Date.now();
  console.log(`[WAIT] Waiting for ${targetCount} images in grid...`);

  while (Date.now() - startTime < timeout) {
    if (window.__WHISK_CANCEL__) {
      throw new Error("Cancelled");
    }

    const gridImages = await getGridImages();
    console.log(`[WAIT] Found ${gridImages.length}/${targetCount} images (elapsed: ${Math.round((Date.now() - startTime)/1000)}s)`);

    if (gridImages.length >= targetCount) {
      console.log(`[WAIT] Target reached! Found ${gridImages.length} images`);
      return gridImages;
    }

    await new Promise(resolve => setTimeout(resolve, 500));
  }

  throw new Error(`Timeout waiting for ${targetCount} images. Found ${(await getGridImages()).length}`);
}

async function waitForStableImages(timeout = 45000, targetCount = 2) {
  const startTime = Date.now();
  let lastUrls = null;
  let stableCount = 0;
  const requiredStableChecks = 5; // Increase to 5 for better stability

  console.log(`[STABILITY] Waiting for ${targetCount} stable images...`);

  while (Date.now() - startTime < timeout) {
    if (window.__WHISK_CANCEL__) {
      throw new Error("Cancelled");
    }

    try {
      const currentUrls = await waitForImagesInGrid(5000, targetCount);
      const uniqueUrls = [...new Set(currentUrls)];

      if (uniqueUrls.length >= targetCount) {
        // Check if URLs are stable
        if (lastUrls && JSON.stringify(lastUrls.sort()) === JSON.stringify(uniqueUrls.sort())) {
          stableCount++;
          console.log(`[STABILITY] Stable for ${stableCount}/${requiredStableChecks} checks`);

          if (stableCount >= requiredStableChecks) {
            console.log(`[STABILITY] Images stabilized! Returning ${uniqueUrls.length} images`);
            return uniqueUrls;
          }
        } else {
          stableCount = 0;
          console.log(`[STABILITY] Images changed, resetting stability counter`);
        }

        lastUrls = uniqueUrls;
      } else {
        stableCount = 0;
      }
    } catch (error) {
      // Continue waiting if images not found yet
      console.log(`[STABILITY] Still waiting for images... (${error.message})`);
    }

    await new Promise(resolve => setTimeout(resolve, 1500)); // Increased delay for better stability
  }

  throw new Error(`Images did not stabilize within timeout. Found ${lastUrls?.length || 0}/${targetCount}`);
}

// === PROMPT SUBMISSION FUNCTION ===
async function submitPromptToUI(promptText) {
  try {
    // Find prompt input
    let input = document.querySelector("textarea") ||
                document.querySelector('[contenteditable="true"]') ||
                document.querySelector('input[aria-label*="prompt"]') ||
                document.querySelector("textarea[placeholder]");

    if (!input) {
      throw new Error("Prompt input not found on page");
    }

    // Set the prompt text
    if (input.tagName.toLowerCase() === "textarea" || input.tagName.toLowerCase() === "input") {
      input.value = promptText;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    } else {
      input.focus();
      input.innerText = promptText;
      input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    }

    // Find submit button
    let submitBtn = Array.from(document.querySelectorAll("button")).find(
      (b) => b.querySelector("i.google-symbols") &&
             b.querySelector("i.google-symbols").textContent.trim() === "arrow_forward"
    );

    if (!submitBtn) {
      submitBtn = Array.from(document.querySelectorAll("button")).find((b) =>
        /generate|create|remix|render|mix|run/i.test(b.innerText)
      );
    }

    if (!submitBtn) {
      submitBtn = document.querySelector("button[aria-label]");
    }

    if (!submitBtn) {
      throw new Error("Submit button not found");
    }

    // Submit the form
    const form = submitBtn.closest("form");
    if (form && form.requestSubmit) {
      form.requestSubmit(submitBtn);
    } else if (form && form.submit) {
      form.submit();
    } else {
      submitBtn.click();
    }

    console.log("[SUBMIT] Prompt submitted to UI");
    return { success: true };

  } catch (error) {
    console.error("[SUBMIT] Error submitting prompt:", error);
    return { success: false, error: error.message };
  }
}

// === MAIN PROCESSING FUNCTION ===
async function processPrompt(promptText, promptIndex) {
  try {
    console.log(`[PROCESS] Starting complete process for prompt ${promptIndex}: ${promptText}`);

    // Step 1: Submit the prompt
    console.log(`[PROCESS] Step 1: Submitting prompt to UI...`);
    const submitResult = await submitPromptToUI(promptText);
    if (!submitResult.success) {
      throw new Error(`Failed to submit prompt: ${submitResult.error}`);
    }

    // Step 2: Wait for 2 images to be fully rendered and stable
    console.log(`[PROCESS] Step 2: Waiting for 2 images to render and stabilize...`);
    await waitForStableImages(60000, 2); // Increased timeout to 60 seconds
    console.log(`[PROCESS] Step 2 completed: 2 images are now stable`);

    // Step 3: Download the first image
    console.log(`[PROCESS] Step 3: Downloading first image...`);
    const downloadResult = await downloadSingleImage(promptIndex);

    if (downloadResult.status === "downloaded" || downloadResult.status === "duplicate") {
      console.log(`[PROCESS] Step 3 completed: Image ${downloadResult.status === "duplicate" ? "already downloaded" : "downloaded successfully"}`);
      return { status: "completed", message: `Prompt ${promptIndex} processed successfully` };
    } else {
      throw new Error(`Download failed: ${downloadResult.message}`);
    }

  } catch (error) {
    console.error(`[PROCESS] Error processing prompt ${promptIndex}:`, error);
    return { status: "error", message: error.message };
  }
}

// === MAIN MESSAGE HANDLERS ===
// Initialize only once
if (!window.__WHISK_INIT__) {
  window.__WHISK_INIT__ = true;
  window.__WHISK_CANCEL__ = false;
  window.__WHISK_PROCESSING__ = false;

  console.log("[INIT] Whisk downloader content script initialized");

  // Handle cancel messages
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === "cancel") {
      window.__WHISK_CANCEL__ = true;
      console.log("[CANCEL] Cancel signal received");
      sendResponse({ ok: true });
      return true;
    }
  });

  // Handle process prompt messages (NEW UNIFIED HANDLER)
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === "processPrompt") {
      (async () => {
        try {
          if (window.__WHISK_PROCESSING__) {
            console.log("[BUSY] Already processing a prompt");
            sendResponse({ status: "busy", message: "Already processing" });
            return;
          }

          window.__WHISK_PROCESSING__ = true;
          window.__WHISK_CANCEL__ = false;

          // Clear downloaded URLs list for the first prompt to start fresh
          if (msg.promptIndex === 1) {
            console.log(`[PROCESS] First prompt, clearing downloaded URLs list`);
            await clearDownloadedUrls();
          }

          // Process the complete prompt (submit + wait + download)
          const result = await processPrompt(msg.prompt, msg.promptIndex);
          sendResponse(result);

        } catch (error) {
          console.error(`[PROCESS] Error:`, error);
          sendResponse({ status: "error", message: error.message });
        } finally {
          window.__WHISK_PROCESSING__ = false;
        }
      })();
      return true;
    }
  });
}
