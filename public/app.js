const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const state = {
  settings: null,
  status: null,
  jobs: [],
  history: [],
  result: null,
  spec: null,
  extrasOpen: false,
  playlistSelected: new Set(),
  view: 'inspect',
  busy: false,
  installing: false,
  lastUrl: '',
  queueOpen: false,
  ready: false
};

const jobNodes = new Map();
const toastsEl = $('#toasts');

/* ------------------------------------------------------------------ helpers */

const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

function setText(element, value) {
  if (!element) return;
  const first = element.firstChild;
  if (first && first.nodeType === 3 && element.childNodes.length === 1) {
    if (first.data !== value) first.data = value;
    return;
  }
  if (element.textContent !== value) element.textContent = value;
}

function fmtBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) { value /= 1024; index += 1; }
  return `${value >= 100 || index === 0 ? Math.round(value) : value.toFixed(1)} ${units[index]}`;
}

function fmtDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

function fmtEta(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function fmtAgo(iso) {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';
  const diff = Math.max(0, Date.now() - then);
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function fmtDate(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function thumbUrl(url) {
  return url ? `/api/thumb?u=${encodeURIComponent(url)}` : '';
}

async function api(path, options = {}) {
  const method = options.method || (options.body ? 'POST' : 'GET');
  const headers = { 'X-Vesper': '1' };
  if (method !== 'GET' && method !== 'HEAD') headers['Content-Type'] = 'application/json';
  const response = await fetch(path, {
    method,
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  if (Array.isArray(data.warnings) && data.warnings.length) {
    toast(data.warnings[0], 'bad');
  }
  return data;
}

function toast(message, tone = 'ok') {
  const node = document.createElement('div');
  node.className = 'toast';
  node.innerHTML = `<span class="lamp" data-tone="${tone}"></span><span>${esc(message)}</span>`;
  toastsEl.append(node);
  requestAnimationFrame(() => node.classList.add('is-in'));
  setTimeout(() => {
    node.classList.remove('is-in');
    setTimeout(() => node.remove(), 220);
  }, 3200);
}

function copy(text) {
  navigator.clipboard?.writeText(text).then(
    () => toast('Link copied'),
    () => toast('Could not copy', 'bad')
  );
}

/* --------------------------------------------------------------------- boot */

async function boot() {
  bindChrome();
  bindIntake();
  bindSettings();
  bindQueue();
  bindArchive();
  try {
    const snapshot = await api('/api/state');
    applyState(snapshot);
  } catch (error) {
    toast(String(error.message || error), 'bad');
  }
  connectStream();
  state.ready = true;
  applyView(state.view, false);
}

function connectStream() {
  const source = new EventSource('/api/stream');
  source.addEventListener('state', (event) => applyState(JSON.parse(event.data)));
  source.addEventListener('jobs', (event) => {
    const next = JSON.parse(event.data);
    const previous = new Map(state.jobs.map((job) => [job.id, job.status]));
    state.jobs = next;
    renderQueue();
    for (const job of next) {
      const before = previous.get(job.id);
      if (!before || before === job.status) continue;
      if (job.status === 'done') toast(`Finished · ${job.title}`, 'ok');
      if (job.status === 'error') toast(`Failed · ${job.title}`, 'bad');
    }
  });
  source.addEventListener('history', (event) => {
    state.history = JSON.parse(event.data);
    renderArchive();
  });
  source.addEventListener('status', (event) => {
    state.status = JSON.parse(event.data);
    renderStatus();
    renderSettings();
  });
  source.addEventListener('install', (event) => {
    const data = JSON.parse(event.data);
    renderInstallProgress(data);
  });
}

function applyState(snapshot) {
  if (!snapshot) return;
  if (snapshot.settings) state.settings = snapshot.settings;
  if (snapshot.status) state.status = snapshot.status;
  if (snapshot.jobs) state.jobs = snapshot.jobs;
  if (snapshot.history) state.history = snapshot.history;
  if (!state.spec) state.spec = defaultSpec();
  renderStatus();
  renderSettings();
  renderQueue();
  renderArchive();
  renderCommit();
}

/* ------------------------------------------------------------------- chrome */

function bindChrome() {
  $$('.rail-btn').forEach((button) => {
    button.addEventListener('click', () => applyView(button.dataset.view));
  });
  $$('[data-goto]').forEach((button) => {
    button.addEventListener('click', () => applyView(button.dataset.goto));
  });
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (state.queueOpen) { toggleQueue(false); return; }
      if (state.extrasOpen) { setExtrasOpen(false); return; }
      if (state.result) { clearStage(); return; }
      const input = $('#url');
      if (document.activeElement === input && input.value) {
        input.value = '';
        $('#inspectBtn').disabled = true;
      }
      return;
    }
    if (!event.metaKey) return;
    if (event.key === '1') { event.preventDefault(); applyView('inspect'); }
    if (event.key === '2') { event.preventDefault(); applyView('archive'); }
    if (event.key === '3') { event.preventDefault(); applyView('settings'); }
    if (event.key === 'Enter' && state.view === 'inspect') {
      event.preventDefault();
      $('#urlForm').requestSubmit();
    }
  });

  $('#queueToggle').addEventListener('click', () => toggleQueue());
  $('#queueScrim').addEventListener('click', () => toggleQueue(false));
  window.addEventListener('resize', () => {
    if (!window.matchMedia('(max-width: 1180px)').matches) toggleQueue(false, true);
  });
}

function applyView(view, animate = true) {
  if (!view) return;
  if (state.view === view && state.ready) {
    if (view === 'inspect') $('#url').focus();
    return;
  }
  state.view = view;
  $$('.rail-btn').forEach((button) => {
    const active = button.dataset.view === view;
    button.classList.toggle('is-active', active);
    if (active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  $$('.view').forEach((section) => {
    const active = section.dataset.view === view;
    section.classList.toggle('is-active', active);
    section.classList.remove('is-entering');
    if (active && animate && state.ready) {
      void section.offsetWidth;
      section.classList.add('is-entering');
      setTimeout(() => section.classList.remove('is-entering'), 240);
    }
  });
  if (view === 'settings') renderSettings();
  if (view === 'archive') renderArchive();
  $('#views').scrollTop = 0;
}

function toggleQueue(force, instant = false) {
  const narrow = window.matchMedia('(max-width: 1180px)').matches;
  if (!narrow) {
    state.queueOpen = false;
    $('#queue').classList.remove('is-open');
    $('#queueScrim').classList.remove('is-open');
    return;
  }
  const open = typeof force === 'boolean' ? force : !state.queueOpen;
  state.queueOpen = open;
  const queue = $('#queue');
  const scrim = $('#queueScrim');
  scrim.hidden = false;
  if (instant) queue.style.transition = 'none';
  requestAnimationFrame(() => {
    queue.classList.toggle('is-open', open);
    scrim.classList.toggle('is-open', open);
    if (instant) requestAnimationFrame(() => { queue.style.transition = ''; });
  });
  if (!open) {
    scrim.classList.remove('is-open');
    setTimeout(() => { if (!state.queueOpen) scrim.hidden = true; }, 240);
  }
}

/* ------------------------------------------------------------------- intake */

function bindIntake() {
  const input = $('#url');
  const form = $('#urlForm');

  input.addEventListener('input', () => {
    $('#inspectBtn').disabled = !normalizeUrl(input.value);
  });

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    inspect(normalizeUrl(input.value));
  });

  $('#errorRetry').addEventListener('click', () => inspect(state.lastUrl));
  $('#outputPath').addEventListener('click', chooseFolder);
  $('#downloadBtn').addEventListener('click', startDownload);
  $('#clearQueue').addEventListener('click', async () => {
    await api('/api/queue/clear', { method: 'POST' });
    toast('Queue cleared');
  });
}

function normalizeUrl(raw) {
  let value = String(raw || '').trim();
  if (!value) return '';
  if (value.startsWith('//')) value = `https:${value}`;
  if (!/^https?:\/\//i.test(value) && /^[\w.-]+\.[a-z]{2,}([/:?#]|$)/i.test(value)) {
    value = `https://${value}`;
  }
  return /^https?:\/\/\S+$/i.test(value) ? value : '';
}

function clearStage() {
  state.result = null;
  state.spec = null;
  state.extrasOpen = false;
  $('#result').innerHTML = '';
  $('#stageEmpty').hidden = false;
  $('#stageError').hidden = true;
  $('#skeleton').hidden = true;
  $('#commit').hidden = true;
}

async function inspect(url) {
  if (!url || state.busy) return;
  state.busy = true;
  state.lastUrl = url;
  state.result = null;
  state.spec = defaultSpec();
  state.extrasOpen = false;
  $('#result').innerHTML = '';
  $('#stageEmpty').hidden = true;
  $('#stageError').hidden = true;
  $('#skeleton').hidden = false;
  $('#commit').hidden = true;
  $('#inspectBtn').textContent = 'Reading…';
  $('#inspectBtn').disabled = true;

  try {
    const result = await api('/api/probe', { body: { url } });
    state.result = result;
    state.spec = defaultSpec();
    state.playlistSelected = new Set((result.entries || []).map((entry) => entry.index));
    renderResult();
  } catch (error) {
    $('#stageErrorTitle').textContent = 'Could not read that link';
    $('#stageErrorBody').textContent = error.message;
    $('#stageError').hidden = false;
  } finally {
    state.busy = false;
    $('#skeleton').hidden = true;
    $('#inspectBtn').textContent = 'Inspect';
    $('#inspectBtn').disabled = !normalizeUrl($('#url').value);
    renderCommit();
  }
}

/* ------------------------------------------------------------------- result */

const BUILTIN_SPEC = {
  kind: 'video',
  container: 'mp4',
  quality: 'best',
  sort: 'default',
  extras: { sponsorblock: 'off', metadata: false, thumbnail: false, subtitles: 'off', chapters: 'off', legacy: false }
};

const VIDEO_COMMON = ['mp4', 'mov', 'mkv', 'webm'];
const VIDEO_OTHER = ['avi', 'flv'];
const AUDIO_COMMON = ['mp3', 'm4a', 'wav', 'flac'];
const AUDIO_OTHER = ['opus', 'ogg', 'aac', 'aiff', 'alac'];
const VIDEO_QUALITIES = ['best', '2160', '1440', '1080', '720', '480', '360'];
const AUDIO_QUALITIES = ['best', '320', '192', '128'];
const LOSSLESS = ['wav', 'flac', 'aiff', 'alac'];

const FORMAT_TITLE = {
  mp4: 'MP4', mov: 'MOV', mkv: 'MKV', webm: 'WEBM', avi: 'AVI', flv: 'FLV',
  mp3: 'MP3', m4a: 'M4A', wav: 'WAV', flac: 'FLAC', opus: 'OPUS', ogg: 'OGG', aac: 'AAC',
  aiff: 'AIFF', alac: 'ALAC'
};

const FORMAT_NOTE = {
  avi: 're-encode', flv: 're-encode', mov: 'remux',
  opus: 'lossy', ogg: 'vorbis', aac: 'lossy', aiff: 'lossless', alac: 'lossless'
};

const SORT_LABEL = {
  default: 'Best quality',
  h264: 'Prefer H.264',
  av1: 'Prefer AV1',
  small: 'Smallest file'
};

const QUALITY_LABEL = { best: 'Best', '2160': '2160p', '1440': '1440p', '1080': '1080p', '720': '720p', '480': '480p', '360': '360p' };
const BITRATE_LABEL = { best: 'Best', '320': '320k', '192': '192k', '128': '128k' };

function cloneSpec(spec) {
  return JSON.parse(JSON.stringify(spec));
}

function normalizeSpec(input) {
  const kind = input?.kind === 'audio' ? 'audio' : 'video';
  const containers = kind === 'audio' ? [...AUDIO_COMMON, ...AUDIO_OTHER] : [...VIDEO_COMMON, ...VIDEO_OTHER];
  const qualities = kind === 'audio' ? AUDIO_QUALITIES : VIDEO_QUALITIES;
  const extras = input?.extras || {};
  return {
    kind,
    container: containers.includes(input?.container) ? input.container : kind === 'audio' ? 'mp3' : 'mp4',
    quality: qualities.includes(String(input?.quality)) ? String(input.quality) : 'best',
    sort: ['default', 'h264', 'av1', 'small'].includes(input?.sort) ? input.sort : 'default',
    extras: {
      sponsorblock: ['off', 'mark', 'remove'].includes(extras.sponsorblock) ? extras.sponsorblock : 'off',
      metadata: Boolean(extras.metadata),
      thumbnail: Boolean(extras.thumbnail),
      subtitles: ['off', 'en', 'all'].includes(extras.subtitles) ? extras.subtitles : 'off',
      chapters: ['off', 'embed', 'split'].includes(extras.chapters) ? extras.chapters : 'off',
      legacy: Boolean(extras.legacy)
    }
  };
}

function specEqual(a, b) {
  return JSON.stringify(normalizeSpec(a)) === JSON.stringify(normalizeSpec(b));
}

function specLabelClient(spec) {
  const clean = normalizeSpec(spec);
  if (clean.kind === 'audio') {
    const lossless = LOSSLESS.includes(clean.container);
    return `${FORMAT_TITLE[clean.container]} · ${lossless ? 'lossless' : clean.quality === 'best' ? 'best' : `${clean.quality} kbps`}`;
  }
  return `${clean.quality === 'best' ? 'Best' : `${clean.quality}p`} · ${FORMAT_TITLE[clean.container]}`;
}

function compactNumber(value) {
  if (!Number.isFinite(value)) return '';
  if (value >= 1e9) return `${(value / 1e9).toFixed(1)}B`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(0)}K`;
  return String(value);
}

function defaultSpec() {
  return normalizeSpec(state.settings?.defaultFormat || BUILTIN_SPEC);
}

function activePreset() {
  const presets = state.settings?.formatPresets || [];
  return presets.find((preset) => specEqual(preset.spec, state.spec)) || null;
}

function extraList() {
  const extras = state.spec.extras;
  const items = [];
  if (extras.sponsorblock !== 'off') items.push(`SponsorBlock ${extras.sponsorblock}`);
  if (extras.metadata) items.push('Metadata');
  if (extras.thumbnail) items.push('Thumbnail');
  if (extras.subtitles !== 'off') items.push(`Subtitles ${extras.subtitles}`);
  if (extras.chapters !== 'off') items.push(`Chapters ${extras.chapters}`);
  if (extras.legacy) items.push('Legacy flags');
  if (state.spec.sort !== 'default') items.push(SORT_LABEL[state.spec.sort]);
  return items;
}

function renderResult() {
  const result = state.result;
  const container = $('#result');
  if (!result) { container.innerHTML = ''; return; }

  container.innerHTML = result.kind === 'playlist' ? playlistMarkup(result) : videoMarkup(result);
  bindResult(container);
  const sheet = $('.sheet', container);
  if (sheet) setTimeout(() => sheet.classList.add('is-settled'), 700);
  requestAnimationFrame(() => {
    positionKindPill();
    renderCommit();
  });
}

function bindResult(container) {
  $$('.thumb img, .pl-thumb', container).forEach((img) => {
    img.addEventListener('error', () => {
      img.style.opacity = '0';
      const fallback = img.parentElement?.querySelector('.thumb-fallback');
      if (fallback) fallback.hidden = false;
    }, { once: true });
  });

  const extrasPanel = $('#extrasPanel', container);
  if (extrasPanel) bindExtrasControls(extrasPanel);

  const formats = $('#formats', container);
  if (formats) {
    formats.addEventListener('click', (event) => {
      const kindButton = event.target.closest('[data-kind]');
      if (kindButton) {
        const kind = kindButton.dataset.kind;
        if (kind === state.spec.kind) return;
        state.spec = normalizeSpec({
          ...state.spec,
          kind,
          container: kind === 'audio' ? 'mp3' : 'mp4',
          quality: 'best',
          sort: kind === 'audio' ? 'default' : state.spec.sort
        });
        refreshFormats({ swap: true });
        return;
      }

      const containerButton = event.target.closest('[data-container]');
      if (containerButton) {
        state.spec = normalizeSpec({ ...state.spec, container: containerButton.dataset.container });
        refreshFormats({ swap: true });
        return;
      }

      const qualityButton = event.target.closest('[data-quality]');
      if (qualityButton) {
        state.spec = normalizeSpec({ ...state.spec, quality: qualityButton.dataset.quality });
        refreshFormats();
        return;
      }

      const presetButton = event.target.closest('[data-preset]');
      if (presetButton) {
        applyPreset(presetButton.dataset.preset);
        return;
      }

      if (event.target.closest('#moreFormats')) return openMorePopover(event.target.closest('#moreFormats'));
      if (event.target.closest('#extrasBtn')) return setExtrasOpen(!state.extrasOpen);
      if (event.target.closest('#savePreset')) return openSavePreset(event.target.closest('#savePreset'));
      if (event.target.closest('#starDefault')) return setCurrentDefault();
      if (event.target.closest('#deletePreset')) return requestDeletePreset(event.target.closest('#deletePreset'));
    });
  }

  $$('[data-open]', container).forEach((button) => {
    button.addEventListener('click', () => api('/api/open', { body: { url: state.result.url } }).catch(() => {}));
  });
  const copyButton = $('[data-copy]', container);
  if (copyButton) copyButton.addEventListener('click', () => copy(state.result.url));

  $$('.pl-row', container).forEach((row) => {
    const toggle = () => row.click();
    row.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        toggle();
      }
    });
    row.addEventListener('click', () => {
      const index = Number(row.dataset.index);
      if (state.playlistSelected.has(index)) state.playlistSelected.delete(index);
      else state.playlistSelected.add(index);
      const on = state.playlistSelected.has(index);
      row.classList.toggle('is-off', !on);
      row.classList.toggle('is-on', on);
      row.setAttribute('aria-checked', String(on));
      updatePlaylistCount();
      renderCommit();
    });
  });

  const allButton = $('#selectAll', container);
  if (allButton) allButton.addEventListener('click', () => togglePlaylistAll(true));
  const noneButton = $('#selectNone', container);
  if (noneButton) noneButton.addEventListener('click', () => togglePlaylistAll(false));
}

function videoMarkup(result) {
  const hasThumb = Boolean(result.thumbnail);
  const year = result.uploadDate ? result.uploadDate.slice(0, 4) : '';
  const meta = [
    result.uploader ? `<span class="uploader">${esc(result.uploader)}</span>` : '',
    result.duration ? `<span class="mono">${fmtDuration(result.duration)}</span>` : '',
    result.viewCount ? `<span class="mono">${compactNumber(result.viewCount)} views</span>` : '',
    year ? `<span class="mono">${esc(year)}</span>` : ''
  ].filter(Boolean).join('<span class="sep"></span>');

  return `
  <article class="sheet">
    <div class="sheet-head">
      <div class="thumb">
        ${hasThumb
          ? `<img src="${thumbUrl(result.thumbnail)}" alt="" referrerpolicy="no-referrer">
             <div class="thumb-fallback" hidden><svg class="icon"><use href="#i-film"/></svg></div>`
          : `<div class="thumb-fallback"><svg class="icon"><use href="#i-film"/></svg></div>`}
        ${result.duration ? `<span class="duration">${fmtDuration(result.duration)}</span>` : ''}
        ${result.live ? '<span class="live-badge">Live</span>' : ''}
      </div>
      <div class="sheet-body">
        <h2 class="sheet-title" title="${esc(result.title)}">${esc(result.title)}</h2>
        <div class="sheet-meta">${meta || '<span class="mono">Media</span>'}</div>
        <div class="sheet-actions">
          <button class="btn-quiet" data-open>Open source</button>
          <button class="btn-quiet" data-copy>Copy link</button>
        </div>
      </div>
    </div>
    ${formatPanel()}
  </article>`;
}

function playlistMarkup(result) {
  const selected = state.playlistSelected.size;
  const entries = result.entries.map((entry, index) => {
    const on = state.playlistSelected.has(entry.index);
    return `
      <div class="pl-row ${on ? 'is-on' : 'is-off'}" data-index="${entry.index}" role="checkbox" tabindex="0"
           aria-checked="${on}" style="--d:${Math.min(index, 8) * 24}ms">
        <span class="check"><svg class="icon"><use href="#i-check"/></svg></span>
        <img class="pl-thumb" src="${thumbUrl(entry.thumbnail)}" alt="" loading="lazy" referrerpolicy="no-referrer">
        <span class="pl-title" title="${esc(entry.title)}">${esc(entry.title)}</span>
        <span class="pl-dur">${fmtDuration(entry.duration)}</span>
      </div>`;
  }).join('');

  return `
  <article class="sheet">
    <div class="sheet-head">
      <div class="thumb">
        ${result.thumbnail
          ? `<img src="${thumbUrl(result.thumbnail)}" alt="" referrerpolicy="no-referrer">
             <div class="thumb-fallback" hidden><svg class="icon"><use href="#i-archive"/></svg></div>`
          : `<div class="thumb-fallback"><svg class="icon"><use href="#i-archive"/></svg></div>`}
      </div>
      <div class="sheet-body">
        <h2 class="sheet-title" title="${esc(result.title)}">${esc(result.title)}</h2>
        <div class="sheet-meta">
          <span class="uploader">Playlist</span><span class="sep"></span>
          <span class="mono">${result.count} items</span>
          ${result.truncated ? '<span class="sep"></span><span class="mono">first 200 shown</span>' : ''}
        </div>
        <div class="sheet-actions">
          <button class="btn-quiet" data-open>Open source</button>
          <button class="btn-quiet" data-copy>Copy link</button>
        </div>
      </div>
    </div>
    ${formatPanel()}
    <div class="playlist">
      <div class="playlist-head">
        <span class="label">Items</span>
        <span class="mono dim" id="playlistCount">${selected} of ${result.entries.length} selected</span>
        <div class="playlist-actions">
          <button class="btn-quiet" id="selectAll">All</button>
          <button class="btn-quiet" id="selectNone">None</button>
        </div>
      </div>
      ${entries}
      ${result.truncated ? `<div class="playlist-more">Only the first 200 items are listed. “All” selects these.</div>` : ''}
    </div>
  </article>`;
}

function updatePlaylistCount() {
  const count = $('#playlistCount');
  if (!count || !state.result?.entries) return;
  count.textContent = `${state.playlistSelected.size} of ${state.result.entries.length} selected`;
}

function togglePlaylistAll(on) {
  if (!state.result?.entries) return;
  state.playlistSelected = on ? new Set(state.result.entries.map((entry) => entry.index)) : new Set();
  $$('.pl-row').forEach((row) => {
    const active = state.playlistSelected.has(Number(row.dataset.index));
    row.classList.toggle('is-off', !active);
    row.classList.toggle('is-on', active);
    row.setAttribute('aria-checked', String(active));
  });
  updatePlaylistCount();
  renderCommit();
}

/* --------------------------------------------------------------- format panel */

function formatPanel() {
  return `
  <div class="formats" id="formats">
    <div class="presets-row" id="presetsRow">${presetsRowInner()}</div>
    <div class="format-rows" id="formatRows" data-mode="${formatMode()}">${formatRowsMarkup()}</div>
    <div class="extras-reveal ${state.extrasOpen ? 'is-open' : ''}" id="extrasReveal">
      <div class="extras-inner" id="extrasPanel">${extrasPanelInner()}</div>
    </div>
    <div class="resolved" id="resolved">${resolvedMarkup()}</div>
  </div>`;
}

function formatMode() {
  const lossless = state.spec.kind === 'audio' && LOSSLESS.includes(state.spec.container);
  return `${state.spec.kind}-${lossless ? 'lossless' : 'lossy'}`;
}

function presetsRowInner() {
  const presets = state.settings?.formatPresets || [];
  const active = activePreset();
  const activeId = active?.id || null;
  const builtinOn = specEqual(state.spec, BUILTIN_SPEC);
  const defaultId = state.settings?.defaultPresetId || null;
  const builtinDefault = !defaultId && specEqual(defaultSpec(), BUILTIN_SPEC);
  const isDefaultSetup =
    specEqual(state.spec, defaultSpec()) &&
    (defaultId ? defaultId === activeId : activeId === null);

  const userChips = presets.map((preset) => {
    const on = activeId === preset.id;
    const isDefault = defaultId === preset.id;
    return `
      <button class="chip preset ${on ? 'is-on' : ''} ${isDefault ? 'is-default' : ''}" data-preset="${esc(preset.id)}"
              title="${isDefault ? 'Default for new links · ' : ''}${esc(specLabelClient(preset.spec))}">
        ${isDefault ? '<span class="preset-dot" aria-hidden="true"></span>' : ''}${esc(preset.name)}
      </button>`;
  }).join('');

  const actions = activeId
    ? `<button class="icon-btn preset-icon ${isDefaultSetup ? 'is-default' : ''}" id="starDefault"
               title="${isDefaultSetup ? 'Default for new links' : 'Use this preset for new links'}"
               aria-label="Set as default preset">
         <svg class="icon star ${isDefaultSetup ? 'star-on' : ''}"><use href="#i-star"/></svg>
       </button>
       <button class="icon-btn preset-icon" id="deletePreset" title="Delete preset" aria-label="Delete preset">
         <svg class="icon"><use href="#i-trash"/></svg>
       </button>`
    : `<button class="icon-btn preset-icon ${isDefaultSetup ? 'is-default' : ''}" id="starDefault"
               title="${isDefaultSetup ? 'Default for new links' : 'Use this setup for new links'}"
               aria-label="Set as default preset">
         <svg class="icon star ${isDefaultSetup ? 'star-on' : ''}"><use href="#i-star"/></svg>
       </button>`;

  return `
    <span class="label">Presets</span>
    <div class="presets">
      <button class="chip preset ${builtinOn ? 'is-on' : ''} ${builtinDefault ? 'is-default' : ''}" data-preset="builtin"
              title="Best video + audio · MP4">
        ${builtinDefault ? '<span class="preset-dot" aria-hidden="true"></span>' : ''}Best MP4
      </button>
      ${userChips}
      <button class="chip chip-add" id="savePreset" title="Save the current setup as a preset">+ Save</button>
    </div>
    <div class="preset-actions">${actions}</div>`;
}

function extrasSummaryInner() {
  const extras = extraList();
  const summaryHtml = extras.length
    ? `${esc(extras[0])}${extras.length > 1 ? ` <span class="dim">+${extras.length - 1}</span>` : ''}`
    : 'Nothing extra';
  return {
    summaryHtml,
    html: `<span class="extras-summary ${extras.length ? '' : 'dim'}">${summaryHtml}</span>
           ${extras.length ? `<span class="extras-count mono">${extras.length}</span>` : ''}
           <svg class="icon"><use href="#i-chevron"/></svg>`,
    count: extras.length
  };
}

function moreButtonInner() {
  const audio = state.spec.kind === 'audio';
  const other = audio ? AUDIO_OTHER : VIDEO_OTHER;
  const selected = other.includes(state.spec.container) ? state.spec.container : null;
  return {
    html: `${selected ? FORMAT_TITLE[selected] : 'More'} <svg class="icon"><use href="#i-chevron"/></svg>`,
    selected
  };
}

function formatRowsMarkup() {
  const audio = state.spec.kind === 'audio';
  const common = audio ? AUDIO_COMMON : VIDEO_COMMON;
  const lossless = audio && LOSSLESS.includes(state.spec.container);

  const containerChips = common.map((id) => `
    <button class="chip ${state.spec.container === id ? 'is-on' : ''}" data-container="${id}"
            role="radio" aria-checked="${state.spec.container === id}">${FORMAT_TITLE[id]}</button>`).join('');

  const qualityChips = audio
    ? lossless
      ? `<span class="format-note">Lossless container. The source sets the bitrate.</span>`
      : AUDIO_QUALITIES.map((id) => `
          <button class="chip ${state.spec.quality === id ? 'is-on' : ''}" data-quality="${id}"
                  role="radio" aria-checked="${state.spec.quality === id}">${BITRATE_LABEL[id]}</button>`).join('')
    : VIDEO_QUALITIES.map((id) => `
        <button class="chip ${state.spec.quality === id ? 'is-on' : ''}" data-quality="${id}"
                role="radio" aria-checked="${state.spec.quality === id}">${QUALITY_LABEL[id]}</button>`).join('');

  const more = moreButtonInner();
  const extras = extrasSummaryInner();

  return `
    <div class="format-row">
      <span class="label">Type</span>
      <div class="kind-switch" id="kindSwitch" role="radiogroup" aria-label="Format type">
        <span class="kind-pill" id="kindPill" aria-hidden="true"></span>
        <button class="kind-btn ${!audio ? 'is-on' : ''}" data-kind="video" role="radio" aria-checked="${!audio}">
          <svg class="icon"><use href="#i-film"/></svg><span>Video</span>
        </button>
        <button class="kind-btn ${audio ? 'is-on' : ''}" data-kind="audio" role="radio" aria-checked="${audio}">
          <svg class="icon"><use href="#i-music"/></svg><span>Audio</span>
        </button>
      </div>
    </div>
    <div class="format-row">
      <span class="label">Container</span>
      <div class="chips">
        ${containerChips}
        <button class="chip more ${more.selected ? 'is-on' : ''}" id="moreFormats" aria-haspopup="menu" aria-expanded="false">
          ${more.html}
        </button>
      </div>
    </div>
    <div class="format-row">
      <span class="label">${audio ? 'Bitrate' : 'Quality'}</span>
      <div class="chips">${qualityChips}</div>
    </div>
    <div class="format-row">
      <span class="label">Extras</span>
      <button class="extras-btn" id="extrasBtn" aria-expanded="${state.extrasOpen}" aria-controls="extrasPanel">
        ${extras.html}
      </button>
    </div>`;
}

function resolvedMarkup() {
  const choice = resolveChoice();
  const title = choice?.title || specLabelClient(state.spec);
  const meta = choice
    ? [choice.meta, choice.size ? `≈ ${fmtBytes(choice.size)}` : null].filter(Boolean).join(' · ')
    : state.result?.kind === 'playlist'
      ? `${state.result.entries.length} items`
      : FORMAT_TITLE[state.spec.container];
  return `
    <div class="resolved-line">
      <span class="lamp" data-tone="ok"></span>
      <span class="resolved-label">${esc(title)}</span>
      <span class="resolved-meta mono">${esc(meta)}</span>
    </div>`;
}

function positionKindPill() {
  const pill = $('#kindPill');
  const active = $('#kindSwitch .kind-btn.is-on');
  if (!pill || !active) return;
  pill.style.width = `${active.offsetWidth}px`;
  pill.style.transform = `translateX(${active.offsetLeft - 3}px)`;
}

function refreshFormats({ swap = false } = {}) {
  if (!state.result) return;
  const rows = $('#formatRows');
  const mode = formatMode();
  const rebuild = Boolean(rows) && (swap || rows.dataset.mode !== mode);

  if (rows && rebuild) {
    closePopover();
    rows.innerHTML = formatRowsMarkup();
    rows.dataset.mode = mode;
    rows.classList.remove('is-swapping');
    void rows.offsetWidth;
    rows.classList.add('is-swapping');
    setTimeout(() => rows.classList.remove('is-swapping'), 240);
    const panel = $('#extrasPanel');
    if (panel) panel.innerHTML = extrasPanelInner();
    requestAnimationFrame(positionKindPill);
  } else if (rows) {
    rows.querySelectorAll('[data-container]').forEach((chip) => {
      const on = chip.dataset.container === state.spec.container;
      chip.classList.toggle('is-on', on);
      chip.setAttribute('aria-checked', String(on));
    });
    rows.querySelectorAll('[data-quality]').forEach((chip) => {
      const on = chip.dataset.quality === state.spec.quality;
      chip.classList.toggle('is-on', on);
      chip.setAttribute('aria-checked', String(on));
    });

    const more = $('#moreFormats');
    if (more) {
      const info = moreButtonInner();
      more.innerHTML = info.html;
      more.classList.toggle('is-on', Boolean(info.selected));
    }

    const extrasButton = $('#extrasBtn');
    if (extrasButton) {
      const info = extrasSummaryInner();
      const summary = extrasButton.querySelector('.extras-summary');
      if (summary) {
        summary.innerHTML = info.summaryHtml;
        summary.classList.toggle('dim', info.count === 0);
      }
      let count = extrasButton.querySelector('.extras-count');
      if (info.count) {
        if (!count) {
          count = document.createElement('span');
          count.className = 'extras-count mono';
          extrasButton.insertBefore(count, extrasButton.querySelector('.icon'));
        }
        count.textContent = info.count;
      } else if (count) {
        count.remove();
      }
    }
  }

  const presets = $('#presetsRow');
  if (presets) presets.innerHTML = presetsRowInner();
  const resolved = $('#resolved');
  if (resolved) resolved.innerHTML = resolvedMarkup();
  renderCommit();
}

function resolveChoice() {
  const result = state.result;
  if (!result || result.kind !== 'video') return null;
  const spec = normalizeSpec(state.spec);
  const audio = (result.formats.audio || [])[0] || null;

  if (spec.kind === 'audio') {
    const lossless = LOSSLESS.includes(spec.container);
    const targetRate =
      spec.quality === 'best'
        ? spec.container === 'mp3'
          ? 245
          : spec.container === 'm4a' || spec.container === 'aac'
            ? 256
            : 192
        : Number(spec.quality);
    const size = lossless ? null : result.duration ? result.duration * (targetRate * 1000 / 8) : null;
    return {
      title: `${FORMAT_TITLE[spec.container]} · ${lossless ? 'lossless' : spec.quality === 'best' ? 'best' : `${spec.quality} kbps`}`,
      meta: lossless
        ? 'Lossless conversion'
        : `${spec.quality === 'best' ? `VBR ~${targetRate} kbps` : 'CBR'}`,
      size,
      recode: true
    };
  }

  const limit = spec.quality === 'best' ? Infinity : Number(spec.quality);
  const pool = (result.formats.video || []).filter((format) => !format.height || format.height <= limit);
  const ranked = pool.length ? pool : result.formats.video || [];
  let video = ranked[0] || null;
  if (spec.sort === 'h264') video = ranked.find((f) => f.vcodec === 'H.264') || video;
  if (spec.sort === 'av1') video = ranked.find((f) => f.vcodec === 'AV1') || video;
  if (spec.sort === 'small') {
    video = [...ranked].sort((a, b) => (a.size || Infinity) - (b.size || Infinity))[0] || video;
  }
  if (!video) {
    return { title: specLabelClient(spec), meta: FORMAT_TITLE[spec.container], size: null };
  }

  const fps = video.height && video.fps && video.fps > 50 ? '60' : '';
  const size = video.muxed ? video.size : video.size && audio?.size ? video.size + audio.size : video.size || null;
  const codec = video.vcodec || 'Video';
  const recode = ['avi', 'flv'].includes(spec.container);
  const sound = recode ? 'MP3' : video.muxed ? video.acodec : audio?.acodec;
  return {
    title: `${video.height ? `${video.height}p${fps}` : 'Source'} · ${codec}`,
    meta: [FORMAT_TITLE[spec.container], sound, recode ? 're-encode' : null].filter(Boolean).join(' · '),
    size,
    recode
  };
}

function applyPreset(id) {
  if (id === 'builtin') {
    state.spec = cloneSpec(BUILTIN_SPEC);
  } else {
    const preset = (state.settings?.formatPresets || []).find((item) => item.id === id);
    if (!preset) return;
    state.spec = normalizeSpec(preset.spec);
  }
  refreshFormats({ swap: true });
}

async function setCurrentDefault() {
  const active = activePreset();
  await saveSettings({ defaultFormat: cloneSpec(state.spec), defaultPresetId: active?.id || null });
  toast(active ? `“${active.name}” is now the default` : 'Setup saved as the default');
}

function requestDeletePreset(trigger) {
  const active = activePreset();
  if (!active) return;
  openPopover(trigger, {
    html: `
      <div class="pop-head"><span class="label">Delete preset</span></div>
      <div class="save-body">
        <p class="pop-hint">“${esc(active.name)}” will be removed. Downloaded files are untouched.</p>
        <div class="pop-actions">
          <button class="btn-quiet" type="button" id="deleteCancel">Cancel</button>
          <button class="btn-danger" type="button" id="deleteConfirm">Delete</button>
        </div>
      </div>`,
    className: 'pop-save',
    align: 'right',
    onMount(el) {
      $('#deleteCancel', el).addEventListener('click', () => closePopover({ restoreFocus: true }));
      $('#deleteConfirm', el).addEventListener('click', async () => {
        await deleteActivePreset();
        closePopover();
      });
    }
  });
}

async function deleteActivePreset() {
  const active = activePreset();
  if (!active) return;
  const presets = (state.settings.formatPresets || []).filter((preset) => preset.id !== active.id);
  const patch = { formatPresets: presets };
  if (state.settings.defaultPresetId === active.id) patch.defaultPresetId = null;
  await saveSettings(patch);
  toast(`Preset “${active.name}” deleted`);
}

async function createPreset(name, useDefault) {
  const clean = String(name || '').trim().slice(0, 40);
  if (!clean) return false;
  const id = `p_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  const preset = { id, name: clean, spec: cloneSpec(state.spec), createdAt: new Date().toISOString() };
  const patch = { formatPresets: [...(state.settings.formatPresets || []), preset] };
  if (useDefault) {
    patch.defaultFormat = cloneSpec(state.spec);
    patch.defaultPresetId = id;
  }
  await saveSettings(patch);
  toast(`Preset “${clean}” saved`);
  return true;
}

/* ---------------------------------------------------------------- popovers */

let popover = null;

function closePopover({ restoreFocus = false } = {}) {
  if (!popover) return;
  const { el, trigger, onScroll, onKey, onPointer } = popover;
  const current = popover;
  popover = null;
  el.classList.remove('is-open');
  el.classList.add('is-closing');
  trigger?.setAttribute('aria-expanded', 'false');
  document.removeEventListener('scroll', onScroll, true);
  document.removeEventListener('keydown', onKey, true);
  document.removeEventListener('pointerdown', onPointer, true);
  setTimeout(() => el.remove(), 170);
  if (restoreFocus && trigger?.isConnected) trigger.focus({ preventScroll: true });
  if (current?.afterClose) current.afterClose();
}

function openPopover(trigger, { html, className = '', align = 'left', onMount }) {
  if (popover && popover.trigger === trigger) {
    closePopover({ restoreFocus: true });
    return null;
  }
  closePopover();
  const el = document.createElement('div');
  el.className = `popover ${className}`;
  el.innerHTML = html;
  document.body.append(el);

  const rect = trigger.getBoundingClientRect();
  const panel = el.getBoundingClientRect();
  let left = align === 'right' ? rect.right - panel.width : rect.left;
  left = Math.max(12, Math.min(left, window.innerWidth - panel.width - 12));

  const spaceBelow = window.innerHeight - rect.bottom - 12;
  const spaceAbove = rect.top - 12;
  const placeBelow = spaceBelow >= panel.height || spaceBelow >= spaceAbove;
  let top = placeBelow ? rect.bottom + 8 : Math.max(12, rect.top - panel.height - 8);

  const space = placeBelow ? spaceBelow : spaceAbove;
  if (space < panel.height) {
    el.style.maxHeight = `${Math.max(160, space - 2)}px`;
    el.style.overflowY = 'auto';
    const measured = el.getBoundingClientRect().height;
    if (!placeBelow) top = Math.max(12, rect.top - measured - 8);
  }

  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
  el.style.transformOrigin = `${align === 'right' ? 'right' : 'left'} ${placeBelow ? 'top' : 'bottom'}`;
  el.style.setProperty('--shift', placeBelow ? '-4px' : '4px');

  trigger.setAttribute('aria-expanded', 'true');

  const onPointer = (event) => {
    if (el.contains(event.target) || trigger.contains(event.target)) return;
    closePopover({ restoreFocus: false });
  };
  const onKey = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closePopover({ restoreFocus: true });
    }
  };
  const onScroll = (event) => {
    if (el.contains(event.target)) return;
    closePopover();
  };

  document.addEventListener('pointerdown', onPointer, true);
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('scroll', onScroll, true);

  popover = { el, trigger, onPointer, onKey, onScroll };
  requestAnimationFrame(() => el.classList.add('is-open'));

  const focusable = el.querySelector('input, button, select');
  if (focusable) setTimeout(() => focusable.focus({ preventScroll: true }), 40);
  if (onMount) onMount(el);
  return el;
}

function openMorePopover(trigger) {
  const audio = state.spec.kind === 'audio';
  const others = audio ? AUDIO_OTHER : VIDEO_OTHER;
  const html = `
    <div class="pop-head">
      <span class="label">Other ${audio ? 'audio' : 'video'} formats</span>
    </div>
    <div class="pop-menu" role="menu">
      ${others.map((id) => {
        const on = state.spec.container === id;
        return `
          <button class="pop-item ${on ? 'is-on' : ''}" data-container="${id}" role="menuitemradio" aria-checked="${on}">
            <span class="pop-check"><svg class="icon"><use href="#i-check"/></svg></span>
            <span>${FORMAT_TITLE[id]}</span>
            <span class="pop-note">${FORMAT_NOTE[id] || ''}</span>
          </button>`;
      }).join('')}
    </div>`;

  openPopover(trigger, {
    html,
    className: 'pop-menu-wrap',
    onMount(el) {
      el.querySelectorAll('[data-container]').forEach((button) => {
        button.addEventListener('click', () => {
          state.spec = normalizeSpec({ ...state.spec, container: button.dataset.container });
          closePopover({ restoreFocus: true });
          refreshFormats({ swap: true });
        });
      });
    }
  });
}

function extrasPanelInner() {
  const extras = state.spec.extras;
  const videoContainers = ['mp4', 'mkv', 'mov', 'webm'];
  const canThumb = [...videoContainers, 'mp3', 'm4a', 'flac', 'opus', 'ogg'].includes(state.spec.container);
  const canSubs = state.spec.kind === 'video' && videoContainers.includes(state.spec.container);
  const seg = (field, options) => `
    <div class="seg" data-field="${field}">
      ${options.map(([value, label]) => `
        <button type="button" data-value="${value}" class="${extras[field] === value ? 'is-on' : ''}">${label}</button>`).join('')}
    </div>`;

  return `
    <div class="extras-head"><span class="label">Extras</span><span class="mono dim">yt-dlp</span></div>
    <div class="pop-body">
      <div class="pop-row">
        <div class="pop-label"><span>SponsorBlock</span><span class="pop-hint">YouTube segments</span></div>
        ${seg('sponsorblock', [['off', 'Off'], ['mark', 'Mark'], ['remove', 'Remove']])}
      </div>
      ${state.spec.kind === 'video' ? `
      <div class="pop-row">
        <div class="pop-label"><span>Format sorting</span><span class="pop-hint">Prefer a codec or size</span></div>
        <select class="input select mini" data-select="sort">
          ${Object.entries(SORT_LABEL).map(([value, label]) => `<option value="${value}" ${state.spec.sort === value ? 'selected' : ''}>${label}</option>`).join('')}
        </select>
      </div>` : ''}
      <div class="pop-row">
        <div class="pop-label"><span>Embed metadata</span><span class="pop-hint">Title, artist, date</span></div>
        <button class="toggle" type="button" role="switch" data-toggle="metadata" aria-checked="${extras.metadata}">
          <span class="toggle-knob"></span>
        </button>
      </div>
      <div class="pop-row">
        <div class="pop-label">
          <span>Embed thumbnail</span>
          <span class="pop-hint">${canThumb ? 'Cover art in the file' : `Not supported in ${FORMAT_TITLE[state.spec.container]}`}</span>
        </div>
        <button class="toggle" type="button" role="switch" data-toggle="thumbnail"
                aria-checked="${extras.thumbnail && canThumb}" ${canThumb ? '' : 'disabled'}>
          <span class="toggle-knob"></span>
        </button>
      </div>
      <div class="pop-row">
        <div class="pop-label">
          <span>Embed subtitles</span>
          <span class="pop-hint">${canSubs ? 'Where the site provides them' : 'Video containers only'}</span>
        </div>
        <select class="input select mini" data-select="subtitles" ${canSubs ? '' : 'disabled'}>
          <option value="off" ${extras.subtitles === 'off' ? 'selected' : ''}>Off</option>
          <option value="en" ${extras.subtitles === 'en' ? 'selected' : ''}>English</option>
          <option value="all" ${extras.subtitles === 'all' ? 'selected' : ''}>All</option>
        </select>
      </div>
      <div class="pop-row">
        <div class="pop-label"><span>Chapters</span><span class="pop-hint">Embed or split the file</span></div>
        ${seg('chapters', [['off', 'Off'], ['embed', 'Embed'], ['split', 'Split']])}
      </div>
      <div class="pop-row">
        <div class="pop-label"><span>youtube-dl flags</span><span class="pop-hint">Legacy compatibility mode</span></div>
        <button class="toggle" type="button" role="switch" data-toggle="legacy" aria-checked="${extras.legacy}">
          <span class="toggle-knob"></span>
        </button>
      </div>
    </div>
    <div class="pop-foot">Merging, thumbnails and chapters rely on ffmpeg.</div>`;
}

function setExtrasOpen(open) {
  state.extrasOpen = open;
  const reveal = $('#extrasReveal');
  if (reveal) reveal.classList.toggle('is-open', open);
  const trigger = $('#extrasBtn');
  if (trigger) trigger.setAttribute('aria-expanded', String(open));
  if (open) {
    const first = $('#extrasPanel select, #extrasPanel button');
    if (first) setTimeout(() => first.focus({ preventScroll: true }), 120);
  }
}

function bindExtrasControls(root) {
  root.addEventListener('click', (event) => {
    const segButton = event.target.closest('.seg button');
    if (segButton) {
      const field = segButton.parentElement.dataset.field;
      state.spec.extras[field] = segButton.dataset.value;
      root.querySelectorAll(`.seg[data-field="${field}"] button`).forEach((button) => {
        button.classList.toggle('is-on', button === segButton);
      });
      refreshFormats();
      return;
    }
    const toggle = event.target.closest('[data-toggle]');
    if (toggle) {
      const field = toggle.dataset.toggle;
      state.spec.extras[field] = !state.spec.extras[field];
      toggle.setAttribute('aria-checked', String(state.spec.extras[field]));
      refreshFormats();
    }
  });
  root.addEventListener('change', (event) => {
    const select = event.target.closest('[data-select]');
    if (!select) return;
    const field = select.dataset.select;
    if (field === 'sort') state.spec.sort = select.value;
    else state.spec.extras[field] = select.value;
    refreshFormats();
  });
}

function openSavePreset(trigger) {
  openPopover(trigger, {
    html: `
      <div class="pop-head"><span class="label">Save preset</span></div>
      <div class="pop-body save-body">
        <input class="input" id="presetName" maxlength="40" placeholder="Preset name" aria-label="Preset name">
        <p class="pop-hint" id="presetHint">${esc(specLabelClient(state.spec))}${extraList().length ? ` · ${extraList().length} extra${extraList().length === 1 ? '' : 's'}` : ''}</p>
        <div class="pop-row compact">
          <div class="pop-label"><span>Use for new links</span><span class="pop-hint">Becomes the default setup</span></div>
          <button class="toggle" type="button" id="presetDefault" role="switch" aria-checked="false">
            <span class="toggle-knob"></span>
          </button>
        </div>
        <div class="pop-actions">
          <button class="btn-quiet" type="button" id="presetCancel">Cancel</button>
          <button class="btn-primary" type="button" id="presetConfirm">Save</button>
        </div>
      </div>`,
    className: 'pop-save',
    align: 'left',
    onMount(el) {
      const input = $('#presetName', el);
      const toggle = $('#presetDefault', el);
      const confirm = $('#presetConfirm', el);
      toggle.addEventListener('click', () => {
        const on = toggle.getAttribute('aria-checked') !== 'true';
        toggle.setAttribute('aria-checked', String(on));
        toggle.classList.toggle('is-on', on);
      });
      const submit = async () => {
        if (!input.value.trim()) {
          input.classList.add('is-invalid');
          input.focus();
          return;
        }
        confirm.disabled = true;
        const ok = await createPreset(input.value, toggle.getAttribute('aria-checked') === 'true');
        confirm.disabled = false;
        if (ok) closePopover({ restoreFocus: true });
      };
      confirm.addEventListener('click', submit);
      $('#presetCancel', el).addEventListener('click', () => closePopover({ restoreFocus: true }));
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') submit();
      });
    }
  });
}

/* ------------------------------------------------------------------ commit */

function renderCommit() {
  const commit = $('#commit');
  const result = state.result;
  if (!result) { commit.hidden = true; return; }
  commit.hidden = false;

  const choice = result.kind === 'video' ? resolveChoice() : null;
  const summary = $('#commitSummary');
  const button = $('#downloadBtn');

  if (result.kind === 'playlist') {
    const count = state.playlistSelected.size;
    summary.textContent = `${specLabelClient(state.spec)} · ${count} item${count === 1 ? '' : 's'}`;
    button.textContent = count ? `Download ${count}` : 'Select items';
    button.disabled = count === 0;
  } else {
    summary.textContent = choice
      ? `${choice.title}${choice.size ? ` · ≈ ${fmtBytes(choice.size)}` : ''}`
      : specLabelClient(state.spec);
    button.textContent = 'Download';
    button.disabled = false;
  }

  const folder = state.settings?.outputDir || '';
  $('#outputLabel').textContent = folder.replace(/^\/Users\/[^/]+/, '~');
  $('#outputLabel').title = folder;
}

async function startDownload() {
  const result = state.result;
  if (!result) return;
  const choice = result.kind === 'video' ? resolveChoice() : null;
  const button = $('#downloadBtn');
  button.disabled = true;
  button.textContent = 'Adding…';
  try {
    const payload = {
      url: result.url,
      title: result.title,
      uploader: result.uploader,
      thumbnail: result.thumbnail,
      site: result.site,
      kind: result.kind,
      spec: cloneSpec(state.spec),
      formatLabel:
        result.kind === 'playlist'
          ? `${specLabelClient(state.spec)} · playlist`
          : state.spec.kind === 'audio'
            ? choice?.title || specLabelClient(state.spec)
            : choice
              ? `${choice.title} · ${FORMAT_TITLE[state.spec.container]}`
              : specLabelClient(state.spec),
      items: result.kind === 'playlist' ? [...state.playlistSelected] : null
    };
    await api('/api/download', { body: payload });
    toast('Added to queue');
    if (window.matchMedia('(max-width: 1180px)').matches) toggleQueue(true);
    button.textContent = 'Queued';
    setTimeout(() => renderCommit(), 1400);
  } catch (error) {
    toast(error.message, 'bad');
    renderCommit();
  }
}

/* -------------------------------------------------------------------- queue */

function bindQueue() {
  $('#queue').addEventListener('click', (event) => {
    const action = event.target.closest('[data-act]');
    if (!action) return;
    const card = action.closest('.job');
    if (!card) return;
    const id = card.dataset.id;
    const act = action.dataset.act;
    if (act === 'cancel') api(`/api/jobs/${id}/cancel`, { method: 'POST' }).catch(() => {});
    if (act === 'retry') api(`/api/jobs/${id}/retry`, { method: 'POST' }).catch(() => {});
    if (act === 'remove') {
      card.classList.add('is-leaving');
      setTimeout(() => api(`/api/jobs/${id}/remove`, { method: 'POST' }).catch(() => {}), 140);
    }
    if (act === 'reveal') api(`/api/jobs/${id}/reveal`, { method: 'POST' }).catch((error) => toast(error.message, 'bad'));
  });
}

function renderQueue() {
  const active = state.jobs.filter((job) => ['running', 'queued'].includes(job.status));
  const finished = state.jobs.filter((job) => !['running', 'queued'].includes(job.status)).slice(0, 12);
  const activeList = $('#activeList');
  const doneList = $('#doneList');

  const present = new Set();
  for (const job of active) present.add(job.id);
  for (const job of finished) present.add(job.id);

  for (const [id, node] of jobNodes) {
    if (!present.has(id)) {
      node.remove();
      jobNodes.delete(id);
    }
  }

  const activeNodes = active.map((job) => {
    let node = jobNodes.get(job.id);
    if (!node) {
      node = buildJobNode(job);
      jobNodes.set(job.id, node);
    }
    updateJobNode(node, job);
    return node;
  });

  const finishedNodes = finished.map((job) => {
    let node = jobNodes.get(job.id);
    if (!node) {
      node = buildJobNode(job);
      jobNodes.set(job.id, node);
    }
    updateJobNode(node, job);
    return node;
  });

  syncQueueList(activeList, activeNodes);
  syncQueueList(doneList, finishedNodes);

  $('#doneSection').hidden = finished.length === 0;
  $('#clearQueue').hidden = finished.length === 0;
  const empty = active.length === 0 && finished.length === 0;
  $('#queueEmpty').hidden = !empty;
  const count = active.length;
  const badge = $('#queueCount');
  setText(badge, String(count));
  badge.dataset.active = String(count > 0);
}

/** Move only the nodes whose position is wrong; never re-append the rest. */
function syncQueueList(parent, nodes) {
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    if (parent.children[index] !== node) {
      parent.insertBefore(node, parent.children[index] || null);
    }
  }
}

function buildJobNode(job) {
  const node = document.createElement('article');
  node.className = 'job is-entering';
  node.dataset.id = job.id;
  setTimeout(() => node.classList.remove('is-entering'), 320);
  node.innerHTML = `
    <div class="job-top">
      <img class="job-thumb" alt="" src="">
      <div class="job-text">
        <div class="job-title"></div>
        <div class="job-sub"></div>
      </div>
      <div class="job-actions"></div>
    </div>
    <div class="job-bar"><span class="job-fill"></span></div>
    <div class="job-foot">
      <span class="pct"></span>
      <span class="meta"></span>
      <span class="grow"></span>
      <span class="size"></span>
    </div>`;
  return node;
}

function updateJobNode(node, job) {
  if (node.dataset.status !== job.status) node.dataset.status = job.status;
  node.classList.toggle('is-running', job.status === 'running');
  node.classList.toggle('is-indeterminate', job.status === 'running' && !Number.isFinite(job.progress?.pct));

  const thumb = node.querySelector('.job-thumb');
  const source = job.thumbnail ? thumbUrl(job.thumbnail) : '';
  if (thumb.dataset.src !== source) {
    thumb.dataset.src = source;
    if (source) thumb.src = source;
    else thumb.removeAttribute('src');
  }

  const titleEl = node.querySelector('.job-title');
  setText(titleEl, job.title || job.url);
  titleEl.title = job.title || job.url;

  const sub = node.querySelector('.job-sub');
  const pct = Number.isFinite(job.progress?.pct) ? Math.round(job.progress.pct) : null;
  const suffix = job.itemCount && job.itemIndex ? ` · item ${job.itemIndex}/${job.itemCount}` : '';
  if (job.status === 'running') {
    setText(sub, `${job.formatLabel || 'Downloading'}${suffix}`);
    sub.classList.remove('danger');
  } else if (job.status === 'queued') {
    setText(sub, `Waiting · ${job.formatLabel || ''}`);
    sub.classList.remove('danger');
  } else if (job.status === 'done') {
    setText(sub, [job.formatLabel, job.size ? fmtBytes(job.size) : null, fmtAgo(job.endedAt)].filter(Boolean).join(' · '));
    sub.classList.remove('danger');
  } else if (job.status === 'error') {
    setText(sub, job.error || 'Failed');
    sub.classList.add('danger');
    sub.title = job.error || '';
  } else {
    setText(sub, 'Canceled');
    sub.classList.remove('danger');
  }

  const actions = node.querySelector('.job-actions');
  const signature = `${job.status}:${job.status === 'done' && !job.file ? 'nofile' : ''}`;
  if (actions.dataset.sig !== signature) {
    actions.dataset.sig = signature;
    if (job.status === 'done') {
      actions.innerHTML = job.file
        ? `<button class="mini" data-act="reveal" title="Show in Finder">Reveal</button>`
        : '';
    } else if (job.status === 'error' || job.status === 'canceled') {
      actions.innerHTML = `
        <button class="mini" data-act="retry" title="Retry">Retry</button>
        <button class="mini" data-act="remove" title="Remove">Remove</button>`;
    } else if (job.status === 'queued') {
      actions.innerHTML = `<button class="job-x" data-act="cancel" aria-label="Cancel"><svg class="icon"><use href="#i-x"/></svg></button>`;
    } else {
      actions.innerHTML = `<button class="job-x" data-act="cancel" aria-label="Cancel"><svg class="icon"><use href="#i-x"/></svg></button>`;
    }
  }

  const bar = node.querySelector('.job-bar');
  const foot = node.querySelector('.job-foot');
  const showBar = job.status === 'running';
  bar.hidden = !showBar;
  foot.hidden = !showBar;

  if (showBar) {
    const fill = node.querySelector('.job-fill');
    if (fill) fill.style.transform = `scaleX(${pct ? pct / 100 : 0})`;
    setText(node.querySelector('.pct'), pct !== null ? `${pct}%` : '…');
    const speed = job.progress?.speed ? `${fmtBytes(job.progress.speed)}/s` : '';
    const eta = job.progress?.eta ? `ETA ${fmtEta(job.progress.eta)}` : '';
    const fragments = job.fragments ? `frag ${job.fragments}` : '';
    const preparing = !speed && !job.progress?.downloaded;
    setText(
      node.querySelector('.meta'),
      preparing ? 'Preparing' : [speed, eta, fragments].filter(Boolean).join(' · ')
    );
    const total = job.progress?.total;
    setText(
      node.querySelector('.size'),
      total
        ? `${fmtBytes(job.progress.downloaded || 0)} / ${fmtBytes(total)}`
        : job.progress?.downloaded
          ? fmtBytes(job.progress.downloaded)
          : ''
    );
  }
}

/* ------------------------------------------------------------------ archive */

function bindArchive() {
  $('#clearArchive').addEventListener('click', async () => {
    await api('/api/history/clear', { method: 'POST' });
    toast('Archive cleared');
  });
  $('#archiveList').addEventListener('click', (event) => {
    const button = event.target.closest('[data-arc]');
    if (!button) return;
    const row = button.closest('.arc-row');
    const id = row?.dataset.id;
    const entry = state.history.find((item) => item.id === id);
    if (!entry) return;
    if (button.dataset.arc === 'reveal') {
      api('/api/reveal', { body: { path: entry.file } }).catch((error) => toast(error.message, 'bad'));
    }
    if (button.dataset.arc === 'remove') {
      api(`/api/history/${encodeURIComponent(id)}/remove`, { method: 'POST' }).catch(() => {});
    }
  });
}

function renderArchive() {
  const list = $('#archiveList');
  const entries = state.history;
  $('#archiveEmpty').hidden = entries.length > 0;
  $('#archiveTable').hidden = entries.length === 0;
  $('#clearArchive').hidden = entries.length === 0;

  list.innerHTML = entries.map((entry) => `
    <div class="arc-row" data-id="${esc(entry.id)}">
      ${entry.thumbnail
        ? `<img class="arc-thumb" src="${thumbUrl(entry.thumbnail)}" alt="" loading="lazy" referrerpolicy="no-referrer">`
        : `<span class="arc-thumb is-empty" aria-hidden="true"></span>`}
      <div class="arc-title">
        <span class="t" title="${esc(entry.title)}">${esc(entry.title)}</span>
        <span class="s">${esc(entry.site || entry.uploader || '')}${entry.kind === 'playlist' ? ` · ${entry.count} items` : ''}</span>
      </div>
      <span class="arc-cell format">${esc(entry.formatLabel || '')}</span>
      <span class="arc-cell">${entry.size ? fmtBytes(entry.size) : 'Unknown'}</span>
      <span class="arc-cell saved">${fmtDate(entry.at)}</span>
      <div class="arc-actions">
        <button class="icon-btn" data-arc="reveal" title="Show in Finder" aria-label="Show in Finder">
          <svg class="icon"><use href="#i-folder"/></svg>
        </button>
        <button class="icon-btn" data-arc="remove" title="Remove from archive" aria-label="Remove from archive">
          <svg class="icon"><use href="#i-trash"/></svg>
        </button>
      </div>
    </div>`).join('');
}

/* ----------------------------------------------------------------- settings */

function bindSettings() {
  $$('#channelSwitch button').forEach((button) => {
    button.addEventListener('click', () => saveSettings({ channel: button.dataset.channel }).then(() => {
      $('#releaseDesc').textContent = 'Checking the channel…';
      checkBuild(true);
    }));
  });

  $('#checkBuild').addEventListener('click', () => checkBuild());
  $('#installBtn').addEventListener('click', () => installTool('yt-dlp'));
  $('#installFfmpeg').addEventListener('click', () => installTool('ffmpeg'));
  $('#setupYtdlp').addEventListener('click', () => installTool('yt-dlp'));
  $('#setupFfmpeg').addEventListener('click', () => installTool('ffmpeg'));
  $('#setupAll').addEventListener('click', async () => {
    const status = state.status || {};
    if (!status.binary?.version) await installTool('yt-dlp', { quiet: true });
    if (!state.status?.ffmpeg?.version) await installTool('ffmpeg', { quiet: true });
    toast('Vesper is ready', 'ok');
  });
  $('#checkUpdate').addEventListener('click', () => checkAppUpdate());
  $('#updateBtn').addEventListener('click', requestUpdate);
  $('#privacyLink').addEventListener('click', () => {
    api('/api/open', { body: { url: 'https://github.com/K3Tamaa/vesper#privacy' } }).catch(() => {});
  });
  $('#pickFolder').addEventListener('click', chooseFolder);

  const folder = $('#folderField');
  folder.addEventListener('change', () => {
    const value = folder.value.trim();
    if (value) saveSettings({ outputDir: value });
    else renderSettings();
  });

  const template = $('#templateField');
  template.addEventListener('change', () => {
    saveSettings({ filenameTemplate: template.value.trim() || '%(title).180B [%(id)s].%(ext)s' });
  });
  const extra = $('#extraArgsField');
  extra.addEventListener('change', () => saveSettings({ extraArgs: extra.value.trim() }));

  $('#cookiesField').addEventListener('change', (event) => saveSettings({ cookiesBrowser: event.target.value }));

  $$('[data-stepper] button').forEach((button) => {
    button.addEventListener('click', () => {
      const current = state.settings?.concurrency || 2;
      const next = Math.min(4, Math.max(1, current + Number(button.dataset.step)));
      saveSettings({ concurrency: next });
    });
  });

  $('#repoLink').addEventListener('click', () => {
    api('/api/open', { body: { url: 'https://github.com/yt-dlp/yt-dlp-nightly-builds' } }).catch(() => {});
  });
  $('#resetDefault').addEventListener('click', async () => {
    await saveSettings({ defaultFormat: null, defaultPresetId: null });
    toast('Default format reset');
  });
  $('#revealData').addEventListener('click', () => {
    if (state.status?.dataDir) {
      api('/api/reveal', { body: { path: state.status.dataDir, folder: true } }).catch((error) => toast(error.message, 'bad'));
    }
  });
}

async function saveSettings(patch) {
  try {
    const { settings } = await api('/api/settings', { body: patch });
    state.settings = settings;
    renderSettings();
    if (state.result) refreshFormats();
    renderCommit();
    return settings;
  } catch (error) {
    toast(error.message, 'bad');
    return null;
  }
}

async function chooseFolder() {
  try {
    const { path } = await api('/api/pick-folder', { method: 'POST' });
    if (path) await saveSettings({ outputDir: path });
  } catch (error) {
    toast(error.message, 'bad');
  }
}

function renderStatus() {
  const status = state.status;
  const settings = state.settings;
  if (!status) return;
  const binary = status.binary || {};
  const tone = !binary.version
    ? 'bad'
    : binary.source === 'managed' && status.updateAvailable
      ? 'warn'
      : 'ok';

  $('#binaryVersion').textContent = binary.version ? `yt-dlp ${binary.version}` : 'yt-dlp missing';
  $('#binarySource').textContent =
    binary.source === 'managed' ? 'managed' : binary.source === 'custom' ? 'custom' : binary.source === 'system' ? 'system' : 'none';
  $('#binaryLamp').dataset.tone = tone;
  $('#railLampDot').dataset.tone = tone;
  $('#railLamp').title = binary.version
    ? `yt-dlp ${binary.version} · ${binary.source}${status.updateAvailable ? ' · update available' : ''}`
    : 'yt-dlp not found';

  const ffmpeg = status.ffmpeg || {};
  $('#ffmpegState').textContent = ffmpeg.version ? `ffmpeg ${ffmpeg.version}` : 'ffmpeg missing';

  const release = status.release;
  const channel = (settings?.channel || 'nightly').toUpperCase();
  $('#channelState').textContent = release ? `${channel} ${release.tag}` : `${channel}`;
  $('#channelState').title = release?.repo || '';

  renderSetup();
}

function renderSettings() {
  const settings = state.settings;
  const status = state.status;
  if (!settings || !status) return;
  renderStatus();

  $$('#channelSwitch button').forEach((button) => {
    const active = button.dataset.channel === settings.channel;
    button.setAttribute('aria-checked', String(active));
    if (active) requestAnimationFrame(() => positionPill(button));
  });

  const binary = status.binary || {};
  $('#binaryPathDesc').textContent = binary.path
    ? `${binary.source === 'managed' ? 'Managed nightly channel' : binary.source === 'custom' ? 'Custom path' : 'From PATH'} · ${binary.prettyPath || binary.path}`
    : 'Not found. Install a build below, or install yt-dlp with Homebrew.';
  $('#binaryVersionSetting').textContent = binary.version || 'missing';
  $('#binaryLamp').dataset.tone = binary.version ? (status.updateAvailable ? 'warn' : 'ok') : 'bad';
  $('#railLampDot').dataset.tone = binary.version ? (status.updateAvailable ? 'warn' : 'ok') : 'bad';

  const ffmpeg = status.ffmpeg || {};
  $('#ffmpegDesc').textContent = ffmpeg.path
    ? `${ffmpeg.prettyPath || ffmpeg.path} · used for merging and audio extraction.`
    : 'Not found. Merging video with audio and extracting MP3 need ffmpeg.';
  $('#ffmpegVersionSetting').textContent = ffmpeg.version || 'missing';
  const ffmpegButton = $('#installFfmpeg');
  ffmpegButton.disabled = Boolean(state.installing);
  ffmpegButton.textContent = ffmpeg.source === 'managed'
    ? (state.installing === 'ffmpeg' ? 'Installing…' : 'Reinstall')
    : (state.installing === 'ffmpeg' ? 'Installing…' : 'Install');

  const release = status.release;
  if (release) {
    const when = release.publishedAt ? ` · ${fmtAgo(release.publishedAt)}` : '';
    $('#releaseDesc').textContent = `${release.channel === 'nightly' ? 'Nightly' : 'Stable'} ${release.tag}${when}`;
  } else if (status.releaseError) {
    $('#releaseDesc').textContent = status.releaseError;
  } else {
    $('#releaseDesc').textContent = 'Not checked yet.';
  }

  const installButton = $('#installBtn');
  installButton.disabled = state.installing;
  if (state.installing) installButton.textContent = 'Installing…';
  else if (binary.source === 'managed' && status.updateAvailable) installButton.textContent = 'Update';
  else if (binary.source === 'managed') installButton.textContent = 'Reinstall';
  else installButton.textContent = 'Install build';

  const folder = settings.outputDir || '';
  if (document.activeElement !== $('#folderField')) $('#folderField').value = folder;
  $('#folderField').title = folder;
  if (document.activeElement !== $('#templateField')) $('#templateField').value = settings.filenameTemplate || '';
  if (document.activeElement !== $('#extraArgsField')) $('#extraArgsField').value = settings.extraArgs || '';
  if (document.activeElement !== $('#cookiesField')) {
    $('#cookiesField').value = settings.cookiesBrowser || '';
  }
  $('#concurrencyValue').textContent = String(settings.concurrency);
  $('#nodeVersion').textContent = `node ${status.node}`;
  $('#dataPath').textContent = status.dataDir || '';

  const app = status.app || {};
  $('#appVersionLabel').textContent = `Vesper ${app.version || ''}`.trim();
  $('#appVersionDesc').textContent = app.available
    ? `Version ${app.latest} is available.`
    : app.checkedAt
      ? 'Up to date.'
      : 'A quiet client for yt-dlp.';
  const updateButton = $('#updateBtn');
  updateButton.hidden = !app.available;
  updateButton.disabled = Boolean(state.installing);
  updateButton.textContent = app.downloaded
    ? 'Restart & install'
    : state.installing === 'update'
      ? 'Downloading…'
      : 'Download update';
  const checkButton = $('#checkUpdate');
  checkButton.disabled = Boolean(state.installing) || app.checking;
  checkButton.textContent = app.checking ? 'Checking…' : 'Check for updates';

  const defaultPreset = (settings.formatPresets || []).find((preset) => preset.id === settings.defaultPresetId);
  $('#defaultFormatDesc').textContent = settings.defaultFormat
    ? `${defaultPreset ? `“${defaultPreset.name}” · ` : ''}${specLabelClient(settings.defaultFormat)}`
    : `Built-in · ${specLabelClient(BUILTIN_SPEC)}`;
  $('#resetDefault').hidden = !settings.defaultFormat;

  $('#channelState').textContent = release
    ? `${settings.channel.toUpperCase()} ${release.tag}`
    : `${settings.channel.toUpperCase()}`;
  $('#channelState').title = release?.repo || '';
}

function positionPill(button) {
  const pill = $('#switchPill');
  if (!pill || !button) return;
  pill.style.width = `${button.offsetWidth}px`;
  pill.style.transform = `translateX(${button.offsetLeft - 2}px)`;
}

async function checkBuild(quiet = false) {
  const button = $('#checkBuild');
  button.disabled = true;
  button.textContent = 'Checking…';
  try {
    const data = await api('/api/binary/check', { body: { channel: state.settings?.channel || 'nightly' } });
    const message = data.installed
      ? data.updateAvailable
        ? `${data.release.tag} is available`
        : `Up to date · ${data.installed}`
      : `Channel head is ${data.release.tag}`;
    if (!quiet) toast(message, data.updateAvailable ? 'warn' : 'ok');
    $('#releaseDesc').textContent = `${data.release.channel === 'nightly' ? 'Nightly' : 'Stable'} ${data.release.tag}`;
    state.status = { ...state.status, release: data.release, updateAvailable: data.updateAvailable, latest: data.release.tag };
    renderSettings();
  } catch (error) {
    toast(error.message, 'bad');
    $('#releaseDesc').textContent = error.message;
  } finally {
    button.disabled = false;
    button.textContent = 'Check';
  }
}

async function installTool(kind, { quiet = false } = {}) {
  if (state.installing) return;
  state.installing = kind;
  const label = kind === 'ffmpeg' ? 'ffmpeg' : 'yt-dlp';
  const panel = $('#installPanel');
  panel.hidden = false;
  $('#installText').textContent = `Downloading ${label}`;
  $('#installPct').textContent = '';
  $('#installFill').style.width = '0%';
  $('#installLamp').dataset.tone = 'busy';
  renderSettings();
  renderSetup();

  try {
    const endpoint = kind === 'ffmpeg' ? '/api/ffmpeg/install' : '/api/binary/install';
    const body = kind === 'ffmpeg' ? {} : { channel: state.settings?.channel || 'nightly' };
    const data = await api(endpoint, { body });
    $('#installFill').style.width = '100%';
    $('#installLamp').dataset.tone = 'ok';
    $('#installText').textContent =
      kind === 'ffmpeg'
        ? `ffmpeg ${data.version} · ffprobe ${data.probeVersion}${data.verified ? ' · checksum verified' : ''}`
        : `Build ${data.version} installed${data.verified ? ' · checksum verified' : ''}`;
    state.status = data.status;
    if (!quiet) {
      toast(kind === 'ffmpeg' ? `ffmpeg ${data.version} ready` : `Build ${data.version} ready`, 'ok');
    }
    setTimeout(() => { panel.hidden = true; }, 2600);
  } catch (error) {
    $('#installLamp').dataset.tone = 'bad';
    $('#installText').textContent = error.message;
    if (!quiet) toast(error.message, 'bad');
  } finally {
    state.installing = null;
    renderSettings();
    renderSetup();
  }
}

function renderSetup() {
  const status = state.status;
  if (!status) return;
  const binary = status.binary || {};
  const ffmpeg = status.ffmpeg || {};
  const needYtdlp = !binary.version;
  const needFfmpeg = !ffmpeg.version;
  const needed = needYtdlp || needFfmpeg;

  $('#setupCard').hidden = !needed;
  $('#emptyIdle').hidden = needed;
  $('#stageEmpty').classList.toggle('is-setup', needed);
  if (!needed) return;

  const busy = Boolean(state.installing);
  const ytdlpButton = $('#setupYtdlp');
  ytdlpButton.disabled = busy;
  ytdlpButton.textContent = state.installing === 'yt-dlp'
    ? 'Installing…'
    : needYtdlp
      ? 'Install'
      : 'Reinstall';
  $('#setupYtdlpState').textContent = binary.version
    ? `yt-dlp ${binary.version} · ${binary.source}`
    : state.installing === 'yt-dlp'
      ? 'Downloading and verifying…'
      : 'Not installed';
  $('#setupLampYtdlp').dataset.tone = binary.version ? 'ok' : state.installing === 'yt-dlp' ? 'busy' : 'idle';

  const ffmpegButton = $('#setupFfmpeg');
  ffmpegButton.disabled = busy;
  ffmpegButton.textContent = state.installing === 'ffmpeg'
    ? 'Installing…'
    : needFfmpeg
      ? 'Install'
      : 'Reinstall';
  $('#setupFfmpegState').textContent = ffmpeg.version
    ? `ffmpeg ${ffmpeg.version}${ffmpeg.probeVersion ? ` · ffprobe ${ffmpeg.probeVersion}` : ''}`
    : state.installing === 'ffmpeg'
      ? 'Downloading and verifying…'
      : 'Not installed';
  $('#setupLampFfmpeg').dataset.tone = ffmpeg.version ? 'ok' : state.installing === 'ffmpeg' ? 'busy' : 'idle';

  const all = $('#setupAll');
  all.disabled = busy;
  all.textContent = busy ? 'Installing…' : 'Install both';
  $('#setupHint').textContent = busy
    ? 'Keeping the app open while the archives download.'
    : 'Downloads come from GitHub and ffmpeg.martin-riedl.de';
}

async function checkAppUpdate({ quiet = false } = {}) {
  if (state.installing) return;
  const app = state.status?.app || {};
  state.status = { ...state.status, app: { ...app, checking: true } };
  renderSettings();
  try {
    const info = await api('/api/app/update/check', { method: 'POST' });
    state.status = {
      ...state.status,
      app: {
        ...(state.status?.app || {}),
        version: info.current,
        latest: info.latest,
        available: info.available,
        notesUrl: info.release?.notesUrl || null,
        checkedAt: new Date().toISOString(),
        checking: false
      }
    };
    if (!quiet) {
      toast(info.available ? `Vesper ${info.latest} is available` : 'Vesper is up to date', info.available ? 'warn' : 'ok');
    }
  } catch (error) {
    state.status = { ...state.status, app: { ...(state.status?.app || {}), checking: false, error: error.message } };
    if (!quiet) toast(error.message, 'bad');
  }
  renderSettings();
}

function requestUpdate() {
  const app = state.status?.app || {};
  if (app.downloaded) {
    openPopover($('#updateBtn'), {
      html: `
        <div class="pop-head"><span class="label">Install update</span></div>
        <div class="save-body">
          <p class="pop-hint">Vesper will quit, replace itself with version ${esc(app.latest || '')}, and reopen. Your queue and settings stay in place.</p>
          <div class="pop-actions">
            <button class="btn-quiet" type="button" id="updateCancel">Later</button>
            <button class="btn-primary" type="button" id="updateConfirm">Restart now</button>
          </div>
        </div>`,
      className: 'pop-save',
      align: 'right',
      onMount(el) {
        $('#updateCancel', el).addEventListener('click', () => closePopover({ restoreFocus: true }));
        $('#updateConfirm', el).addEventListener('click', installAppUpdate);
      }
    });
    return;
  }
  downloadAppUpdate();
}

async function downloadAppUpdate() {
  if (state.installing) return;
  state.installing = 'update';
  const panel = $('#updatePanel');
  panel.hidden = false;
  $('#updateFill').style.width = '0%';
  $('#updateLamp').dataset.tone = 'busy';
  $('#updateText').textContent = 'Downloading update';
  $('#updatePct').textContent = '';
  renderSettings();

  try {
    const data = await api('/api/app/update/download', { method: 'POST' });
    state.status = {
      ...state.status,
      app: { ...(state.status?.app || {}), downloaded: { version: data.version } }
    };
    $('#updateFill').style.width = '100%';
    $('#updateLamp').dataset.tone = 'ok';
    $('#updateText').textContent = `Vesper ${data.version} is ready${data.verified ? ' · checksum verified' : ''}`;
    $('#updatePct').textContent = fmtBytes(data.size);
    toast('Update downloaded', 'ok');
  } catch (error) {
    $('#updateLamp').dataset.tone = 'bad';
    $('#updateText').textContent = error.message;
    toast(error.message, 'bad');
  } finally {
    state.installing = null;
    renderSettings();
  }
}

async function installAppUpdate() {
  try {
    await api('/api/app/update/install', { method: 'POST' });
    closePopover();
    toast('Installing — Vesper will reopen', 'ok');
  } catch (error) {
    toast(error.message, 'bad');
  }
}

function renderInstallProgress(data) {
  const ratio = data.ratio || 0;
  const pct = Math.round(Math.min(1, ratio) * 100);
  if (data.kind === 'update') {
    const panel = $('#updatePanel');
    panel.hidden = false;
    $('#updateFill').style.width = `${pct}%`;
    $('#updatePct').textContent = data.total ? `${pct}% of ${fmtBytes(data.total)}` : `${pct}%`;
    return;
  }
  const panel = $('#installPanel');
  if (panel.hidden) panel.hidden = false;
  if (data.tool) $('#installText').textContent = `Downloading ${data.tool}`;
  $('#installFill').style.width = `${pct}%`;
  $('#installPct').textContent = data.total ? `${pct}% of ${fmtBytes(data.total)}` : `${pct}%`;
}

/* -------------------------------------------------------------------- start */

window.vesper = {
  checkUpdates: () => checkAppUpdate()
};

boot();
