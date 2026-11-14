import path from 'node:path';

/**
 * Request and path policy for the local server.
 *
 * The server only ever talks to the app window on this machine: the Host and
 * Origin headers must name loopback, POST requests carry a marker header, and
 * Finder/URL actions are limited to paths the app produced itself.
 */

export function hostHeaderAllowed(value, port) {
  if (!value) return false;
  const host = String(value).trim().toLowerCase();
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

export function originAllowed(value, port) {
  if (!value) return true;
  const origin = String(value).trim().toLowerCase();
  return origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
}

export function postHeadersAllowed(headers = {}) {
  if (String(headers['x-vesper'] || '') !== '1') return false;
  const type = String(headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  return type === 'application/json';
}

export function isPrivateHost(hostname) {
  const host = String(hostname || '').trim().toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return true;
  if (host === '::1' || host === '0:0:0:0:0:0:0:1') return true;

  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true;
    return false;
  }

  if (/^f[cd][0-9a-f]{2}:/.test(host)) return true;
  if (/^fe80:/.test(host)) return true;
  return false;
}

export const BASE_THUMB_HOSTS = Object.freeze([
  'i.ytimg.com',
  'i9.ytimg.com',
  'i.vimeocdn.com',
  'pbs.twimg.com'
]);

export function thumbUrlAllowed(rawUrl, extraHosts = []) {
  let url;
  try {
    url = new URL(String(rawUrl || ''));
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase();
  if (isPrivateHost(host)) return false;
  if (BASE_THUMB_HOSTS.includes(host)) return true;
  if (host.endsWith('.googleusercontent.com')) return true;
  return extraHosts.some((item) => String(item || '').toLowerCase() === host);
}

export const BLOCKED_OPEN_EXTENSIONS = Object.freeze([
  '.command',
  '.app',
  '.sh',
  '.terminal',
  '.pkg',
  '.workflow'
]);

function isWithin(root, target) {
  if (!root) return false;
  const relative = path.relative(path.resolve(root), target);
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * Only paths the app itself produced are revealed: files under the output
 * folder, entries in the archive, files of current queue jobs, and the data
 * folder itself (folder mode). Bundles and scripts are never revealed.
 */
export function revealTargetAllowed(target, options = {}) {
  if (!target) return false;
  const resolved = path.resolve(String(target));
  if (options.folder) {
    return Boolean(options.dataDir) && resolved === path.resolve(options.dataDir);
  }
  if (BLOCKED_OPEN_EXTENSIONS.includes(path.extname(resolved).toLowerCase())) return false;

  if (isWithin(options.outputDir, resolved)) return true;
  const sameFile = (candidate) => Boolean(candidate) && path.resolve(String(candidate)) === resolved;
  if ((options.history || []).some((entry) => sameFile(entry?.file))) return true;
  if ((options.extraFiles || []).some(sameFile)) return true;
  return false;
}

export function openUrlAllowed(value) {
  const target = String(value || '');
  if (!target || target.length > 2048) return false;
  return /^https?:\/\//i.test(target);
}
