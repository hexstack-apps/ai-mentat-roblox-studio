'use strict';
//
// Pure platform/path logic, extracted from electron-main.js so it can be unit
// tested. Nothing here may require('electron') or touch a live process — that
// is the whole point of the split: electron-main.js could not be loaded outside
// Electron at all (verified: `node -e "require('./electron-main.js')"` throws),
// so none of this logic had any test coverage.
//
// Every function takes `platform` (and `env`/`home`) as an argument instead of
// reading process.* directly. Behaviour on a given platform is therefore
// checkable on ANY host, which matters here because the app ships mac, win and
// linux targets while CI/dev runs on one of them.

const path = require('path');

/**
 * PATH used for every child process the app spawns.
 *
 * Why this exists at all: a GUI app launched from Finder/launchd inherits a
 * minimal PATH that does NOT include Homebrew, ~/.local/bin or ~/.bun/bin.
 * `rojo`, `claude` and friends are installed in exactly those places, so
 * without this the app reports "not installed" for tools the user can run
 * fine in their terminal.
 *
 * Extra paths go BEFORE the inherited PATH so a user-installed toolchain wins
 * over anything stale the system provides.
 */
function buildPath(platform, home, envPath) {
  const isWin = platform === 'win32';
  const sep = isWin ? ';' : ':';
  const extra = [path.join(home, '.local', 'bin'), path.join(home, '.bun', 'bin')];
  if (isWin) {
    extra.push(
      path.join(home, 'AppData', 'Roaming', 'npm'),
      path.join(home, 'AppData', 'Local', 'Programs', 'claude-code')
    );
  } else {
    // Apple silicon Homebrew, then Intel/Linuxbrew and the usual manual prefix.
    extra.push('/opt/homebrew/bin', '/usr/local/bin');
  }
  // Fall back to a sane default rather than '' — an empty PATH means even
  // /bin/sh cannot be found, turning a missing-tool warning into a crash.
  const base = envPath || (isWin ? '' : '/usr/bin:/bin');
  return extra.join(sep) + sep + base;
}

/**
 * Directory Roblox Studio loads plugins from.
 *
 * Linux is deliberately NOT the macOS path. Studio does not run natively on
 * Linux; users run it under Wine, where the plugin dir lives inside the Wine
 * prefix. Returning ~/Documents/Roblox/Plugins there silently created a
 * directory Studio never reads, and `plugin:status` then reported "installed"
 * for a plugin nothing could load.
 */
function pluginDir(platform, home, env = {}) {
  if (platform === 'win32') {
    return path.join(env.LOCALAPPDATA || '', 'Roblox', 'Plugins');
  }
  if (platform === 'linux') {
    const prefix = env.WINEPREFIX || path.join(home, '.wine');
    return path.join(prefix, 'drive_c', 'users', env.USER || 'user', 'Documents', 'Roblox', 'Plugins');
  }
  return path.join(home, 'Documents', 'Roblox', 'Plugins');
}

/**
 * Command used to detect/launch the official Roblox Studio MCP binary.
 *
 * Returned as {command, args} — NEVER as a pre-joined shell string. The macOS
 * path contains no spaces today, but callers build a `claude mcp add ... --`
 * invocation from it; joining first means any future path with a space (or a
 * user-relocated Studio) silently splits into two arguments.
 */
function studioMcpCommand(platform, env = {}) {
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA || '';
    return { command: 'cmd.exe', args: ['/c', path.join(local, 'Roblox', 'mcp.bat')] };
  }
  return { command: '/Applications/RobloxStudio.app/Contents/MacOS/StudioMCP', args: [] };
}

/**
 * Shell-quote one argument for a command line assembled as a string.
 *
 * Needed because `claude mcp add` is invoked through execSync (a shell), so an
 * unquoted path with a space becomes two arguments and the MCP server is
 * registered with a truncated command that fails at launch.
 */
function shellQuote(arg, platform) {
  const s = String(arg);
  if (platform === 'win32') {
    // cmd.exe: wrap in double quotes, escaping any embedded ones.
    return /[\s"&|<>^]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  // POSIX: single quotes are literal; close-escape-reopen for embedded quotes.
  return /[^A-Za-z0-9_@%+=:,./-]/.test(s) ? "'" + s.replace(/'/g, `'\\''`) + "'" : s;
}

/**
 * Process-detection command for Roblox Studio.
 *
 * Returns null where Studio cannot run, so callers can distinguish
 * "not running" from "cannot be determined on this platform". The previous
 * inline version had no linux branch and fell through to `running: false`,
 * which is indistinguishable from a genuine not-running result.
 */
function studioStatusCommand(platform) {
  if (platform === 'darwin') return { cmd: 'pgrep -x RobloxStudio', match: (out) => out.trim().length > 0 };
  if (platform === 'win32') {
    return {
      cmd: 'tasklist /FI "IMAGENAME eq RobloxStudioBeta.exe" /NH',
      match: (out) => out.includes('RobloxStudioBeta'),
    };
  }
  // Linux: Studio only exists under Wine, so look for the Wine-hosted binary.
  if (platform === 'linux') {
    return { cmd: 'pgrep -f RobloxStudioBeta.exe', match: (out) => out.trim().length > 0 };
  }
  return null;
}

/** Launch command for Roblox Studio, or null where it cannot be launched. */
function studioLaunchCommand(platform) {
  if (platform === 'darwin') return { command: 'open', args: ['-a', 'RobloxStudio'] };
  if (platform === 'win32') return { command: 'cmd', args: ['/c', 'start', '', 'RobloxStudioBeta.exe'] };
  return null;
}

module.exports = {
  buildPath,
  pluginDir,
  studioMcpCommand,
  shellQuote,
  studioStatusCommand,
  studioLaunchCommand,
};
