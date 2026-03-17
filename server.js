const express = require('express');
const { chromium } = require('playwright');

const app = express();
const PORT = process.env.PORT || 10000;
app.use(express.json({ limit: '50mb' }));

function normalizeUrl(raw, base) {
  try {
    const u = base ? new URL(raw, base) : new URL(raw);
    u.hash = '';
    return u.toString();
  } catch (e) {
    return null;
  }
}

function cleanPathname(pathname) {
  if (!pathname) return '/';
  return pathname.replace(/\/+$/, '') || '/';
}

function sameOrigin(url, origin) {
  try {
    return new URL(url).origin === origin;
  } catch (e) {
    return false;
  }
}

function isSkippable(url) {
  const lower = url.toLowerCase();
  return (
    lower.startsWith('mailto:') ||
    lower.startsWith('tel:') ||
    lower.includes('/wp-admin') ||
    lower.includes('/wp-login') ||
    lower.endsWith('.jpg') || lower.endsWith('.jpeg') || lower.endsWith('.png') ||
    lower.endsWith('.gif') || lower.endsWith('.svg') || lower.endsWith('.webp') ||
    lower.endsWith('.pdf') || lower.endsWith('.zip') || lower.endsWith('.mp4')
  );
}

async function discoverUrls(startUrl) {
  const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  const origin = new URL(startUrl).origin;
  const queue = [startUrl];
  const seen = new Set();
  const ordered = [];

  while (queue.length) {
    const current = queue.shift();
    if (seen.has(current)) continue;
    seen.add(current);

    try {
      await page.goto(current, { waitUntil: 'networkidle', timeout: 60000 });
      ordered.push(current);

      const hrefs = await page.$$eval('a[href]', anchors => anchors.map(a => a.getAttribute('href')));
      for (const href of hrefs) {
        const normalized = normalizeUrl(href, current);
        if (!normalized) continue;
        if (!sameOrigin(normalized, origin)) continue;
        if (isSkippable(normalized)) continue;

        const urlObj = new URL(normalized);
        urlObj.hash = '';
        urlObj.search = '';
        urlObj.pathname = cleanPathname(urlObj.pathname);
        const finalUrl = urlObj.toString();

        if (!seen.has(finalUrl) && !queue.includes(finalUrl)) {
          queue.push(finalUrl);
        }
      }
    } catch (e) {
      // Keep crawling other pages
    }
  }

  await browser.close();
  return ordered;
}

async function captureOne(browser, url, width, height, delay) {
  const page = await browser.newPage({ viewport: { width, height } });
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
    if (delay > 0) await page.waitForTimeout(delay);
    const buf = await page.screenshot({ fullPage: true, type: 'jpeg', quality: 82 });
    await page.close();
    return buf.toString('base64');
  } catch (e) {
    try { await page.close(); } catch (_) {}
    throw e;
  }
}

app.get('/', (req, res) => {
  res.json({ ok: true, service: 'bssp-v52-worker' });
});

app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'bssp-v52-worker', ts: Date.now() });
});

app.get('/discover', async (req, res) => {
  const startUrl = req.query.url;
  if (!startUrl) {
    return res.status(400).json({ error: 'Missing url parameter' });
  }
  try {
    const normalized = normalizeUrl(startUrl);
    if (!normalized) return res.status(400).json({ error: 'Invalid URL' });
    const urls = await discoverUrls(normalized);
    return res.json({ ok: true, urls });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Discovery failed' });
  }
});

app.post('/capture-batch', async (req, res) => {
  const urls = Array.isArray(req.body.urls) ? req.body.urls : [];
  const desktop = req.body.desktop || { width: 1920, height: 1080 };
  const tablet = req.body.tablet || { width: 768, height: 1024 };
  const mobile = req.body.mobile || { width: 390, height: 844 };
  const delay = Number(req.body.delay || 1500);

  if (!urls.length) {
    return res.status(400).json({ error: 'Missing urls array' });
  }

  let browser;
  try {
    browser = await chromium.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const results = await Promise.all(urls.map(async (url) => {
      try {
        const [desktopImg, tabletImg, mobileImg] = await Promise.all([
          captureOne(browser, url, Number(desktop.width || 1920), Number(desktop.height || 1080), delay),
          captureOne(browser, url, Number(tablet.width || 768), Number(tablet.height || 1024), delay),
          captureOne(browser, url, Number(mobile.width || 390), Number(mobile.height || 844), delay),
        ]);
        return { url, success: true, desktop: desktopImg, tablet: tabletImg, mobile: mobileImg };
      } catch (e) {
        return { url, success: false, error: e.message || 'Capture failed' };
      }
    }));
    await browser.close();
    res.json(results);
  } catch (e) {
    try { if (browser) await browser.close(); } catch (_) {}
    res.status(500).json({ error: e.message || 'Batch capture failed' });
  }
});

app.listen(PORT, () => {
  console.log(`BSSP v5.2 worker listening on ${PORT}`);
});
