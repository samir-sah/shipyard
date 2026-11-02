import test from 'node:test';
import assert from 'node:assert/strict';
import { artifactKey, logCursor, parseProject, requireUuid } from '../src/validation.js';

test('accepts one documented GitHub HTTPS recipe and canonicalizes URLs', () => {
  assert.deepEqual(parseProject({ name: ' Portfolio ', repoUrl: 'https://github.com/samir-sah/shipyard' }), { name: 'Portfolio', repoUrl: 'https://github.com/samir-sah/shipyard.git' });
  assert.equal(parseProject({ name: 'x', repoUrl: 'https://github.com/a/b.git' }).repoUrl, 'https://github.com/a/b.git');
});

test('rejects local, credentialed, non-GitHub and shell-shaped repository inputs', () => {
  for (const repoUrl of ['file:///tmp/repo', 'http://github.com/a/b', 'https://github.com.evil.test/a/b', 'https://user:secret@github.com/a/b', 'https://github.com/a/b?token=x', 'https://github.com/a/b#main', 'https://github.com:444/a/b', 'https://github.com/a/b;touch', '-rf', 'git@github.com:a/b.git']) {
    assert.throws(() => parseProject({ name: 'test', repoUrl }), Error, repoUrl);
  }
  for (const input of [null, [], {}, { name: '', repoUrl: 'https://github.com/a/b' }, { name: 'a'.repeat(81), repoUrl: 'https://github.com/a/b' }, { name: 'bad\0name', repoUrl: 'https://github.com/a/b' }]) assert.throws(() => parseProject(input));
});

test('artifact paths and log cursors cannot escape their namespace', () => {
  assert.equal(artifactKey('assets/app.js'), 'assets/app.js');
  for (const key of ['../secret', '/secret', 'assets/../secret', 'a\\b', 'a//b', 'a\0b', './x', 'a'.repeat(1025)]) assert.throws(() => artifactKey(key));
  assert.equal(logCursor(undefined), 0);
  assert.equal(logCursor('42'), 42);
  for (const cursor of ['-1', '1.2', '1e3', '9007199254740992', ['1']]) assert.throws(() => logCursor(cursor));
  assert.throws(() => requireUuid("' OR 1=1"));
});
