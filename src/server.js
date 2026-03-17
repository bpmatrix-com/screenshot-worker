const express = require('express');
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');

const app = express();
const PORT = process.env.PORT || 3000;
const FILE_ROOT = path.join(__dirname, '..', 'files');

app.use(express.json({ limit: '5mb' }));
app.use('/files', express.static(FILE_ROOT));

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function safeSlug(input) {
  return (input || 'site')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'site';
}

function normalizeUrl(raw) {
  if (!raw) return '';
  const trimmed = String(raw).trim();
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

function sameHost(urlA, urlB) {
  try {
    return new URL(urlA).hostname === new URL(urlB).hostname;
  } catch (e) {
    return false;
  }
}

function shouldSkipLink(href) {
  if (!href) return true;
  const lowered = href.toLowerCase();
  return (
    lowered.startsWith('mailto:') ||
    lowered.startsWith('tel:') ||
    lowered.startsWith('javascript:') ||
    lowered.startsWith('#')
  );
}

async function randomPause(page, min = 500, max = 1400) {
  const ms = Math.floor(Math.random() * (max - min + 1)) + min;
  await page.waitForTimeout(ms);
}

async function humanLikeScroll(page, extraWait = 4000) {
  await page.evaluate(async (extraWaitInner) => {
    await new Promise((resolve) => {
      let totalHeight = 0;
      const distance = 350;
      const timer = setInterval(() => {
        window.scrollBy(0, distance);
        totalHeight += distance;
        const maxHeight = Math.max(
          document.body.scrollHeight,
          document.documentElement.scrollHeight
        );
        if (totalHeight >= maxHeight) {
          clearInterval(timer);
          setTimeout(resolve, extraWaitInner);
        }
      }, 300);
    });
  }, extraWait);
}

async function detectChallenge(page) {
  try {
    const text = await page.evaluate(() => document.body ? document.body.innerText.slice(0, 5000) : '');
    const html = await page.content();
    const combined = `${text}\n${html}`.toLowerCase();

    const patterns = [
      'checking your browser',
      'verify you are human',
      'cf-challenge',
      'cloudflare',
      'attention required',
      'captcha',
      'turnstile'
    ];

    return patterns.some(p => combined.includes(p));
  } catch (e) {
    return false;
  }
}

async function waitForPotentialChallenge(page, timeoutMs = 45000) {
  const start = Date.now();
  let detected = await detectChallenge(page);

  while (detected && (Date.now() - start) < timeoutMs) {
    await page.waitForTimeout(3000);
    detected = await detectChallenge(page);
  }

  return !detected;
}

async function buildContext(browser, viewport) {
  const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

  return browser.newContext({
    viewport,
    userAgent,
    locale: 'en-US',
    timezoneId: 'America/New_York',
    extraHTTPHeaders: {
      'Accept-Language': 'en-US,en;q=0.9'
    }
  });
}

async function navigateAndPrepare(page, url, waitMs, postScrollWaitMs) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 180000 });
  await randomPause(page, 1000, 2500);

  const cleared = await waitForPotentialChallenge(page, 45000);
  if (!cleared) {
    throw new Error('Challenge page did not clear in time');
  }

  if (waitMs > 0) await page.waitForTimeout(waitMs);
  await humanLikeScroll(page, postScrollWaitMs);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(1200);
}

async function discoverPages(baseUrl, maxPages, crawlDepth, waitMs, postScrollWaitMs) {
  const browser = await chromium.launch({ headless: true });
  const discovered = [];
  const visited = new Set();
  const queue = [{ url: baseUrl, depth: 0 }];

  try {
    while (queue.length && discovered.length < maxPages) {
      const current = queue.shift();
      if (!current || visited.has(current.url)) continue;
      visited.add(current.url);

      const context = await buildContext(browser, { width: 1440, height: 900 });
      const page = await context.newPage();

      try {
        await navigateAndPrepare(page, current.url, Math.min(waitMs, 10000), Math.min(postScrollWaitMs, 2000));
        discovered.push(current.url);

        if (current.depth < crawlDepth) {
          const links = await page.evaluate(() => {
            return Array.from(document.querySelectorAll('a[href]'))
              .map(a => a.href)
              .filter(Boolean);
          });

          for (const link of links) {
            if (shouldSkipLink(link)) continue;
            if (!sameHost(baseUrl, link)) continue;
            const cleaned = link.split('#')[0];
            if (!visited.has(cleaned) && !queue.find(q => q.url === cleaned) && discovered.length + queue.length < maxPages * 2) {
              queue.push({ url: cleaned, depth: current.depth + 1 });
            }
          }
        }
      } catch (e) {
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }

  return discovered;
}

function pageFileBase(siteUrl, pageUrl) {
  try {
    const host = safeSlug(new URL(siteUrl).hostname);
    const u = new URL(pageUrl);
    const pathSlug = safeSlug(u.pathname === '/' ? 'home' : u.pathname);
    return `${host}-${pathSlug}`;
  } catch (e) {
    return safeSlug(pageUrl);
  }
}

async function captureAllPages(siteUrl, pageUrls, waitMs, postScrollWaitMs, jobDir) {
  const browser = await chromium.launch({ headless: true });
  const views = [
    { label: 'desktop', width: 1920, height: 1080 },
    { label: 'tablet', width: 1024, height: 1366 },
    { label: 'mobile', width: 430, height: 932 }
  ];

  const allFiles = [];

  try {
    for (const pageUrl of pageUrls) {
      const fileBase = pageFileBase(siteUrl, pageUrl);

      for (const view of views) {
        const context = await buildContext(browser, { width: view.width, height: view.height });
        const page = await context.newPage();

        try {
          await navigateAndPrepare(page, pageUrl, waitMs, postScrollWaitMs);

          const fileName = `${fileBase}-${view.label}.png`;
          const filePath = path.join(jobDir, fileName);
          await page.screenshot({ path: filePath, fullPage: true });

          allFiles.push({
            page: pageUrl,
            label: view.label,
            fileName
          });
        } catch (e) {
          allFiles.push({
            page: pageUrl,
            label: view.label,
            error: e.message
          });
        } finally {
          await context.close();
        }
      }
    }
  } finally {
    await browser.close();
  }

  return allFiles;
}

async function runFullSiteJob(inputUrl, options = {}) {
  const siteUrl = normalizeUrl(inputUrl);
  const waitMs = Number.isFinite(Number(options.waitMs)) ? Number(options.waitMs) : 60000;
  const postScrollWaitMs = Number.isFinite(Number(options.postScrollWaitMs)) ? Number(options.postScrollWaitMs) : 4000;
  const maxPages = Number.isFinite(Number(options.maxPages)) ? Number(options.maxPages) : 25;
  const crawlDepth = Number.isFinite(Number(options.crawlDepth)) ? Number(options.crawlDepth) : 2;

  const jobId = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  const jobDir = path.join(FILE_ROOT, jobId);
  ensureDir(jobDir);

  const discoveredPages = await discoverPages(siteUrl, maxPages, crawlDepth, waitMs, postScrollWaitMs);
  const pageList = discoveredPages.length ? discoveredPages : [siteUrl];

  const files = await captureAllPages(siteUrl, pageList, waitMs, postScrollWaitMs, jobDir);

  const okFiles = files.filter(f => f.fileName);
  const zip = new AdmZip();
  okFiles.forEach(f => zip.addLocalFile(path.join(jobDir, f.fileName)));

  const hostBase = safeSlug(new URL(siteUrl).hostname);
  const zipName = `${hostBase}-full-site-crawl.zip`;
  const zipPath = path.join(jobDir, zipName);
  zip.writeZip(zipPath);

  return {
    jobId,
    site: siteUrl,
    message: `Crawl complete. ${pageList.length} pages discovered.`,
    pagesDiscovered: pageList,
    screenshots: okFiles.map(f => ({
      page: f.page,
      label: f.label,
      url: `/files/${jobId}/${f.fileName}`
    })),
    failures: files.filter(f => f.error),
    zip: `/files/${jobId}/${zipName}`
  };
}

app.get('/', (_req, res) => {
  res.status(200).json({ status: 'ok', message: 'Screenshot worker running' });
});

app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});

async function crawlHandler(req, res) {
  try {
    const url = req.body && req.body.url ? String(req.body.url).trim() : '';
    if (!url) return res.status(400).json({ message: 'Missing url' });

    const result = await runFullSiteJob(url, {
      waitMs: req.body?.waitMs,
      postScrollWaitMs: req.body?.postScrollWaitMs,
      maxPages: req.body?.maxPages,
      crawlDepth: req.body?.crawlDepth
    });

    const base = `${req.protocol}://${req.get('host')}`;
    result.zip = base + result.zip;
    result.screenshots = result.screenshots.map(s => ({ ...s, url: base + s.url }));

    res.status(200).json(result);
  } catch (err) {
    res.status(500).json({ message: err.message || 'Worker error' });
  }
}

app.post('/capture', crawlHandler);
app.post('/api/crawl', crawlHandler);
app.post('/crawl', crawlHandler);

ensureDir(FILE_ROOT);
app.listen(PORT, () => {
  console.log(`Screenshot worker running on port ${PORT}`);
});
