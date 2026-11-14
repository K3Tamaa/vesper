import test from 'node:test';
import assert from 'node:assert/strict';
import { formatArgs, sanitizeSpec } from '../lib/formats.mjs';

const build = (patch) => {
  const spec = sanitizeSpec({
    kind: 'video',
    container: 'mp4',
    quality: 'best',
    extras: { thumbnail: true, metadata: true },
    ...patch
  });
  return formatArgs(spec).args;
};

test('thumbnail embedding is requested for supported containers', () => {
  assert.equal(build({ container: 'mp4' }).includes('--embed-thumbnail'), true);
  assert.equal(build({ container: 'mkv' }).includes('--embed-thumbnail'), true);
  const audio = sanitizeSpec({
    kind: 'audio',
    container: 'mp3',
    quality: 'best',
    extras: { thumbnail: true }
  });
  assert.equal(formatArgs(audio).args.includes('--embed-thumbnail'), true);
});

test('webm never asks yt-dlp to embed a thumbnail', () => {
  assert.equal(build({ container: 'webm' }).includes('--embed-thumbnail'), false);
});
