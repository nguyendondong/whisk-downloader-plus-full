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
  console.log(`[GRID] All image URLs:`, gridImages.map((url, index) => `${index + 1}: ...${url.substring(url.length - 20)}`));
  console.log(`[GRID] Selected first image URL ending: ...${gridImages[0].substring(gridImages[0].length - 20)}`);

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

  console.log(`[FILENAME] Created filename for prompt ${promptIndex}: ${filename}`);
  console.log(`[FILENAME] Settings - prefix: ${prefix}, template: ${template}`);

  return filename;
}

// === URL TRACKING FUNCTIONS ===
async function getDownloadedUrls() {
  return new Promise((resolve) => {
    chrome.storage.local.get(["downloadedUrls"], (result) => {
      const urls = result.downloadedUrls || [];
      console.log(`[TRACKING] Retrieved downloaded URLs count: ${urls.length}`);
      resolve(urls);
    });
  });
}

async function addDownloadedUrl(url) {
  const current = await getDownloadedUrls();
  const updated = Array.from(new Set([...current, url]));
  return new Promise((resolve) => {
    chrome.storage.local.set({ downloadedUrls: updated }, () => {
      console.log(`[TRACKING] Added URL to downloaded list: ...${url.substring(url.length - 20)}`);
      console.log(`[TRACKING] Total downloaded URLs now: ${updated.length}`);
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

    // Send to background for download with retry logic
    let downloadResult = null;
    let attempts = 0;
    const maxAttempts = 3;

    while (attempts < maxAttempts && !downloadResult?.ok) {
      attempts++;
      console.log(`[DOWNLOAD] Download attempt ${attempts}/${maxAttempts} for ${filename}`);

      try {
        downloadResult = await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            reject(new Error("Download request timeout"));
          }, 10000); // 10 second timeout

          chrome.runtime.sendMessage(
            {
              type: "downloadSingleImage",
              dataUrl: dataUrl,
              filename: filename
            },
            (response) => {
              clearTimeout(timeout);
              if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
              } else {
                resolve(response);
              }
            }
          );
        });

        if (downloadResult?.ok) {
          break; // Success, exit retry loop
        }
      } catch (error) {
        console.warn(`[DOWNLOAD] Attempt ${attempts} failed: ${error.message}`);
        if (attempts < maxAttempts) {
          await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1s before retry
        }
      }
    }

    if (downloadResult && downloadResult.ok) {
      // Mark this URL as downloaded
      await addDownloadedUrl(blobUrl);
      console.log(`[DOWNLOAD] Successfully downloaded: ${filename}`);
      return { status: "downloaded", filename: filename };
    } else {
      throw new Error(downloadResult?.error || "Download failed after all retries");
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
    const elapsed = Math.round((Date.now() - startTime)/1000);

    // More detailed logging
    console.log(`[WAIT] Found ${gridImages.length}/${targetCount} images (elapsed: ${elapsed}s)`);

    if (gridImages.length > 0) {
      console.log(`[WAIT] Current image URLs: ${gridImages.map((url, i) => `${i+1}: ...${url.substring(url.length - 15)}`).join(', ')}`);
    }

    if (gridImages.length >= targetCount) {
      // Additional validation: ensure images are truly loaded and stable
      const validImages = [];

      for (let i = 0; i < gridImages.length; i++) {
        const url = gridImages[i];

        // Check if blob URL is accessible
        try {
          const response = await fetch(url, { method: 'HEAD' });
          if (response.ok) {
            validImages.push(url);
            console.log(`[WAIT] ✓ Image ${i+1} validated: ...${url.substring(url.length - 15)}`);
          } else {
            console.log(`[WAIT] ✗ Image ${i+1} failed validation (HTTP ${response.status}): ...${url.substring(url.length - 15)}`);
          }
        } catch (error) {
          console.log(`[WAIT] ✗ Image ${i+1} failed validation (fetch error): ...${url.substring(url.length - 15)}`);
        }
      }

      if (validImages.length >= targetCount) {
        console.log(`[WAIT] ✅ Target reached! Found ${validImages.length} valid images`);
        return validImages;
      } else {
        console.log(`[WAIT] ⚠️  Only ${validImages.length}/${targetCount} images passed validation, continuing...`);
      }
    }

    await new Promise(resolve => setTimeout(resolve, 800)); // Slightly longer delay
  }

  const finalImages = await getGridImages();
  throw new Error(`Timeout waiting for ${targetCount} images. Found ${finalImages.length} total, ${finalImages.filter(url => url.startsWith('blob:')).length} valid blobs`);
}

async function waitForStableImages(timeout = 60000, targetCount = 2) {
  const startTime = Date.now();
  let lastUrls = null;
  let stableCount = 0;
  const requiredStableChecks = 8; // Increase to 8 for much better stability
  let lastImageCount = 0;

  console.log(`[STABILITY] Waiting for ${targetCount} stable images with ${requiredStableChecks} consecutive stable checks...`);

  while (Date.now() - startTime < timeout) {
    if (window.__WHISK_CANCEL__) {
      throw new Error("Cancelled");
    }

    try {
      const currentUrls = await waitForImagesInGrid(8000, targetCount); // Increased timeout
      const uniqueUrls = [...new Set(currentUrls)];
      const elapsed = Math.round((Date.now() - startTime) / 1000);

      console.log(`[STABILITY] Found ${uniqueUrls.length}/${targetCount} unique images (elapsed: ${elapsed}s)`);

      // More strict validation
      if (uniqueUrls.length >= targetCount) {
        // Additional validation: ensure all images are different blob URLs
        const validUrls = uniqueUrls.filter(url =>
          url &&
          url.startsWith("blob:") &&
          url.includes("labs.google") &&
          url.length > 30 // Reasonable blob URL length
        );

        if (validUrls.length >= targetCount) {
          // Check if URLs are stable AND count is stable
          const urlsMatch = lastUrls && JSON.stringify(lastUrls.sort()) === JSON.stringify(validUrls.sort());
          const countStable = lastImageCount === validUrls.length;

          if (urlsMatch && countStable) {
            stableCount++;
            console.log(`[STABILITY] ✓ Stable check ${stableCount}/${requiredStableChecks} - ${validUrls.length} images unchanged`);
            console.log(`[STABILITY] Current URLs: ${validUrls.map(url => `...${url.substring(url.length - 15)}`).join(', ')}`);

            if (stableCount >= requiredStableChecks) {
              console.log(`[STABILITY] 🎉 Images fully stabilized! Returning ${validUrls.length} images after ${elapsed}s`);

              // Final validation: wait additional 2 seconds and recheck
              console.log(`[STABILITY] Final validation: waiting 2s more...`);
              await new Promise(resolve => setTimeout(resolve, 2000));

              const finalUrls = await getGridImages();
              const finalValid = [...new Set(finalUrls)].filter(url =>
                url && url.startsWith("blob:") && url.includes("labs.google")
              );

              if (finalValid.length >= targetCount &&
                  JSON.stringify(finalValid.sort()) === JSON.stringify(validUrls.sort())) {
                console.log(`[STABILITY] ✅ Final validation passed! ${finalValid.length} images confirmed stable`);
                return finalValid;
              } else {
                console.log(`[STABILITY] ⚠️  Final validation failed, restarting stability check...`);
                stableCount = 0;
                continue;
              }
            }
          } else {
            stableCount = 0;
            console.log(`[STABILITY] ⚠️  Images changed (URLs: ${urlsMatch}, Count: ${countStable}), resetting counter`);
            console.log(`[STABILITY] Previous: ${lastUrls?.map(url => `...${url.substring(url.length - 15)}`).join(', ') || 'none'}`);
            console.log(`[STABILITY] Current:  ${validUrls.map(url => `...${url.substring(url.length - 15)}`).join(', ')}`);
          }

          lastUrls = validUrls;
          lastImageCount = validUrls.length;
        } else {
          stableCount = 0;
          console.log(`[STABILITY] ⚠️  Only ${validUrls.length}/${targetCount} valid blob URLs found`);
        }
      } else {
        stableCount = 0;
        lastImageCount = uniqueUrls.length;
        console.log(`[STABILITY] ⏳ Still generating... ${uniqueUrls.length}/${targetCount} images`);
      }
    } catch (error) {
      stableCount = 0;
      console.log(`[STABILITY] ⏳ Waiting for images to appear... (${error.message})`);
    }

    await new Promise(resolve => setTimeout(resolve, 2000)); // Increased delay for better stability
  }

  const finalCount = lastUrls?.length || 0;
  throw new Error(`Images did not stabilize within ${timeout/1000}s timeout. Found ${finalCount}/${targetCount} stable images`);
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
    console.log(`[PROCESS] ===== STARTING PROMPT ${promptIndex}: ${promptText} =====`);

    // Step 1: Submit the prompt
    console.log(`[PROCESS] Step 1: Submitting prompt to UI...`);
    const submitResult = await submitPromptToUI(promptText);
    if (!submitResult.success) {
      throw new Error(`Failed to submit prompt: ${submitResult.error}`);
    }
    console.log(`[PROCESS] ✅ Step 1 completed: Prompt submitted successfully`);

    // Step 1.5: Wait for UI to process the submission
    console.log(`[PROCESS] Step 1.5: Waiting for UI to start processing (5s delay)...`);
    await new Promise(resolve => setTimeout(resolve, 5000));
    console.log(`[PROCESS] ✅ Step 1.5 completed: UI processing delay finished`);

    // Step 2: Wait for 2 images to be fully rendered and stable
    console.log(`[PROCESS] Step 2: Waiting for 2 images to render and stabilize...`);
    const stableImages = await waitForStableImages(90000, 2); // Increased to 90 seconds
    console.log(`[PROCESS] ✅ Step 2 completed: ${stableImages.length} images are now stable and validated`);
    console.log(`[PROCESS] Stable image URLs: ${stableImages.map((url, i) => `${i+1}: ...${url.substring(url.length - 15)}`).join(', ')}`);

    // Step 2.5: Additional validation delay to ensure rendering is complete
    console.log(`[PROCESS] Step 2.5: Final validation delay (3s)...`);
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Double-check images are still there
    const finalCheck = await getGridImages();
    if (finalCheck.length < 2) {
      throw new Error(`Images disappeared during final validation. Found ${finalCheck.length}/2`);
    }
    console.log(`[PROCESS] ✅ Step 2.5 completed: Final validation passed (${finalCheck.length} images confirmed)`);

    // Step 3: Download the first image
    console.log(`[PROCESS] Step 3: Downloading first image...`);
    const downloadResult = await downloadSingleImage(promptIndex);

    if (downloadResult.status === "downloaded" || downloadResult.status === "duplicate") {
      console.log(`[PROCESS] ✅ Step 3 completed: Image ${downloadResult.status === "duplicate" ? "already downloaded" : "downloaded successfully"}`);

      // Step 4: Post-download delay as requested
      console.log(`[PROCESS] Step 4: Post-download delay (2s)...`);
      await new Promise(resolve => setTimeout(resolve, 2000));
      console.log(`[PROCESS] ✅ Step 4 completed: Post-download delay finished`);

      console.log(`[PROCESS] ===== PROMPT ${promptIndex} FULLY COMPLETED =====`);
      return { status: "completed", message: `Prompt ${promptIndex} processed successfully` };
    } else {
      throw new Error(`Download failed: ${downloadResult.message}`);
    }

  } catch (error) {
    console.error(`[PROCESS] ❌ Error processing prompt ${promptIndex}:`, error);
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
    } else if (msg.type === "ping") {
      console.log("[PING] Ping received, responding...");
      sendResponse({ status: "ok", message: "Content script is ready" });
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

          // Only clear downloaded URLs list for the very first prompt of a new session
          // Check if this is really the start of a new batch
          if (msg.promptIndex === 1 && msg.clearCache === true) {
            console.log(`[PROCESS] First prompt of new session, clearing downloaded URLs list`);
            await clearDownloadedUrls();
          } else {
            console.log(`[PROCESS] Continuing session, keeping downloaded URLs list`);
          }

          console.log(`[PROCESS] ===== STARTING PROMPT ${msg.promptIndex} =====`);

          // Process the complete prompt (submit + wait + download)
          const result = await processPrompt(msg.prompt, msg.promptIndex);
          sendResponse(result);

        } catch (error) {
          console.error(`[PROCESS] Error:`, error);
          sendResponse({ status: "error", message: error.message });
        } finally {
          window.__WHISK_PROCESSING__ = false;
          console.log(`[PROCESS] ===== FINISHED PROMPT ${msg.promptIndex} =====`);
        }
      })();
      return true;
    }
  });
}
