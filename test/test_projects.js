'use strict';
// Unit tests for lib/settings.js — the project registry.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const S = require('../lib/projects');

function tmpFile() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'rbxs-test-'));
  return path.join(d, 'settings.json');
}

// ── load / save ────────────────────────────────────────────────────────────









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

// ─── Shape normalisation ─────────────────────────────────────────────────

test('normalise supplies a projects array the app can always .find() on', () => {
  // Five call sites do s.projects.find(...). A hand-edited file missing the key
  // used to crash every one of them.
  assert.deepStrictEqual(S.normalise({}).projects, []);
  assert.deepStrictEqual(S.normalise({ projects: 'nope' }).projects, []);
  assert.deepStrictEqual(S.normalise(null), S.emptySettings());
  assert.deepStrictEqual(S.normalise({ projects: [{ name: 'a' }] }).projects, [{ name: 'a' }]);
});

test('normalise rejects a non-string activeProject', () => {
  assert.strictEqual(S.normalise({ activeProject: 42 }).activeProject, null);
  assert.strictEqual(S.normalise({ activeProject: 'a' }).activeProject, 'a');
});

test('normalise preserves keys it does not know about', () => {
  // The store is shared with whatever else the app persists.
  assert.strictEqual(S.normalise({ mcpInstalled: true }).mcpInstalled, true);
});
