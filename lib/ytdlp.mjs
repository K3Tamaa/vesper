import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  IS_MAC,
  IS_WIN,
  ensureDir,
  isExecutable,
  managedDir,
  prettyPath,
  which
} from './util.mjs';
import { run } from './process.mjs';

const NIGHTLY_REPO = 'yt-dlp/yt-dlp-nightly-builds';
const STABLE_REPO = 'yt-dlp/yt-dlp';
const UA = 'Vesper/1.0 (+https://github.com/yt-dlp/yt-dlp-nightly-builds)';

const releaseCache = new Map();
let binaryCache = null;

export function repoFor(channel) {
  return channel === 'stable' ? STABLE_REPO : NIGHTLY_REPO;
}

function binaryName() {
  if (IS_WIN) return 'yt-dlp.exe';
  return 'yt-dlp';
}

export function managedBinaryPath() {
  return path.join(managedDir(), binaryName());
}

export function resolveBinary(settings = {}) {
  const candidates = [];
  if (settings.binaryPath) candidates.push({ path: settings.binaryPath, source: 'custom' });
  candidates.push({ path: managedBinaryPath(), source: 'managed' });

  const onPath = which('yt-dlp');
  if (onPath) candidates.push({ path: onPath, source: 'system' });

  for (const candidate of candidates) {
    if (candidate.path && isExecutable(candidate.path)) return candidate;
  }
  return { path: null, source: 'missing' };
}

export function resolveFfmpeg() {
  const bin = which('ffmpeg');
  return bin ? { path: bin, source: 'system' } : { path: null, source: 'missing' };
}

export async function binaryVersion(binaryPath) {
  if (!binaryPath) return null;
  const result = await run(binaryPath, ['--version'], { timeout: 15_000 });
  if (result.code !== 0) return null;
  return result.stdout.trim().split(/\s+/)[0] || null;
}

export async function ffmpegVersion(ffmpegPath) {
  if (!ffmpegPath) return null;
  const result = await run(ffmpegPath, ['-version'], { timeout: 15_000 });
  if (result.code !== 0) return null;
  const match = result.stdout.match(/ffmpeg version (\S+)/);
  return match ? match[1] : null;
}

export async function binaryStatus(settings, { refresh = false } = {}) {
  const resolved = resolveBinary(settings);
  if (refresh || !binaryCache || binaryCache.path !== resolved.path) {
    binaryCache = {
      path: resolved.path,
      source: resolved.source,
      version: await binaryVersion(resolved.path)
    };
  }
  return { ...binaryCache };
}

export function resetBinaryCache() {
  binaryCache = null;
}

/* ------------------------------------------------------------------ release */

function pickAssetName() {
  if (IS_WIN) return process.arch === 'arm64' ? 'yt-dlp_arm64.exe' : 'yt-dlp.exe';
  if (IS_MAC) return 'yt-dlp_macos';
  if (process.arch === 'arm64') return 'yt-dlp_linux_aarch64';
  return 'yt-dlp_linux';
}

async function githubJSON(url) {
  const headers = {
    'User-Agent': UA,
    Accept: 'application/vnd.github+json'
  };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
  if (response.status === 403) {
    throw new Error('GitHub rate limit reached. Try again later, or set GITHUB_TOKEN.');
  }
  if (!response.ok) throw new Error(`GitHub responded ${response.status}`);
  return response.json();
}

export async function releaseInfo(channel = 'nightly', { refresh = false } = {}) {
  const cached = releaseCache.get(channel);
  if (!refresh && cached && Date.now() - cached.at < 5 * 60_000) return cached.value;

  const data = await githubJSON(`https://api.github.com/repos/${repoFor(channel)}/releases/latest`);
  const assetName = pickAssetName();
  const assets = (data.assets || []).map((a) => ({
    name: a.name,
    size: a.size,
    url: a.browser_download_url
  }));
  const asset = assets.find((a) => a.name === assetName) || null;
  const sums = assets.find((a) => a.name === 'SHA2-256SUMS') || null;

  const value = {
    channel,
    repo: repoFor(channel),
    tag: data.tag_name,
    name: data.name || data.tag_name,
    publishedAt: data.published_at,
    notesUrl: data.html_url,
    asset,
    checksumsUrl: sums?.url || null,
    assetName
  };
  releaseCache.set(channel, { at: Date.now(), value });
  return value;
}

async function fetchChecksum(sumsUrl, assetName) {
  const response = await fetch(sumsUrl, {
    headers: { 'User-Agent': UA },
    signal: AbortSignal.timeout(20_000)
  });
  if (!response.ok) throw new Error('Checksum list unavailable');
  const text = await response.text();
  for (const line of text.split('\n')) {
    const match = line.trim().match(/^([a-f0-9]{64})\s+\*?(.+)$/i);
    if (match && match[2].trim() === assetName) return match[1].toLowerCase();
  }
  return null;
}

export async function installBuild(channel, { onProgress } = {}) {
  const release = await releaseInfo(channel, { refresh: true });
  if (!release.asset) throw new Error(`No build published for this platform (${release.assetName}).`);

  ensureDir(managedDir());
  const target = managedBinaryPath();
  const temp = `${target}.download`;
  const expected = release.checksumsUrl
    ? await fetchChecksum(release.checksumsUrl, release.asset.name).catch(() => null)
    : null;

  const response = await fetch(release.asset.url, {
    headers: { 'User-Agent': UA },
    redirect: 'follow',
    signal: AbortSignal.timeout(10 * 60_000)
  });
  if (!response.ok) throw new Error(`Download failed (${response.status})`);

  const total = Number(response.headers.get('content-length')) || release.asset.size || 0;
  const hash = crypto.createHash('sha256');
  let received = 0;
  const handle = await fs.promises.open(temp, 'w');
  try {
    for await (const chunk of response.body) {
      const buffer = Buffer.from(chunk);
      hash.update(buffer);
      received += buffer.length;
      await handle.write(buffer);
      if (onProgress) {
        onProgress({ received, total, ratio: total ? received / total : 0 });
      }
    }
  } finally {
    await handle.close();
  }

  const digest = hash.digest('hex');
  if (expected && digest !== expected) {
    await fs.promises.rm(temp, { force: true });
    throw new Error('Checksum mismatch — the build was discarded.');
  }

  if (IS_MAC) {
    const head = Buffer.alloc(4);
    const probe = await fs.promises.open(temp, 'r');
    await probe.read(head, 0, 4, 0);
    await probe.close();
    const magic = head.readUInt32BE(0);
    if (magic !== 0xcffaedfe && magic !== 0xcafebabe && magic !== 0xfeedfacf) {
      await fs.promises.rm(temp, { force: true });
      throw new Error('Downloaded file is not a macOS executable.');
    }
  }

  await fs.promises.chmod(temp, 0o755);
  await fs.promises.rename(temp, target);
  resetBinaryCache();
  const version = await binaryVersion(target);
  if (!version) throw new Error('The build installed but did not run.');

  return {
    version,
    path: target,
    prettyPath: prettyPath(target),
    channel,
    tag: release.tag,
    asset: release.asset.name,
    verified: Boolean(expected)
  };
}

/* --------------------------------------------------------------------- probe */

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function number(value) {
  return Number.isFinite(value) ? value : null;
}

function normalizeFormat(format) {
  const vcodec = format.vcodec && format.vcodec !== 'none' ? format.vcodec : null;
  const acodec = format.acodec && format.acodec !== 'none' ? format.acodec : null;
  const height = number(format.height);
  const isSource = !vcodec && !acodec;
  const isVideo = Boolean(vcodec);
  const isAudio = Boolean(acodec) && !isVideo;
  const isMuxed = Boolean(vcodec) && Boolean(acodec);
  const codecName = (codec) => {
    if (!codec) return null;
    if (codec.startsWith('avc1') || codec.startsWith('h264')) return 'H.264';
    if (codec.startsWith('hev1') || codec.startsWith('hvc1')) return 'HEVC';
    if (codec.startsWith('av01')) return 'AV1';
    if (codec.startsWith('vp9') || codec.startsWith('vp09')) return 'VP9';
    if (codec.startsWith('vp8')) return 'VP8';
    if (codec.startsWith('mp4a')) return 'AAC';
    if (codec.startsWith('opus')) return 'Opus';
    if (codec.startsWith('vorbis')) return 'Vorbis';
    return codec.split('.')[0].toUpperCase();
  };

  return {
    id: format.format_id,
    ext: format.ext || null,
    height,
    fps: number(format.fps),
    vcodec: codecName(vcodec),
    acodec: codecName(acodec),
    browserCodec: [vcodec, acodec].filter(Boolean).join(','),
    muxed: isMuxed || isSource,
    source: isSource,
    audio: isAudio,
    video: isVideo || isSource,
    note: text(format.format_note),
    tbr: number(format.tbr),
    abr: number(format.abr),
    size: number(format.filesize) ?? number(format.filesize_approx),
    protocol: text(format.protocol),
    dynamicRange: text(format.dynamic_range) || null
  };
}

export function normalizeFormats(rawFormats = []) {
  const formats = rawFormats
    .filter((f) => {
      if (!f.format_id || f.protocol === 'mhtml' || f.ext === 'mhtml') return false;
      const hasVideo = f.vcodec && f.vcodec !== 'none';
      const hasAudio = f.acodec && f.acodec !== 'none';
      const mediaExt = ['mp4', 'webm', 'mkv', 'mov', 'm4a', 'mp3', 'opus', 'ogg', 'flac', 'wav', 'aac'].includes(
        String(f.ext || '').toLowerCase()
      );
      return Boolean(hasVideo || hasAudio || mediaExt);
    })
    .map(normalizeFormat);

  const ranked = formats
    .filter((f) => f.video)
    .sort(
      (a, b) =>
        (b.height || 0) - (a.height || 0) ||
        (b.fps || 0) - (a.fps || 0) ||
        (a.protocol === 'm3u8_native' ? 1 : 0) - (b.protocol === 'm3u8_native' ? 1 : 0) ||
        (a.ext === 'mp4' ? 0 : 1) - (b.ext === 'mp4' ? 0 : 1) ||
        (b.tbr || 0) - (a.tbr || 0)
    );

  // one row per resolution + frame rate + dynamic range: the exact-stream list
  // is a decision aid, not a dump of every protocol yt-dlp negotiated.
  const video = [];
  const seen = new Set();
  for (const format of ranked) {
    const key = `${format.height}|${Math.round(format.fps || 0)}|${format.dynamicRange || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    video.push(format);
    if (video.length >= 12) break;
  }

  const audioSeen = new Set();
  const audio = [];
  for (const format of formats.filter((f) => f.audio).sort((a, b) => (b.abr || b.tbr || 0) - (a.abr || a.tbr || 0))) {
    const key = `${format.acodec}|${Math.round((format.abr || 0) / 32)}`;
    if (audioSeen.has(key)) continue;
    audioSeen.add(key);
    audio.push(format);
    if (audio.length >= 6) break;
  }

  return { video, audio };
}

function pickThumbnail(info) {
  const thumbs = Array.isArray(info.thumbnails) ? info.thumbnails : [];
  const scored = thumbs
    .filter((t) => t.url)
    .map((t) => ({ url: t.url, score: (t.width || 0) * (t.height || 0) + (t.preference || 0) }))
    .sort((a, b) => b.score - a.score);
  if (scored[0] && scored[0].score > 0) return scored[0].url;
  return text(info.thumbnail) || null;
}

function normalizeEntry(entry, index) {
  return {
    index: index + 1,
    id: text(entry.id),
    title: text(entry.title) || `Item ${index + 1}`,
    url: text(entry.url) || text(entry.webpage_url),
    duration: number(entry.duration),
    thumbnail: pickThumbnail(entry)
  };
}

export async function probe(url, settings) {
  const binary = resolveBinary(settings);
  if (!binary.path) {
    throw new Error('yt-dlp was not found. Open Settings → Binary to install a build.');
  }

  const result = await run(
    binary.path,
    ['-J', '--flat-playlist', '--no-warnings', '--no-colors', '--', url],
    { timeout: 75_000 }
  );

  if (result.code !== 0 || !result.stdout.trim()) {
    const lines = `${result.stderr}\n${result.stdout}`.split('\n');
    const errorLine = lines.find((line) => line.startsWith('ERROR:')) || lines.filter(Boolean).pop();
    throw new Error(
      (errorLine || 'yt-dlp could not read this link.').replace(/^ERROR:\s*/, '').slice(0, 300)
    );
  }

  let info;
  try {
    info = JSON.parse(result.stdout);
  } catch {
    throw new Error('yt-dlp returned unreadable metadata.');
  }
  if (!info) throw new Error('No media found at this address.');

  const common = {
    url: text(info.webpage_url) || url,
    title: text(info.title) || text(info.id) || 'Untitled',
    site: text(info.extractor_key) || text(info.extractor) || 'Unknown',
    duration: number(info.duration),
    thumbnail: pickThumbnail(info),
    uploader: text(info.uploader) || text(info.channel) || text(info.uploader_id),
    viewCount: number(info.view_count),
    uploadDate: text(info.upload_date),
    live: Boolean(info.is_live),
    binary: binary.source
  };

  if (info._type === 'playlist' || Array.isArray(info.entries)) {
    const rawEntries = (info.entries || []).filter(Boolean);
    const entries = rawEntries.slice(0, 200).map(normalizeEntry);
    return {
      kind: 'playlist',
      ...common,
      title: text(info.title) || 'Playlist',
      count: number(info.playlist_count) || entries.length,
      truncated: rawEntries.length > entries.length,
      entries,
      formats: { video: [], audio: [] },
      presetAvailable: false
    };
  }

  let formats = { video: [], audio: [] };
  if (Array.isArray(info.formats) && info.formats.length) {
    formats = normalizeFormats(info.formats);
  } else {
    const full = await run(binary.path, ['-J', '--no-warnings', '--no-colors', '--', url], {
      timeout: 75_000
    });
    if (full.code === 0 && full.stdout.trim()) {
      try {
        const fullInfo = JSON.parse(full.stdout);
        formats = normalizeFormats(fullInfo.formats || []);
        common.duration = common.duration ?? number(fullInfo.duration);
        common.thumbnail = common.thumbnail || pickThumbnail(fullInfo);
      } catch {}
    }
  }

  return { kind: 'video', ...common, formats, presetAvailable: true };
}
