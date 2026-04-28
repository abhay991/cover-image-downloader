// Browser-based downloader using Multilogin
import fs from 'fs/promises';
import path from 'path';
import puppeteer from 'puppeteer-core';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

// Configuration
const CONFIG = {
  THREADS: parseInt(process.env.THREADS || '2'), // Number of parallel browser instances
  URLS_FILE: 'urls.json',
  SUCCESS_LOG: 'successful_urls.txt',
  IMAGES_DIR: 'images',
  BATCH_SIZE: parseInt(process.env.BATCH_SIZE || '10'), // Number of images to download per browser session
  BATCH_DELAY: parseInt(process.env.BATCH_DELAY || '5'), // Delay in seconds after each batch

  // Multilogin configuration
  MULTILOGIN_API_KEY: process.env.MULTILOGIN_API_KEY || '', // Your Multilogin API key from .env
  MULTILOGIN_PORT: parseInt(process.env.MULTILOGIN_PORT || '35000'), // Multilogin local API port
  PROFILE_FOLDER_ID: '', // Your Multilogin folder ID (optional)

  // Browser settings
  BROWSER_TIMEOUT: 60000,
  PAGE_LOAD_TIMEOUT: 30000,
  DOWNLOAD_TIMEOUT: 120000,
};

// Sleep function
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Load successful URLs
async function loadSuccessfulUrls() {
  try {
    const content = await fs.readFile(CONFIG.SUCCESS_LOG, 'utf-8');
    return new Set(content.split('\n').map(line => line.trim()).filter(Boolean));
  } catch (error) {
    return new Set();
  }
}

// Save successful URL
async function saveSuccessfulUrl(url) {
  try {
    await fs.appendFile(CONFIG.SUCCESS_LOG, url + '\n');
  } catch (error) {
    console.error(`Error writing to ${CONFIG.SUCCESS_LOG}:`, error.message);
  }
}

// Load URLs from file
async function loadUrls(filename) {
  try {
    const content = await fs.readFile(filename, 'utf-8');
    const jsonData = JSON.parse(content);
    if (Array.isArray(jsonData)) {
      return jsonData.filter(url => url && typeof url === 'string');
    }
    if (jsonData.urls && Array.isArray(jsonData.urls)) {
      return jsonData.urls.filter(url => url && typeof url === 'string');
    }
    console.error(`Invalid JSON format in ${filename}`);
    return [];
  } catch (error) {
    console.error(`Error loading ${filename}:`, error.message);
    return [];
  }
}

// Get headers for Multilogin API requests
function getMultiloginHeaders() {
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };

  if (CONFIG.MULTILOGIN_API_KEY) {
    headers['Authorization'] = `Bearer ${CONFIG.MULTILOGIN_API_KEY}`;
  }

  return headers;
}

// Create Multilogin quick profile with proxy
async function createQuickProfile(proxy) {
  const parts = proxy.split(':');

  if (parts.length !== 4) {
    throw new Error(`Invalid proxy format. Expected host:port:username:password, got: ${proxy}`);
  }

  const [host, port, username, password] = parts;

  console.log(`  → Proxy: ${host}:${port} (user: ${username.substring(0, 3)}***)`);

  // Ensure no whitespace in credentials
  const cleanUsername = username.trim();
  const cleanPassword = password.trim();

  const profileData = {
    browser_type: 'mimic',
    os_type: 'macos',
    automation: 'puppeteer',
    parameters: {
      flags: {
        proxy_masking: 'custom'
      },
      proxy: {
        type: 'http',
        host: host.trim(),
        port: parseInt(port),
        username: cleanUsername,
        password: cleanPassword
      }
    }
  };

  try {
    const apiUrl = `https://launcher.mlx.yt:${CONFIG.MULTILOGIN_PORT}/api/v3/profile/quick`;

    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: getMultiloginHeaders(),
      body: JSON.stringify(profileData),
    });

    const responseText = await response.text();

    if (!response.ok) {
      throw new Error(`Failed to create profile (${response.status}): ${responseText}`);
    }

    const result = JSON.parse(responseText);

    // The quick profile API returns the profile ID and auto-starts it
    return {
      profileId: result.data.id,
      port: result.data.port
    };
  } catch (error) {
    if (error.cause) {
      console.error(`Error creating Multilogin profile: ${error.message} (Cause: ${error.cause.code || error.cause.message})`);
    } else {
      console.error(`Error creating Multilogin profile: ${error.message}`);
    }
    console.error(`  → Make sure Multilogin is running`);
    console.error(`  → Check API key in .env file`);
    throw error;
  }
}

// Start Multilogin browser profile
async function startProfile(profileId) {
  try {
    const response = await fetch(`https://launcher.mlx.yt:${CONFIG.MULTILOGIN_PORT}/api/v3/profile/start?automation=true&profileId=${profileId}`, {
      method: 'GET',
      headers: getMultiloginHeaders(),
    });

    if (!response.ok) {
      throw new Error(`Failed to start profile: ${response.status}`);
    }

    const result = await response.json();
    return result.value; // WebSocket endpoint for puppeteer
  } catch (error) {
    console.error(`Error starting profile:`, error.message);
    throw error;
  }
}

// Stop Multilogin profile
async function stopProfile(profileId) {
  try {
    await fetch(`https://launcher.mlx.yt:${CONFIG.MULTILOGIN_PORT}/api/v3/profile/stop?profileId=${profileId}`, {
      method: 'GET',
      headers: getMultiloginHeaders(),
    });
  } catch (error) {
    console.error(`Error stopping profile:`, error.message);
  }
}

// Delete Multilogin profile
async function deleteProfile(profileId) {
  try {
    await fetch(`https://launcher.mlx.yt:${CONFIG.MULTILOGIN_PORT}/api/v3/profile/remove?profileId=${profileId}`, {
      method: 'GET',
      headers: getMultiloginHeaders(),
    });
  } catch (error) {
    console.error(`Error deleting profile:`, error.message);
  }
}

// Track a download triggered by the next user action.
// Must be called BEFORE the click that triggers the download so listeners
// are attached in time. Returns { wait } — call wait() after the click to
// resolve with { filename } on success or throw on failure.
//
// Failure modes detected:
//   - Download never starts within `startTimeout` (e.g. Freepik shows the
//     "upgrade to plan" modal instead of serving the file).
//   - Download starts but is canceled.
//   - Download starts but doesn't complete within `completeTimeout`.
//   - Download reports complete but no file ended up on disk.
function trackDownload(client, downloadDir, { startTimeout = 15000, completeTimeout = CONFIG.DOWNLOAD_TIMEOUT } = {}) {
  let downloadGuid = null;
  let suggestedFilename = null;
  let resolveStarted;
  let resolveFinished;
  let rejectFinished;

  const startedPromise = new Promise((r) => { resolveStarted = r; });
  const finishedPromise = new Promise((res, rej) => { resolveFinished = res; rejectFinished = rej; });

  const willBeginHandler = (event) => {
    downloadGuid = event.guid;
    suggestedFilename = event.suggestedFilename;
    console.log(`    → Download started: ${suggestedFilename}`);
    resolveStarted();
  };

  const progressHandler = (event) => {
    if (downloadGuid && event.guid !== downloadGuid) return;
    if (event.state === 'completed') {
      cleanup();
      resolveFinished({ filename: suggestedFilename });
    } else if (event.state === 'canceled') {
      cleanup();
      rejectFinished(new Error('Download canceled by browser (likely premium/paywall block)'));
    }
  };

  const cleanup = () => {
    client.off('Page.downloadWillBegin', willBeginHandler);
    client.off('Page.downloadProgress', progressHandler);
  };

  client.on('Page.downloadWillBegin', willBeginHandler);
  client.on('Page.downloadProgress', progressHandler);

  return {
    async wait() {
      try {
        // Phase 1: download must actually start. If it doesn't, the page
        // probably showed an upgrade prompt rather than serving a file.
        await Promise.race([
          startedPromise,
          new Promise((_, rej) => setTimeout(
            () => rej(new Error('Download never started — likely "upgrade to plan" modal')),
            startTimeout
          )),
        ]);

        // Phase 2: started download must complete.
        const result = await Promise.race([
          finishedPromise,
          new Promise((_, rej) => setTimeout(
            () => rej(new Error('Download started but did not complete in time')),
            completeTimeout
          )),
        ]);

        // Phase 3: belt-and-braces — verify the file actually landed on disk.
        if (result.filename) {
          const filePath = path.join(downloadDir, result.filename);
          try {
            const stat = await fs.stat(filePath);
            if (stat.size === 0) throw new Error('Downloaded file is empty');
          } catch (err) {
            throw new Error(`Download reported complete but file missing on disk: ${err.message}`);
          }
        }

        return result;
      } finally {
        cleanup();
      }
    },
  };
}

// Download images from a batch of URLs
async function downloadBatch(urls, proxy, batchIndex, totalBatches) {
  const timestamp = new Date().toISOString().split('T')[1].split('.')[0];
  console.log(`\n[${timestamp}] [Batch ${batchIndex + 1}/${totalBatches}] Processing ${urls.length} URLs with proxy: ${proxy.split(':')[0]}:${proxy.split(':')[1]}`);

  let profileId = null;
  let browser = null;

  try {
    // Create Multilogin quick profile with proxy (it auto-starts)
    console.log(`  🔧 Creating Multilogin profile...`);
    const profileData = await createQuickProfile(proxy);
    profileId = profileData.profileId;
    const port = profileData.port;
    console.log(`  ✓ Profile created and started: ${profileId} on port ${port}`);

    // Get the WebSocket endpoint from Chrome's DevTools discovery
    console.log(`  🔍 Fetching WebSocket endpoint...`);
    const debuggerUrl = `http://127.0.0.1:${port}/json/version`;
    const debuggerResponse = await fetch(debuggerUrl);
    const debuggerInfo = await debuggerResponse.json();
    const wsEndpoint = debuggerInfo.webSocketDebuggerUrl;

    console.log(`  🔗 Connecting to: ${wsEndpoint}`);

    browser = await puppeteer.connect({
      browserWSEndpoint: wsEndpoint,
      defaultViewport: null,
    });

    const page = await browser.newPage();
    page.setDefaultTimeout(CONFIG.PAGE_LOAD_TIMEOUT);

    // Set download behavior using CDP
    const client = await page.target().createCDPSession();
    await client.send('Page.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: path.resolve(CONFIG.IMAGES_DIR),
    });

    // Warmup request to initialize proxy authentication
    try {
      console.log(`  🔥 Warming up proxy connection...`);
      await page.goto('https://www.freepik.com', {
        waitUntil: 'domcontentloaded',
        timeout: 15000
      });
      console.log(`  ✓ Proxy warmed up`);
    } catch (e) {
      console.log(`  ⚠️  Warmup failed (continuing anyway): ${e.message}`);
    }

    // Give proxy time to fully authenticate
    await sleep(2000);

    let successCount = 0;
    let failCount = 0;

    // Process each URL in the batch
    for (let i = 0; i < urls.length; i++) {
      const url = urls[i];
      console.log(`\n  [${i + 1}/${urls.length}] Processing: ${url}`);

      try {
        // Step 1: Navigate to the page
        console.log(`    → Loading page...`);
        await page.goto(url, { waitUntil: 'networkidle2', timeout: CONFIG.PAGE_LOAD_TIMEOUT });
        console.log(`    ✓ Page loaded`);

        // Step 2: Wait for and click the download dropdown button
        console.log(`    → Waiting for download button...`);
        await page.waitForSelector('button[data-cy="dropdown-download-options"]', {
          visible: true,
          timeout: 10000
        });
        console.log(`    ✓ Download button found`);

        console.log(`    → Clicking download button...`);
        await page.click('button[data-cy="dropdown-download-options"]');
        console.log(`    ✓ Download dropdown opened`);

        // Small delay for dropdown to fully appear
        await sleep(500);

        // Step 3: Find all download size options and click the 2nd one
        console.log(`    → Looking for download size options...`);
        const downloadLinks = await page.$$('a[data-cy="download-size"]');

        if (downloadLinks.length < 2) {
          throw new Error(`Expected at least 2 download options, found ${downloadLinks.length}`);
        }

        console.log(`    ✓ Found ${downloadLinks.length} download options`);
        console.log(`    → Clicking 2nd download option...`);

        // Step 4: Attach download listeners BEFORE clicking, then click and wait
        // for an actual completed download. If Freepik shows an "upgrade to plan"
        // modal instead of serving the file, no download event fires and this
        // throws, leaving the URL out of successful_urls.txt for retry.
        const downloadDir = path.resolve(CONFIG.IMAGES_DIR);
        const tracker = trackDownload(client, downloadDir);
        await downloadLinks[1].click();
        console.log(`    ✓ Download click sent, waiting for completion...`);

        const downloadResult = await tracker.wait();
        console.log(`    ✅ Download verified: ${downloadResult.filename || '(file saved)'}`);

        // Mark as successful only after verified completion
        await saveSuccessfulUrl(url);
        successCount++;

        // Step 5: Random delay between 2-3 seconds before next download
        const randomDelay = 2000 + Math.random() * 1000; // 2-3 seconds
        console.log(`    ⏳ Waiting ${(randomDelay / 1000).toFixed(1)}s before next download...`);
        await sleep(randomDelay);

      } catch (error) {
        console.log(`    ❌ Failed: ${error.message}`);
        failCount++;

        // Small delay before continuing to next URL even on error
        await sleep(1000);
      }
    }

    console.log(`\n  📊 Batch complete: ${successCount} succeeded, ${failCount} failed`);

    // Delay after batch if configured
    if (CONFIG.BATCH_DELAY > 0) {
      console.log(`  ⏳ Waiting ${CONFIG.BATCH_DELAY}s before next batch...`);
      await sleep(CONFIG.BATCH_DELAY * 1000);
    }

    return { success: true, successCount, failCount };

  } catch (error) {
    console.log(`  ❌ Browser error: ${error.message}`);
    return { success: false, error: error.message };

  } finally {
    // Cleanup
    if (browser) {
      try {
        // Close all pages before disconnecting
        const pages = await browser.pages();
        for (const page of pages) {
          try {
            await page.close();
          } catch (e) {
            // Ignore errors when closing pages
          }
        }
        await browser.disconnect();
        console.log(`  🔒 Browser disconnected`);
      } catch (e) {
        console.error(`  ⚠️  Error disconnecting browser:`, e.message);
      }
    }

    if (profileId) {
      try {
        console.log(`  🛑 Stopping profile ${profileId}...`);
        await sleep(2000); // Longer delay to ensure browser closes
        await stopProfile(profileId);
        console.log(`  ✓ Profile stopped`);
      } catch (e) {
        console.error(`  ⚠️  Error stopping profile:`, e.message);
      }

      try {
        console.log(`  🗑️  Deleting profile ${profileId}...`);
        await sleep(1000);
        await deleteProfile(profileId);
        console.log(`  ✓ Profile deleted`);
      } catch (e) {
        console.error(`  ⚠️  Error deleting profile:`, e.message);
      }
    }
  }
}

// Worker function for parallel processing
async function worker(workerId, urlBatches, proxies, results) {
  console.log(`\n🚀 Worker ${workerId + 1} started`);

  while (urlBatches.length > 0) {
    const batch = urlBatches.shift();
    if (!batch) break;

    const batchIndex = results.processed;
    const proxy = proxies[Math.floor(Math.random() * proxies.length)];

    const result = await downloadBatch(batch.urls, proxy, batchIndex, results.total);

    results.processed++;
    if (result.success) {
      results.successful += result.successCount;
      results.failed += result.failCount;
    } else {
      results.failed += batch.urls.length;
    }

    // Show progress
    console.log(`\n📊 Overall Progress: ${results.processed}/${results.total} batches | ✅ ${results.successful} | ❌ ${results.failed}`);
  }

  console.log(`\n✋ Worker ${workerId + 1} finished`);
}

// Check if Multilogin is accessible
async function checkMultiloginConnection() {
  try {
    console.log(`🔍 Checking Multilogin connection on port ${CONFIG.MULTILOGIN_PORT}...`);

    // Just skip the check and proceed - we'll find out when we try to create a profile
    console.log(`✅ Skipping connection check, will verify when creating profile\n`);
    return true;
  } catch (error) {
    console.error(`❌ Cannot connect to Multilogin on port ${CONFIG.MULTILOGIN_PORT}`);
    console.error(`   Error: ${error.message}`);
    console.error(`\n   Please make sure:`);
    console.error(`   1. Multilogin application is running`);
    console.error(`   2. Cloud API is accessible at https://launcher.mlx.yt:${CONFIG.MULTILOGIN_PORT}`);
    console.error(`   3. API key is correct in .env file\n`);
    return false;
  }
}

// Main function
async function main() {
  console.log('\n╔════════════════════════════════════════╗');
  console.log('║   Browser-Based Image Downloader      ║');
  console.log('╚════════════════════════════════════════╝\n');

  console.log('⚙️  Configuration:');
  console.log(`   • Threads: ${CONFIG.THREADS}`);
  console.log(`   • Batch size: ${CONFIG.BATCH_SIZE} URLs per browser`);
  console.log(`   • Batch delay: ${CONFIG.BATCH_DELAY}s`);
  console.log(`   • Images directory: ${CONFIG.IMAGES_DIR}`);
  console.log(`   • Multilogin port: ${CONFIG.MULTILOGIN_PORT}\n`);

  // Check Multilogin connection
  const isConnected = await checkMultiloginConnection();
  if (!isConnected) {
    console.error('Exiting due to Multilogin connection error.');
    process.exit(1);
  }

  // Create images directory
  try {
    await fs.access(CONFIG.IMAGES_DIR);
    console.log(`📁 Images directory exists: ${CONFIG.IMAGES_DIR}`);
  } catch {
    console.log(`📁 Creating images directory: ${CONFIG.IMAGES_DIR}`);
    await fs.mkdir(CONFIG.IMAGES_DIR, { recursive: true });
  }

  // Load URLs and proxies
  console.log('\n📂 Loading files...');
  const [allUrls, successfulUrls, proxiesContent] = await Promise.all([
    loadUrls(CONFIG.URLS_FILE),
    loadSuccessfulUrls(),
    fs.readFile('proxies.txt', 'utf-8').catch(() => ''),
  ]);

  const proxies = proxiesContent.split('\n').map(line => line.trim()).filter(Boolean);

  if (proxies.length === 0) {
    console.error('❌ No proxies found in proxies.txt!');
    return;
  }

  console.log(`✓ Loaded ${allUrls.length} URLs, ${proxies.length} proxies`);
  console.log(`✓ Found ${successfulUrls.size} already processed URLs\n`);

  // Filter out already processed URLs
  const urls = allUrls.filter(url => !successfulUrls.has(url));

  if (urls.length === 0) {
    console.log('🎉 All URLs have been processed!');
    return;
  }

  console.log(`📋 URLs to process: ${urls.length} (${allUrls.length - urls.length} skipped)\n`);

  // Split URLs into batches
  const batches = [];
  for (let i = 0; i < urls.length; i += CONFIG.BATCH_SIZE) {
    batches.push({
      urls: urls.slice(i, i + CONFIG.BATCH_SIZE),
      index: batches.length,
    });
  }

  console.log(`📦 Created ${batches.length} batches of up to ${CONFIG.BATCH_SIZE} URLs each\n`);

  // Start processing
  console.log('='.repeat(60));
  console.log('🚀 Starting processing...');
  console.log('='.repeat(60));

  const startTime = Date.now();
  const results = {
    total: batches.length,
    processed: 0,
    successful: 0,
    failed: 0,
  };

  // Create workers
  const workers = [];
  for (let i = 0; i < CONFIG.THREADS; i++) {
    workers.push(worker(i, [...batches], proxies, results));
  }

  await Promise.all(workers);

  const duration = ((Date.now() - startTime) / 1000).toFixed(2);

  // Print summary
  console.log('\n' + '='.repeat(60));
  console.log('📋 FINAL SUMMARY');
  console.log('='.repeat(60));
  console.log(`📦 Total batches: ${results.total}`);
  console.log(`✅ Successful downloads: ${results.successful}`);
  console.log(`❌ Failed downloads: ${results.failed}`);
  console.log(`⏱️  Total duration: ${duration}s`);
  console.log(`📁 Images saved to: ${CONFIG.IMAGES_DIR}/`);
  console.log('='.repeat(60) + '\n');
}

// Run
main().catch(console.error);
