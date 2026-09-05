'use strict';
// Unit tests for lib/platform.js — pure platform/path logic.
// Run: node --test test/   (node 18+ built-in runner, no dependencies)

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const P = require('../lib/platform');

// ── buildPath ──────────────────────────────────────────────────────────────

test('buildPath puts user tool dirs BEFORE the inherited PATH', () => {
  const out = P.buildPath('darwin', '/Users/x', '/usr/bin:/bin');
  const brew = out.indexOf('/opt/homebrew/bin');
  const usr = out.indexOf('/usr/bin');
  assert.ok(brew >= 0, 'homebrew must be present');
  assert.ok(brew < usr, 'user tools must win over system PATH');
});

test('buildPath includes the dirs a GUI-launched app is missing', () => {
  // This is the bug the function exists for: Finder/launchd give a minimal
  // PATH, so rojo/claude appear "not installed" despite working in a terminal.
  const out = P.buildPath('darwin', '/Users/x', '/usr/bin:/bin');
  for (const p of ['/Users/x/.local/bin', '/Users/x/.bun/bin', '/opt/homebrew/bin', '/usr/local/bin']) {
    assert.ok(out.split(':').includes(p), `missing ${p}`);
  }
});

test('buildPath uses ; and Windows tool dirs on win32', () => {
  const out = P.buildPath('win32', 'C:\\Users\\x', 'C:\\Windows');
  assert.ok(out.includes(';'), 'win32 must use ; as separator');
  assert.ok(!out.split(';').includes('/opt/homebrew/bin'), 'no POSIX brew path on win32');
  assert.ok(out.includes(path.join('C:\\Users\\x', 'AppData', 'Roaming', 'npm')));
});

test('buildPath falls back to a usable PATH when the env has none', () => {
  // An empty PATH means even /bin/sh is unreachable, turning a missing-tool
  // warning into a crash.
  const out = P.buildPath('darwin', '/Users/x', '');
  assert.ok(out.endsWith('/usr/bin:/bin'), 'must append a default base PATH');
});

// ── pluginDir ──────────────────────────────────────────────────────────────

test('pluginDir uses LOCALAPPDATA on win32', () => {
  const out = P.pluginDir('win32', 'C:\\Users\\x', { LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local' });
  assert.strictEqual(out, path.join('C:\\Users\\x\\AppData\\Local', 'Roblox', 'Plugins'));
});

test('pluginDir uses ~/Documents on macOS', () => {
  assert.strictEqual(
    P.pluginDir('darwin', '/Users/x'),
    path.join('/Users/x', 'Documents', 'Roblox', 'Plugins')
  );
});

test('pluginDir on linux resolves inside the Wine prefix, NOT ~/Documents', () => {
  // REGRESSION: linux previously fell through to the macOS branch, creating a
  // directory Studio (running under Wine) never reads — plugin:status then
  // reported "installed" for a plugin nothing could load.
  const out = P.pluginDir('linux', '/home/x', { USER: 'x' });
  assert.ok(out.includes('.wine'), 'must be under the wine prefix');
  assert.notStrictEqual(out, path.join('/home/x', 'Documents', 'Roblox', 'Plugins'));
});

test('pluginDir honours WINEPREFIX when set', () => {
  const out = P.pluginDir('linux', '/home/x', { WINEPREFIX: '/custom/prefix', USER: 'x' });
  assert.ok(out.startsWith('/custom/prefix'), 'must respect a custom wine prefix');
});

// ── studioMcpCommand ───────────────────────────────────────────────────────

test('studioMcpCommand returns command+args separately, never a joined string', () => {
  // Joining first means a path containing a space silently splits into two
  // arguments and the MCP server is registered with a truncated command.
  const mac = P.studioMcpCommand('darwin');
  assert.strictEqual(typeof mac.command, 'string');
  assert.ok(Array.isArray(mac.args), 'args must be an array');
});

test('studioMcpCommand builds the win32 bat path from LOCALAPPDATA', () => {
  const out = P.studioMcpCommand('win32', { LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local' });
  assert.strictEqual(out.command, 'cmd.exe');
  // Must be a real resolved path, not the literal %LOCALAPPDATA% token: the
  // previous version passed '%LOCALAPPDATA%\\Roblox\\mcp.bat' through
  // `claude mcp add`, which does not expand cmd.exe variables.
  assert.ok(!out.args.join(' ').includes('%LOCALAPPDATA%'), 'env token must be expanded');
  assert.ok(out.args.join(' ').includes('mcp.bat'));
});

// ── shellQuote ─────────────────────────────────────────────────────────────

test('shellQuote leaves simple POSIX arguments untouched', () => {
  assert.strictEqual(P.shellQuote('/usr/bin/rojo', 'darwin'), '/usr/bin/rojo');
});

test('shellQuote protects paths containing spaces', () => {
  const q = P.shellQuote('/Applications/Roblox Studio.app/X', 'darwin');
  assert.ok(q.startsWith("'") && q.endsWith("'"), 'must be quoted');
  assert.ok(q.includes('Roblox Studio'));
});

test('shellQuote survives an embedded single quote', () => {
  const q = P.shellQuote("/tmp/o'brien/x", 'darwin');
  // Must not terminate the quoted string early — the classic injection shape.
  assert.ok(q.includes(`'\\''`), 'embedded quote must be escaped');
});

test('shellQuote uses double quotes on win32', () => {
  const q = P.shellQuote('C:\\Program Files\\x.bat', 'win32');
  assert.ok(q.startsWith('"') && q.endsWith('"'));
});

// ── studioStatusCommand / studioLaunchCommand ──────────────────────────────

test('studioStatusCommand covers darwin, win32 AND linux', () => {
  // REGRESSION: linux had no branch, so status always returned running:false —
  // indistinguishable from a genuine "not running" answer.
  for (const plat of ['darwin', 'win32', 'linux']) {
    const c = P.studioStatusCommand(plat);
    assert.ok(c && typeof c.cmd === 'string' && c.cmd.length > 0, `no command for ${plat}`);
    assert.strictEqual(typeof c.match, 'function', `no matcher for ${plat}`);
  }
});

test('studioStatusCommand returns null for an unknown platform', () => {
  // null lets the caller say "cannot determine" instead of asserting "stopped".
  assert.strictEqual(P.studioStatusCommand('aix'), null);
});

test('studioStatusCommand matchers actually discriminate', () => {
  const mac = P.studioStatusCommand('darwin');
  assert.strictEqual(mac.match('12345\n'), true);
  assert.strictEqual(mac.match('   \n'), false);
  const win = P.studioStatusCommand('win32');
  assert.strictEqual(win.match('RobloxStudioBeta.exe  1234 Console'), true);
  assert.strictEqual(win.match('INFO: No tasks are running.'), false);
});

test('studioLaunchCommand returns null where Studio cannot be launched', () => {
  assert.ok(P.studioLaunchCommand('darwin'));
  assert.ok(P.studioLaunchCommand('win32'));
  assert.strictEqual(P.studioLaunchCommand('linux'), null, 'no native linux Studio');
});
