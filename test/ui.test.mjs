import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

test('the interface declares a content security policy', () => {
  const html = read('public/index.html');
  assert.match(html, /http-equiv="Content-Security-Policy"/);
  assert.match(html, /default-src 'self'/);
  assert.match(html, /script-src 'self'/);
  assert.match(html, /img-src 'self' data: https:/);
  assert.match(html, /style-src 'self' 'unsafe-inline'/);
});

test('the interface marks its requests', () => {
  const js = read('public/app.js');
  assert.match(js, /'X-Vesper': '1'/);
});

test('the dead archive open branch is gone', () => {
  assert.equal(read('public/app.js').includes("dataset.arc === 'open'"), false);
});

test('the screenshot script does not target a missing selector', () => {
  assert.equal(read('dev/shoot.mjs').includes('#advancedToggle'), false);
});

test('the shell restricts navigation to the local server', () => {
  const swift = read('mac/Vesper.swift');
  assert.match(swift, /func webView\(_ webView: WKWebView, decidePolicyFor/);
  assert.match(swift, /host == "127\.0\.0\.1" \|\| host == "localhost"/);
});
