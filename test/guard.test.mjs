import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  checkCookiesBrowser,
  checkExecutablePath,
  checkExtraArgs,
  filterExtraTokens,
  MAX_EXTRA_TOKENS,
  splitArgs
} from '../lib/guard.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vesper-guard-'));
const fake = path.join(tmp, 'tool');
fs.writeFileSync(fake, '#!/bin/sh\n', { mode: 0o755 });

test.after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('splitArgs keeps quoted values together', () => {
  assert.deepEqual(splitArgs('--limit 10 --match-filter "a b"'), ['--limit', '10', '--match-filter', 'a b']);
});

test('splitArgs reports too many tokens instead of truncating', () => {
  const input = Array.from({ length: MAX_EXTRA_TOKENS + 1 }, (_, i) => `--flag${i}`).join(' ');
  assert.throws(() => splitArgs(input), /Too many extra arguments/);
});

test('dangerous options are rejected', () => {
  for (const input of [
    '--exec id',
    '--exec-before-download "rm -rf ~"',
    '--config-locations /tmp/evil',
    '--downloader curl',
    '--batch-file list.txt',
    '--paths /tmp',
    '--output /tmp/x',
    '-o /tmp/x',
    '-o=/tmp/x',
    '--plugin-dirs /tmp/plugins',
    '--external-downloader aria2c',
    '--exec=id'
  ]) {
    const result = checkExtraArgs(input);
    assert.equal(result.ok, false, `${input} should be rejected`);
    assert.ok(result.error, 'an error message is reported');
  }
});

test('ordinary extra arguments pass through', () => {
  const result = checkExtraArgs('--limit-rate 2M --no-mtime');
  assert.equal(result.ok, true);
  assert.deepEqual(result.args, ['--limit-rate', '2M', '--no-mtime']);
  assert.equal(result.value, '--limit-rate 2M --no-mtime');
});

test('legacy settings are filtered at build time', () => {
  assert.deepEqual(filterExtraTokens('--exec id --limit-rate 2M'), ['--limit-rate', '2M']);
});

test('executable paths must be absolute and executable', () => {
  assert.equal(checkExecutablePath('').ok, true);
  assert.equal(checkExecutablePath('bin/tool').ok, false);
  assert.equal(checkExecutablePath(path.join(tmp, 'missing')).ok, false);
  const ok = checkExecutablePath(fake);
  assert.equal(ok.ok, true);
  assert.equal(ok.path, fake);
});

test('cookies browser is validated against yt-dlp names', () => {
  assert.equal(checkCookiesBrowser('safari').ok, true);
  assert.equal(checkCookiesBrowser('chrome:Work').ok, true);
  assert.equal(checkCookiesBrowser('brave+keyring').ok, true);
  assert.equal(checkCookiesBrowser('netscape').ok, false);
  assert.equal(checkCookiesBrowser('firefox; rm -rf /').ok, false);
});
