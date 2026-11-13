import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dataDir, ensureDir, prettyPath } from './util.mjs';

/**
 * Application updates.
 *
 * Vesper reads its own release feed on GitHub, downloads the published DMG,
 * verifies the SHA-256 in the release's SHA256SUMS file, then hands the DMG
 * to a detached helper that waits for the app to quit before swapping the
 * bundle. No update service, no identifiers, no background daemon.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP_REPO = process.env.VESPER_REPO || 'K3Tamaa/vesper';
const BUNDLE_ID = 'studio.vesper.client';
const UA = 'Vesper-Updater';

let cached = null;

export function currentVersion() {
  if (process.env.VESPER_VERSION) return process.env.VESPER_VERSION;
  for (const file of [path.join(ROOT, 'VERSION'), path.join(ROOT, 'Contents', 'Resources', 'VERSION')]) {
    try {
      const value = fs.readFileSync(file, 'utf8').trim();
      if (value) return value;
    } catch {}
  }
  return '0.0.0';
}

export function updateDir() {
  return path.join(dataDir(), 'updates');
}

function parseVersion(value) {
  return String(value || '')
    .replace(/^v/i, '')
    .split('-')[0]
    .split('.')
    .map((part) => Number.parseInt(part, 10) || 0);
}

export function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const diff = (left[index] || 0) - (right[index] || 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

async function githubJSON(url) {
  const response = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(20_000)
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`GitHub responded ${response.status}.`);
  return response.json();
}

export async function checkForUpdate({ refresh = false } = {}) {
  const current = currentVersion();
  if (!refresh && cached && Date.now() - cached.at < 10 * 60_000) {
    return { ...cached.value, current };
  }

  const data = await githubJSON(`https://api.github.com/repos/${APP_REPO}/releases/latest`);
  if (!data || data.draft || data.prerelease) {
    const value = { available: false, current, latest: current, release: null, repo: APP_REPO };
    cached = { at: Date.now(), value };
    return value;
  }

  const tag = data.tag_name || data.name || '';
  const latest = tag.replace(/^v/i, '');
  const assets = (data.assets || []).map((asset) => ({
    name: asset.name,
    size: asset.size,
    url: asset.browser_download_url
  }));
  const asset = assets.find((item) => /\.dmg$/i.test(item.name)) || null;
  const sums = assets.find((item) => /^SHA256SUMS(\.txt)?$/i.test(item.name)) || null;

  const value = {
    available: Boolean(asset) && compareVersions(latest, current) > 0,
    current,
    latest,
    tag,
    release: {
      tag,
      name: data.name || tag,
      publishedAt: data.published_at,
      notesUrl: data.html_url,
      notes: data.body || '',
      asset,
      checksumsUrl: sums?.url || null
    },
    repo: APP_REPO
  };
  cached = { at: Date.now(), value };
  return value;
}

async function fetchExpectedSum(url, assetName) {
  if (!url) return null;
  const response = await fetch(url, {
    headers: { 'User-Agent': UA },
    signal: AbortSignal.timeout(20_000)
  });
  if (!response.ok) return null;
  const text = await response.text();
  for (const line of text.split('\n')) {
    const match = line.trim().match(/^([a-f0-9]{64})\s+\*?(.+)$/i);
    if (match && match[2].trim() === assetName) return match[1].toLowerCase();
  }
  return null;
}

export async function downloadUpdate({ onProgress } = {}) {
  const info = await checkForUpdate({ refresh: true });
  if (!info.available || !info.release?.asset) throw new Error('No update is available.');

  const { asset } = info.release;
  ensureDir(updateDir());
  const target = path.join(updateDir(), `Vesper-${info.latest}.dmg`);
  const temp = `${target}.download`;
  const expected = await fetchExpectedSum(info.release.checksumsUrl, asset.name).catch(() => null);

  const response = await fetch(asset.url, {
    headers: { 'User-Agent': UA },
    redirect: 'follow',
    signal: AbortSignal.timeout(20 * 60_000)
  });
  if (!response.ok) throw new Error(`Download failed (${response.status}).`);

  const total = Number(response.headers.get('content-length')) || asset.size || 0;
  const hash = crypto.createHash('sha256');
  const handle = await fs.promises.open(temp, 'w');
  let received = 0;
  try {
    for await (const chunk of response.body) {
      const buffer = Buffer.from(chunk);
      hash.update(buffer);
      received += buffer.length;
      await handle.write(buffer);
      if (onProgress) onProgress({ received, total, ratio: total ? received / total : 0 });
    }
  } finally {
    await handle.close();
  }

  const digest = hash.digest('hex');
  if (expected && digest !== expected) {
    await fs.promises.rm(temp, { force: true });
    throw new Error('Checksum mismatch — the update was discarded.');
  }

  await fs.promises.rename(temp, target);
  return {
    path: target,
    prettyPath: prettyPath(target),
    version: info.latest,
    size: received,
    verified: Boolean(expected)
  };
}

function helperScript(appPath, dmgPath, pid) {
  const root = updateDir();
  ensureDir(root);
  const script = path.join(root, 'install.sh');
  const body = `#!/bin/sh
set -eu
APP="$1"
DMG="$2"
PID="$3"
MOUNT=$(mktemp -d /tmp/vesper-update.XXXXXX)
cleanup() {
  hdiutil detach "$MOUNT" -quiet >/dev/null 2>&1 || true
  rmdir "$MOUNT" >/dev/null 2>&1 || true
}
trap cleanup EXIT

while kill -0 "$PID" 2>/dev/null; do sleep 0.4; done

hdiutil attach "$DMG" -nobrowse -readonly -mountpoint "$MOUNT" >/dev/null
if [ ! -d "$MOUNT/Vesper.app" ]; then
  echo "Vesper.app missing from the update image" >&2
  exit 1
fi

NEW="$APP.new"
OLD="$APP.old"
rm -rf "$NEW" "$OLD"
ditto "$MOUNT/Vesper.app" "$NEW"
xattr -dr com.apple.quarantine "$NEW" >/dev/null 2>&1 || true
if [ -d "$APP" ]; then mv "$APP" "$OLD"; fi
if ! mv "$NEW" "$APP"; then
  if [ -d "$OLD" ]; then mv "$OLD" "$APP"; fi
  exit 1
fi
rm -rf "$OLD"
cleanup
trap - EXIT
rm -f "$DMG"
open "$APP"
`;
  fs.writeFileSync(script, body, { mode: 0o755 });
  return script;
}

export function installUpdate({ dmg, appPath, pid }) {
  if (!dmg || !fs.existsSync(dmg)) throw new Error('The downloaded update is missing.');
  if (!appPath || !appPath.endsWith('.app')) {
    throw new Error('Updates are only available from the packaged app.');
  }
  if (!fs.existsSync(appPath)) throw new Error('The application bundle could not be located.');
  if (path.dirname(dmg) !== updateDir()) throw new Error('Unexpected update path.');

  const script = helperScript(appPath, dmg, Number(pid) || process.ppid);
  const child = spawn('/bin/sh', [script, appPath, dmg, String(Number(pid) || process.ppid)], {
    detached: true,
    stdio: 'ignore'
  });
  child.unref();

  // The helper waits for this PID to disappear, so ask the shell to quit
  // normally. The server is a child of the app and dies with it.
  setTimeout(() => {
    spawn('/usr/bin/osascript', ['-e', `tell application id "${BUNDLE_ID}" to quit`], {
      detached: true,
      stdio: 'ignore'
    }).unref();
  }, 500);

  return { ok: true };
}
