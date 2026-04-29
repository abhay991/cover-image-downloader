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
  PROFILE_ROTATION_DELAY: parseInt(process.env.PROFILE_ROTATION_DELAY || '5'), // Seconds to wait after closing one profile before opening the next
  MAX_URLS_PER_PROFILE: parseInt(process.env.MAX_URLS_PER_PROFILE || '0'), // Force-rotate after N successful downloads (0 = no cap)

  // Multilogin configuration
  MULTILOGIN_API_KEY: process.env.MULTILOGIN_API_KEY || '', // Your Multilogin API key from .env
  MULTILOGIN_PORT: parseInt(process.env.MULTILOGIN_PORT || '35000'), // Multilogin local API port
  PROFILE_FOLDER_ID: '', // Your Multilogin folder ID (optional)

  // Proxy source: 'file' loads from proxies.txt, 'multilogin' generates per profile via Multilogin's proxy API
  PROXY_SOURCE: (process.env.PROXY_SOURCE || 'file').toLowerCase(),
  MULTILOGIN_PROXY_COUNTRY: process.env.MULTILOGIN_PROXY_COUNTRY || 'us',
  MULTILOGIN_PROXY_REGION: process.env.MULTILOGIN_PROXY_REGION || '',
  MULTILOGIN_PROXY_CITY: process.env.MULTILOGIN_PROXY_CITY || '',
  MULTILOGIN_PROXY_PROTOCOL: process.env.MULTILOGIN_PROXY_PROTOCOL || 'http',
  MULTILOGIN_PROXY_SESSION_TYPE: process.env.MULTILOGIN_PROXY_SESSION_TYPE || 'sticky',
  MULTILOGIN_PROXY_IPTTL: parseInt(process.env.MULTILOGIN_PROXY_IPTTL || '0'),
  MULTILOGIN_PROXY_MASKING: process.env.MULTILOGIN_PROXY_MASKING || 'custom', // 'custom' or 'built_in' — try 'built_in' if profile API rejects generated proxies

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

// Parse a proxy entry. Supports:
//   host:port:username:password           (legacy, http with auth)
//   host:port                             (http, no auth)
//   scheme://host:port                    (scheme = http|https|socks4|socks5)
//   scheme://username:password@host:port
const PROXY_SCHEMES = ['http', 'https', 'socks4', 'socks5'];

function parseProxy(raw) {
  const trimmed = raw.trim();

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    let u;
    try {
      u = new URL(trimmed);
    } catch (e) {
      throw new Error(`Invalid proxy URL: ${trimmed} (${e.message})`);
    }
    const type = u.protocol.replace(':', '').toLowerCase();
    if (!PROXY_SCHEMES.includes(type)) {
      throw new Error(`Unsupported proxy scheme "${type}" in: ${trimmed}`);
    }
    if (!u.hostname || !u.port) {
      throw new Error(`Proxy URL missing host or port: ${trimmed}`);
    }
    return {
      type,
      host: u.hostname,
      port: parseInt(u.port),
      username: decodeURIComponent(u.username || ''),
      password: decodeURIComponent(u.password || ''),
    };
  }

  const parts = trimmed.split(':');
  if (parts.length === 2) {
    const [host, port] = parts;
    return { type: 'http', host: host.trim(), port: parseInt(port), username: '', password: '' };
  }
  if (parts.length === 4) {
    const [host, port, username, password] = parts;
    return {
      type: 'http',
      host: host.trim(),
      port: parseInt(port),
      username: username.trim(),
      password: password.trim(),
    };
  }
  throw new Error(`Invalid proxy format. Expected scheme://host:port, scheme://user:pass@host:port, host:port, or host:port:user:pass — got: ${trimmed}`);
}

function describeProxy(proxy) {
  const { type, host, port, username } = parseProxy(proxy);
  const userPart = username ? ` (user: ${username.substring(0, 3)}***)` : '';
  return `${type}://${host}:${port}${userPart}`;
}

// Pull a proxy URL out of Multilogin's response, which may use one of several
// shapes. Returns null if nothing matched so the caller can log the raw body.
function extractGeneratedProxyUrl(result) {
  if (!result) return null;
  if (typeof result === 'string') return result;
  if (typeof result.connection_url === 'string') return result.connection_url;
  if (Array.isArray(result.connection_urls) && result.connection_urls.length) {
    return result.connection_urls[0];
  }
  if (Array.isArray(result.proxies) && result.proxies.length) {
    const p = result.proxies[0];
    return typeof p === 'string' ? p : (p && (p.connection_url || p.url)) || null;
  }
  if (result.data) {
    return extractGeneratedProxyUrl(result.data);
  }
  if (Array.isArray(result) && result.length) {
    return extractGeneratedProxyUrl(result[0]);
  }
  return null;
}

// Generate a fresh proxy via Multilogin's proxy service.
// Endpoint: POST https://profile-proxy.multilogin.com/v1/proxy/connection_url
async function generateMultiloginProxy() {
  const body = {
    country: CONFIG.MULTILOGIN_PROXY_COUNTRY,
    sessionType: CONFIG.MULTILOGIN_PROXY_SESSION_TYPE,
    protocol: CONFIG.MULTILOGIN_PROXY_PROTOCOL,
    IPTTL: CONFIG.MULTILOGIN_PROXY_IPTTL,
    count: 1,
  };
  if (CONFIG.MULTILOGIN_PROXY_REGION) body.region = CONFIG.MULTILOGIN_PROXY_REGION;
  if (CONFIG.MULTILOGIN_PROXY_CITY) body.city = CONFIG.MULTILOGIN_PROXY_CITY;

  const response = await fetch('https://profile-proxy.multilogin.com/v1/proxy/connection_url', {
    method: 'POST',
    headers: getMultiloginHeaders(),
    body: JSON.stringify(body),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Multilogin proxy generation failed (${response.status}): ${text}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`Multilogin proxy response was not JSON: ${text}`);
  }

  const url = extractGeneratedProxyUrl(parsed);
  if (!url) {
    throw new Error(`Could not extract proxy URL from Multilogin response: ${text}`);
  }
  const masked = url.replace(/\/\/[^@]+@/, '//***:***@');
  console.log(`  🌐 Generated proxy: ${masked}`);
  return url;
}

// Create Multilogin quick profile with proxy
async function createQuickProfile(proxy) {
  const { type, host, port, username, password } = parseProxy(proxy);

  const userDisplay = username ? ` (user: ${username.substring(0, 3)}***)` : '';
  console.log(`  → Proxy: ${type}://${host}:${port}${userDisplay}`);

  const profileData = {
    browser_type: 'mimic',
    os_type: 'macos',
    automation: 'puppeteer',
    parameters: {
      flags: {
        proxy_masking: CONFIG.PROXY_SOURCE === 'multilogin' ? CONFIG.MULTILOGIN_PROXY_MASKING : 'custom'
      },
      proxy: {
        type,
        host,
        port,
        username,
        password
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

// Snapshot non-hidden files in a directory.
async function snapshotDir(dir) {
  try {
    const entries = await fs.readdir(dir);
    return new Set(entries.filter((f) => !f.startsWith('.')));
  } catch {
    return new Set();
  }
}

// Track a download by watching the download directory on disk. CDP download
// events (Page.downloadWillBegin / Browser.downloadWillBegin) don't fire
// reliably across all Chromium builds — particularly the Mimic browser used
// by Multilogin — so we trust the filesystem instead. Must be created BEFORE
// the click that triggers the download so the "before" snapshot is accurate.
//
// Failure modes detected:
//   - No new file appears within `startTimeout` (e.g. Freepik showed the
//     "upgrade to plan" modal instead of serving the file).
//   - A new file appeared but never reached a stable, non-temp state within
//     `completeTimeout` (download hung or aborted mid-way).
async function trackDiskDownload(downloadDir, {
  startTimeout = 20000,
  completeTimeout = CONFIG.DOWNLOAD_TIMEOUT,
  stableMs = 1500,
  pollMs = 400,
} = {}) {
  const before = await snapshotDir(downloadDir);
  const isTemp = (f) => /\.(crdownload|part|tmp)$/i.test(f);

  const newEntries = async () => {
    const now = await snapshotDir(downloadDir);
    return [...now].filter((f) => !before.has(f));
  };

  return {
    async wait() {
      const startDeadline = Date.now() + startTimeout;
      const completeDeadline = Date.now() + completeTimeout;
      let activityLogged = false;

      while (Date.now() < completeDeadline) {
        const seen = await newEntries();

        if (seen.length === 0) {
          if (Date.now() >= startDeadline) {
            throw new Error('Download never started — likely "upgrade to plan" modal');
          }
          await sleep(pollMs);
          continue;
        }

        if (!activityLogged) {
          activityLogged = true;
          console.log(`    → Disk activity detected: ${seen.join(', ')}`);
        }

        const finals = seen.filter((f) => !isTemp(f));
        if (finals.length === 0) {
          // Only temp files so far — still downloading.
          await sleep(pollMs);
          continue;
        }

        // Pick the most recently modified final file as our candidate.
        const stats = await Promise.all(finals.map(async (f) => {
          const s = await fs.stat(path.join(downloadDir, f));
          return { name: f, size: s.size, mtime: s.mtimeMs };
        }));
        stats.sort((a, b) => b.mtime - a.mtime);
        const pick = stats[0];

        if (pick.size === 0) {
          await sleep(pollMs);
          continue;
        }

        // Stability check: wait stableMs, then verify size is unchanged AND
        // no temp file is still in flight before declaring success.
        await sleep(stableMs);
        const stillInProgress = (await newEntries()).some(isTemp);
        if (stillInProgress) continue;

        try {
          const after = await fs.stat(path.join(downloadDir, pick.name));
          if (after.size === pick.size && after.size > 0) {
            return { filename: pick.name, size: after.size };
          }
        } catch {
          // File renamed or moved between checks — keep polling.
        }
      }

      if (!activityLogged) {
        throw new Error('Download never started — likely "upgrade to plan" modal');
      }
      throw new Error('Download started but did not complete in time');
    },
  };
}

// Spin up one Multilogin profile and pull URLs from the shared queue until
// the profile gets paywalled (or the queue empties). On failure, the URL
// that triggered it is dropped for this run — it stays out of
// successful_urls.txt and will be retried the next time the script runs.
async function downloadWithProfile(urlQueue, proxy, profileLabel, results) {
  const timestamp = new Date().toISOString().split('T')[1].split('.')[0];
  console.log(`\n[${timestamp}] [Profile ${profileLabel}] Spinning up with proxy: ${describeProxy(proxy)} | ${urlQueue.length} URLs in queue`);

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

    let profileSuccess = 0;

    while (urlQueue.length > 0) {
      const url = urlQueue.shift();
      if (!url) break;

      console.log(`\n  [Profile ${profileLabel}] [${urlQueue.length} left in queue] Processing: ${url}`);

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

        // Step 4: Snapshot the download dir BEFORE clicking, then click and
        // watch the filesystem for the new file to appear and stabilize. If
        // Freepik shows an "upgrade to plan" modal instead of serving the
        // file, no new file appears and this throws, leaving the URL out of
        // successful_urls.txt so it gets retried on the next run.
        const downloadDir = path.resolve(CONFIG.IMAGES_DIR);
        const tracker = await trackDiskDownload(downloadDir);
        await downloadLinks[1].click();
        console.log(`    ✓ Download click sent, watching ${CONFIG.IMAGES_DIR}/ for new file...`);

        const downloadResult = await tracker.wait();
        console.log(`    ✅ Download verified: ${downloadResult.filename} (${(downloadResult.size / 1024).toFixed(1)} KB)`);

        // Mark as successful only after verified completion
        await saveSuccessfulUrl(url);
        profileSuccess++;
        results.successful++;

        if (CONFIG.MAX_URLS_PER_PROFILE > 0 && profileSuccess >= CONFIG.MAX_URLS_PER_PROFILE) {
          console.log(`    🔁 Hit MAX_URLS_PER_PROFILE (${CONFIG.MAX_URLS_PER_PROFILE}) — rotating proactively`);
          break;
        }

        // Random delay between 2-3 seconds before next download
        const randomDelay = 2000 + Math.random() * 1000;
        console.log(`    ⏳ Waiting ${(randomDelay / 1000).toFixed(1)}s before next download...`);
        await sleep(randomDelay);

      } catch (error) {
        console.log(`    ❌ Failed: ${error.message}`);
        results.failed++;
        console.log(`    🔄 Profile paywalled — closing and rotating proxy. URL will be retried on next script run.`);
        break;
      }
    }

    console.log(`\n  📊 Profile ${profileLabel} ended: ${profileSuccess} download(s) before rotation`);
    return { profileSuccess };

  } catch (error) {
    console.log(`  ❌ Profile error: ${error.message}`);
    return { profileSuccess: 0, error: error.message };

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

// Worker function for parallel processing. Each worker repeatedly spins up
// a profile, drains as much of the shared queue as that profile can handle
// before getting paywalled, then rotates to a fresh profile/proxy.
async function worker(workerId, urlQueue, proxies, results) {
  console.log(`\n🚀 Worker ${workerId + 1} started`);
  let profileNum = 0;

  while (urlQueue.length > 0) {
    profileNum++;
    const profileLabel = `${workerId + 1}.${profileNum}`;

    let proxy;
    if (CONFIG.PROXY_SOURCE === 'multilogin') {
      try {
        proxy = await generateMultiloginProxy();
      } catch (e) {
        console.error(`❌ [Profile ${profileLabel}] Failed to generate Multilogin proxy: ${e.message}`);
        console.error(`  → Skipping this profile spin-up; will retry on next iteration.`);
        await sleep(5000);
        continue;
      }
    } else {
      proxy = proxies[Math.floor(Math.random() * proxies.length)];
    }

    await downloadWithProfile(urlQueue, proxy, profileLabel, results);

    const done = results.successful + results.failed;
    console.log(`\n📊 Overall Progress: ${done}/${results.total} | ✅ ${results.successful} | ❌ ${results.failed} | 📋 ${urlQueue.length} left in queue`);

    if (CONFIG.PROFILE_ROTATION_DELAY > 0 && urlQueue.length > 0) {
      console.log(`  ⏳ Waiting ${CONFIG.PROFILE_ROTATION_DELAY}s before next profile...`);
      await sleep(CONFIG.PROFILE_ROTATION_DELAY * 1000);
    }
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
  console.log(`   • Profile rotation delay: ${CONFIG.PROFILE_ROTATION_DELAY}s`);
  console.log(`   • Max URLs per profile: ${CONFIG.MAX_URLS_PER_PROFILE || 'unlimited'}`);
  console.log(`   • Images directory: ${CONFIG.IMAGES_DIR}`);
  console.log(`   • Multilogin port: ${CONFIG.MULTILOGIN_PORT}`);
  console.log(`   • Proxy source: ${CONFIG.PROXY_SOURCE}${CONFIG.PROXY_SOURCE === 'multilogin' ? ` (${CONFIG.MULTILOGIN_PROXY_PROTOCOL}, ${CONFIG.MULTILOGIN_PROXY_COUNTRY}${CONFIG.MULTILOGIN_PROXY_REGION ? '/' + CONFIG.MULTILOGIN_PROXY_REGION : ''}${CONFIG.MULTILOGIN_PROXY_CITY ? '/' + CONFIG.MULTILOGIN_PROXY_CITY : ''}, ${CONFIG.MULTILOGIN_PROXY_SESSION_TYPE})` : ''}\n`);

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

  // Load URLs (and proxies, if using file mode)
  console.log('\n📂 Loading files...');
  const [allUrls, successfulUrls, proxiesContent] = await Promise.all([
    loadUrls(CONFIG.URLS_FILE),
    loadSuccessfulUrls(),
    CONFIG.PROXY_SOURCE === 'file'
      ? fs.readFile('proxies.txt', 'utf-8').catch(() => '')
      : Promise.resolve(''),
  ]);

  let proxies = [];
  if (CONFIG.PROXY_SOURCE === 'file') {
    proxies = proxiesContent.split('\n').map(line => line.trim()).filter(Boolean);
    if (proxies.length === 0) {
      console.error('❌ No proxies found in proxies.txt!');
      return;
    }
    console.log(`✓ Loaded ${allUrls.length} URLs, ${proxies.length} proxies`);
  } else {
    console.log(`✓ Loaded ${allUrls.length} URLs (proxies generated on-demand via Multilogin)`);
  }
  console.log(`✓ Found ${successfulUrls.size} already processed URLs\n`);

  // Filter out already processed URLs
  const urls = allUrls.filter(url => !successfulUrls.has(url));

  if (urls.length === 0) {
    console.log('🎉 All URLs have been processed!');
    return;
  }

  console.log(`📋 URLs to process: ${urls.length} (${allUrls.length - urls.length} skipped)\n`);

  // Build a single shared queue. Workers pull URLs one at a time, keeping
  // their profile alive until it gets paywalled, then rotating to a new one.
  const urlQueue = [...urls];

  console.log(`📦 Queue ready: ${urlQueue.length} URLs to process\n`);

  // Start processing
  console.log('='.repeat(60));
  console.log('🚀 Starting processing...');
  console.log('='.repeat(60));

  const startTime = Date.now();
  const results = {
    total: urlQueue.length,
    successful: 0,
    failed: 0,
  };

  // Create workers — they all share the same urlQueue.
  const workers = [];
  for (let i = 0; i < CONFIG.THREADS; i++) {
    workers.push(worker(i, urlQueue, proxies, results));
  }

  await Promise.all(workers);

  const duration = ((Date.now() - startTime) / 1000).toFixed(2);

  // Print summary
  console.log('\n' + '='.repeat(60));
  console.log('📋 FINAL SUMMARY');
  console.log('='.repeat(60));
  console.log(`📋 Total URLs: ${results.total}`);
  console.log(`✅ Successful downloads: ${results.successful}`);
  console.log(`❌ Failed downloads: ${results.failed}`);
  console.log(`⏱️  Total duration: ${duration}s`);
  console.log(`📁 Images saved to: ${CONFIG.IMAGES_DIR}/`);
  console.log('='.repeat(60) + '\n');
}

// Run
main().catch(console.error);
