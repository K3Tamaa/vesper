import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vesper-api-'));
const PORT = 45000 + Math.floor(Math.random() * 4000);

const child = spawn(process.execPath, ['server.mjs', `--port=${PORT}`], {
  cwd: ROOT,
  env: {
    ...process.env,
    VESPER_DATA: dataDir,
    VESPER_PORT: String(PORT),
    VESPER_SKIP_NETWORK: '1'
  },
  stdio: 'ignore'
});

function request({ method = 'GET', path: route = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, method, path: route, headers }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', reject);
    req.setTimeout(15_000, () => req.destroy(new Error('request timed out')));
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const jsonHeaders = { 'content-type': 'application/json', 'x-vesper': '1' };

test.before(async () => {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const response = await request({ path: '/api/health' });
      if (response.status === 200) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error('server did not start');
});

test.after(() => {
  child.kill('SIGTERM');
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('health answers without the request marker', async () => {
  const response = await request({ path: '/api/health' });
  assert.equal(response.status, 200);
  assert.match(response.text, /Vesper/);
});

test('POST without the marker header is refused and writes nothing', async () => {
  const response = await request({
    method: 'POST',
    path: '/api/settings',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ concurrency: 4 })
  });
  assert.equal(response.status, 403);
  assert.equal(fs.existsSync(path.join(dataDir, 'settings.json')), false);
});

test('POST with a non-JSON content type is refused', async () => {
  const response = await request({
    method: 'POST',
    path: '/api/settings',
    headers: { 'content-type': 'text/plain', 'x-vesper': '1' },
    body: JSON.stringify({ concurrency: 4 })
  });
  assert.equal(response.status, 403);
});

test('a foreign Host header is refused', async () => {
  const response = await request({
    method: 'POST',
    path: '/api/settings',
    headers: { ...jsonHeaders, host: 'evil.example' },
    body: JSON.stringify({ concurrency: 4 })
  });
  assert.equal(response.status, 403);
});

test('a foreign Origin header is refused', async () => {
  const response = await request({
    method: 'POST',
    path: '/api/settings',
    headers: { ...jsonHeaders, origin: 'http://evil.example' },
    body: JSON.stringify({ concurrency: 4 })
  });
  assert.equal(response.status, 403);
});

test('a well-formed settings POST is accepted', async () => {
  const response = await request({
    method: 'POST',
    path: '/api/settings',
    headers: jsonHeaders,
    body: JSON.stringify({ concurrency: 3 })
  });
  assert.equal(response.status, 200);
  const payload = JSON.parse(response.text);
  assert.equal(payload.settings.concurrency, 3);
  const stored = JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8'));
  assert.equal(stored.concurrency, 3);
});

test('dangerous extra arguments are dropped with a warning', async () => {
  const response = await request({
    method: 'POST',
    path: '/api/settings',
    headers: jsonHeaders,
    body: JSON.stringify({ extraArgs: '--exec id' })
  });
  assert.equal(response.status, 200);
  const payload = JSON.parse(response.text);
  assert.equal(payload.settings.extraArgs, '');
  assert.match(payload.warnings.join(' '), /not allowed/);
  const stored = JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8'));
  assert.equal(stored.extraArgs, '');
});

test('relative executable paths are refused', async () => {
  const response = await request({
    method: 'POST',
    path: '/api/settings',
    headers: jsonHeaders,
    body: JSON.stringify({ binaryPath: 'bin/yt-dlp' })
  });
  assert.equal(response.status, 200);
  assert.equal(JSON.parse(response.text).settings.binaryPath, '');
});

test('reveal is limited to managed paths', async () => {
  const response = await request({
    method: 'POST',
    path: '/api/reveal',
    headers: jsonHeaders,
    body: JSON.stringify({ path: '/etc/passwd' })
  });
  assert.equal(response.status, 403);
});

test('thumbnails from unknown hosts are refused', async () => {
  const response = await request({ path: `/api/thumb?u=${encodeURIComponent('https://example.com/a.jpg')}` });
  assert.equal(response.status, 400);
});

test('an empty playlist selection is refused', async () => {
  const response = await request({
    method: 'POST',
    path: '/api/download',
    headers: jsonHeaders,
    body: JSON.stringify({ url: 'https://example.com/list', kind: 'playlist', items: [] })
  });
  assert.equal(response.status, 400);
});
