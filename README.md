# ai-mentat-roblox-studio

## Quick start

```sh
git clone --recurse-submodules https://github.com/hexstack-apps/ai-mentat-roblox-studio.git
cd ai-mentat-roblox-studio
npm run setup     # install all npm and non-npm dependencies
npm run run       # launch in dev mode
npm run build     # build for this system
npm run check     # build, then start the built app
```

Already cloned without `--recurse-submodules`? Run `npm run setup` — it
initialises the [ai-mentat-sdk](https://github.com/hexstack-apps/ai-mentat-sdk)
submodule for you.

| script | what it does |
|---|---|
| `setup` | git submodules, npm dependencies, non-npm/system dependency check, creates the data dir |
| `run` | runs `setup` first, then launches the Electron app in dev mode |
| `build` | builds for the current OS into `/.hexstack-app/ai-mentat-roblox-studio/ai-mentat-roblox-studio.<ext>` |
| `check` | runs `build`, then starts the built executable |

`<ext>` is `dmg` on macOS, `exe` on Windows, `AppImage` on Linux.

## Where data is stored

```
/.hexstack-app/ai-mentat-roblox-studio/data
```

The filesystem root is not writable by an unprivileged user on most systems, so
`npm run setup` creates the directory and tells you what to run if it cannot:

```sh
sudo mkdir -p /.hexstack-app && sudo chown -R "$(whoami)" /.hexstack-app
```

Until then the app falls back to `~/.hexstack-app/ai-mentat-roblox-studio/data` rather than
failing to start.

## Shared code

Common logic, UI and utilities live in
[ai-mentat-sdk](https://github.com/hexstack-apps/ai-mentat-sdk), mounted here as
a git submodule at `sdk/`.

---

Desktop app for Roblox Studio development — sets up [Rojo](https://rojo.space) and a
Claude Code MCP server for a project in three clicks, then keeps them running from a
native window with an embedded terminal.

Extracted from the `hexstack` monorepo into a standalone Electron project; the build
helpers it used to share live in `shared/` here.

## Tabs

1. **Projects** — register local Roblox project folders, pick the active one, scaffold a new one (`projects:init`)
2. **Setup** — one-click environment: Rojo install/serve, MCP server install, Studio plugin install, agent skills install, launch Studio
3. **FAQ** — walkthrough for first launch

## What it manages

| Concern | IPC surface |
|---|---|
| Project registry | `projects:list` / `add` / `remove` / `select` / `active` / `init` |
| Rojo server | `rojo:check` / `status` / `start` / `stop` |
| Claude Code MCP server | `mcp:status` / `install` / `uninstall` |
| Roblox Studio | `studio:status` / `launch` |
| Studio plugin | `plugin:status` / `install` |
| Agent skills | `skills:status` / `install` |
| Embedded terminal | `pty:spawn` (xterm.js + `pty-helper.py`) |

## Agent skills

56 Roblox/Luau skills are vendored in `skills/` and installed to
`~/.claude/skills` on startup (or from Setup > Install skills). The
`/mentat-rbxs` slash command is generated with a live index of them, so the
agent is told which skills exist and when to load each one.

MCP gives the agent hands (read/write scripts, run Luau, playtest); the skills
supply the judgement — current-API guidance on DataStores, remotes and
authority, physics, GUI, monetization, and Luau typing.

Namespaced by upstream (`rbx-suite-*`, `rbx-brain-*`, `luau-*`,
`rbx-practices-*`, `rbx-dev-*`) because six
skill names collide across the three sources. Refresh with
`sh scripts/vendor-skills.sh`; provenance and local modifications are recorded
in `skills/ATTRIBUTION.md`.

## Shared helpers (`shared/`)

| Concern | File |
|---|---|
| Electron bundling (esbuild) | `sdk/utils/bundle-electron.js` |
| Auto-update | `sdk/logic/auto-update.js` |
| Publish pipeline | `sdk/logic/publish.js` |
| Release / itch.io upload | `sdk/logic/release.js` |

`update-ui.js` is copied from `shared/` into the repo root at bundle time — it is a
build artifact and is gitignored.

## Layout

| Path | Role |
|---|---|
| `electron-main.js` | Main process: 24 IPC handlers, Rojo/PTY supervision |
| `lib/platform.js` | Pure platform + path logic (PATH, plugin dir, MCP command, quoting) |
| `lib/skills.js` | Pure skill logic (frontmatter parse, index render, install, status) |
| `skills/` | 56 vendored Roblox/Luau agent skills (see `skills/ATTRIBUTION.md`) |
| `lib/settings.js` | Project registry: load/save/select, Rojo scaffold |
| `preload.js` | contextIsolation bridge, explicit allowlist |
| `app.html` / `app.css` | UI — Projects / Setup / FAQ tabs |
| `pty-helper.py` | PTY backing the embedded xterm.js terminal |
| `shared/` | Bundling, auto-update, publish/release |

`lib/` exists because `electron-main.js` cannot be loaded outside Electron, so
none of its platform branches were testable. Those functions take
`platform`/`env`/`home` as arguments, meaning the Windows and Linux paths are
verifiable on any host. See [CLAUDE.md](CLAUDE.md).

## Test

```bash
npm test                     # 36 unit tests, no deps, no Electron, no display
npm run test:mutation        # 11 mutation checks — each fix must fail when reverted
```

⚠️ Use the glob (`node --test 'test/*.js'`). `node --test test/` treats the bare
directory as a file named `test` and reports a spurious failure while running
nothing.

## Build

```bash
npm install

npm run gui                   # bundle + launch
npm run build:mac             # unsigned universal DMG
npm run build:mac:signed      # signed + notarized DMG
npm run build:win             # MSI
npm run build:linux           # deb
npm run publish               # full pipeline (bump, bundle, build, itch, updates feed)
```

The main process is bundled with esbuild before every run; `main` points at the generated
`electron-main.bundle.js`.

## Dev notes

- App state (registered projects) lives in `.mentat-rbxs/settings.json` — under the repo root in dev
  (`electron-main.js:33`) and under Electron's `userData` dir when packaged. The dev copy is gitignored;
  the monorepo's copy held machine-local paths and was deliberately left behind in the extraction.
- `certs/` (MAS provisioning profiles) is gitignored — signing material is never committed.
- `config.updates.json` holds the itch.io channel + auto-update feed config used by `npm run publish`.
