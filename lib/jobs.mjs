import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { LineProcess } from './process.mjs';
import { loadJobs, saveJobs, loadHistory, saveHistory } from './config.mjs';
import { resolveBinary } from './ytdlp.mjs';
import { resolveFfmpeg } from './ffmpeg.mjs';
import { formatArgs, sanitizeSpec, specLabel } from './formats.mjs';
import { uid, ensureDir } from './util.mjs';

const PROGRESS_TEMPLATE =
  'download:vesper|%(progress.status)s|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|' +
  '%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s|' +
  '%(progress.fragment_index)s|%(progress.fragment_count)s';


function splitArgs(input) {
  if (!input || typeof input !== 'string') return [];
  const tokens = [];
  let current = '';
  let quote = null;
  let escaped = false;
  for (const char of input) {
    if (escaped) { current += char; escaped = false; continue; }
    if (char === '\\') { escaped = true; continue; }
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (/\s/.test(char)) {
      if (current) { tokens.push(current); current = ''; }
      continue;
    }
    current += char;
  }
  if (current) tokens.push(current);
  return tokens.slice(0, 40);
}

function buildArgs(job, settings, binary) {
  const args = [
    '--newline',
    '--progress',
    '--no-colors',
    '--no-mtime',
    '--no-simulate',
    '--concurrent-fragments', '4',
    '--progress-template', PROGRESS_TEMPLATE,
    '--print', 'after_move:vesper-file:%(filepath)s',
    '--paths', settings.outputDir,
    '--output', settings.filenameTemplate || '%(title).180B [%(id)s].%(ext)s'
  ];

  if (job.kind === 'playlist') {
    args.push('--yes-playlist');
    if (Array.isArray(job.items) && job.items.length) {
      args.push('--playlist-items', job.items.join(','));
    }
  } else {
    args.push('--no-playlist');
  }

  args.push(...formatArgs(job.spec).args);

  if (settings.cookiesBrowser) {
    args.push('--cookies-from-browser', settings.cookiesBrowser);
  }

  const ffmpeg = resolveFfmpeg(settings);
  if (ffmpeg.dir && ffmpeg.source !== 'system') {
    args.push('--ffmpeg-location', ffmpeg.dir);
  }

  for (const extra of splitArgs(settings.extraArgs)) args.push(extra);

  args.push('--', job.url);
  return { args, binary };
}

function nowIso() {
  return new Date().toISOString();
}

function numberOrNull(value) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export class Queue extends EventEmitter {
  constructor({ getSettings }) {
    super();
    this.getSettings = getSettings;
    this.jobs = loadJobs().map((job) => {
      if (job.status === 'running' || job.status === 'queued') {
        return { ...job, status: 'error', error: 'Interrupted when Vesper quit.', endedAt: nowIso() };
      }
      return job;
    });
    this.running = new Map();
    this.lastEmit = 0;
    this.emitTimer = null;
  }

  list() {
    return this.jobs.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  get(id) {
    return this.jobs.find((job) => job.id === id) || null;
  }

  persisted() {
    return this.jobs.map((job) => {
      const { progress, ...rest } = job;
      return rest;
    });
  }

  changed(immediate = false) {
    if (immediate) {
      saveJobs(this.persisted());
      this.emit('changed', this.list());
      return;
    }
    if (this.emitTimer) return;
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null;
      this.emit('changed', this.list());
    }, 140);
  }

  enqueue(payload) {
    const job = {
      id: uid('job'),
      url: payload.url,
      title: payload.title || payload.url,
      uploader: payload.uploader || '',
      thumbnail: payload.thumbnail || null,
      site: payload.site || '',
      kind: payload.kind || 'video',
      spec: sanitizeSpec(payload.spec),
      formatLabel: payload.formatLabel || specLabel(payload.spec),
      items: Array.isArray(payload.items) ? payload.items : null,
      status: 'queued',
      progress: { pct: null, downloaded: null, total: null, speed: null, eta: null },
      itemIndex: null,
      itemCount: Array.isArray(payload.items) ? payload.items.length : null,
      createdAt: nowIso(),
      startedAt: null,
      endedAt: null,
      file: null,
      size: null,
      error: null,
      log: []
    };
    this.jobs.unshift(job);
    this.changed(true);
    this.pump();
    return job;
  }

  activeCount() {
    return this.running.size;
  }

  pump() {
    const settings = this.getSettings();
    const limit = Math.min(4, Math.max(1, settings.concurrency || 1));
    const queued = this.jobs
      .filter((job) => job.status === 'queued')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    for (const job of queued) {
      if (this.running.size >= limit) break;
      this.start(job);
    }
  }

  start(job) {
    const settings = this.getSettings();
    const binary = resolveBinary(settings);
    if (!binary.path) {
      job.status = 'error';
      job.error = 'yt-dlp is not installed. Open Settings → Binary.';
      job.endedAt = nowIso();
      this.changed(true);
      return;
    }

    const { args } = buildArgs(job, settings, binary);
    const proc = new LineProcess(binary.path, args, { cwd: settings.outputDir });
    ensureDir(settings.outputDir);
    this.running.set(job.id, proc);
    job.status = 'running';
    job.startedAt = nowIso();
    job.pid = proc.pid;
    this.changed(true);

    let lastFile = null;

    proc.on('line', ({ channel, line }) => {
      if (line.startsWith('vesper|')) {
        const [, status, downloaded, total, estimate, speed, eta, fragIndex, fragCount] = line.split('|');
        const totalBytes = numberOrNull(total) ?? numberOrNull(estimate);
        const received = numberOrNull(downloaded);
        const pct = totalBytes && received ? Math.min(100, (received / totalBytes) * 100) : null;
        job.progress = {
          pct,
          downloaded: received,
          total: totalBytes,
          speed: numberOrNull(speed),
          eta: numberOrNull(eta),
          status: status || 'downloading'
        };
        job.fragments = fragIndex && fragCount && fragCount !== 'NA' ? `${fragIndex}/${fragCount}` : null;
        this.changed();
        return;
      }

      if (line.startsWith('vesper-file:')) {
        lastFile = line.slice('vesper-file:'.length).trim() || null;
        if (lastFile) {
          job.file = lastFile;
          job.files = [...(job.files || []), lastFile];
        }
        return;
      }

      const itemMatch = line.match(/Downloading item (\d+) of (\d+)/);
      if (itemMatch) {
        job.itemIndex = Number(itemMatch[1]);
        job.itemCount = Number(itemMatch[2]);
        job.progress = { pct: null, downloaded: null, total: null, speed: null, eta: null };
        this.changed(true);
        return;
      }

      if (line.startsWith('ERROR:') || line.startsWith('[ERROR]')) {
        job.log.push(line.slice(0, 400));
        if (job.log.length > 12) job.log.shift();
        return;
      }

      if (channel === 'stderr' && /error/i.test(line) && job.log.length < 12) {
        job.log.push(line.slice(0, 400));
      }
    });

    proc.on('failed', (error) => {
      job.status = 'error';
      job.error = String(error?.message || error);
      job.endedAt = nowIso();
      this.finish(job);
    });

    proc.on('exit', ({ code, signal }) => {
      const current = this.running.get(job.id);
      if (current !== proc) return;
      this.running.delete(job.id);

      if (job.status === 'canceled') {
        finished(this, job);
        return;
      }
      if (signal || code !== 0) {
        job.status = 'error';
        job.error =
          job.log[0]?.replace(/^ERROR:\s*/, '') ||
          (signal ? 'Stopped before the download finished.' : `yt-dlp exited with code ${code}.`);
        job.endedAt = nowIso();
      } else {
        job.status = 'done';
        job.endedAt = nowIso();
        job.progress = { ...job.progress, pct: 100, speed: null, eta: 0 };
        job.file = job.file || lastFile;
        const produced = [...new Set([...(job.files || []), ...(job.file ? [job.file] : [])])];
        let total = 0;
        for (const file of produced) {
          try {
            total += fs.statSync(file).size;
          } catch {}
        }
        job.size = total || null;
        job.file = produced[produced.length - 1] || job.file;
        recordHistory(this, job);
      }
      finished(this, job);
    });
  }

  finish(job) {
    this.running.delete(job.id);
    finished(this, job);
  }

  cancel(id) {
    const job = this.get(id);
    if (!job) return false;
    if (job.status === 'queued') {
      job.status = 'canceled';
      job.endedAt = nowIso();
      this.changed(true);
      return true;
    }
    const proc = this.running.get(id);
    if (!proc) return false;
    job.status = 'canceled';
    proc.stop('SIGTERM');
    setTimeout(() => {
      if (this.running.get(id) === proc) proc.stop('SIGKILL');
    }, 4000);
    this.changed(true);
    return true;
  }

  retry(id) {
    const job = this.get(id);
    if (!job || ['running', 'queued'].includes(job.status)) return false;
    job.status = 'queued';
    job.error = null;
    job.progress = { pct: null, downloaded: null, total: null, speed: null, eta: null };
    job.startedAt = null;
    job.endedAt = null;
    job.createdAt = nowIso();
    this.changed(true);
    this.pump();
    return true;
  }

  remove(id) {
    const index = this.jobs.findIndex((job) => job.id === id);
    if (index < 0) return false;
    const job = this.jobs[index];
    if (['running', 'queued'].includes(job.status)) this.cancel(id);
    this.jobs.splice(index, 1);
    this.changed(true);
    return true;
  }

  clearFinished() {
    this.jobs = this.jobs.filter((job) => ['running', 'queued'].includes(job.status));
    this.changed(true);
  }
}

function finished(queue, job) {
  delete job.pid;
  queue.changed(true);
  queue.emit('job:finished', job);
  queue.pump();
}

function recordHistory(queue, job) {
  if (!job.file) return;
  const history = loadHistory();
  history.unshift({
    id: job.id,
    title: job.title,
    uploader: job.uploader,
    site: job.site,
    url: job.url,
    file: job.file,
    size: job.size,
    formatLabel: job.formatLabel,
    thumbnail: job.thumbnail,
    at: job.endedAt || nowIso(),
    kind: job.kind,
    count: job.kind === 'playlist' ? job.itemCount : 1
  });
  saveHistory(history.slice(0, 300));
  queue.emit('history:changed');
}

export { splitArgs };
