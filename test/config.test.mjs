import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'vesper-config-'));
process.env.VESPER_DATA = data;

const { loadJobs, saveJobs } = await import('../lib/config.mjs');

test.after(() => {
  fs.rmSync(data, { recursive: true, force: true });
});

test('saveJobs keeps the 80 newest jobs', () => {
  const jobs = Array.from({ length: 100 }, (_, i) => ({
    id: `job_${String(i).padStart(3, '0')}`,
    status: 'done',
    log: []
  }));
  saveJobs(jobs);
  const stored = loadJobs();
  assert.equal(stored.length, 80);
  assert.equal(stored[0].id, 'job_000');
  assert.equal(stored[79].id, 'job_079');
  assert.equal(stored.some((job) => job.id === 'job_099'), false);
});

test('saveJobs trims the per-job log', () => {
  saveJobs([{ id: 'job_x', status: 'error', log: Array.from({ length: 20 }, (_, i) => `line ${i}`) }]);
  const [stored] = loadJobs();
  assert.equal(stored.log.length, 8);
  assert.equal(stored.log.at(-1), 'line 19');
});
