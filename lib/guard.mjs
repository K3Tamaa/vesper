import path from 'node:path';
import { expandHome, isExecutable } from './util.mjs';

/**
 * Input guards for values that end up on a command line.
 *
 * `extraArgs` is free-form by design, but a handful of yt-dlp options turn it
 * into code execution (or write outside the chosen folder), so they are
 * refused. Paths are only accepted when they are absolute and executable.
 */

export const MAX_EXTRA_TOKENS = 40;

export const DANGEROUS_OPTIONS = Object.freeze([
  '--exec',
  '--exec-before-download',
  '--config-locations',
  '--downloader',
  '--batch-file',
  '--paths',
  '--output',
  '-o',
  '--plugin-dirs',
  '--external-downloader'
]);

export const COOKIE_BROWSERS = Object.freeze([
  'chrome',
  'firefox',
  'safari',
  'brave',
  'edge',
  'chromium',
  'opera',
  'vivaldi',
  'whale'
]);

function tokenize(input) {
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
  return tokens;
}

export function splitArgs(input) {
  const tokens = tokenize(input);
  if (tokens.length > MAX_EXTRA_TOKENS) {
    throw new Error(`Too many extra arguments (max ${MAX_EXTRA_TOKENS}).`);
  }
  return tokens;
}

export function isDangerousToken(token) {
  if (!token) return false;
  const flag = (token.includes('=') ? token.slice(0, token.indexOf('=')) : token).toLowerCase();
  if (DANGEROUS_OPTIONS.includes(flag)) return true;
  // yt-dlp also accepts the short output flag as one token: -oPATH or -o=PATH.
  if (/^-o(=|.)/i.test(token) && !token.startsWith('-O')) return true;
  return false;
}

/** Validate free-form arguments before they are stored. */
export function checkExtraArgs(input) {
  const raw = typeof input === 'string' ? input.trim() : '';
  if (!raw) return { ok: true, args: [], rejected: [], error: null, value: '' };

  let tokens;
  try {
    tokens = splitArgs(raw);
  } catch (error) {
    return { ok: false, args: [], rejected: [], error: error.message, value: '' };
  }

  const rejected = tokens.filter((token) => isDangerousToken(token));
  if (rejected.length) {
    return {
      ok: false,
      args: [],
      rejected,
      error: `These options are not allowed: ${rejected.join(', ')}`,
      value: ''
    };
  }
  return { ok: true, args: tokens, rejected: [], error: null, value: raw };
}

/** Build-time filter: old settings files may still contain a blocked option. */
export function filterExtraTokens(input) {
  if (!input || typeof input !== 'string') return [];
  const tokens = tokenize(input).slice(0, MAX_EXTRA_TOKENS);
  const kept = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!isDangerousToken(token)) {
      kept.push(token);
      continue;
    }
    // A blocked option usually carries a value in the next token; drop both.
    if (!token.includes('=')) index += 1;
  }
  return kept;
}

export function checkExecutablePath(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return { ok: true, path: '', error: null };
  const expanded = expandHome(raw);
  if (!path.isAbsolute(expanded)) {
    return { ok: false, path: '', error: 'Use an absolute path to an executable.' };
  }
  if (!isExecutable(expanded)) {
    return { ok: false, path: '', error: 'That file is missing or not executable.' };
  }
  return { ok: true, path: expanded, error: null };
}

export function checkCookiesBrowser(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return { ok: true, value: '', error: null };
  const match = raw.match(/^([a-z]+)(?:\+[A-Za-z0-9_]+)?(?::[^:]{1,64})?$/);
  if (!match || !COOKIE_BROWSERS.includes(match[1])) {
    return { ok: false, value: '', error: `Unknown browser "${raw}".` };
  }
  return { ok: true, value: raw, error: null };
}
