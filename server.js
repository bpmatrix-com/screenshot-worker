const express = require('express');
const { chromium } = require('playwright');

const app = express();
const PORT = process.env.PORT || 10000;
app.use(express.json({ limit: '100mb' }));

function normalizeUrl(raw, base = null) {
  try {
    const u = base ? new URL(raw, base) : new URL(raw);
    u.hash = '';
    return u.toString();
  } catch (e) {
    return null;
  }
}

function cleanUrl(url) {
  try {
    const u = new URL(url);
    u.hash = '';
    const tracking = ['utm_source','utm_medium','utm_campaign','utm_term','utm_content','gclid','fbclid'];
    tracking.forEach(k => u.searchParams.delete(k));
    u.search = u.searchParams.toString() ? '?' + u.searchParams.toString() : '';
    u.pathname = u.pathname.replace(/\/+$/, '') || '/';
    return u.toString();
  } catch (e) {
    return null;
  }
}

function shouldSkip(url, origin) {
  try {
    const u = new URL(url);
    const lower = u.toString().toLowerCase();
    if (u.origin !== origin) return true;
    if (lower.startsWith('mailto:') || lower.startsWith('tel:')) return true;
    if (lower.includes('/wp-admin') || lower.includes('/wp-login')) return true;
    if (/\.(jpg|jpeg|png|gif|svg|webp|pdf|zip|mp4|mov|avi|mp3|wav)$/i.test(lower)) return true;
    return false;
  } catch (e) {
    return true;
  }
}

async function fetchSitemapUrls(startUrl) {
  try {
    const base = new URL(startUrl).origin;
    const sitemapCandidates = [
      `${base}/sitemap.xml`,
      `${base}/sitemap_index.xml`,
      `${base}/page-sitemap.xml`,
      `${base}/post-sitemap.xml`,
    ];
    for (const sitemapUrl of sitemapCandidates) {
      const resp = await fetch(sitemapUrl);
      if (!resp.ok) continue;
      const text = await resp.text();
      const locs = Array.from(text.matchAll(/<loc>(.*?)<\/loc>/g)).map(m => m[1]).filter(Boolean);
      if (!locs.length) continue;
      const pageish = locs.filter(u => {
        const cleaned = cleanUrl(u);
        if (!cleaned) return false;
        if (shouldSkip(cleaned, base)) return false;
        return true;
      });
      if (pageish.length) return Array.from(new Set(pageish));
    }
  } catch (e) {}
  return [];
}

async function discoverUrls(startUrl) {
  const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  const origin = new URL(startUrl).origin;
  const found = new Set();

  const pushUrl = (u) => {
    const cleaned = cleanUrl(u);
    if (!cleaned) return;
    if (shouldSkip(cleaned, origin)) return;
    found.add(cleaned);
  };

  pushUrl(startUrl);

  try {
    await page.goto(startUrl, { waitUntil: 'networkidle', timeout: 60000 });

    const selectorGroups = [
      'nav a[href]',
      'header a[href]',
      '[role="navigation"] a[href]',
      '.menu a[href]',
      '.navbar a[href]',
      '.nav a[href]',
      '#menu a[href]',
      'footer a[href]'
    ];

    for (const selector of selectorGroups) {
      try {
        const hrefs = await page.$$eval(selector, nodes => nodes.map(n => n.getAttribute('href')).filter(Boolean));
        hrefs.forEach(h => {
          const normalized = normalizeUrl(h, startUrl);
          if (normalized) pushUrl(normalized);
        });
      } catch (e) {}
    }

    try {
      const allLinks = await page.$$eval('a[href]', nodes => nodes.map(n => n.getAttribute('href')).filter(Boolean));
      allLinks.forEach(h => {
        const normalized = normalizeUrl(h, startUrl);
        if (normalized) pushUrl(normalized);
      });
    } catch (e) {}

  } catch (e) {}

  await browser.close();

  const sitemapUrls = await fetchSitemapUrls(startUrl);
  sitemapUrls.forEach(pushUrl);

  const ordered = Array.from(found);
  ordered.sort((a, b) => {
    const aHome = new URL(a).pathname === '/' ? 0 : 1;
    const bHome = new URL(b).pathname === '/' ? 0 : 1;
    if (aHome !== bHome) return aHome - bHome;
    return a.localeCompare(b);
  });

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
  res.json({ ok: true, service: 'bssp-v53-worker' });
});

app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'bssp-v53-worker', ts: Date.now() });
});

app.get('/discover', async (req, res) => {
  const startUrl = req.query.url;
  if (!startUrl) return res.status(400).json({ error: 'Missing url parameter' });

  const normalized = normalizeUrl(startUrl);
  if (!normalized) return res.status(400).json({ error: 'Invalid URL' });

  try {
    const urls = await discoverUrls(normalized);
    res.json({ ok: true, urls });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Discovery failed' });
  }
});

app.post('/capture-batch', async (req, res) => {
  const urls = Array.isArray(req.body.urls) ? req.body.urls : [];
  const desktop = req.body.desktop || { width: 1920, height: 1080 };
  const tablet = req.body.tablet || { width: 768, height: 1024 };
  const mobile = req.body.mobile || { width: 390, height: 844 };
  const delay = Math.max(Number(req.body.delay || 1500), 0);

  if (!urls.length) return res.status(400).json({ error: 'Missing urls array' });

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
  console.log(`BSSP v5.3 worker listening on ${PORT}`);
});
