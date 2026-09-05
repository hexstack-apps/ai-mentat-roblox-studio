# CLAUDE.md — Hexstack Mentat RBXS

Electron desktop app that sets up and supervises a Roblox Studio dev loop:
Rojo sync server + Claude Code MCP server + Studio plugin, driven from one
window with an embedded terminal.

## Run and test

```sh
npm install
npm run gui                  # bundle main process with esbuild, then launch
npm test                     # 36 unit tests, no dependencies (node --test)
sh test/discriminates.sh     # 11 mutation checks — every fix must fail when reverted
```

`npm test` needs no Electron and no display: everything it covers is pure
logic in `lib/`. That is deliberate — see below.

## Architecture

| Layer | File | Notes |
|---|---|---|
| Main process | `electron-main.js` | 24 IPC handlers, process supervision |
| Preload bridge | `preload.js` | contextIsolation on, explicit allowlist |
| UI | `app.html` + `app.css` | single page, three tabs |
| Terminal backend | `pty-helper.py` | PTY the embedded xterm.js talks to |
| **Pure logic** | **`lib/platform.js`, `lib/settings.js`** | **the only unit-testable code** |
| Build | `shared/*.js` | esbuild bundling, auto-update, publish/release |

### Why `lib/` exists

`electron-main.js` cannot be loaded outside Electron — `require('electron')` at
the top throws under plain node, and it exported nothing. **Every platform path,
PATH construction and settings mutation therefore had zero test coverage**, on
an app that ships mac, win and linux builds where those branches are exactly
what differ.

`lib/` holds that logic as pure functions taking `platform`/`env`/`home` as
arguments. A Windows code path is verifiable on Linux, which is the point.
`electron-main.js` delegates to them and keeps only the Electron-facing parts.

**Rule: new platform-conditional or state-shaping logic goes in `lib/` with a
test. Do not add `process.platform` branches inline in `electron-main.js`.**

## Design decisions worth preserving

**Rojo status is measured by PORT, not by a process handle.** Ownership of port
34872 is what determines whether Studio can sync. A handle says nothing about a
server the user started in their own terminal, and after an app restart the
handle is gone while the server may still run. `rojo:status` probes the port and
reports `{running, ours, external}` so the UI can explain why Stop is disabled.

**Rojo is spawned NOT detached.** The server should not outlive the app that
started it. `killProc` signals the process directly and only falls back to
`kill(-pid)` for anything still started detached — a process group kill on a
non-detached child raises ESRCH.

**`rojo:start` waits for the port to open** (25 × 200ms) before reporting
success. An immediate exit means the server never came up; reporting success
there produced a green indicator over a dead server.

**Settings are written atomically** (temp file + rename). A crash mid-write
would otherwise truncate the file and lose the whole project registry. The
test asserts the *mechanism*, not just the result — an in-place write produces
an identical result and passed every result-only assertion (caught by mutation
testing).

**`shellEnv()` prepends user tool dirs to PATH.** A GUI app launched from
Finder/launchd inherits a minimal PATH without Homebrew, `~/.local/bin` or
`~/.bun/bin`, so `rojo` and `claude` appear "not installed" despite working
fine in a terminal.

**Rojo output is logged to `<dataDir>/logs/rojo.log`.** stdio used to be piped
and never read, so failures vanished. The log is capped at 512KB, trimmed from
the front.

## Bugs fixed in the `lib/` extraction

1. **`studio:status` had no linux branch** → always `running: false`, which is
   indistinguishable from genuinely not running, on a build that ships `.deb`.
   Now returns `supported: false` where Studio cannot run.
2. **`pluginDir()` fell through to the macOS path on linux** → created
   `~/Documents/Roblox/Plugins`, which Studio-under-Wine never reads. Now
   resolves inside the Wine prefix (`$WINEPREFIX`, default `~/.wine`).
3. **`%LOCALAPPDATA%` was passed unexpanded** to `claude mcp add` on Windows.
   That token is expanded by cmd.exe's parser, not by `claude`, so the MCP
   server was registered with a nonexistent path.
4. **MCP args were joined into a shell string unquoted** — a path with a space
   split into two arguments. Both call sites (`mcp:install` and the
   `ensureMcpRegistered` auto-path) now use `PLAT.shellQuote`.
5. **`plugin:status` hardcoded `RojoPlugin.rbxm`** — the artifact name has
   changed across Rojo releases, so a correctly installed plugin reported as
   missing. Now matches any `*.rbxm[x]` containing "rojo".

## Testing conventions

- **`node --test 'test/*.js'`, with the glob.** `node --test test/` treats the
  bare directory as a file named `test` and silently runs nothing useful — it
  reported `1..1 fail` while both suites passed individually.
- **Every fix must have a mutation entry** in `test/discriminates.sh`. A green
  suite proves nothing until a broken build turns it red.
- Assert the *property*, not the source text — literal string matching breaks on
  refactors and produces silent no-op mutations.

## Agent skills (`skills/`, `lib/skills.js`)

56 skills vendored from five MIT upstreams, namespaced `rbx-suite-*`,
`rbx-brain-*`, `luau-*`, `rbx-practices-*`, `rbx-dev-*`. Installed to `~/.claude/skills`; refresh with
`sh scripts/vendor-skills.sh`. Provenance in `skills/ATTRIBUTION.md`.

**The command index is the wiring.** `/mentat-rbxs` is generated by
`buildRobloxDevCommand()`, substituting `__SKILL_INDEX__` with a live scan of
`skills/`. Installing skills without naming them in the command is inert — the
agent has no reason to look for them. Keep them generated together; do not
hardcode the list.

**`Skill` must stay in the command's `allowed-tools`.** Without it the agent
can reach Studio over MCP but cannot load any installed skill.

**Namespacing is load-bearing.** Six directory names collide across upstreams
(`roblox-audio`, `-cloud`, `-core`, `-data`, `-networking`, `-physics`). A flat
install silently overwrites: 54 reported, 48 present. `name:` inside each
SKILL.md is left at its upstream value so refreshes apply cleanly.

**BOMs hide frontmatter.** 23 luau-skills files ship a UTF-8 BOM before `---`;
a parser requiring `---` at byte 0 concludes there is no frontmatter and the
skill is undiscoverable (3 of 9 luau skills were invalid before stripping).
The vendored copies are clean AND `parseSkillMeta` tolerates a BOM, so an
upstream refresh cannot silently drop skills.

**Never wipe `~/.claude/skills`.** Users keep their own skills there. Install
is a per-skill `rm` + recursive copy; only directories we ship are touched.
Tested.

**Copy recursively.** 55 of 56 skills carry a `references/` dir; copying only
SKILL.md strips the material the skill points at. Tested.

**Partial installs report `installed: false`** so startup repairs them instead
of skipping on a nonzero count.

**YAML block scalars.** `description: >` / `|` put the value on following
indented lines. A single-line regex captures the ">" marker, which is TRUTHY —
so it passes every truthiness check and renders an index bullet reading just
">". `parseSkillMeta` folds block scalars; there is a mutation for it.

**Adding an upstream = two edits.** `scripts/vendor-skills.sh` SETS *and* the
group table in `lib/skills.js`. A missing group entry does not error — the
skills land in "Other" and lose the label saying what the source is for. A
test asserts no namespace falls through.

**Judging candidate skills: scope the probe to the unit being judged.** A gap
scan that walked every `.md` under a repo credited one candidate with four
unique topics that no SKILL.md covered — the matches were in a 500-file `wiki/`
docs mirror at the repo root. Likewise, counting `wait(`/`spawn(` as
outdated-API markers matches inside `task.wait(`/`task.spawn(`, scoring modern
skills as legacy; every hit was "prefer task.wait() over wait()" guidance.
Use a negative lookbehind and a positive control.

**No LICENSE = not vendorable**, regardless of quality. That disqualified six
candidates, including one with 108 skills.

**`skills/` needs both `build.files` and `asarUnpack`.** Install copies real
files out of the directory, so it cannot live inside app.asar — same
requirement as `pty-helper.py`.

## Gotchas

- `main` points at `electron-main.bundle.js`, generated by esbuild before every
  run. Edit `electron-main.js`, never the bundle.
  (The original reason for bundling was that the licensing SDK was ESM-only.
  That SDK is gone and `electron-updater` is CommonJS, so bundling is no longer
  strictly required — it is kept because the build, packaging and asarUnpack
  config all assume the bundle path. Removing it is a separate change.)
- `update-ui.js` is copied from `shared/` at bundle time. It is a build
  artifact and gitignored — do not edit it in the root.
- **Licensing was removed** (all three mentat apps). The update notification bar
  used to live inside `licensing-ui.js`; it was extracted to
  `sdk/ui/update-bar.js` rather than lost. There is no gate, no trial, no
  Moonbase dependency.
- `.mentat-rbxs/settings.json` holds machine-local paths; gitignored.
- `certs/` (MAS provisioning profiles) is gitignored. Signing material is never
  committed.
