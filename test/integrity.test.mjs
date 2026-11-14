import test from 'node:test';
import assert from 'node:assert/strict';
import { digestOf, findChecksum, parseDigestLine, verifyDigest } from '../lib/integrity.mjs';

const sha = (value) => digestOf(Buffer.from(value));
const text = `# generated\n${sha('a')}  yt-dlp_macos\n${sha('b')} *yt-dlp_linux\n`;

test('findChecksum returns the digest for the exact asset name', () => {
  assert.equal(findChecksum(text, 'yt-dlp_macos'), sha('a'));
  assert.equal(findChecksum(text, 'yt-dlp_linux'), sha('b'));
  assert.equal(findChecksum(text, 'not-listed'), null);
});

test('findChecksum ignores unrelated lines', () => {
  assert.equal(findChecksum('', 'yt-dlp_macos'), null);
  assert.equal(findChecksum('not a checksum file', 'yt-dlp_macos'), null);
});

test('verifyDigest compares case-insensitively and fails without an expectation', () => {
  assert.equal(verifyDigest(sha('a'), sha('a')), true);
  assert.equal(verifyDigest(sha('a').toUpperCase(), sha('a')), true);
  assert.equal(verifyDigest(sha('a'), sha('b')), false);
  assert.equal(verifyDigest(sha('a'), null), false);
  assert.equal(verifyDigest(null, sha('a')), false);
});

test('parseDigestLine reads a single-digest sidecar', () => {
  assert.equal(parseDigestLine(`${sha('a')}  ffmpeg.zip\n`), sha('a'));
  assert.equal(parseDigestLine('nope'), null);
});
