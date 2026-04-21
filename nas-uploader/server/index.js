import express from 'express';
import cors from 'cors';
import { promises as fs } from 'fs';
import { existsSync, readdirSync, statSync } from 'fs';
import os from 'os';
import path from 'path';
import { spawn, execFile } from 'child_process';
import { promisify } from 'util';
import { updateWikiDocs, commitWikiChanges, parseNasFilename } from './wiki-updater.js';

const execFileAsync = promisify(execFile);
const app = express();
const PORT = process.env.PORT || 3002;

const CONFIG_PATH = new URL('./config.json', import.meta.url).pathname;
const DB_PATH = new URL('./db.json', import.meta.url).pathname;
const QUEUE_PATH = new URL('./queue.json', import.meta.url).pathname;
const LEGACY_NAS_PREFIXES = [
  path.join(os.homedir(), 'NAS-stu') + path.sep,
  '/home/darklee/NAS-stu/',
];

// ===================== Config =====================
let configCache = null;

async function loadConfig() {
  if (configCache) return configCache;
  try {
    const raw = await fs.readFile(CONFIG_PATH, 'utf-8');
    configCache = JSON.parse(raw);
  } catch {
    configCache = {};
  }
  return configCache;
}

async function saveConfig(cfg) {
  configCache = cfg;
  await fs.writeFile(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

// ===================== NAS Mount =====================
function resolveNasRoot() {
  const cfg = configCache || {};
  if (cfg.nasMount?.target) return cfg.nasMount.target;

  const candidates = [
    process.env.NAS_ROOT,
    '/other_data/NAS-stu',
    path.join(os.homedir(), 'NAS-stu'),
  ].filter(Boolean);

  const scored = candidates
    .map((candidate) => {
      try {
        if (!statSync(candidate).isDirectory()) return null;
        const entries = readdirSync(candidate);
        const looksLikeMount = candidate.startsWith('/other_data/') || candidate.startsWith('/mnt/') || candidate.startsWith('/media/');
        return {
          candidate,
          score: (looksLikeMount ? 10 : 0) + (entries.length > 0 ? 1 : 0),
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);

  return scored[0]?.candidate || candidates[candidates.length - 1];
}

async function isNasMounted(target) {
  try {
    const mounts = await fs.readFile('/proc/mounts', 'utf-8');
    return mounts.split('\n').some(line => {
      const parts = line.split(' ');
      return parts.length >= 2 && parts[1] === target;
    });
  } catch {
    return false;
  }
}

async function ensureNasMounted() {
  const cfg = await loadConfig();
  const target = resolveNasRoot();

  if (await isNasMounted(target)) {
    console.log(`[NAS] Already mounted at ${target}`);
    return { mounted: true, target };
  }

  if (!cfg.nasMount?.enabled) {
    console.warn(`[NAS] Not mounted at ${target} and auto-mount is disabled.`);
    return { mounted: false, target, error: 'Auto-mount disabled in config' };
  }

  const { source, options } = cfg.nasMount;
  console.log(`[NAS] Attempting to mount ${source} -> ${target}`);

  try {
    await fs.mkdir(target, { recursive: true });
  } catch {}

  return new Promise((resolve) => {
    const args = ['-t', 'cifs', source, target];
    if (options) {
      args.push('-o', options);
    }

    const proc = spawn('mount', args);
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    proc.on('close', async (code) => {
      if (code === 0 && (await isNasMounted(target))) {
        console.log(`[NAS] Mounted successfully at ${target}`);
        resolve({ mounted: true, target });
      } else {
        // Try with sudo as fallback
        const sudoProc = spawn('sudo', ['-n', 'mount', ...args]);
        let sudoStderr = '';
        sudoProc.stderr.on('data', (d) => { sudoStderr += d.toString(); });
        sudoProc.on('close', async (sudoCode) => {
          if (sudoCode === 0 && (await isNasMounted(target))) {
            console.log(`[NAS] Mounted successfully with sudo at ${target}`);
            resolve({ mounted: true, target });
          } else {
            const err = (stderr || sudoStderr || `exit code ${code}`).trim();
            console.error(`[NAS] Mount failed: ${err}`);
            resolve({ mounted: false, target, error: err });
          }
        });
      }
    });
  });
}

// ===================== DB helpers =====================
function normalizeDbPath(filePath) {
  if (typeof filePath !== 'string' || !filePath) return filePath;
  for (const legacyPrefix of LEGACY_NAS_PREFIXES) {
    if (filePath.startsWith(legacyPrefix)) {
      return path.join(NAS_ROOT, filePath.slice(legacyPrefix.length));
    }
  }
  return filePath;
}

function normalizeDb(db) {
  let changed = false;
  const normalized = {};
  for (const [filePath, info] of Object.entries(db || {})) {
    const normalizedPath = normalizeDbPath(filePath);
    if (normalizedPath !== filePath) changed = true;
    normalized[normalizedPath] = {
      ...normalized[normalizedPath],
      ...info,
    };
  }
  return { normalized, changed };
}

async function readDb() {
  try {
    const raw = await fs.readFile(DB_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    const { normalized, changed } = normalizeDb(parsed);
    if (changed) {
      await writeDb(normalized);
    }
    return normalized;
  } catch {
    return {};
  }
}

async function writeDb(db) {
  const { normalized } = normalizeDb(db);
  await fs.writeFile(DB_PATH, JSON.stringify(normalized, null, 2));
}

// ===================== Queue persistence =====================
async function saveQueue() {
  await fs.writeFile(QUEUE_PATH, JSON.stringify(queue, null, 2));
}

async function loadQueue() {
  try {
    const raw = await fs.readFile(QUEUE_PATH, 'utf-8');
    const saved = JSON.parse(raw);
    // Reset any in-progress items back to queued so they can be retried
    for (const item of saved) {
      if (item.status === 'uploading') item.status = 'queued';
    }
    queue.push(...saved);
  } catch {
    // No saved queue, start fresh
  }
}

// ===================== File scanning =====================
async function scanDir(dir, cutoff, searchTerm = '', results = []) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await scanDir(full, cutoff, searchTerm, results);
    } else if (entry.isFile()) {
      try {
        const stat = await fs.stat(full);
        const matchesTime = !cutoff || stat.mtimeMs >= cutoff;
        const matchesSearch = !searchTerm || full.toLowerCase().includes(searchTerm);
        if (matchesTime && matchesSearch) {
          results.push({ path: full, size: stat.size, mtime: stat.mtime.toISOString() });
        }
      } catch {}
    }
  }
  return results;
}

function matchesSearchTerm(filePath, searchTerm = '') {
  return !searchTerm || filePath.toLowerCase().includes(searchTerm);
}

function toTimestamp(value) {
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : 0;
}

function buildDbBackedFiles(db, cutoff, searchTerm = '') {
  const files = [];
  for (const [filePath, info] of Object.entries(db)) {
    const normalizedPath = normalizeDbPath(filePath);
    const mtime = info?.mtime || info?.uploadedAt || null;
    const timestamp = mtime ? toTimestamp(mtime) : 0;
    const matchesTime = !cutoff || timestamp >= cutoff;
    if (!matchesTime || !matchesSearchTerm(normalizedPath, searchTerm)) {
      continue;
    }
    files.push({
      path: normalizedPath,
      size: info?.size ?? null,
      mtime,
    });
  }
  return files;
}

function mergeFiles(primaryFiles, secondaryFiles) {
  const merged = new Map();
  for (const file of secondaryFiles) {
    merged.set(file.path, file);
  }
  for (const file of primaryFiles) {
    merged.set(file.path, {
      ...merged.get(file.path),
      ...file,
    });
  }
  return [...merged.values()].sort((a, b) => toTimestamp(b.mtime) - toTimestamp(a.mtime));
}

function decorateFiles(files, db) {
  return files.map((file) => {
    const info = lookupDb(db, file.path);
    return {
      ...file,
      uploaded: !!info,
      link: info?.link || null,
      wikiUpdated: info?.wikiUpdated || false,
      uploadedAt: info?.uploadedAt || null,
    };
  });
}

const scanCache = {
  files: [],
  scannedAt: 0,
  running: false,
  promise: null,
  error: null,
};

function getCachedFiles(cutoff, searchTerm = '') {
  return scanCache.files.filter((file) => {
    const matchesTime = !cutoff || toTimestamp(file.mtime) >= cutoff;
    return matchesTime && matchesSearchTerm(file.path, searchTerm);
  });
}

function refreshScanCache(force = false) {
  const cacheFresh = scanCache.scannedAt && (Date.now() - scanCache.scannedAt < 5 * 60 * 1000);
  if (scanCache.promise) return scanCache.promise;
  if (!force && cacheFresh) return Promise.resolve(scanCache.files);

  scanCache.running = true;
  scanCache.error = null;
  scanCache.promise = scanDir(NAS_ROOT, null, '')
    .then((files) => {
      scanCache.files = files.sort((a, b) => toTimestamp(b.mtime) - toTimestamp(a.mtime));
      scanCache.scannedAt = Date.now();
      return scanCache.files;
    })
    .catch((err) => {
      scanCache.error = err.message;
      console.error('[Scan] Cache refresh failed:', err.message);
      return scanCache.files;
    })
    .finally(() => {
      scanCache.running = false;
      scanCache.promise = null;
    });

  return scanCache.promise;
}

async function listFiles({ cutoff, searchTerm = '' }) {
  const db = await readDb();
  const persistedFiles = buildDbBackedFiles(db, cutoff, searchTerm);
  const scannedFiles = getCachedFiles(cutoff, searchTerm);

  if (!scanCache.running) {
    refreshScanCache().catch(() => {});
  }

  return decorateFiles(mergeFiles(scannedFiles, persistedFiles), db);
}

// ===================== OneDrive Link =====================
async function generateOneDriveLink(remote, destDir, relPath) {
  const remotePath = `${remote}:${destDir}/${relPath}`;
  try {
    const { stdout } = await execFileAsync('rclone', ['link', remotePath], { timeout: 30000 });
    const link = stdout.trim();
    if (link.startsWith('http')) {
      return { success: true, link };
    }
    return { success: false, error: `Unexpected link output: ${link}` };
  } catch (err) {
    return { success: false, error: err.stderr?.trim() || err.message };
  }
}

function getLegacyRemoteSearchRoots(basename) {
  const parsed = parseNasFilename(basename);
  if (!parsed) {
    return ['Jetson-Images/reComputer-J401', 'Jetson-Images/reComputer-J30', 'Jetson-Images/reComputer-Mini'];
  }

  if (parsed.series === 'super') {
    return ['Jetson-Images/reComputer-Super'];
  }
  if (parsed.series === 'industrial' || parsed.series === 'classic') {
    return ['Jetson-Images/reComputer-industrial'];
  }
  if (parsed.series === 'reserver') {
    return ['Jetson-Images/reServer-Industrial-J30J40', 'Jetson-Images/reServer-J501'];
  }

  if (parsed.carrier?.startsWith('j401')) {
    return ['Jetson-Images/reComputer-J401'];
  }
  if (parsed.carrier?.startsWith('j30')) {
    return ['Jetson-Images/reComputer-J30'];
  }
  if (parsed.series === 'mini') {
    return ['Jetson-Images/reComputer-Mini'];
  }

  return ['Jetson-Images/reComputer-J401', 'Jetson-Images/reComputer-J30', 'Jetson-Images/reComputer-Mini'];
}

async function generateLegacyOneDriveLink(remote, basename) {
  const roots = getLegacyRemoteSearchRoots(basename);

  for (const root of roots) {
    try {
      const { stdout } = await execFileAsync(
        'rclone',
        ['lsf', `${remote}:${root}`, '--files-only', '--recursive'],
        { timeout: 60000, maxBuffer: 10 * 1024 * 1024 }
      );
      const matches = stdout
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line && path.basename(line) === basename)
        .sort((a, b) => a.split('/').length - b.split('/').length);

      for (const match of matches) {
        const remotePath = `${remote}:${root}/${match}`;
        try {
          const { stdout: linkStdout } = await execFileAsync('rclone', ['link', remotePath], { timeout: 30000 });
          const link = linkStdout.trim();
          if (link.startsWith('http')) {
            return { success: true, link, remotePath };
          }
        } catch {
          // Keep trying other legacy matches.
        }
      }
    } catch {
      // Ignore missing legacy roots and keep trying.
    }
  }

  return { success: false, error: `No legacy OneDrive file found for ${basename}` };
}

// ===================== Wiki Update =====================
async function updateWiki(cfg, filename, link) {
  if (!cfg.wiki?.enabled) return { skipped: true };

  const wiki = cfg.wiki;
  const text = (wiki.template || '文件 {{filename}} 已上传: {{link}}')
    .replace(/\{\{filename\}\}/g, filename)
    .replace(/\{\{link\}\}/g, link);

  try {
    if (wiki.type === 'webhook') {
      const headers = { 'Content-Type': 'application/json' };
      if (wiki.token) headers['Authorization'] = `Bearer ${wiki.token}`;
      const res = await fetch(wiki.url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ filename, link, text, pageId: wiki.pageId }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      return { success: true };
    }

    if (wiki.type === 'mediawiki') {
      // Placeholder for MediaWiki API integration
      // Requires: url, token (or username/password), pageId or pageTitle
      return { success: false, error: 'MediaWiki integration not yet implemented. Please use webhook or implement in wiki.js.' };
    }

    return { success: false, error: `Unknown wiki type: ${wiki.type}` };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

function getWikiGitOptions(cfg = {}) {
  return {
    wikiBase: cfg.wiki?.localPath,
    remote: cfg.wiki?.gitRemote || 'origin',
    branch: cfg.wiki?.gitBranch || undefined,
  };
}

// ===================== App Setup =====================
const NAS_ROOT = resolveNasRoot();

app.use(cors());
app.use(express.json());

// --- API: Config ---
app.get('/api/config', async (req, res) => {
  res.json(await loadConfig());
});

app.post('/api/config', async (req, res) => {
  const cfg = req.body;
  if (!cfg || typeof cfg !== 'object') {
    return res.status(400).json({ error: 'Invalid config' });
  }
  await saveConfig(cfg);
  res.json({ saved: true });
});

// Helper: lookup db record by path or basename fallback
function lookupDb(db, filePath) {
  if (db[filePath]) return db[filePath];
  const base = path.basename(filePath);
  for (const [p, info] of Object.entries(db)) {
    if (path.basename(p) === base) return info;
  }
  return null;
}

function resolveDbEntry(db, filePath) {
  if (db[filePath]) {
    return { actualPath: filePath, info: db[filePath] };
  }
  const base = path.basename(filePath);
  for (const [storedPath, info] of Object.entries(db)) {
    if (path.basename(storedPath) === base) {
      return { actualPath: storedPath, info };
    }
  }
  return { actualPath: filePath, info: null };
}

// GET /api/files?days=1|7|30&q=keyword
app.get('/api/files', async (req, res) => {
  const days = parseInt(req.query.days) || 7;
  const searchTerm = String(req.query.q || '').trim().toLowerCase();
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  res.json(await listFiles({ cutoff, searchTerm }));
});

// GET /api/files/all?q=keyword
app.get('/api/files/all', async (req, res) => {
  const searchTerm = String(req.query.q || '').trim().toLowerCase();
  res.json(await listFiles({ cutoff: null, searchTerm }));
});

// GET /api/uploaded
app.get('/api/uploaded', async (req, res) => {
  res.json(await readDb());
});

// GET /api/queue
app.get('/api/queue', async (req, res) => {
  res.json(queue);
});

// --- Upload queue ---
const queue = [];          // { id, filePath, status, progress, speed, error, link, wikiUpdated, uploadedAt }
const sseClients = new Set();
let activeUploads = 0;

function getUploadConcurrency() {
  const configured = Number(configCache?.onedrive?.concurrency);
  if (Number.isInteger(configured) && configured > 0) {
    return configured;
  }
  return 2;
}

function broadcast(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    client.write(msg);
  }
  // Persist queue state on every change
  saveQueue().catch(() => {});
}

// GET /api/progress  (SSE)
app.get('/api/progress', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  res.write(`data: ${JSON.stringify({ type: 'queue', queue })}\n\n`);

  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

// POST /api/upload  body: { paths: [...], syncWiki: true|false }
app.post('/api/upload', async (req, res) => {
  const { paths, syncWiki } = req.body;
  if (!Array.isArray(paths) || paths.length === 0) {
    return res.status(400).json({ error: 'paths required' });
  }
  const db = await readDb();
  const added = [];
  for (const p of paths) {
    if (!p.startsWith(NAS_ROOT)) continue;
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const item = {
      id,
      filePath: p,
      status: 'queued',
      progress: 0,
      speed: '',
      transferredBytes: 0,
      totalBytes: 0,
      error: null,
      link: null,
      wikiUpdated: false,
      uploadedAt: null,
      syncWiki: syncWiki !== false,
    };
    queue.push(item);
    added.push(item);
  }
  broadcast({ type: 'queue', queue });
  res.json({ queued: added.length, items: added });
  processQueue();
});

// POST /api/sync-wiki  body: { path: '/path/to/file' }
app.post('/api/sync-wiki', async (req, res) => {
  const { path: filePath } = req.body;
  if (!filePath) {
    return res.status(400).json({ error: 'path required' });
  }
  const basename = path.basename(filePath);
  if (!basename.startsWith('mfi_')) {
    return res.status(400).json({ error: 'Only mfi_ files can be synced to wiki' });
  }
  const db = await readDb();
  let { actualPath, info } = resolveDbEntry(db, filePath);
  if (!info) {
    return res.status(400).json({ error: 'File not uploaded yet' });
  }
  try {
    const cfg = configCache || {};
    const wikiGitOptions = getWikiGitOptions(cfg);
    const remote = cfg.onedrive?.remote || 'onedrive';
    const destDir = cfg.onedrive?.destDir || 'NAS-Backup';
    const rel = path.relative(NAS_ROOT, actualPath);
    let link = info.link || null;

    if (!link) {
      let linkResult = await generateOneDriveLink(remote, destDir, rel);
      if ((!linkResult.success || !linkResult.link) && info.uploadedAt) {
        linkResult = await generateLegacyOneDriveLink(remote, basename);
      }
      if (!linkResult.success || !linkResult.link) {
        return res.status(500).json({
          error: `Unable to generate OneDrive link for previously uploaded file: ${linkResult.error || 'unknown error'}`,
        });
      }
      link = linkResult.link;
      db[actualPath] = {
        ...info,
        link,
      };
      await writeDb(db);
      info = db[actualPath];
    }

    const wikiResult = await updateWikiDocs(NAS_ROOT, link, basename, wikiGitOptions);
    if (wikiResult.l4t.updated > 0) {
      db[actualPath] = {
        ...db[actualPath],
        ...info,
        link,
        wikiUpdated: true,
      };
      await writeDb(db);
      const gitResult = await commitWikiChanges(
        `docs: update BSP download link for ${basename}`,
        wikiResult.modifiedFiles,
        wikiGitOptions
      );
      const message = !gitResult.committed
        ? `Wiki already up to date for ${wikiResult.l4t.matches.join(', ')}`
        : `Wiki updated for ${wikiResult.l4t.matches.join(', ')}${gitResult.pushed ? ' and pushed' : gitResult.committed ? ' (commit only)' : ''}`;
      return res.json({
        success: true,
        message,
        l4t: wikiResult.l4t,
        docs: wikiResult.docs,
        git: gitResult,
      });
    }
    return res.status(400).json({ error: wikiResult.l4t.error || 'No matching wiki entry found' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

function processQueue() {
  const concurrency = getUploadConcurrency();
  while (activeUploads < concurrency) {
    const item = queue.find(i => i.status === 'queued');
    if (!item) break;
    activeUploads += 1;
    uploadFile(item).finally(() => {
      activeUploads -= 1;
      processQueue();
    });
  }
}

function formatSpeed(bytesPerSecond) {
  const value = Number(bytesPerSecond);
  if (!Number.isFinite(value) || value <= 0) return '';

  const units = ['B/s', 'KiB/s', 'MiB/s', 'GiB/s', 'TiB/s'];
  let size = value;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }

  const digits = size >= 100 ? 0 : size >= 10 ? 1 : 2;
  return `${size.toFixed(digits)} ${units[unitIndex]}`;
}

function parseProgressUpdate(line) {
  let text = String(line || '').trim();
  if (!text) return null;

  try {
    const parsed = JSON.parse(text);
    const transfer = parsed?.stats?.transferring?.[0];
    if (transfer && Number.isFinite(transfer.percentage)) {
      const transferredBytes = Number(transfer.bytes) || 0;
      const totalBytes = Number(transfer.size) || 0;
      const computedProgress = totalBytes > 0
        ? (transferredBytes / totalBytes) * 100
        : Number(transfer.percentage) || 0;
      return {
        progress: Math.max(0, Math.min(100, Number(computedProgress.toFixed(1)))),
        speed: formatSpeed(transfer.speed || parsed?.stats?.speed),
        transferredBytes,
        totalBytes,
      };
    }
    text = String(parsed.msg || parsed.message || '').trim();
  } catch {
    // Fall back to plain-text parsing for older rclone output.
  }

  text = text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '').trim();

  const progressMatch = text.match(/Transferred:.*?(\d{1,3})%/);
  if (!progressMatch) return null;

  const speedMatch = text.match(/([\d.]+\s*(?:[KMGT]?i?B|B)\/s)/);
  return {
    progress: Math.max(0, Math.min(100, parseInt(progressMatch[1], 10))),
    speed: speedMatch?.[1] || '',
    transferredBytes: null,
    totalBytes: null,
  };
}

function uploadFile(item) {
  return new Promise(resolve => {
    item.status = 'uploading';
    broadcast({ type: 'update', item });

    const cfg = configCache || {};
    const remote = cfg.onedrive?.remote || 'onedrive';
    const destDir = cfg.onedrive?.destDir || 'NAS-Backup';

    const rel = path.relative(NAS_ROOT, item.filePath);
    const remotePath = `${remote}:${destDir}/${rel}`;
    const args = [
      'copyto',
      item.filePath,
      remotePath,
      '--use-json-log',
      '--log-level', 'INFO',
      '--stats-log-level', 'INFO',
      '--stats', '1s',
      '--stats-one-line',
    ];
    const proc = spawn('rclone', args);

    let buf = '';
    const handleChunk = (chunk) => {
      buf += chunk.toString();
      const lines = buf.split(/\r|\n/);
      buf = lines.pop();
      for (const line of lines) {
        const update = parseProgressUpdate(line);
        if (update) {
          item.progress = update.progress;
          item.speed = update.speed || item.speed;
          item.transferredBytes = update.transferredBytes ?? item.transferredBytes;
          item.totalBytes = update.totalBytes ?? item.totalBytes;
          broadcast({ type: 'update', item });
        }
      }
    };

    const flushProgressBuffer = () => {
      const update = parseProgressUpdate(buf);
      if (update) {
        item.progress = update.progress;
        item.speed = update.speed || item.speed;
        item.transferredBytes = update.transferredBytes ?? item.transferredBytes;
        item.totalBytes = update.totalBytes ?? item.totalBytes;
        broadcast({ type: 'update', item });
      }
      buf = '';
    };

    proc.stderr.on('data', handleChunk);
    proc.stdout.on('data', handleChunk);

    proc.on('close', async (code) => {
      flushProgressBuffer();
      if (code === 0) {
        item.status = 'done';
        item.progress = 100;
        item.uploadedAt = new Date().toISOString();

        // Save basic completion info immediately
        const db = await readDb();
        try {
          const stat = await fs.stat(item.filePath);
          db[item.filePath] = {
            size: stat.size,
            mtime: stat.mtime.toISOString(),
            uploadedAt: item.uploadedAt,
            link: item.link,
            wikiUpdated: item.wikiUpdated,
          };
        } catch {
          db[item.filePath] = {
            uploadedAt: item.uploadedAt,
            link: item.link,
            wikiUpdated: item.wikiUpdated,
          };
        }
        await writeDb(db);
        broadcast({ type: 'update', item });
        resolve(); // Free the queue immediately

        // Background: generate OneDrive share link and update wiki
        (async () => {
          console.log(`[Upload] Generating link for ${rel}...`);
          const linkResult = await generateOneDriveLink(remote, destDir, rel);
          if (linkResult.success) {
            item.link = linkResult.link;
            console.log(`[Upload] Link generated: ${item.link}`);

            // Update wiki docs (L4TData.json + individual tutorial docs)
            const basename = path.basename(item.filePath);
            if (basename.startsWith('mfi_') && item.syncWiki !== false) {
              try {
                const wikiGitOptions = getWikiGitOptions(cfg);
                const wikiResult = await updateWikiDocs(NAS_ROOT, item.link, basename, wikiGitOptions);
                if (wikiResult.l4t.updated > 0) {
                  console.log(`[Upload] L4TData.json updated for ${wikiResult.l4t.matches.join(', ')}`);
                  if (wikiResult.docs.length > 0) {
                    console.log(`[Upload] Tutorial docs updated: ${wikiResult.docs.join(', ')}`);
                  }
                  item.wikiUpdated = true;

                  // Git commit and push
                  try {
                    const gitResult = await commitWikiChanges(
                      `docs: update BSP download link for ${basename}`,
                      wikiResult.modifiedFiles,
                      wikiGitOptions
                    );
                    if (gitResult.committed) {
                      if (gitResult.pushed) {
                        console.log(`[Upload] Wiki changes committed and pushed`);
                      } else {
                        console.warn(`[Upload] Wiki committed locally but push failed: ${gitResult.pushError}`);
                        console.warn(`[Upload] Please run 'git push' manually in the wiki repo`);
                      }
                    } else {
                      console.log(`[Upload] Wiki already up to date: ${gitResult.reason}`);
                    }
                  } catch (gitErr) {
                    console.error(`[Upload] Git commit failed: ${gitErr.message}`);
                  }
                } else {
                  console.warn(`[Upload] Wiki update failed: ${wikiResult.l4t.error}`);
                }
              } catch (wikiErr) {
                console.error(`[Upload] Wiki update error: ${wikiErr.message}`);
              }
            }

            // Legacy webhook wiki update (if configured)
            const wikiResult = await updateWiki(cfg, basename, item.link);
            if (wikiResult.success) {
              console.log(`[Upload] Webhook wiki updated for ${basename}`);
            } else if (!wikiResult.skipped) {
              console.error(`[Upload] Webhook wiki update failed: ${wikiResult.error}`);
            }
          } else {
            console.error(`[Upload] Link generation failed: ${linkResult.error}`);
          }

          // Update db with link info
          const db2 = await readDb();
          const existing = db2[item.filePath] || {};
          db2[item.filePath] = {
            ...existing,
            link: item.link,
            wikiUpdated: item.wikiUpdated,
          };
          await writeDb(db2);
          broadcast({ type: 'update', item });
        })().catch(err => {
          console.error('[Upload] Post-processing error:', err.message);
        });
      } else {
        item.status = 'error';
        item.error = `rclone exited with code ${code}`;
        broadcast({ type: 'update', item });
        resolve();
      }
    });

    proc.on('error', (err) => {
      item.status = 'error';
      item.error = err.message;
      broadcast({ type: 'update', item });
      resolve();
    });
  });
}

// ===================== Startup =====================
async function startup() {
  await loadConfig();
  await loadQueue();

  console.log(`[Startup] NAS root resolved to: ${NAS_ROOT}`);

  const mountResult = await ensureNasMounted();
  if (!mountResult.mounted) {
    console.warn(`[Startup] WARNING: NAS is not mounted. File scanning will likely fail.`);
    console.warn(`[Startup] To fix, run: sudo scripts/setup-systemd-mount.sh (one-time setup)`);
    console.warn(`[Startup] Or manually mount: sudo mount -t cifs ${configCache?.nasMount?.source || '//192.168.1.77/red_2t/jetson'} ${NAS_ROOT} -o ${configCache?.nasMount?.options || '...'}`);
  }

  if (!existsSync(NAS_ROOT)) {
    console.warn(`[Startup] WARNING: NAS root does not exist: ${NAS_ROOT}`);
  }

  refreshScanCache().catch(() => {});

  app.listen(PORT, () => {
    console.log(`NAS Uploader backend running on http://localhost:${PORT}`);
    console.log(`[Startup] Upload concurrency: ${getUploadConcurrency()}`);
    // Resume any queued items that survived a restart
    if (queue.some(i => i.status === 'queued')) {
      console.log(`[Startup] Resuming ${queue.filter(i => i.status === 'queued').length} queued item(s)`);
      processQueue();
    }
  });
}

startup().catch(err => {
  console.error('Startup failed:', err);
  process.exit(1);
});
