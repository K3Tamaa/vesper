import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { HOME, prettyPath } from '../lib/util.mjs';

test('prettyPath shortens only real home paths', () => {
  assert.equal(prettyPath(HOME), '~');
  assert.equal(prettyPath(path.join(HOME, 'Movies', 'Vesper')), `~${path.sep}Movies${path.sep}Vesper`);
  assert.equal(prettyPath(`${HOME}2/file`), `${HOME}2/file`);
  assert.equal(prettyPath('/tmp/x'), '/tmp/x');
  assert.equal(prettyPath(''), '');
});
