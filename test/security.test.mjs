import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import {
  hostHeaderAllowed,
  isPrivateHost,
  openUrlAllowed,
  originAllowed,
  postHeadersAllowed,
  revealTargetAllowed,
  thumbUrlAllowed
} from '../lib/security.mjs';

const PORT = 4711;

test('only loopback host headers are accepted', () => {
  assert.equal(hostHeaderAllowed(`127.0.0.1:${PORT}`, PORT), true);
  assert.equal(hostHeaderAllowed(`LOCALHOST:${PORT}`, PORT), true);
  assert.equal(hostHeaderAllowed('evil.example', PORT), false);
  assert.equal(hostHeaderAllowed(`evil.example:${PORT}`, PORT), false);
  assert.equal(hostHeaderAllowed(`127.0.0.1:${PORT + 1}`, PORT), false);
  assert.equal(hostHeaderAllowed('', PORT), false);
});

test('an Origin header must be the app window origin', () => {
  assert.equal(originAllowed(undefined, PORT), true);
  assert.equal(originAllowed(`http://127.0.0.1:${PORT}`, PORT), true);
  assert.equal(originAllowed(`http://localhost:${PORT}`, PORT), true);
  assert.equal(originAllowed('http://evil.example', PORT), false);
  assert.equal(originAllowed('null', PORT), false);
});

test('POST requests need the marker header and JSON', () => {
  assert.equal(postHeadersAllowed({ 'x-vesper': '1', 'content-type': 'application/json' }), true);
  assert.equal(postHeadersAllowed({ 'x-vesper': '1', 'content-type': 'application/json; charset=utf-8' }), true);
  assert.equal(postHeadersAllowed({ 'x-vesper': '0', 'content-type': 'application/json' }), false);
  assert.equal(postHeadersAllowed({ 'content-type': 'application/json' }), false);
  assert.equal(postHeadersAllowed({ 'x-vesper': '1', 'content-type': 'text/plain' }), false);
  assert.equal(postHeadersAllowed({ 'x-vesper': '1' }), false);
});

test('private and loopback addresses are recognised', () => {
  for (const host of ['127.0.0.1', '10.0.0.5', '172.16.4.2', '172.31.255.1', '192.168.1.10', '169.254.1.1', '::1', '[::1]', 'localhost', 'printer.local', 'fd00::1', 'fe80::1']) {
    assert.equal(isPrivateHost(host), true, `${host} should be private`);
  }
  assert.equal(isPrivateHost('172.32.0.1'), false);
  assert.equal(isPrivateHost('8.8.8.8'), false);
  assert.equal(isPrivateHost('i.ytimg.com'), false);
});

test('thumbnail hosts are allowlisted', () => {
  assert.equal(thumbUrlAllowed('https://i.ytimg.com/vi/x/mqdefault.jpg'), true);
  assert.equal(thumbUrlAllowed('https://i9.ytimg.com/vi/x/mqdefault.jpg'), true);
  assert.equal(thumbUrlAllowed('https://lh3.googleusercontent.com/abc'), true);
  assert.equal(thumbUrlAllowed('https://i.vimeocdn.com/video/1.jpg'), true);
  assert.equal(thumbUrlAllowed('https://pbs.twimg.com/media/x.jpg'), true);
  assert.equal(thumbUrlAllowed('https://example.com/x.jpg'), false);
  assert.equal(thumbUrlAllowed('http://169.254.169.254/latest/meta-data'), false);
  assert.equal(thumbUrlAllowed('file:///etc/passwd'), false);
  assert.equal(thumbUrlAllowed('https://example.com/x.jpg', ['example.com']), true);
});

test('reveal is limited to files the app produced', () => {
  const home = path.join(os.tmpdir(), 'vesper-reveal-home');
  const outputDir = path.join(home, 'Movies', 'Vesper');
  const dataDir = path.join(home, 'Library', 'Application Support', 'Vesper');
  const history = [{ file: path.join(outputDir, 'Song [id].mp3') }];
  const extraFiles = [path.join(home, 'elsewhere', 'clip.mp4')];
  const options = { dataDir, outputDir, history, extraFiles };

  assert.equal(revealTargetAllowed(path.join(outputDir, 'Song [id].mp3'), options), true);
  assert.equal(revealTargetAllowed(path.join(outputDir, 'other.mkv'), options), true);
  assert.equal(revealTargetAllowed(path.join(home, 'elsewhere', 'clip.mp4'), options), true);
  assert.equal(revealTargetAllowed(path.join(home, 'Documents', 'taxes.pdf'), options), false);
  assert.equal(revealTargetAllowed('/etc/passwd', options), false);
  assert.equal(revealTargetAllowed(outputDir, options), false, 'the output folder itself is not a file');
  assert.equal(revealTargetAllowed(dataDir, { ...options, folder: true }), true);
  assert.equal(revealTargetAllowed(home, { ...options, folder: true }), false);
});

test('script and bundle extensions are never revealed', () => {
  const outputDir = '/Users/someone/Movies/Vesper';
  const options = { outputDir };
  for (const name of ['install.command', 'App.app', 'run.sh', 'Terminal.terminal', 'pkg.pkg', 'flow.workflow']) {
    assert.equal(revealTargetAllowed(path.join(outputDir, name), options), false, name);
  }
  assert.equal(revealTargetAllowed(path.join(outputDir, 'movie.mp4'), options), true);
});

test('open only accepts short http(s) links', () => {
  assert.equal(openUrlAllowed('https://github.com/K3Tamaa/vesper'), true);
  assert.equal(openUrlAllowed('file:///etc/passwd'), false);
  assert.equal(openUrlAllowed(`https://example.com/${'a'.repeat(2100)}`), false);
  assert.equal(openUrlAllowed(''), false);
});
