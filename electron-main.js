const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');
const PLAT = require('./lib/platform');
const SKILLS = require('./lib/skills');
const STORE = require('./lib/settings');
const { setupAutoUpdate } = require('./sdk/logic/auto-update');

function shellEnv() {
  // PATH construction lives in lib/platform.js so it can be unit tested; a
  // GUI-launched app inherits a minimal PATH without Homebrew/.local/.bun.
  return { ...process.env, PATH: PLAT.buildPath(process.platform, os.homedir(), process.env.PATH) };
}

function execSyncEnv(cmd, opts = {}) {
  return execSync(cmd, { ...opts, env: { ...shellEnv(), ...opts.env } });
}

let mainWindow;
let rojoProcess;
let ptyProcess;
let cleanupDone = false;

// Data lives at <filesystem root>/.hexstack-app/<app-name>/data for every
// build type, dev and packaged alike, so there is one location to inspect.
// resolveDataDir falls back to ~/.hexstack-app/<app>/data when the root is
// not user-writable (see sdk/utils/data-dir.js).
const { resolveDataDir } = require('./sdk/utils/data-dir');
const dataDir = resolveDataDir("ai-mentat-roblox-studio");

if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

// ─── Settings ──────────────────────────────────────────────────────────────

const SETTINGS_FILE = path.join(dataDir, 'settings.json');

function loadSettings() { return STORE.loadSettings(SETTINGS_FILE); }

function saveSettings(data) { return STORE.saveSettings(SETTINGS_FILE, data); }

// ─── Logs ──────────────────────────────────────────────────────────────────
//
// Design note (Apr 29, from the sibling app): "why processing fails silently?
// can we add writing log file per run (same file) to debug?" — the same applies
// here: `rojo serve` failures used to vanish because stdio was piped and never
// read. Everything Rojo prints now lands in <dataDir>/logs/rojo.log, which
// survives restarts and is reachable from the UI.

const logsDir = path.join(dataDir, 'logs');
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

const ROJO_LOG_FILE = path.join(logsDir, 'rojo.log');
const ROJO_LOG_MAX_BYTES = 512 * 1024;

function appendRojoLog(text) {
  try {
    // Trim from the front when the log outgrows its cap.
    try {
      const st = fs.statSync(ROJO_LOG_FILE);
      if (st.size > ROJO_LOG_MAX_BYTES) {
        const kept = fs.readFileSync(ROJO_LOG_FILE, 'utf8').slice(-ROJO_LOG_MAX_BYTES / 2);
        fs.writeFileSync(ROJO_LOG_FILE, kept);
      }
    } catch {}
    fs.appendFileSync(ROJO_LOG_FILE, text);
  } catch {}
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('rojo:log', text);
}

// ─── Window ────────────────────────────────────────────────────────────────

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100, height: 750, title: 'Roblox Studio Mentat',
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: {
      nodeIntegration: false, contextIsolation: true, sandbox: false,
      preload: path.join(__dirname, 'preload.js'),
    },
    show: false,
  });
  mainWindow.on('closed', () => cleanup());
  mainWindow.loadFile(path.join(__dirname, 'app.html'));
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (!app.isPackaged) mainWindow.webContents.openDevTools();
  });
}

// ─── Cleanup ───────────────────────────────────────────────────────────────

function killProc(proc, name) {
  if (!proc || proc.killed) return;
  try {
    if (process.platform === 'win32') {
      execSync(`taskkill /pid ${proc.pid} /T /F`, { stdio: 'ignore' });
    } else {
      // rojo is no longer spawned detached, so it has no process group of its
      // own — `kill(-pid)` would raise ESRCH. Signal the process directly and
      // only fall back to the group for anything still started detached.
      try { proc.kill('SIGTERM'); }
      catch { process.kill(-proc.pid, 'SIGTERM'); }
    }
  } catch {}
  setTimeout(() => { try { if (!proc.killed) proc.kill('SIGKILL'); } catch {} }, 3000);
}

function cleanup() {
  if (cleanupDone) return;
  cleanupDone = true;
  killProc(rojoProcess, 'rojo');
  if (ptyProcess) { try { ptyProcess.kill(); } catch {} ptyProcess = null; }
  setTimeout(() => app.quit(), 500);
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function getActiveProjectPath() { return STORE.activeProjectPath(loadSettings()); }

function pluginDir() {
  return PLAT.pluginDir(process.platform, os.homedir(), process.env);
}

// ─── IPC: Projects ─────────────────────────────────────────────────────────

ipcMain.handle('projects:list', () => loadSettings());

ipcMain.handle('projects:add', (_, proj) => {
  const s = loadSettings();
  if (!s.projects.find(p => p.name === proj.name)) s.projects.push(proj);
  if (!s.activeProject) s.activeProject = proj.name;
  saveSettings(s);
  return s;
});

ipcMain.handle('projects:remove', (_, name) => {
  const s = loadSettings();
  s.projects = s.projects.filter(p => p.name !== name);
  if (s.activeProject === name) s.activeProject = s.projects[0]?.name || null;
  saveSettings(s);
  return s;
});

ipcMain.handle('projects:select', (_, name) => {
  const s = loadSettings();
  s.activeProject = name;
  saveSettings(s);
  return s;
});

ipcMain.handle('projects:active', () => {
  const s = loadSettings();
  return s.projects.find(p => p.name === s.activeProject) || null;
});

ipcMain.handle('projects:init', async (_, name, projPath) => {
  try {
    fs.mkdirSync(projPath, { recursive: true });

    // Rojo project scaffold
    for (const d of ['src/ServerScriptService', 'src/ReplicatedStorage', 'src/StarterPlayer']) {
      fs.mkdirSync(path.join(projPath, d), { recursive: true });
    }
    fs.writeFileSync(path.join(projPath, 'default.project.json'), JSON.stringify({
      name, tree: {
        $className: "DataModel",
        ServerScriptService: { $path: "src/ServerScriptService" },
        ReplicatedStorage: { $path: "src/ReplicatedStorage" },
        StarterPlayer: { $path: "src/StarterPlayer" },
      }
    }, null, 2));
    fs.writeFileSync(path.join(projPath, 'CLAUDE.md'), `# ${name}\n\nRoblox game project. Use Rojo for sync. Scripts are in src/.\n`);

    const s = loadSettings();
    const proj = { name, path: projPath };
    if (!s.projects.find(p => p.name === name)) s.projects.push(proj);
    s.activeProject = name;
    saveSettings(s);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.stderr?.toString().trim() || e.message };
  }
});

// ─── IPC: Rojo ─────────────────────────────────────────────────────────────

ipcMain.handle('rojo:check', () => {
  try { execSyncEnv('rojo --version', { timeout: 5000, stdio: 'pipe' }); return { installed: true }; }
  catch { return { installed: false }; }
});

// Rojo's default serve port. Ownership of the port — not ownership of a child
// process handle — is what actually determines whether Studio can sync.
const ROJO_PORT = 34872;

function probePort(port, timeout = 700) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    const done = (open) => { sock.destroy(); resolve(open); };
    sock.setTimeout(timeout);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
    sock.connect(port, '127.0.0.1');
  });
}

// The old status reported only `rojoProcess && !killed`, which was wrong in both
// directions:
//   * `rojo serve` is spawned detached, so it outlives the app. After a restart
//     the handle is gone, status said "stopped", and Start spawned a second
//     server that could not bind the port.
//   * A server the user started in their own terminal was invisible here.
// Probing the port covers every case and also tells us whether the running
// server is ours, so the UI can explain why Stop is unavailable.
ipcMain.handle('rojo:status', async () => {
  const ours = !!(rojoProcess && !rojoProcess.killed);
  const listening = await probePort(ROJO_PORT);
  return { running: listening, ours, external: listening && !ours, port: ROJO_PORT };
});

ipcMain.handle('rojo:start', async () => {
  if (rojoProcess && !rojoProcess.killed) return { success: true };

  if (await probePort(ROJO_PORT)) {
    // Something already owns the port. Starting another `rojo serve` would fail
    // to bind; previously we returned success and left a green indicator over a
    // server that was never ours.
    return { success: true, external: true, note: `A Rojo server is already listening on ${ROJO_PORT}.` };
  }

  const projPath = getActiveProjectPath();
  if (!projPath) return { success: false, error: 'No project selected' };

  return await new Promise((resolve) => {
    let settled = false;
    let stderr = '';
    const finish = (r) => { if (!settled) { settled = true; resolve(r); } };

    try {
      // Not detached: the server should not outlive the app that started it.
      rojoProcess = spawn('rojo', ['serve'], { cwd: projPath, stdio: 'pipe', env: shellEnv() });
    } catch (e) {
      return finish({ success: false, error: e.message });
    }

    rojoProcess.stderr?.on('data', (d) => {
      const t = d.toString();
      stderr += t;
      appendRojoLog(t);
    });
    rojoProcess.stdout?.on('data', (d) => appendRojoLog(d.toString()));

    rojoProcess.on('error', (e) => {
      rojoProcess = null;
      finish({ success: false, error: e.code === 'ENOENT' ? 'rojo not found on PATH — install it from the Setup tab.' : e.message });
    });

    // An immediate exit means the server never came up (bad project file, port
    // clash). Report the real reason instead of a bare success.
    rojoProcess.on('exit', (code) => {
      rojoProcess = null;
      finish({ success: false, error: (stderr.trim() || `rojo serve exited with code ${code}`).split('\n').slice(-4).join('\n') });
    });

    // Confirm the port actually opens before calling it a success.
    (async () => {
      for (let i = 0; i < 25; i++) {
        if (settled) return;
        if (await probePort(ROJO_PORT, 300)) return finish({ success: true, port: ROJO_PORT });
        await new Promise((r) => setTimeout(r, 200));
      }
      finish({ success: false, error: `rojo serve did not open port ${ROJO_PORT} within 5s. ${stderr.trim()}`.trim() });
    })();
  });
});

ipcMain.handle('rojo:stop', async () => {
  if (rojoProcess && !rojoProcess.killed) {
    killProc(rojoProcess, 'rojo');
    rojoProcess = null;
    return { success: true };
  }
  if (await probePort(ROJO_PORT)) {
    return { success: false, error: `Port ${ROJO_PORT} is held by a Rojo server this app did not start — stop it where it was launched.` };
  }
  return { success: true };
});

// ─── IPC: Skills ─────────────────────────────────────────────────

ipcMain.handle('skills:status', () => {
  try {
    return { success: true, ...SKILLS.skillsStatus(vendoredSkillsDir(), os.homedir()) };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('skills:install', () => {
  try {
    const r = SKILLS.installSkills(vendoredSkillsDir(), os.homedir());
    // Rewrite the command so its index matches what was just installed.
    ensureRobloxDevCommand();
    return { success: r.failed.length === 0, ...r };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// ─── IPC: MCP (Roblox Studio) ──────────────────────────────────────────────

// Vendored skills live next to this file. When packaged they must be OUTSIDE
// app.asar, because installing copies real files out of this directory — the
// same asarUnpack requirement pty-helper.py already has.
function vendoredSkillsDir() {
  let p = path.join(__dirname, 'skills');
  if (app.isPackaged) p = p.replace('app.asar', 'app.asar.unpacked');
  return p;
}

// `Skill` is listed in allowed-tools alongside the MCP glob: without it the
// agent is permitted to talk to Studio but not to load any of the skills we
// just installed, which is the whole point of installing them.
const ROBLOX_DEV_COMMAND = `---
name: mentat-rbxs
description: Develop Roblox games using Roblox Studio MCP server and Rojo
allowed-tools:
  - mcp__Roblox_Studio__*
  - Skill
---

You are a Roblox game developer assistant with access to Roblox Studio via MCP.

**On startup, do these steps:**

1. Read CLAUDE.md if it exists to understand the project
2. Try calling the MCP tool \`mcp__Roblox_Studio__list_roblox_studios\` to check if Studio is connected
   - If it works: Studio MCP is active. Report connected and ready.
   - If it fails with "server not found" or similar: the Roblox_Studio MCP server is not running. Tell the user:
     "Roblox Studio MCP is not connected. Please ensure:
     (a) Roblox Studio is open with your place loaded
     (b) MCP is enabled in Studio: Assistant > ... > Manage MCP Servers > Enable Studio as MCP server
     (c) MCP is registered in Claude Code (use the Setup tab in Roblox Studio Mentat app)
     Then restart this Claude session."
3. Summarize what you found and ask what the user wants to build

**Available MCP tools (when connected):**
- script_read, multi_edit, script_search, script_grep — read/write Luau scripts
- generate_mesh, generate_material, insert_from_creator_store — assets
- search_game_tree, inspect_instance — explore the data model
- execute_luau — run Luau code in Studio
- start_stop_play, console_output — playtesting
- character_navigation, keyboard_input, mouse_input — player input simulation
- list_roblox_studios, set_active_studio — session management

**Even without MCP**, you can edit Luau scripts in src/ directly — Rojo syncs them to Studio.

## Roblox skills — consult these before writing Luau

__SKILL_INDEX__

Load the relevant skill with the Skill tool BEFORE implementing, not after a
review finds problems. These encode current-API guidance that general training
data gets wrong — for example \`task.wait\`/\`task.spawn\` supersede the
deprecated \`wait()\`/\`spawn()\`, and DataStore writes need
\`UpdateAsync\` with \`pcall\` rather than \`SetAsync\` to survive concurrent
sessions and transient failures.

Suggested routing:
- Any Roblox task at all → \`rbx-suite-roblox\` (hub, routes to specialists)
- Studio over MCP → \`rbx-suite-roblox-mcp\`
- Rojo / Wally / tooling → \`rbx-suite-roblox-rojo\`, \`rbx-brain-roblox-tooling\`
- Saving player data → \`rbx-suite-roblox-datastores\`
- Remotes, exploits, authority → \`rbx-suite-roblox-networking\`, \`rbx-brain-roblox-security\`
- Pure language / typing questions → \`luau-luau-core\`, \`luau-luau-types\`
- Writing or reviewing ANY Luau file → \`rbx-practices-best-practices\`
  (script layout, naming, doc comments; carry its invariant card through
  summaries or later files silently drift off-standard)
- Unsure which API is current, or migrating legacy code → \`rbx-dev-roblox-dev\`

$ARGUMENTS
`;

/**
 * Build the slash command with the live skill catalogue substituted in.
 *
 * Generated rather than hardcoded so the command can never claim a skill that
 * is not on disk — the index is derived from the same directory scan that the
 * installer uses.
 */
function buildRobloxDevCommand() {
  let index;
  try {
    index = SKILLS.renderSkillIndex(SKILLS.listVendoredSkills(vendoredSkillsDir()));
  } catch (e) {
    console.error('Failed to build skill index:', e.message);
    index = 'Skill index unavailable.';
  }
  return ROBLOX_DEV_COMMAND.replace('__SKILL_INDEX__', index);
}

// Ensure /mentat-rbxs command exists on startup
function ensureRobloxDevCommand() {
  try {
    const cmdDir = path.join(os.homedir(), '.claude', 'commands');
    const cmdFile = path.join(cmdDir, 'mentat-rbxs.md');
    fs.mkdirSync(cmdDir, { recursive: true });
    fs.writeFileSync(cmdFile, buildRobloxDevCommand());
  } catch (e) {
    console.error('Failed to create /mentat-rbxs command:', e.message);
  }
}

// Install skills on startup so a user who never opens Setup still gets them.
// Idempotent: per-skill replace, and only directories we ship are touched.
function ensureSkillsInstalled() {
  try {
    const st = SKILLS.skillsStatus(vendoredSkillsDir(), os.homedir());
    if (st.installed) return;
    const r = SKILLS.installSkills(vendoredSkillsDir(), os.homedir());
    console.log(`Installed ${r.installed.length}/${r.total} Roblox skills to ${r.dest}`);
    if (r.failed.length) console.error('Skill install failures:', r.failed);
  } catch (e) {
    console.error('Failed to install skills:', e.message);
  }
}

// Auto-register Roblox Studio MCP if binary exists and not yet registered
function ensureMcpRegistered() {
  if (!isStudioMcpBinaryAvailable()) return;
  try {
    const claudeJson = path.join(os.homedir(), '.claude.json');
    if (fs.existsSync(claudeJson)) {
      const data = JSON.parse(fs.readFileSync(claudeJson, 'utf8'));
      if (data.mcpServers?.['Roblox_Studio']) return; // already registered
    }
    const home = os.homedir();
    const mcp = getStudioMcpCommand();
    const addArgs = ['mcp', 'add', 'Roblox_Studio', '-s', 'user', '--', mcp.command];
    if (mcp.args.length) addArgs.push(...mcp.args);
    // Same quoting requirement as mcp:install — this is the auto-register path
    // that runs on every pty:spawn, so an unquoted path fails silently here.
    const quoted = addArgs.map((a) => PLAT.shellQuote(a, process.platform)).join(' ');
    execSyncEnv(`claude ${quoted}`, { timeout: 30000, cwd: home, stdio: 'pipe' });
    console.log('Auto-registered Roblox_Studio MCP server');
  } catch (e) {
    console.warn('Auto-register MCP failed:', e.message);
  }
}

// Roblox Studio MCP — built into Studio, OS-specific binary.
// Delegates to lib/platform.js so the win32 path is unit tested: this used to
// return the literal '%LOCALAPPDATA%\Roblox\mcp.bat'. That token is expanded by
// cmd.exe's own parser, NOT by `claude mcp add`, so the MCP server was
// registered with a path that does not exist and failed at launch.
function getStudioMcpCommand() {
  return PLAT.studioMcpCommand(process.platform, process.env);
}

function isStudioMcpBinaryAvailable() {
  if (process.platform === 'win32') {
    const batPath = path.join(process.env.LOCALAPPDATA || '', 'Roblox', 'mcp.bat');
    return fs.existsSync(batPath);
  }
  return fs.existsSync('/Applications/RobloxStudio.app/Contents/MacOS/StudioMCP');
}

ipcMain.handle('mcp:status', () => {
  let installed = false;
  try {
    const claudeJson = path.join(os.homedir(), '.claude.json');
    if (fs.existsSync(claudeJson)) {
      const data = JSON.parse(fs.readFileSync(claudeJson, 'utf8'));
      // Check top-level (user scope)
      if (data.mcpServers?.['Roblox_Studio'] || data.mcpServers?.['roblox-studio']) installed = true;
      // Check per-project
      if (!installed && data.projects) {
        for (const proj of Object.values(data.projects)) {
          if (proj?.mcpServers?.['Roblox_Studio'] || proj?.mcpServers?.['roblox-studio']) { installed = true; break; }
        }
      }
    }
  } catch {}
  return { installed, binaryAvailable: isStudioMcpBinaryAvailable() };
});

ipcMain.handle('mcp:install', async () => {
  try {
    const home = os.homedir();
    // Remove any existing entries
    for (const name of ['Roblox_Studio', 'roblox-studio']) {
      try { execSyncEnv(`claude mcp remove ${name} -s user`, { timeout: 10000, stdio: 'pipe', cwd: home }); } catch {}
      try { execSyncEnv(`claude mcp remove ${name} -s local`, { timeout: 10000, stdio: 'pipe', cwd: home }); } catch {}
    }

    // Install with official Roblox Studio MCP binary
    const mcp = getStudioMcpCommand();
    const addArgs = ['mcp', 'add', 'Roblox_Studio', '-s', 'user', '--'];
    addArgs.push(mcp.command);
    if (mcp.args.length) addArgs.push(...mcp.args);
    // Quote every argument: this is joined into a string and run through a
    // shell, so an unquoted path containing a space (a relocated Studio, or
    // any Windows "Program Files" path) would split into two arguments and
    // register a truncated command. shellQuote is unit tested per platform.
    const quoted = addArgs.map((a) => PLAT.shellQuote(a, process.platform)).join(' ');
    execSyncEnv(`claude ${quoted}`, { timeout: 30000, cwd: home });

    // Skills first so that by the time the command referencing them is written,
    // the skills it names are actually loadable.
    ensureSkillsInstalled();
    ensureRobloxDevCommand();
    return { success: true };
  } catch (e) {
    return { success: false, error: e.stderr?.toString().trim() || e.message };
  }
});

ipcMain.handle('mcp:uninstall', async () => {
  const home = os.homedir();
  for (const name of ['Roblox_Studio', 'roblox-studio']) {
    try { execSyncEnv(`claude mcp remove ${name} -s user`, { timeout: 10000, stdio: 'pipe', cwd: home }); } catch {}
    try { execSyncEnv(`claude mcp remove ${name} -s local`, { timeout: 10000, stdio: 'pipe', cwd: home }); } catch {}
  }
  return { success: true };
});

// ─── IPC: Roblox Studio status ────────────────────────────────────────────

// The detection command per platform lives in lib/platform.js and is unit
// tested. Previously there was no linux branch at all, so `running` stayed
// false there — indistinguishable from a genuine "not running" answer, on a
// build that ships a .deb target. `supported: false` now lets the UI say
// "cannot determine" instead of asserting Studio is stopped.
ipcMain.handle('studio:status', () => {
  const probe = PLAT.studioStatusCommand(process.platform);
  if (!probe) return { running: false, supported: false };
  try {
    const out = execSync(probe.cmd, { timeout: 3000, stdio: 'pipe' }).toString();
    return { running: probe.match(out), supported: true };
  } catch {
    // A non-zero exit from pgrep/tasklist means "no match", not an error.
    return { running: false, supported: true };
  }
});

ipcMain.handle('studio:launch', () => {
  try {
    if (process.platform === 'darwin') {
      spawn('open', ['-a', 'RobloxStudio'], { stdio: 'ignore', detached: true }).unref();
    } else if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '', 'RobloxStudioBeta.exe'], { stdio: 'ignore', detached: true }).unref();
    }
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// ─── IPC: Roblox Studio Plugin ─────────────────────────────────────────────

// Match ANY Rojo plugin file rather than one hardcoded name.
// `rojo plugin install` names its artifact after the Rojo version (e.g.
// "Rojo.rbxm", "RojoPlugin.rbxm"), and the exact name has changed across
// releases. Asserting a single filename made a correctly installed plugin
// report as missing, and the Setup tab then offered to install it again.
// Substring match on "rojo" + the .rbxm extension is what actually identifies
// it; the plugin dir can also contain unrelated third-party plugins.
ipcMain.handle('plugin:status', () => {
  const dir = pluginDir();
  try {
    const found = fs.readdirSync(dir).some(
      (f) => /\.rbxmx?$/i.test(f) && f.toLowerCase().includes('rojo')
    );
    return { installed: found, dir };
  } catch {
    // Directory does not exist yet — not an error, just nothing installed.
    return { installed: false, dir };
  }
});

ipcMain.handle('plugin:install', async () => {
  try {
    const dir = pluginDir();
    fs.mkdirSync(dir, { recursive: true });
    // Rojo installs its own plugin
    execSyncEnv('rojo plugin install', { timeout: 30000, stdio: 'pipe' });
    return { success: true };
  } catch (e) {
    return { success: false, error: e.stderr?.toString().trim() || e.message };
  }
});

// ─── IPC: PTY ──────────────────────────────────────────────────────────────

ipcMain.handle('pty:spawn', async (_, cols, rows, skipPerms) => {
  try {
    ensureMcpRegistered();
    if (ptyProcess) { try { ptyProcess.kill(); } catch {} ptyProcess = null; }
    const home = os.homedir();
    const projPath = getActiveProjectPath() || home;
    const env = { ...shellEnv(), TERM: 'xterm-256color', COLUMNS: String(cols || 80), LINES: String(rows || 24) };

    const claudeArgs = skipPerms
      ? ['--dangerously-skip-permissions', '/mentat-rbxs']
      : ['/mentat-rbxs'];
    if (process.platform === 'win32') {
      ptyProcess = spawn('cmd.exe', ['/c', 'claude', ...claudeArgs], { stdio: ['pipe', 'pipe', 'pipe'], cwd: projPath, env });
    } else {
      const claudeBin = path.join(home, '.local', 'bin', 'claude');
      const bin = fs.existsSync(claudeBin) ? claudeBin : 'claude';
      let helperPath = path.join(__dirname, 'pty-helper.py');
      if (app.isPackaged) helperPath = helperPath.replace('app.asar', 'app.asar.unpacked');
      ptyProcess = spawn('python3', [helperPath, bin, ...claudeArgs], { stdio: ['pipe', 'pipe', 'pipe'], cwd: projPath, env });
      ptyProcess.on('error', (e) => console.error('PTY spawn error:', e.message));
    }

    ptyProcess.stdout.on('data', (d) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('pty:data', d.toString()); });
    ptyProcess.stderr.on('data', (d) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('pty:data', d.toString()); });
    ptyProcess.on('exit', () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('pty:exit'); ptyProcess = null; });
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.on('pty:write', (_, data) => { if (ptyProcess && !ptyProcess.killed) ptyProcess.stdin.write(data); });
ipcMain.on('pty:resize', (_, cols, rows) => { if (ptyProcess?.pid && process.platform !== 'win32') try { process.kill(ptyProcess.pid, 'SIGWINCH'); } catch {} });
ipcMain.on('pty:kill', () => { if (ptyProcess) { if (process.platform !== 'win32') try { process.kill(-ptyProcess.pid, 'SIGTERM'); } catch {} try { ptyProcess.kill(); } catch {} ptyProcess = null; } });

// ─── IPC: Shell ────────────────────────────────────────────────────────────

ipcMain.handle('shell:open-external', (_, url) => { if (typeof url === 'string' && url.startsWith('https://')) shell.openExternal(url); });
ipcMain.handle('shell:open-folder', (_, p) => { shell.openPath(p); });
ipcMain.handle('shell:open-logs-dir', () => { shell.openPath(logsDir); });
ipcMain.handle('dialog:select-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory', 'createDirectory'] });
  return result.canceled ? null : result.filePaths[0];
});

// ─── Lifecycle ─────────────────────────────────────────────────────────────

app.setName('Roblox Studio Mentat');

app.whenReady().then(async () => {
  if (process.platform === 'darwin' && fs.existsSync(path.join(__dirname, 'icon.png'))) app.dock.setIcon(path.join(__dirname, 'icon.png'));
  ensureSkillsInstalled();
  ensureRobloxDevCommand();
  ensureMcpRegistered();
  createWindow();
  setupAutoUpdate(mainWindow);
});
app.on('window-all-closed', () => cleanup());
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
app.on('before-quit', () => cleanup());
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
process.on('uncaughtException', (e) => {
  if (e.code === 'EPIPE' || e.code === 'ERR_STREAM_DESTROYED') { console.warn('Stream error (ignored):', e.code); return; }
  console.error('Uncaught:', e); cleanup();
});
