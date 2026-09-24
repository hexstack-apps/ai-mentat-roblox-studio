# Vendored agent skills

These skills are copied verbatim from three upstream MIT-licensed repositories.
They are vendored (not fetched at install time) so that Setup works offline and
so a given app version always installs a known-good skill set.

| Namespace | Upstream | Commit | Skills | License |
|---|---|---|---|---|
| `rbx-suite-*` | [nonlooped/roblox-suite](https://github.com/nonlooped/roblox-suite) | `fc1c3dd` | 16 | MIT |
| `rbx-brain-*` | [TabooHarmony/roblox-brain](https://github.com/TabooHarmony/roblox-brain) | `7ac9cc2` | 29 | MIT |
| `luau-*` | [luumenlabs/luau-skills](https://github.com/luumenlabs/luau-skills) | `6550b6b` | 9 | MIT |
| `rbx-practices-*` | [andrian-syh/roblox-best-practices-skill](https://github.com/andrian-syh/roblox-best-practices-skill) | `300a79d` | 1 | MIT |
| `rbx-dev-*` | [MSayib/roblox-dev-skill](https://github.com/MSayib/roblox-dev-skill) | `5ca71d8` | 1 | MIT |

## Why these five, out of 265 repos surveyed

GitHub repo search (20 queries) plus **code search** for `filename:SKILL.md`
matching Roblox API tokens — code search was essential, since it found skills
buried in `.claude/skills/` inside larger projects that name-based search
never surfaced. 265 unique repos, 160 containing a Roblox/Luau `SKILL.md`;
20 clonable candidates evaluated in depth.

Accepted on **topic coverage the existing set lacked**, not prose volume:

- `rbx-practices` — the only source with a *compaction-survival* mechanism
  (an invariant card the agent must carry forward verbatim through
  summarisation), mandated script layout, and coverage of the Knit and Fusion
  frameworks that no other vendored skill mentions. Versioned (1.19.2) with a
  CHANGELOG, 38 files, 570KB, 9 genre case studies.
- `rbx-dev` — MCP-aware routing table, an explicit API-currency lookup
  workflow (local docs → live web), a legacy-migration reference, and `--!native`
  codegen guidance that the other four sources lack.

Rejected, with reasons:

| Repo | Skills | Why not |
|---|---|---|
| `JustineDevs/roblox-ai-os` | 108 | **No LICENSE** — cannot vendor |
| `dig1t/skills` | 26 | **No LICENSE** |
| `lucas-burlot/BloxAI` | 25 | **No LICENSE** |
| `sentinelcore/roblox-skills` | 7 | **No LICENSE** |
| `ohzw/roblox-dev-skills` | 5 | **No LICENSE** |
| `foxycuter2-ai/codex-roblox-studio-bridge` | 8 | **No LICENSE** |
| `flipbook-labs/flipbook` | 20 | Project-specific to *their* plugin (`flipbook-architecture-contract`, `flipbook-debugging-playbook`) — not general guidance |
| `CodePhobiia/claude-roblox-game-studio` | 51 | MIT, but its unique topics (plugin authoring, terrain, `buffer`, native codegen) live in a `wiki/` docs mirror, **not in any SKILL.md** — see note below |
| `szlay/roblox-base` | 32 | MIT; a Rojo *starter scaffold*, skills duplicate covered topics |
| `AshExplained/roblox-skills` | 40 | MIT; thin (avg 2.7KB) and fully subsumed by `rbx-brain-*` |
| `jeremylongshore/tons-of-skills-marketplace` | 5671 | Generic mega-dump; Roblox content duplicates what we have |
| `gamedev-skills/awesome-gamedev-agent-skills` | 69 | Apache-2.0, multi-engine; Roblox portion is a thin subset |

**A measurement error worth recording.** An early gap probe walked every `.md`
file under each skill's directory and credited CodePhobiia with four unique
topics. Scoped strictly to `SKILL.md` files and their own subdirectories, all
four vanished: the matches were in a 500-file `wiki/` mirror of the Roblox
docs sitting at the repo root, which the walk had swept in. Scope a content
probe to the unit you are actually judging.

A second error: scoring `wait(`/`spawn(` as "outdated API" counted the
substring inside `task.wait(`/`task.spawn(`, so skills teaching the modern API
scored as if they taught the deprecated one. Every flagged instance turned out
to be *"prefer `task.wait()` over `wait()`"* guidance. Fixed with a negative
lookbehind and a positive control asserting the two forms are distinguished.

## Why namespaced

Six skill directory names collide across the three upstreams:
`roblox-audio`, `roblox-cloud`, `roblox-core`, `roblox-data`,
`roblox-networking`, `roblox-physics`.

Installing them flat would silently overwrite — the later copy wins and the
user gets 48 skills while believing they have 54. The namespace prefix keeps
all three perspectives available; the `name:` field inside each `SKILL.md` is
left untouched so upstream updates apply cleanly.

## Local modifications

**UTF-8 BOM stripped** from 23 markdown files in `luau-skills`. The BOM sits
before the opening `---`, so frontmatter parsers that require `---` at byte 0
saw no frontmatter at all and the three affected skills
(`luau-luau-core`, `luau-roblox-cloud`, `luau-roblox-oauth`) were undiscoverable.
Content is otherwise byte-identical to upstream.

## Refreshing

    sh scripts/vendor-skills.sh

Re-clones each upstream at HEAD, re-namespaces, re-strips BOMs, and rewrites
the commit table above. Review the diff before committing — upstream skills
are prose, so a large diff is normal and worth reading.
