import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const HOME = os.homedir();
export const IS_MAC = process.platform === 'darwin';
export const IS_WIN = process.platform === 'win32';

export function dataDir() {
  if (process.env.VESPER_DATA) return process.env.VESPER_DATA;
  if (IS_MAC) return path.join(HOME, 'Library', 'Application Support', 'Vesper');
  if (IS_WIN) return path.join(process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming'), 'Vesper');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(HOME, '.config'), 'vesper');
}

export function managedDir() {
  return path.join(dataDir(), 'bin');
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function readJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJSON(file, value) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

export function isExecutable(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** Directories GUI-launched apps forget to include in PATH. */
export const PATH_DIRS = [
  '/opt/homebrew/bin',
  '/opt/local/bin',
  '/usr/local/bin',
  '/usr/bin',
  '/bin',
  path.join(HOME, '.local', 'bin'),
  path.join(HOME, '.nix-profile', 'bin'),
  path.join(HOME, '.pyenv', 'shims')
];

export function which(name, extraDirs = []) {
  const dirs = [...extraDirs, ...PATH_DIRS, ...(process.env.PATH || '').split(path.delimiter)];
  const exts = IS_WIN ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of dirs) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return null;
}

export function expandHome(p) {
  if (!p) return p;
  if (p === '~') return HOME;
  if (p.startsWith('~/')) return path.join(HOME, p.slice(2));
  return p;
}

export function prettyPath(p) {
  if (!p) return '';
  return p.startsWith(HOME) ? `~${p.slice(HOME.length)}` : p;
}

export function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

export function uid(prefix = 'j') {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}
