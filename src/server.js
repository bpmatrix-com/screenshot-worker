import express from 'express';
import cors from 'cors';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';
import archiver from 'archiver';
import mime from 'mime-types';
import slugify from 'slugify';
import { Cluster } from 'playwright-cluster';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const STORAGE_ROOT = path.resolve(process.env.STORAGE_ROOT || path.join(ROOT, 'storage'));
const PORT = parseInt(process.env.PORT || '3000', 10);
const API_KEY = process.env.API_KEY || '';
const BASE_URL = process.env.BASE_URL || '';
const MAX_CONCURRENCY = parseInt(process.env.MAX_CONCURRENCY || '6', 10);

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use('/files', express.static(STORAGE_ROOT));

const jobs = new Map();
await ensureDir(STORAGE_ROOT);

function auth(req, res, next){
  if (!API_KEY) return next();
  const sent = req.header('x-api-key');
  if (sent !== API_KEY) return res.status(401).json({ error: 'Invalid API key' });
  next();
}

app.get('/health', async (req, res) => {
  res.json({ ok: true, service: 'bpsc4-worker', storage: STORAGE_ROOT });
});

app.post('/crawl', auth, async (req, res) => {
  try {
    const body = req.body || {};
    const url = normalizeUrl(body.url || '');
    if (!url) return res.status(400).json({ error: 'Missing url' });

    const jobId = uuidv4();
    const domain = new URL(url).hostname.toLowerCase();
    const jobRoot = path.join(STORAGE_ROOT, jobId);
    const shotsRoot = path.join(jobRoot, 'screenshots');
    await ensureDir(shotsRoot);

    const job = {
      jobId,
      domain,
      url,
      status: 'queued',
      message: 'Queued',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      totalPages: 0,
      processedPages: 0,
      pages: [],
      images: [],
      zipPath: '',
      zipUrl: '',
      rootDir: jobRoot,
      shotsRoot,
      options: {
        crawlNav: body.crawlNav !== false,
        includeHome: body.includeHome !== false,
        createZip: body.createZip !== false,
        sameDomainOnly: body.sameDomainOnly !== false,
        viewports: Array.isArray(body.viewports) && body.viewports.length ? body.viewports : [
          { label: 'desktop', width: 1920, height: 1080 },
          { label: 'tablet', width: 768, height: 1024 },
          { label: 'mobile', width: 390, height: 844 },
        ]
      }
    };
    jobs.set(jobId, job);
    runJob(job).catch(err => failJob(job, err));
    res.json({ jobId, status: 'queued', message: 'Job queued' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/job/:id', auth, async (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(serializeJob(job));
});

app.listen(PORT, () => {
  console.log(`bpsc4-worker listening on ${PORT}`);
});

function serializeJob(job){
  return {
    jobId: job.jobId,
    domain: job.domain,
    url: job.url,
    status: job.status,
    message: job.message,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    totalPages: job.totalPages,
    processedPages: job.processedPages,
    pages: job.pages,
    images: job.images,
    zipUrl: job.zipUrl,
  };
}

async function runJob(job){
  job.status = 'running';
  job.message = 'Extracting pages';
  touch(job);
  const pages = await extractPages(job.url, job.options.crawlNav, job.options.includeHome, job.options.sameDomainOnly);
  job.pages = pages.map(p => ({ pageUrl: p.url, pageSlug: p.slug }));
  job.totalPages = pages.length;
  job.message = `Found ${pages.length} pages`;
  touch(job);

  const cluster = await Cluster.launch({
    concurrency: Cluster.CONCURRENCY_CONTEXT,
    maxConcurrency: MAX_CONCURRENCY,
    timeout: 10 * 60 * 1000,
    monitor: false,
  });

  await cluster.task(async ({ page, data }) => {
    const { pageUrl, pageSlug } = data;
    await page.goto(pageUrl, { waitUntil: 'networkidle' });
    await autoScroll(page);
    await page.evaluate(() => window.scrollTo(0,0));

    for (const vp of job.options.viewports) {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      const filename = `${pageSlug}-${vp.label}.png`;
      const filepath = path.join(job.shotsRoot, filename);
      await page.screenshot({ path: filepath, fullPage: true });
      const publicUrl = fileUrl(job, `screenshots/${filename}`);
      job.images.push({
        pageSlug,
        pageUrl,
        device: vp.label,
        imageUrl: publicUrl,
        thumbUrl: publicUrl,
        width: vp.width,
        height: vp.height,
      });
    }
    job.processedPages += 1;
    job.message = `Processed ${job.processedPages}/${job.totalPages} pages`;
    touch(job);
  });

  for (const pageData of pages) {
    await cluster.queue(pageData);
  }

  await cluster.idle();
  await cluster.close();

  if (job.options.createZip) {
    job.message = 'Creating ZIP';
    touch(job);
    const zipPath = path.join(job.rootDir, `${job.domain}.zip`);
    await zipDirectory(job.shotsRoot, zipPath);
    job.zipPath = zipPath;
    job.zipUrl = fileUrl(job, `${job.domain}.zip`);
  }

  job.status = 'completed';
  job.message = 'Completed';
  touch(job);
}

function failJob(job, err){
  job.status = 'failed';
  job.message = err && err.message ? err.message : 'Job failed';
  touch(job);
  console.error(err);
}

function touch(job){
  job.updatedAt = new Date().toISOString();
}

async function extractPages(startUrl, crawlNav, includeHome, sameDomainOnly){
  const browserCluster = await Cluster.launch({
    concurrency: Cluster.CONCURRENCY_CONTEXT,
    maxConcurrency: 1,
    timeout: 120000,
    monitor: false,
  });

  const found = [];
  await browserCluster.task(async ({ page, data }) => {
    await page.goto(data, { waitUntil: 'networkidle' });
    const links = await page.evaluate(() => {
      let anchors = Array.from(document.querySelectorAll('nav a'));
      if (!anchors.length) anchors = Array.from(document.querySelectorAll('header a'));
      if (!anchors.length) anchors = Array.from(document.querySelectorAll('a'));
      return anchors.map(a => a.href).filter(Boolean);
    });
    found.push(...links);
  });
  await browserCluster.queue(startUrl);
  await browserCluster.idle();
  await browserCluster.close();

  const origin = new URL(startUrl).origin;
  const normalized = new Map();
  if (includeHome) {
    normalized.set(startUrl, { url: startUrl, slug: 'home' });
  }
  if (crawlNav) {
    for (const raw of found) {
      const clean = normalizeUrl(raw);
      if (!clean) continue;
      if (sameDomainOnly && !clean.startsWith(origin)) continue;
      const u = new URL(clean);
      u.hash = '';
      u.search = '';
      const finalUrl = u.toString().replace(/\/$/, '') || startUrl;
      const slug = slugForUrl(finalUrl, startUrl);
      normalized.set(finalUrl, { url: finalUrl, slug });
    }
  }
  return Array.from(normalized.values());
}

async function autoScroll(page){
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let total = 0;
      const distance = 500;
      const timer = setInterval(() => {
        window.scrollBy(0, distance);
        total += distance;
        if (total >= document.body.scrollHeight) {
          clearInterval(timer);
          resolve();
        }
      }, 200);
    });
  });
}

function normalizeUrl(url){
  try {
    if (!url) return '';
    const value = /^https?:\/\//i.test(url) ? url : `https://${url}`;
    return new URL(value).toString();
  } catch {
    return '';
  }
}

function slugForUrl(url, homeUrl){
  try {
    const u = new URL(url);
    const home = new URL(homeUrl);
    if (u.pathname === '/' || u.pathname === home.pathname) return 'home';
    const raw = u.pathname.replace(/^\//, '').replace(/\/$/, '') || 'home';
    return slugify(raw, { lower: true, strict: true }) || 'page';
  } catch {
    return 'page';
  }
}

function fileUrl(job, relativePath){
  const base = BASE_URL || '';
  if (!base) {
    return `/files/${job.jobId}/${relativePath}`;
  }
  return `${base.replace(/\/$/, '')}/files/${job.jobId}/${relativePath}`;
}

async function ensureDir(dir){
  await fsp.mkdir(dir, { recursive: true });
}

async function zipDirectory(sourceDir, outPath){
  await ensureDir(path.dirname(outPath));
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(outPath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    output.on('close', resolve);
    archive.on('error', reject);
    archive.pipe(output);
    archive.directory(sourceDir, false);
    archive.finalize();
  });
}
