import path from 'node:path';
import {
  HOME,
  dataDir,
  ensureDir,
  readJSON,
  writeJSON
} from './util.mjs';
import { BUILTIN_SPEC, legacySpec, sanitizePresets, sanitizeSpec } from './formats.mjs';

const settingsFile = () => path.join(dataDir(), 'settings.json');
const historyFile = () => path.join(dataDir(), 'history.json');
const jobsFile = () => path.join(dataDir(), 'jobs.json');

export const PRESETS = [
  { id: 'best', label: 'Best', hint: 'Highest resolution available' },
  { id: '1080', label: '1080p', hint: 'Full HD, H.264 preferred' },
  { id: '720', label: '720p', hint: 'HD, smallest useful size' },
  { id: 'mp3', label: 'MP3', hint: 'Audio only, 320 kbps' },
  { id: 'm4a', label: 'M4A', hint: 'Audio only, AAC' },
  { id: 'custom', label: 'Custom', hint: 'Pick an exact stream' }
];

export const DEFAULTS = {
  channel: 'nightly',
  outputDir: path.join(HOME, 'Movies', 'Vesper'),
  filenameTemplate: '%(title).180B [%(id)s].%(ext)s',
  concurrency: 2,
  preset: 'best',
  cookiesBrowser: '',
  binaryPath: '',
  ffmpegPath: '',
  extraArgs: '',
  checkUpdates: true,
  formatPresets: [],
  defaultFormat: null,
  defaultPresetId: null
};

export function loadSettings() {
  const stored = readJSON(settingsFile(), {});
  const settings = { ...DEFAULTS, ...stored };
  settings.outputDir = settings.outputDir || DEFAULTS.outputDir;
  settings.concurrency = Math.min(4, Math.max(1, Number(settings.concurrency) || 2));
  if (!PRESETS.some((p) => p.id === settings.preset)) settings.preset = DEFAULTS.preset;
  settings.formatPresets = sanitizePresets(stored.formatPresets);
  settings.defaultFormat = stored.defaultFormat
    ? sanitizeSpec(stored.defaultFormat)
    : stored.preset && stored.preset !== 'best'
      ? legacySpec(stored.preset)
      : null;
  settings.defaultPresetId =
    typeof stored.defaultPresetId === 'string' &&
    settings.formatPresets.some((preset) => preset.id === stored.defaultPresetId)
      ? stored.defaultPresetId
      : null;
  return settings;
}

export function saveSettings(patch) {
  const next = { ...loadSettings(), ...patch };
  next.concurrency = Math.min(4, Math.max(1, Number(next.concurrency) || 2));
  next.formatPresets = sanitizePresets(next.formatPresets);
  next.defaultFormat = next.defaultFormat ? sanitizeSpec(next.defaultFormat) : null;
  next.defaultPresetId =
    typeof next.defaultPresetId === 'string' &&
    next.formatPresets.some((preset) => preset.id === next.defaultPresetId)
      ? next.defaultPresetId
      : null;
  writeJSON(settingsFile(), next);
  ensureDir(next.outputDir);
  return next;
}

export function loadHistory() {
  const list = readJSON(historyFile(), []);
  return Array.isArray(list) ? list : [];
}

export function saveHistory(list) {
  writeJSON(historyFile(), list.slice(0, 300));
}

export function loadJobs() {
  const list = readJSON(jobsFile(), []);
  return Array.isArray(list) ? list : [];
}

export function saveJobs(list) {
  writeJSON(
    jobsFile(),
    list
      // Jobs are stored newest-first, so the head of the list is the most recent.
      .slice(0, 80)
      .map((j) => ({ ...j, log: (j.log || []).slice(-8) }))
  );
}
