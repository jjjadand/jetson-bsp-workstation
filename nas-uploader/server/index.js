import express from 'express';
import cors from 'cors';
import { promises as fs } from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { createReadStream } from 'fs';

const app = express();
const PORT = 3002;
const NAS_ROOT = '/other_data/NAS-stu';
const ONEDRIVE_DEST = 'onedrive:NAS-Backup';
const DB_PATH = new URL('./db.json', import.meta.url).pathname;

app.use(cors());
app.use(express.json());

// --- DB helpers ---
async function readDb() {
  try {
    const raw = await fs.readFile(DB_PATH, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function writeDb(db) {
  await fs.writeFile(DB_PATH, JSON.stringify(db, null, 2));
}

// --- File scanning ---
async function scanDir(dir, cutoff, results = []) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await scanDir(full, cutoff, results);
    } else if (entry.isFile()) {
      try {
        const stat = await fs.stat(full);
        if (!cutoff || stat.mtimeMs >= cutoff) {
          results.push({ path: full, size: stat.size, mtime: stat.mtime.toISOString() });
        }
      } catch {}
    }
  }
  return results;
}

// GET /api/files?days=1|7|30
app.get('/api/files', async (req, res) => {
  const days = parseInt(req.query.days) || 7;
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const db = await readDb();
  const files = await scanDir(NAS_ROOT, cutoff);
  res.json(files.map(f => ({ ...f, uploaded: !!db[f.path] })));
});

// GET /api/files/all
app.get('/api/files/all', async (req, res) => {
  const db = await readDb();
  const files = await scanDir(NAS_ROOT, null);
  res.json(files.map(f => ({ ...f, uploaded: !!db[f.path] })));
});

// GET /api/uploaded
app.get('/api/uploaded', async (req, res) => {
  res.json(await readDb());
});

// --- Upload queue ---
const queue = [];          // { id, filePath, status, progress, speed, error }
const sseClients = new Set();
let isProcessing = false;
const CONCURRENCY = 1;     // serial by default

function broadcast(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    client.write(msg);
  }
}

// GET /api/progress  (SSE)
app.get('/api/progress', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Send current queue state immediately
  res.write(`data: ${JSON.stringify({ type: 'queue', queue })}\n\n`);

  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

// POST /api/upload  body: { paths: [...] }
app.post('/api/upload', async (req, res) => {
  const { paths } = req.body;
  if (!Array.isArray(paths) || paths.length === 0) {
    return res.status(400).json({ error: 'paths required' });
  }
  const db = await readDb();
  const added = [];
  for (const p of paths) {
    if (!p.startsWith(NAS_ROOT)) continue;
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const item = { id, filePath: p, status: 'queued', progress: 0, speed: '', error: null, uploadedAt: null };
    queue.push(item);
    added.push(item);
  }
  broadcast({ type: 'queue', queue });
  res.json({ queued: added.length });
  processQueue();
});

async function processQueue() {
  if (isProcessing) return;
  isProcessing = true;
  while (true) {
    const item = queue.find(i => i.status === 'queued');
    if (!item) break;
    await uploadFile(item);
  }
  isProcessing = false;
}

function uploadFile(item) {
  return new Promise(resolve => {
    item.status = 'uploading';
    broadcast({ type: 'update', item });

    const rel = path.relative(NAS_ROOT, item.filePath);
    const destDir = path.join(ONEDRIVE_DEST, path.dirname(rel));
    // rclone copyto preserves the filename
    const args = ['copyto', item.filePath, `${ONEDRIVE_DEST}/${rel}`, '--progress', '--stats-one-line'];
    const proc = spawn('rclone', args);

    // rclone writes progress to stderr
    let buf = '';
    const handleChunk = (chunk) => {
      buf += chunk.toString();
      // rclone --stats-one-line outputs lines like:
      // Transferred: 1.234 MiB / 10 MiB, 12%, 1.23 MiB/s, ETA 7s
      const lines = buf.split(/\r|\n/);
      buf = lines.pop();
      for (const line of lines) {
        const m = line.match(/Transferred:.*?(\d+)%.*?([\d.]+\s*\w+\/s)/);
        if (m) {
          item.progress = parseInt(m[1]);
          item.speed = m[2];
          broadcast({ type: 'update', item });
        }
      }
    };

    proc.stderr.on('data', handleChunk);
    proc.stdout.on('data', handleChunk);

    proc.on('close', async (code) => {
      if (code === 0) {
        item.status = 'done';
        item.progress = 100;
        item.uploadedAt = new Date().toISOString();
        const db = await readDb();
        try {
          const stat = await fs.stat(item.filePath);
          db[item.filePath] = { size: stat.size, mtime: stat.mtime.toISOString(), uploadedAt: item.uploadedAt };
        } catch {
          db[item.filePath] = { uploadedAt: item.uploadedAt };
        }
        await writeDb(db);
      } else {
        item.status = 'error';
        item.error = `rclone exited with code ${code}`;
      }
      broadcast({ type: 'update', item });
      resolve();
    });

    proc.on('error', (err) => {
      item.status = 'error';
      item.error = err.message;
      broadcast({ type: 'update', item });
      resolve();
    });
  });
}

app.listen(PORT, () => {
  console.log(`NAS Uploader backend running on http://localhost:${PORT}`);
});
