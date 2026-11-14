import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { run } from './process.mjs';
import { IS_MAC, ensureDir, isExecutable, managedDir, prettyPath, which } from './util.mjs';
import { parseDigestLine, verifyDigest } from './integrity.mjs';

/**
 * ffmpeg + ffprobe, installed on demand into the Vesper data folder.
 *
 * Builds come from ffmpeg.martin-riedl.de, which publishes static macOS
 * binaries for both architectures. Every archive is checked against the
 * SHA-256 sidecar served next to it before anything is made executable.
 */

const MIRROR = 'https://ffmpeg.martin-riedl.de';
const TOOLS = ['ffmpeg', 'ffprobe'];

let statusCache = null;
let installInFlight = false;

export function resetFfmpegCache() {
  statusCache = null;
}

export function managedFfmpegDir() {
  return managedDir();
}

export function resolveFfmpeg(settings = {}) {
  const candidates = [];
  if (settings.ffmpegPath) candidates.push({ path: settings.ffmpegPath, source: 'custom' });
  for (const tool of TOOLS) {
    const managed = path.join(managedDir(), tool);
    if (isExecutable(managed)) {
      candidates.push({ path: path.join(managedDir(), 'ffmpeg'), source: 'managed', dir: managedDir() });
      break;
    }
  }
  const onPath = which('ffmpeg');
  if (onPath) candidates.push({ path: onPath, source: 'system', dir: path.dirname(onPath) });

  for (const candidate of candidates) {
    if (candidate.path && isExecutable(candidate.path)) return candidate;
  }
  return { path: null, source: 'missing', dir: null };
}

export async function ffmpegVersion(ffmpegPath) {
  if (!ffmpegPath) return null;
  const result = await run(ffmpegPath, ['-version'], { timeout: 15_000 });
  if (result.code !== 0) return null;
  const match = result.stdout.match(/ffmpeg version (\S+)/);
  return match ? match[1].split('-http')[0] : null;
}

export async function ffprobeVersion(ffprobePath) {
  if (!ffprobePath) return null;
  const result = await run(ffprobePath, ['-version'], { timeout: 15_000 });
  if (result.code !== 0) return null;
  const match = result.stdout.match(/ffprobe version (\S+)/);
  return match ? match[1].split('-http')[0] : null;
}

export async function ffmpegStatus(settings = {}) {
  const resolved = resolveFfmpeg(settings);
  const probePath = resolved.source === 'managed' ? path.join(managedDir(), 'ffprobe') : null;
  if (statusCache && statusCache.path === resolved.path && statusCache.probePath === probePath) {
    return { ...statusCache.value };
  }

  const value = {
    ...resolved,
    prettyPath: prettyPath(resolved.path),
    version: await ffmpegVersion(resolved.path),
    probeVersion: probePath ? await ffprobeVersion(probePath) : null,
    managed: resolved.source === 'managed'
  };
  statusCache = { path: resolved.path, probePath, value };
  return { ...value };
}

function archTag() {
  if (process.arch === 'x64') return 'amd64';
  if (process.arch === 'arm64') return 'arm64';
  return null;
}

async function latestArchive(tool) {
  const arch = archTag();
  if (!IS_MAC || !arch) {
    throw new Error(`No prebuilt ffmpeg is published for ${process.platform}/${process.arch}.`);
  }
  const entry = `${MIRROR}/redirect/latest/macos/${arch}/release/${tool}.zip`;
  const response = await fetch(entry, {
    redirect: 'manual',
    headers: { 'User-Agent': 'Vesper' },
    signal: AbortSignal.timeout(30_000)
  });
  const location = response.headers.get('location');
  const url = location ? new URL(location, entry).href : entry;
  const checksum = await fetch(`${url}.sha256`, {
    headers: { 'User-Agent': 'Vesper' },
    signal: AbortSignal.timeout(30_000)
  });
  if (!checksum.ok) throw new Error('ffmpeg checksum is unavailable.');
  const expected = parseDigestLine(await checksum.text());
  if (!expected) throw new Error('ffmpeg checksum could not be read.');
  return { url, expected, tool };
}

async function downloadArchive({ url, expected, tool }, { onProgress } = {}) {
  const response = await fetch(url, {
    headers: { 'User-Agent': 'Vesper' },
    redirect: 'follow',
    signal: AbortSignal.timeout(10 * 60_000)
  });
  if (!response.ok) throw new Error(`Download failed (${response.status}).`);
  const total = Number(response.headers.get('content-length')) || 0;
  const hash = crypto.createHash('sha256');
  const temp = path.join(managedDir(), `${tool}.zip.download`);
  const handle = await fs.promises.open(temp, 'w');
  let received = 0;
  try {
    for await (const chunk of response.body) {
      const buffer = Buffer.from(chunk);
      hash.update(buffer);
      received += buffer.length;
      await handle.write(buffer);
      if (onProgress) onProgress({ tool, received, total });
    }
  } finally {
    await handle.close();
  }

  const digest = hash.digest('hex');
  if (!verifyDigest(digest, expected)) {
    await fs.promises.rm(temp, { force: true });
    throw new Error(`Checksum mismatch for ${tool} — the archive was discarded.`);
  }
  return { file: temp, digest, expected, verified: verifyDigest(digest, expected) };
}

async function extractBinary(zip, tool, { onProgress } = {}) {
  const staging = path.join(managedDir(), `.${tool}-extract`);
  await fs.promises.rm(staging, { recursive: true, force: true });
  ensureDir(staging);
  if (onProgress) onProgress({ tool, phase: 'extract' });
  const result = await run('/usr/bin/unzip', ['-oq', zip, '-d', staging], { timeout: 120_000 });
  if (result.code !== 0) throw new Error(`Could not unpack ${tool}.`);

  const candidate = [path.join(staging, tool), path.join(staging, `${tool}.exe`)].find((file) =>
    fs.existsSync(file)
  );
  if (!candidate) throw new Error(`${tool} was not inside the archive.`);

  const head = Buffer.alloc(4);
  const probe = await fs.promises.open(candidate, 'r');
  await probe.read(head, 0, 4, 0);
  await probe.close();
  const magic = head.readUInt32BE(0);
  if (![0xcffaedfe, 0xcafebabe, 0xfeedfacf].includes(magic)) {
    throw new Error(`${tool} is not a macOS executable.`);
  }

  const target = path.join(managedDir(), tool);
  await fs.promises.rm(target, { force: true });
  await fs.promises.chmod(candidate, 0o755);
  await fs.promises.rename(candidate, target);
  await fs.promises.rm(staging, { recursive: true, force: true });
  await fs.promises.rm(zip, { force: true });
  return target;
}

export async function installFfmpeg({ onProgress } = {}) {
  if (installInFlight) {
    throw Object.assign(new Error('An install is already running.'), { code: 'EBUSY' });
  }
  installInFlight = true;
  try {
    return await performInstall({ onProgress });
  } finally {
    installInFlight = false;
  }
}

async function performInstall({ onProgress } = {}) {
  ensureDir(managedDir());
  const archives = [];
  for (const tool of TOOLS) {
    archives.push(await latestArchive(tool));
  }

  let verified = true;
  for (let index = 0; index < archives.length; index += 1) {
    const archive = archives[index];
    const download = await downloadArchive(archive, {
      onProgress: ({ received, total }) => {
        if (!onProgress) return;
        onProgress({
          kind: 'ffmpeg',
          tool: archive.tool,
          index,
          count: archives.length,
          ratio: total ? Math.min(1, received / total) : 0,
          received,
          total
        });
      }
    });
    verified = verified && download.verified;
    await extractBinary(download.file, archive.tool, {
      onProgress: (payload) => onProgress && onProgress({ kind: 'ffmpeg', ...payload })
    });
    if (onProgress) {
      onProgress({ kind: 'ffmpeg', tool: archive.tool, ratio: 1, received: 1, total: 1 });
    }
  }

  const ffmpeg = path.join(managedDir(), 'ffmpeg');
  const ffprobe = path.join(managedDir(), 'ffprobe');
  const version = await ffmpegVersion(ffmpeg);
  const probeVersion = await ffprobeVersion(ffprobe);
  if (!version || !probeVersion) throw new Error('ffmpeg installed but did not run.');

  resetFfmpegCache();
  return {
    version,
    probeVersion,
    path: ffmpeg,
    prettyPath: prettyPath(ffmpeg),
    verified
  };
}
