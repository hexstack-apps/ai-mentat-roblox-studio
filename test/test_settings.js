'use strict';
// Unit tests for lib/settings.js — the project registry.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const S = require('../lib/settings');

function tmpFile() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'rbxs-test-'));
  return path.join(d, 'settings.json');
}

// ── load / save ────────────────────────────────────────────────────────────

test('loadSettings returns an empty registry when the file is missing', () => {
  assert.deepStrictEqual(S.loadSettings('/nonexistent/x.json'), { projects: [], activeProject: null });
});

test('loadSettings survives a corrupt file instead of throwing', () => {
  // A damaged settings file must not stop the app from starting.
  const f = tmpFile();
  fs.writeFileSync(f, '{ this is not json');
  assert.deepStrictEqual(S.loadSettings(f), { projects: [], activeProject: null });
});

test('loadSettings normalises a file missing `projects`', () => {
  // REGRESSION: a hand-edited file without `projects` made every caller throw
  // "cannot read property find of undefined".
  const f = tmpFile();
  fs.writeFileSync(f, JSON.stringify({ activeProject: 'a' }));
  const s = S.loadSettings(f);
  assert.ok(Array.isArray(s.projects), 'projects must always be an array');
});

test('loadSettings rejects a non-object payload', () => {
  const f = tmpFile();
  fs.writeFileSync(f, '"just a string"');
  assert.deepStrictEqual(S.loadSettings(f), { projects: [], activeProject: null });
});

test('saveSettings round-trips through loadSettings', () => {
  const f = tmpFile();
  const data = { projects: [{ name: 'a', path: '/p/a' }], activeProject: 'a' };
  S.saveSettings(f, data);
  assert.deepStrictEqual(S.loadSettings(f), data);
});

test('saveSettings writes via a temp file then renames (atomicity mechanism)', () => {
  // Asserting the RESULT is not enough: a plain in-place writeFileSync produces
  // an identical result and passed every other test here (caught by mutation
  // testing). Atomicity is a property of HOW the write happens, so observe the
  // mechanism — the real file must appear via rename, never be opened for
  // writing directly.
  const f = tmpFile();
  fs.writeFileSync(f, JSON.stringify(S.emptySettings()));

  const realWrite = fs.writeFileSync;
  const realRename = fs.renameSync;
  const writes = [];
  let renamed = null;
  fs.writeFileSync = (p, ...rest) => { writes.push(String(p)); return realWrite(p, ...rest); };
  fs.renameSync = (a, b) => { renamed = [String(a), String(b)]; return realRename(a, b); };
  try {
    S.saveSettings(f, { projects: [{ name: 'a', path: '/p/a' }], activeProject: 'a' });
  } finally {
    fs.writeFileSync = realWrite;
    fs.renameSync = realRename;
  }

  assert.ok(renamed, 'must rename a temp file into place');
  assert.strictEqual(renamed[1], f, 'rename target must be the settings file');
  assert.ok(
    !writes.includes(f),
    'settings file must never be written in place — a crash mid-write would truncate the registry'
  );
});

test('saveSettings leaves no .tmp file behind', () => {
  // The atomic write renames the temp file; a leftover means the rename failed
  // and the next save could read a half-written file.
  const f = tmpFile();
  S.saveSettings(f, S.emptySettings());
  assert.ok(!fs.existsSync(f + '.tmp'), 'temp file must be renamed, not left');
});

test('saveSettings never leaves a truncated file on repeated writes', () => {
  const f = tmpFile();
  for (let i = 0; i < 20; i++) {
    S.saveSettings(f, { projects: [{ name: 'p' + i, path: '/p/' + i }], activeProject: 'p' + i });
    // Every intermediate state must be parseable — that is what atomicity buys.
    const s = S.loadSettings(f);
    assert.strictEqual(s.activeProject, 'p' + i);
  }
});

// ── activeProjectPath ──────────────────────────────────────────────────────

test('activeProjectPath resolves the selected project', () => {
  const s = { projects: [{ name: 'a', path: '/p/a' }, { name: 'b', path: '/p/b' }], activeProject: 'b' };
  assert.strictEqual(S.activeProjectPath(s), '/p/b');
});

test('activeProjectPath returns null when the active project was removed', () => {
  // The file can name an activeProject that is no longer in the list; callers
  // must get null, not undefined.
  const s = { projects: [{ name: 'a', path: '/p/a' }], activeProject: 'gone' };
  assert.strictEqual(S.activeProjectPath(s), null);
});

test('activeProjectPath tolerates a malformed settings object', () => {
  assert.strictEqual(S.activeProjectPath(null), null);
  assert.strictEqual(S.activeProjectPath({}), null);
});

// ── mutations are immutable ────────────────────────────────────────────────

test('addProject does not mutate the input', () => {
  // The caller decides when to persist; a failed write must not leave in-memory
  // state disagreeing with disk.
  const s = { projects: [], activeProject: null };
  const out = S.addProject(s, 'a', '/p/a');
  assert.strictEqual(s.projects.length, 0, 'input must be untouched');
  assert.strictEqual(out.projects.length, 1);
});

test('addProject selects an existing name instead of duplicating it', () => {
  const s = { projects: [{ name: 'a', path: '/p/a' }], activeProject: null };
  const out = S.addProject(s, 'a', '/p/other');
  assert.strictEqual(out.projects.length, 1, 'registry is keyed by name');
  assert.strictEqual(out.activeProject, 'a');
});

test('removeProject clears activeProject when the active one is removed', () => {
  // Falling back to null rather than another project: silently switching the
  // user to a different codebase is worse than "no project selected".
  const s = { projects: [{ name: 'a', path: '/p/a' }, { name: 'b', path: '/p/b' }], activeProject: 'a' };
  const out = S.removeProject(s, 'a');
  assert.strictEqual(out.activeProject, null);
  assert.strictEqual(out.projects.length, 1);
});

test('removeProject keeps activeProject when a different project is removed', () => {
  const s = { projects: [{ name: 'a', path: '/p/a' }, { name: 'b', path: '/p/b' }], activeProject: 'a' };
  assert.strictEqual(S.removeProject(s, 'b').activeProject, 'a');
});

test('selectProject rejects an unknown name', () => {
  const s = { projects: [{ name: 'a', path: '/p/a' }], activeProject: 'a' };
  assert.strictEqual(S.selectProject(s, 'nope').activeProject, 'a', 'must not store an unknown name');
});

// ── scaffold ───────────────────────────────────────────────────────────────

test('rojoProjectScaffold produces a valid Rojo tree', () => {
  // A malformed scaffold only surfaces when `rojo serve` refuses to start,
  // long after the folder was created.
  const sc = S.rojoProjectScaffold('MyGame');
  assert.strictEqual(sc.name, 'MyGame');
  assert.strictEqual(sc.tree.$className, 'DataModel');
  const json = JSON.stringify(sc);
  assert.deepStrictEqual(JSON.parse(json), sc, 'must be JSON-serialisable');
});

test('every scaffold dir has a matching $path entry, and vice versa', () => {
  // The two lists are written separately in projects:init — a directory with no
  // $path is dead weight, and a $path with no directory makes Rojo error.
  const sc = S.rojoProjectScaffold('X');
  const paths = Object.values(sc.tree).filter((v) => v && v.$path).map((v) => v.$path);
  assert.deepStrictEqual(paths.slice().sort(), S.SCAFFOLD_DIRS.slice().sort());
});
