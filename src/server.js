const express = require('express');
const cors = require('cors');
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');

const app = express();
const PORT = process.env.PORT || 3000;
const FILE_ROOT = path.join(__dirname, '..', 'files');

app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use('/files', express.static(FILE_ROOT));

function ensureDir(dir){ fs.mkdirSync(dir, { recursive: true }); }
function safeSlug(input){
  return (input || 'site').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'site';
}
function normalizeUrl(raw){
  if (!raw) return '';
  const trimmed = String(raw).trim();
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}
function sameHost(urlA, urlB){
  try { return new URL(urlA).hostname === new URL(urlB).hostname; } catch(e){ return false; }
}
function shouldSkipLink(href){
  if (!href) return true;
  const lowered = href.toLowerCase();
  return lowered.startsWith('mailto:') || lowered.startsWith('tel:') || lowered.startsWith('javascript:') || lowered.startsWith('#');
}
async function detectChallenge(page){
  try {
    const text = await page.evaluate(() => document.body ? document.body.innerText.slice(0, 5000) : '');
    const html = await page.content();
    const combined = `${text}\n${html}`.toLowerCase();
    return ['checking your browser','verify you are human','cf-challenge','cloudflare','attention required','captcha','turnstile']
      .some(p => combined.includes(p));
  } catch(e){ return false; }
}
async function waitForPotentialChallenge(page, timeoutMs = 45000){
  const start = Date.now();
  let challenge = await detectChallenge(page);
  while (challenge && (Date.now() - start) < timeoutMs) {
    await page.waitForTimeout(3000);
    challenge = await detectChallenge(page);
  }
  return !challenge;
}
async function humanLikeScroll(page, extraWait = 4000){
  await page.evaluate(async (extraWaitInner) => {
    await new Promise((resolve) => {
      let totalHeight = 0;
      const distance = 350;
      const timer = setInterval(() => {
        window.scrollBy(0, distance);
        totalHeight += distance;
        const maxHeight = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
        if (totalHeight >= maxHeight) {
          clearInterval(timer);
          setTimeout(resolve, extraWaitInner);
        }
      }, 300);
    });
  }, extraWait);
}
async function buildContext(browser, viewport){
  return browser.newContext({
    viewport,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale: 'en-US',
    timezoneId: 'America/New_York',
    extraHTTPHeaders: {'Accept-Language': 'en-US,en;q=0.9'}
  });
}
async function navigateAndPrepare(page, url, waitMs, postScrollWaitMs){
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 180000 });
  const ok = await waitForPotentialChallenge(page, 45000);
  if (!ok) throw new Error('Challenge page did not clear in time');
  if (waitMs > 0) await page.waitForTimeout(waitMs);
  await humanLikeScroll(page, postScrollWaitMs);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(1000);
}
async function discoverPages(baseUrl, maxPages, crawlDepth){
  const browser = await chromium.launch({ headless: true });
  const found = [];
  const visited = new Set();
  const queue = [{url: baseUrl, depth: 0}];
  try {
    while (queue.length && found.length < maxPages) {
      const current = queue.shift();
      if (!current || visited.has(current.url)) continue;
      visited.add(current.url);

      const context = await buildContext(browser, { width: 1400, height: 900 });
      const page = await context.newPage();
      try {
        await page.goto(current.url, { waitUntil: 'domcontentloaded', timeout: 180000 });
        const ok = await waitForPotentialChallenge(page, 15000);
        if (!ok) throw new Error('Challenge on discovery');
        found.push(current.url);

        if (current.depth < crawlDepth) {
          const links = await page.evaluate(() => Array.from(document.querySelectorAll('a[href]')).map(a => a.href).filter(Boolean));
          for (const link of links) {
            if (shouldSkipLink(link)) continue;
            if (!sameHost(baseUrl, link)) continue;
            const clean = link.split('#')[0];
            if (!visited.has(clean) && !queue.find(q => q.url === clean)) queue.push({url: clean, depth: current.depth + 1});
          }
        }
      } catch(e) {
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
  return found;
}
function pageFileBase(siteUrl, pageUrl){
  try {
    const host = safeSlug(new URL(siteUrl).hostname);
    const u = new URL(pageUrl);
    const slug = safeSlug(u.pathname === '/' ? 'home' : u.pathname);
    return `${host}-${slug}`;
  } catch(e){
    return safeSlug(pageUrl);
  }
}
async function captureAll(siteUrl, pages, waitMs, postScrollWaitMs, jobDir){
  const browser = await chromium.launch({ headless: true });
  const views = [
    { label: 'desktop', width: 1920, height: 1080 },
    { label: 'tablet', width: 1024, height: 1366 },
    { label: 'mobile', width: 430, height: 932 }
  ];
  const outputs = [];
  try {
    for (const pageUrl of pages) {
      const base = pageFileBase(siteUrl, pageUrl);
      for (const view of views) {
        const context = await buildContext(browser, { width: view.width, height: view.height });
        const page = await context.newPage();
        try {
          await navigateAndPrepare(page, pageUrl, waitMs, postScrollWaitMs);
          const fileName = `${base}-${view.label}.png`;
          const filePath = path.join(jobDir, fileName);
          await page.screenshot({ path: filePath, fullPage: true });
          outputs.push({ page: pageUrl, label: view.label, fileName });
        } catch(e) {
          outputs.push({ page: pageUrl, label: view.label, error: e.message });
        } finally {
          await context.close();
        }
      }
    }
  } finally {
    await browser.close();
  }
  return outputs;
}
async function runJob(inputUrl, opts = {}){
  const siteUrl = normalizeUrl(inputUrl);
  const waitMs = Number.isFinite(Number(opts.waitMs)) ? Number(opts.waitMs) : 60000;
  const postScrollWaitMs = Number.isFinite(Number(opts.postScrollWaitMs)) ? Number(opts.postScrollWaitMs) : 4000;
  const maxPages = Number.isFinite(Number(opts.maxPages)) ? Number(opts.maxPages) : 25;
  const crawlDepth = Number.isFinite(Number(opts.crawlDepth)) ? Number(opts.crawlDepth) : 2;

  const jobId = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2,8);
  const jobDir = path.join(FILE_ROOT, jobId);
  ensureDir(jobDir);

  const pages = await discoverPages(siteUrl, maxPages, crawlDepth);
  const pageList = pages.length ? pages : [siteUrl];
  const outputs = await captureAll(siteUrl, pageList, waitMs, postScrollWaitMs, jobDir);

  const zip = new AdmZip();
  outputs.filter(o => o.fileName).forEach(o => zip.addLocalFile(path.join(jobDir, o.fileName)));
  const zipName = `${safeSlug(new URL(siteUrl).hostname)}-full-site-crawl.zip`;
  const zipPath = path.join(jobDir, zipName);
  zip.writeZip(zipPath);

  return {
    site: siteUrl,
    message: `Crawl complete. ${pageList.length} pages discovered.`,
    pagesDiscovered: pageList,
    screenshots: outputs.filter(o => o.fileName).map(o => ({
      page: o.page,
      label: o.label,
      url: `/files/${jobId}/${o.fileName}`
    })),
    failures: outputs.filter(o => o.error),
    zip: `/files/${jobId}/${zipName}`
  };
}
app.get('/', (_req, res) => res.status(200).json({ status: 'ok', message: 'Screenshot worker running' }));
app.get('/health', (_req, res) => res.status(200).json({ status: 'ok' }));

async function crawlHandler(req, res){
  try {
    const url = req.body && req.body.url ? String(req.body.url).trim() : '';
    if (!url) return res.status(400).json({ message: 'Missing url' });
    const result = await runJob(url, {
      waitMs: req.body?.waitMs,
      postScrollWaitMs: req.body?.postScrollWaitMs,
      maxPages: req.body?.maxPages,
      crawlDepth: req.body?.crawlDepth,
    });
    const base = `${req.protocol}://${req.get('host')}`;
    result.zip = base + result.zip;
    result.screenshots = result.screenshots.map(s => ({ ...s, url: base + s.url }));
    res.status(200).json(result);
  } catch(e){
    res.status(500).json({ message: e.message || 'Worker error' });
  }
}
app.post('/capture', crawlHandler);
app.post('/api/crawl', crawlHandler);
app.post('/crawl', crawlHandler);

ensureDir(FILE_ROOT);
app.listen(PORT, () => console.log(`Screenshot worker running on port ${PORT}`));
