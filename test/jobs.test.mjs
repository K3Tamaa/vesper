import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'vesper-jobs-'));
process.env.VESPER_DATA = data;

const { Queue, buildArgs, ffmpegLocationFor } = await import('../lib/jobs.mjs');
const { sanitizeSpec } = await import('../lib/formats.mjs');

test.after(() => {
  fs.rmSync(data, { recursive: true, force: true });
});

test('a custom ffmpeg points yt-dlp at its own folder', () => {
  assert.equal(ffmpegLocationFor({ ffmpegPath: '/opt/homebrew/bin/ffmpeg' }), '/opt/homebrew/bin');
  assert.equal(ffmpegLocationFor({ ffmpegPath: '' }), null, 'nothing found means no flag');
});

test('a managed ffmpeg points at the managed folder', () => {
  fs.mkdirSync(path.join(data, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(data, 'bin', 'ffmpeg'), '#!/bin/sh\n', { mode: 0o755 });
  assert.equal(ffmpegLocationFor({}), path.join(data, 'bin'));
});

test('buildArgs carries the ffmpeg location and drops blocked extras', () => {
  const settings = {
    outputDir: path.join(data, 'out'),
    filenameTemplate: '%(id)s.%(ext)s',
    ffmpegPath: '/opt/homebrew/bin/ffmpeg',
    extraArgs: '--exec id --limit-rate 2M'
  };
  const job = { url: 'https://example.com/v', kind: 'video', items: null, spec: sanitizeSpec({}) };
  const { args } = buildArgs(job, settings, { path: '/usr/bin/true' });
  const location = args.indexOf('--ffmpeg-location');
  assert.notEqual(location, -1);
  assert.equal(args[location + 1], '/opt/homebrew/bin');
  assert.equal(args.includes('--exec'), false);
  assert.equal(args.includes('--limit-rate'), true);
  assert.equal(args.at(-2), '--');
  assert.equal(args.at(-1), 'https://example.com/v');
});

function fakeJob(overrides = {}) {
  return {
    id: 'job_retry',
    url: 'https://example.com/v',
    title: 'clip',
    kind: 'video',
    spec: sanitizeSpec({}),
    status: 'error',
    progress: { pct: 12 },
    file: '/tmp/partial.mp4',
    files: ['/tmp/partial.mp4'],
    size: 100,
    log: ['ERROR: boom'],
    fragments: '3/9',
    itemIndex: 2,
    startedAt: '2026-01-01T00:00:00.000Z',
    endedAt: '2026-01-01T00:01:00.000Z',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides
  };
}

test('retry clears the previous attempt', () => {
  const queue = new Queue({ getSettings: () => ({ concurrency: 1, outputDir: path.join(data, 'out') }) });
  queue.jobs = [fakeJob()];
  queue.running.set('occupied', {});
  assert.equal(queue.retry('job_retry'), true);
  const [job] = queue.jobs;
  queue.running.clear();

  assert.equal(job.status, 'queued');
  assert.equal(job.error, null);
  assert.deepEqual(job.progress, { pct: null, downloaded: null, total: null, speed: null, eta: null });
  assert.equal(job.file, null);
  assert.deepEqual(job.files, []);
  assert.equal(job.size, null);
  assert.deepEqual(job.log, []);
  assert.equal(job.fragments, null);
  assert.equal(job.itemIndex, null);
  assert.equal(job.startedAt, null);
  assert.equal(job.endedAt, null);
});

test('queued jobs survive a restart, running jobs become errors', () => {
  const settings = { concurrency: 1, outputDir: path.join(data, 'out') };
  const first = new Queue({ getSettings: () => settings });
  first.jobs = [fakeJob({ id: 'job_running', status: 'running' }), fakeJob({ id: 'job_queued', status: 'queued' })];
  first.changed(true);

  const reopened = new Queue({ getSettings: () => settings });
  const byId = new Map(reopened.jobs.map((job) => [job.id, job]));
  assert.equal(byId.get('job_running').status, 'error');
  assert.match(byId.get('job_running').error, /Interrupted/);
  assert.equal(byId.get('job_queued').status, 'queued');
});
