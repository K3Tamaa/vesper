import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  loadHistory,
  loadSettings,
  saveHistory,
  saveSettings
} from './lib/config.mjs';
import {
  binaryStatus,
  installBuild,
  probe,
  releaseInfo
} from './lib/ytdlp.mjs';
import { ffmpegStatus, installFfmpeg } from './lib/ffmpeg.mjs';
import {
  checkForUpdate,
  currentVersion,
  downloadUpdate,
  installUpdate
} from './lib/updater.mjs';
import { Queue } from './lib/jobs.mjs';
import { sanitizePresets, sanitizeSpec, specLabel } from './lib/formats.mjs';
import { dataDir, ensureDir, expandHome, prettyPath } from './lib/util.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const PORT = Number(process.env.VESPER_PORT || process.argv.find((a) => a.startsWith('--port='))?.split('=')[1] || 4173);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8'
};

let settings = loadSettings();
const queue = new Queue({ getSettings: () => settings });
const clients = new Set();
const thumbCache = new Map();

const releaseState = { nightly: null, stable: null, error: null };
const appState = { info: null, at: null, error: null, downloaded: null, checking: false };

async function refreshAppUpdate(force = false) {
  if (appState.checking) return appState.info;
  appState.checking = true;
  try {
    appState.info = await checkForUpdate({ refresh: force });
    appState.at = new Date().toISOString();
    appState.error = null;
  } catch (error) {
    appState.error = String(error?.message || error);
  } finally {
    appState.checking = false;
  }
  broadcast('status', await statusSnapshot());
  return appState.info;
}

async function refreshRelease(channel, force = false) {
  try {
    releaseState[channel] = await releaseInfo(channel, { refresh: force });
    releaseState.error = null;
  } catch (error) {
    releaseState.error = String(error?.message || error);
  }
  broadcast('status', await statusSnapshot());
}

async function statusSnapshot() {
  const binary = await binaryStatus(settings);
  const ffmpeg = await ffmpegStatus(settings);
  const release = releaseState[settings.channel];
  const latest = release?.tag || null;
  const info = appState.info;
  return {
    platform: process.platform,
    arch: process.arch,
    node: process.versions.node,
    binary: { ...binary, prettyPath: prettyPath(binary.path) },
    ffmpeg,
    release,
    releaseError: releaseState.error,
    latest,
    updateAvailable: Boolean(latest && binary.version && latest !== binary.version),
    dataDir: dataDir(),
    managedPath: prettyPath(path.join(dataDir(), 'bin', 'yt-dlp')),
    app: {
      version: currentVersion(),
      repo: 'K3Tamaa/vesper',
      latest: info?.latest || null,
      available: Boolean(info?.available),
      notesUrl: info?.release?.notesUrl || null,
      checkedAt: appState.at,
      checking: appState.checking,
      error: appState.error,
      downloaded: appState.downloaded ? { version: appState.downloaded.version } : null
    }
  };
}

async function stateSnapshot() {
  return {
    settings,
    jobs: queue.list(),
    history: loadHistory(),
    status: await statusSnapshot()
  };
}

/* --------------------------------------------------------------------- http */

function send(res, status, body, headers = {}) {
  const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers
  });
  res.end(payload);
}

function fail(res, status, message) {
  send(res, status, { error: message });
}

async function readJSON(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1_000_000) {
        reject(new Error('Request too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    res.write(payload);
  }
}

queue.on('changed', (jobs) => {
  if (queue.activeCount() === 0) {
    // still broadcast; active count drives client-side idle states
  }
  broadcast('jobs', jobs);
});
queue.on('job:finished', async (job) => {
  broadcast('history', loadHistory());
  broadcast('status', await statusSnapshot());
});
queue.on('history:changed', () => broadcast('history', loadHistory()));

/* ------------------------------------------------------------------- routes */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const route = url.pathname;
  const method = req.method || 'GET';

  try {
    if (route.startsWith('/api/')) {
      if (method === 'OPTIONS') return send(res, 204, '');
      return await handleAPI(req, res, route, url, method);
    }
    return serveStatic(req, res, route);
  } catch (error) {
    fail(res, 500, String(error?.message || error));
  }
});

async function handleAPI(req, res, route, url, method) {
  if (route === '/api/health') {
    return send(res, 200, { ok: true, name: 'Vesper', port: PORT });
  }

  if (route === '/api/state' && method === 'GET') {
    return send(res, 200, await stateSnapshot());
  }

  if (route === '/api/stream' && method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.write('retry: 2000\n\n');
    clients.add(res);
    res.write(`event: state\ndata: ${JSON.stringify(await stateSnapshot())}\n\n`);
    const keepalive = setInterval(() => res.write(': ping\n\n'), 25_000);
    req.on('close', () => {
      clearInterval(keepalive);
      clients.delete(res);
    });
    return;
  }

  if (route === '/api/settings' && method === 'POST') {
    const patch = await readJSON(req);
    const allowed = [
      'channel',
      'outputDir',
      'filenameTemplate',
      'concurrency',
      'preset',
      'cookiesBrowser',
      'binaryPath',
      'ffmpegPath',
      'extraArgs',
      'checkUpdates',
      'formatPresets',
      'defaultFormat',
      'defaultPresetId'
    ];
    const clean = {};
    for (const key of allowed) {
      if (key in patch) clean[key] = patch[key];
    }
    if ('formatPresets' in clean) clean.formatPresets = sanitizePresets(clean.formatPresets);
    if ('defaultFormat' in clean) {
      clean.defaultFormat = clean.defaultFormat ? sanitizeSpec(clean.defaultFormat) : null;
    }
    if ('defaultPresetId' in clean) {
      clean.defaultPresetId =
        typeof clean.defaultPresetId === 'string' ? clean.defaultPresetId : null;
    }
    if (typeof clean.outputDir === 'string') {
      clean.outputDir = expandHome(clean.outputDir.trim());
      if (!clean.outputDir) delete clean.outputDir;
      else ensureDir(clean.outputDir);
    }
    if (typeof clean.concurrency !== 'undefined') {
      clean.concurrency = Math.min(4, Math.max(1, Number(clean.concurrency) || 1));
    }
    if (typeof clean.channel === 'string' && !['nightly', 'stable'].includes(clean.channel)) {
      delete clean.channel;
    }
    if ('checkUpdates' in clean) clean.checkUpdates = Boolean(clean.checkUpdates);
    settings = saveSettings(clean);
    if (clean.channel) refreshRelease(clean.channel).catch(() => {});
    broadcast('status', await statusSnapshot());
    return send(res, 200, { settings });
  }

  if (route === '/api/probe' && method === 'POST') {
    const body = await readJSON(req);
    const target = String(body.url || '').trim();
    if (!/^https?:\/\//i.test(target)) {
      return fail(res, 400, 'Enter a full link starting with http:// or https://.');
    }
    const result = await probe(target, settings);
    return send(res, 200, result);
  }

  if (route === '/api/download' && method === 'POST') {
    const body = await readJSON(req);
    const target = String(body.url || '').trim();
    if (!/^https?:\/\//i.test(target)) return fail(res, 400, 'Enter a full link.');
    const spec = sanitizeSpec(body.spec);
    const items = Array.isArray(body.items)
      ? [...new Set(body.items.map((n) => Number(n)).filter((n) => Number.isInteger(n) && n > 0))].slice(0, 500)
      : null;
    const job = queue.enqueue({
      url: target,
      title: String(body.title || target).slice(0, 300),
      uploader: String(body.uploader || '').slice(0, 160),
      thumbnail: typeof body.thumbnail === 'string' ? body.thumbnail : null,
      site: String(body.site || '').slice(0, 60),
      kind: body.kind === 'playlist' ? 'playlist' : 'video',
      spec,
      formatLabel:
        typeof body.formatLabel === 'string' && body.formatLabel.trim()
          ? body.formatLabel.trim().slice(0, 120)
          : specLabel(spec),
      items: body.kind === 'playlist' ? items : null
    });
    broadcast('jobs', queue.list());
    return send(res, 200, { job });
  }

  const jobMatch = route.match(/^\/api\/jobs\/([a-z0-9_]+)(?:\/(cancel|retry|remove|reveal))?$/);
  if (jobMatch) {
    const [, id, action] = jobMatch;
    const job = queue.get(id);
    if (!job) return fail(res, 404, 'Job not found.');
    if (action === 'cancel') {
      queue.cancel(id);
      return send(res, 200, { ok: true });
    }
    if (action === 'retry') {
      queue.retry(id);
      return send(res, 200, { ok: true });
    }
    if (action === 'remove') {
      queue.remove(id);
      return send(res, 200, { ok: true });
    }
    if (action === 'reveal') {
      if (job.file && fs.existsSync(job.file)) {
        execFile('open', ['-R', job.file]);
        return send(res, 200, { ok: true });
      }
      return fail(res, 404, 'File is no longer on disk.');
    }
    return send(res, 200, { job });
  }

  if (route === '/api/queue/clear' && method === 'POST') {
    queue.clearFinished();
    return send(res, 200, { ok: true });
  }

  if (route === '/api/history/clear' && method === 'POST') {
    saveHistory([]);
    broadcast('history', []);
    return send(res, 200, { ok: true });
  }

  if (route === '/api/ffmpeg/install' && method === 'POST') {
    const result = await installFfmpeg({
      onProgress: (payload) => {
        const body = `event: install\ndata: ${JSON.stringify(payload)}\n\n`;
        for (const client of clients) client.write(body);
      }
    });
    broadcast('status', await statusSnapshot());
    return send(res, 200, { ...result, status: await statusSnapshot() });
  }

  if (route === '/api/app/update/check' && method === 'POST') {
    const info = await checkForUpdate({ refresh: true });
    appState.info = info;
    appState.at = new Date().toISOString();
    appState.error = null;
    broadcast('status', await statusSnapshot());
    return send(res, 200, info);
  }

  if (route === '/api/app/update/download' && method === 'POST') {
    const result = await downloadUpdate({
      onProgress: ({ ratio, received, total }) => {
        const body = `event: install\ndata: ${JSON.stringify({ kind: 'update', ratio, received, total })}\n\n`;
        for (const client of clients) client.write(body);
      }
    });
    appState.downloaded = result;
    broadcast('status', await statusSnapshot());
    return send(res, 200, result);
  }

  if (route === '/api/app/update/install' && method === 'POST') {
    if (!appState.downloaded) return fail(res, 400, 'Download the update first.');
    const result = installUpdate({
      dmg: appState.downloaded.path,
      appPath: process.env.VESPER_APP_PATH || '',
      pid: process.ppid
    });
    return send(res, 200, result);
  }

  const historyMatch = route.match(/^\/api\/history\/([^/]+)\/remove$/);
  if (historyMatch && method === 'POST') {
    const id = decodeURIComponent(historyMatch[1]);
    const history = loadHistory().filter((entry) => entry.id !== id);
    saveHistory(history);
    broadcast('history', history);
    return send(res, 200, { ok: true });
  }

  if (route === '/api/binary/check' && method === 'POST') {
    const body = await readJSON(req);
    const channel = body.channel === 'stable' ? 'stable' : 'nightly';
    const release = await releaseInfo(channel, { refresh: true });
    const binary = await binaryStatus(settings, { refresh: true });
    releaseState[channel] = release;
    return send(res, 200, {
      release,
      installed: binary.version,
      updateAvailable: Boolean(binary.version && binary.version !== release.tag)
    });
  }

  if (route === '/api/binary/install' && method === 'POST') {
    const body = await readJSON(req);
    const channel = body.channel === 'stable' ? 'stable' : 'nightly';
    const progressClients = clients;
    const result = await installBuild(channel, {
      onProgress: ({ ratio, received, total }) => {
        const payload = `event: install\ndata: ${JSON.stringify({ kind: 'yt-dlp', ratio, received, total })}\n\n`;
        for (const client of progressClients) client.write(payload);
      }
    });
    broadcast('status', await statusSnapshot());
    return send(res, 200, { ...result, status: await statusSnapshot() });
  }

  if (route === '/api/reveal' && method === 'POST') {
    const body = await readJSON(req);
    const target = expandHome(String(body.path || ''));
    if (!target || !fs.existsSync(target)) return fail(res, 404, 'That path does not exist.');
    execFile('open', [body.folder ? target : '-R', ...(body.folder ? [] : [target])]);
    return send(res, 200, { ok: true });
  }

  if (route === '/api/open' && method === 'POST') {
    const body = await readJSON(req);
    const target = String(body.url || '');
    if (!/^https?:\/\//i.test(target)) return fail(res, 400, 'Not a valid link.');
    execFile('open', [target]);
    return send(res, 200, { ok: true });
  }

  if (route === '/api/pick-folder' && method === 'POST') {
    if (process.platform !== 'darwin') return send(res, 200, { path: null });
    const picked = await new Promise((resolve) => {
      execFile(
        'osascript',
        ['-e', 'POSIX path of (choose folder with prompt "Choose where Vesper saves downloads")'],
        { timeout: 120_000 },
        (error, stdout) => resolve(error ? null : stdout.trim().replace(/\/$/, ''))
      );
    });
    return send(res, 200, { path: picked });
  }

  if (route === '/api/thumb' && method === 'GET') {
    const target = url.searchParams.get('u') || '';
    if (!/^https?:\/\//i.test(target)) return fail(res, 400, 'Bad image address.');
    try {
      const cached = thumbCache.get(target);
      if (cached && Date.now() - cached.at < 3_600_000) {
        return send(res, 200, cached.body, { 'Content-Type': cached.type, 'Cache-Control': 'public, max-age=3600' });
      }
      const response = await fetch(target, {
        headers: { 'User-Agent': 'Mozilla/5.0 Vesper', Accept: 'image/*' },
        signal: AbortSignal.timeout(12_000)
      });
      if (!response.ok) return fail(res, 502, 'Image unavailable.');
      const type = response.headers.get('content-type') || 'image/jpeg';
      if (!type.startsWith('image/')) return fail(res, 415, 'Not an image.');
      const body = Buffer.from(await response.arrayBuffer());
      if (body.length > 8_000_000) return fail(res, 413, 'Image too large.');
      thumbCache.set(target, { at: Date.now(), body, type });
      if (thumbCache.size > 120) thumbCache.delete(thumbCache.keys().next().value);
      return send(res, 200, body, { 'Content-Type': type, 'Cache-Control': 'public, max-age=3600' });
    } catch {
      return fail(res, 502, 'Image unavailable.');
    }
  }

  return fail(res, 404, 'Unknown endpoint.');
}

/* ------------------------------------------------------------------- static */

function serveStatic(req, res, route) {
  const clean = route === '/' ? '/index.html' : route;
  const file = path.normalize(path.join(PUBLIC, clean));
  if (!file.startsWith(PUBLIC)) return fail(res, 403, 'Forbidden');
  fs.readFile(file, (error, data) => {
    if (error) {
      if (route !== '/' && !path.extname(route)) {
        return fs.readFile(path.join(PUBLIC, 'index.html'), (fallbackError, html) => {
          if (fallbackError) return fail(res, 404, 'Not found');
          res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' });
          res.end(html);
        });
      }
      return fail(res, 404, 'Not found');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-store'
    });
    res.end(data);
  });
}

/* -------------------------------------------------------------------- start */

server.listen(PORT, '127.0.0.1', async () => {
  console.log(`Vesper running at http://127.0.0.1:${PORT}`);
  await binaryStatus(settings, { refresh: true });
  refreshRelease(settings.channel).catch(() => {});
  if (settings.checkUpdates) refreshAppUpdate(false).catch(() => {});
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Vesper may already be running.`);
    process.exit(1);
  }
  throw error;
});

function shutdown() {
  for (const job of queue.list()) {
    if (job.status === 'running') queue.cancel(job.id);
  }
  for (const client of clients) client.end();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
