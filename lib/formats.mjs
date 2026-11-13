/**
 * Format model shared by the API and the queue.
 * The UI sends a small, validated spec; this module turns it into yt-dlp flags.
 */

export const VIDEO_CONTAINERS = ['mp4', 'mov', 'mkv', 'webm', 'avi', 'flv'];
export const AUDIO_CONTAINERS = ['mp3', 'm4a', 'wav', 'flac', 'opus', 'ogg', 'aac', 'aiff', 'alac'];
export const VIDEO_QUALITIES = ['best', '2160', '1440', '1080', '720', '480', '360'];
export const AUDIO_QUALITIES = ['best', '320', '192', '128'];
export const SORTS = ['default', 'h264', 'av1', 'small'];
export const LOSSLESS = ['wav', 'flac', 'aiff', 'alac'];

export const BUILTIN_SPEC = {
  kind: 'video',
  container: 'mp4',
  quality: 'best',
  sort: 'default',
  extras: {
    sponsorblock: 'off',
    metadata: false,
    thumbnail: false,
    subtitles: 'off',
    chapters: 'off',
    legacy: false
  }
};

export function cloneSpec(spec) {
  return JSON.parse(JSON.stringify(spec));
}

export function sanitizeSpec(input = {}) {
  const kind = input.kind === 'audio' ? 'audio' : 'video';
  const containers = kind === 'audio' ? AUDIO_CONTAINERS : VIDEO_CONTAINERS;
  const qualities = kind === 'audio' ? AUDIO_QUALITIES : VIDEO_QUALITIES;
  const extras = input.extras || {};

  return {
    kind,
    container: containers.includes(input.container)
      ? input.container
      : kind === 'audio'
        ? 'mp3'
        : 'mp4',
    quality: qualities.includes(String(input.quality)) ? String(input.quality) : 'best',
    sort: SORTS.includes(input.sort) ? input.sort : 'default',
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

export function legacySpec(preset) {
  const base = cloneSpec(BUILTIN_SPEC);
  switch (preset) {
    case '1080':
    case '720':
      return { ...base, quality: preset };
    case 'mp3':
    case 'm4a':
      return { ...base, kind: 'audio', container: preset, quality: 'best' };
    default:
      return base;
  }
}

export function specLabel(spec) {
  const clean = sanitizeSpec(spec);
  if (clean.kind === 'audio') {
    const lossless = LOSSLESS.includes(clean.container);
    const rate = clean.quality === 'best' ? 'best' : `${clean.quality} kbps`;
    return `${clean.container.toUpperCase()} · ${lossless ? 'lossless' : rate}`;
  }
  const quality = clean.quality === 'best' ? 'Best' : `${clean.quality}p`;
  return `${quality} · ${clean.container.toUpperCase()}`;
}

export function formatArgs(spec) {
  const clean = sanitizeSpec(spec);
  const args = [];

  if (clean.kind === 'audio') {
    args.push('-f', 'ba/b', '-x', '--audio-format', clean.container);
    if (!LOSSLESS.includes(clean.container)) {
      args.push('--audio-quality', clean.quality === 'best' ? '0' : `${clean.quality}K`);
    }
  } else {
    const height = clean.quality === 'best' ? null : Number(clean.quality);
    const format = height
      ? `bv*[height<=${height}]+ba/b[height<=${height}]/b`
      : 'bv*+ba/b';
    args.push('-f', format);

    const sort = [];
    if (height) sort.push(`res:${height}`);
    if (clean.sort === 'h264') sort.push('vcodec:h264');
    if (clean.sort === 'av1') sort.push('vcodec:av01');
    if (clean.sort === 'small') sort.push('+size');
    if (clean.container === 'mp4' || clean.container === 'mov') sort.push('ext:mp4:m4a');
    if (clean.container === 'webm') sort.push('ext:webm:webm');
    if (sort.length) args.push('-S', sort.join(','));

    if (clean.container === 'mov') {
      args.push('--merge-output-format', 'mp4', '--remux-video', 'mov');
    } else if (['mp4', 'mkv', 'webm'].includes(clean.container)) {
      args.push('--merge-output-format', clean.container);
    } else {
      args.push('--recode-video', clean.container);
      const videoCodec = clean.container === 'avi' ? 'mpeg4' : 'flv';
      args.push('--postprocessor-args', `VideoConvertor:-c:v ${videoCodec} -c:a libmp3lame`);
    }
  }

  const extras = clean.extras;
  if (extras.sponsorblock === 'remove') {
    args.push('--sponsorblock-remove', 'sponsor,selfpromo,interaction');
  } else if (extras.sponsorblock === 'mark') {
    args.push('--sponsorblock-mark', 'sponsor,selfpromo,interaction');
  }
  const videoContainers = ['mp4', 'mkv', 'mov', 'webm'];
  const thumbContainers = [...videoContainers, 'mp3', 'm4a', 'flac', 'opus', 'ogg'];
  if (extras.metadata) args.push('--embed-metadata');
  if (extras.thumbnail && thumbContainers.includes(clean.container)) args.push('--embed-thumbnail');
  if (clean.kind === 'video' && videoContainers.includes(clean.container)) {
    if (extras.subtitles === 'en') args.push('--embed-subs', '--sub-langs', 'en.*,en');
    if (extras.subtitles === 'all') args.push('--embed-subs', '--sub-langs', 'all');
  }
  if (extras.chapters === 'embed') args.push('--embed-chapters');
  if (extras.chapters === 'split') args.push('--split-chapters');
  if (extras.legacy) args.push('--compat-options', 'youtube-dl');

  return { args, label: specLabel(clean), spec: clean };
}

export function sanitizePresets(input) {
  if (!Array.isArray(input)) return [];
  const seen = new Set();
  const output = [];
  for (const item of input.slice(0, 24)) {
    if (!item || typeof item.name !== 'string') continue;
    const name = item.name.trim().slice(0, 40);
    if (!name) continue;
    let id = typeof item.id === 'string' ? item.id.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) : '';
    if (!id || seen.has(id)) id = `p_${Date.now().toString(36)}${output.length}`;
    seen.add(id);
    output.push({
      id,
      name,
      spec: sanitizeSpec(item.spec),
      createdAt: typeof item.createdAt === 'string' ? item.createdAt : new Date().toISOString()
    });
  }
  return output;
}
