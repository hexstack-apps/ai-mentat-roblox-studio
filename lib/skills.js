'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Pure(ish) helpers for installing the vendored agent skills into
 * ~/.claude/skills, plus building the skill index that gets embedded in the
 * /mentat-rbxs slash command.
 *
 * Kept in lib/ (not electron-main.js) so it is unit-testable without booting
 * Electron — same split as lib/platform.js.
 */

/** Directory Claude Code reads user-level skills from. */
function skillsDir(homedir) {
  return path.join(homedir, '.claude', 'skills');
}

/**
 * Parse the `name` and `description` out of a SKILL.md frontmatter block.
 *
 * Deliberately tolerant of a leading UTF-8 BOM: upstream luau-skills ships 23
 * files with one, and a BOM before `---` makes a strict parser conclude there
 * is no frontmatter at all. We strip the vendored copies too, but a refresh
 * from upstream can reintroduce them, so the parser must not depend on that.
 *
 * Returns null when the file has no usable frontmatter, so callers can skip
 * rather than install a skill Claude cannot route to.
 */
function parseSkillMeta(text) {
  if (typeof text !== 'string') return null;
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  if (!body.startsWith('---')) return null;
  const end = body.indexOf('\n---', 3);
  if (end === -1) return null;
  const fm = body.slice(3, end);

  const pick = (key) => {
    const m = fm.match(new RegExp('^' + key + ':\\s*(.*)$', 'm'));
    if (!m) return null;
    let v = m[1].trim();

    // YAML block scalars: `description: >` (folded) or `|` (literal) put the
    // value on the following indented lines. Without this the description
    // reads as the single character ">" — which still passes a truthiness
    // check, so the skill installs with an empty-looking index entry.
    if (v === '' || v === '>' || v === '|' || v === '>-' || v === '|-') {
      const after = fm.slice(m.index + m[0].length).replace(/^\n/, '');
      const lines = [];
      for (const line of after.split('\n')) {
        if (/^\s*$/.test(line)) { if (lines.length) break; continue; }
        // Block content must be indented; the next top-level key ends it.
        if (!/^\s+/.test(line)) break;
        lines.push(line.trim());
      }
      v = lines.join(' ').trim();
    }
    // Strip one layer of matching quotes; descriptions are usually quoted
    // because they contain colons, which would otherwise break YAML.
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    return v;
  };

  const name = pick('name');
  if (!name) return null;
  return { name, description: pick('description') || '' };
}

/**
 * Enumerate vendored skills: every immediate subdirectory of `skillsSrc`
 * containing a SKILL.md.
 *
 * Sorted by directory name so the generated command index is stable — an
 * unsorted readdir would reshuffle the slash command on every install and
 * produce noisy diffs for users who keep ~/.claude in git.
 */
function listVendoredSkills(skillsSrc, fsImpl = fs) {
  let entries;
  try {
    entries = fsImpl.readdirSync(skillsSrc, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = path.join(skillsSrc, e.name);
    const md = path.join(dir, 'SKILL.md');
    let text;
    try {
      text = fsImpl.readFileSync(md, 'utf8');
    } catch {
      continue;
    }
    const meta = parseSkillMeta(text);
    if (!meta) continue;
    out.push({ dir: e.name, path: dir, name: meta.name, description: meta.description });
  }
  out.sort((a, b) => (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0));
  return out;
}

/** Group skills by their namespace prefix, for a readable command index. */
function groupByNamespace(skills) {
  const groups = new Map([
    ['rbx-suite-', { label: 'Roblox engine & Studio (roblox-suite)', items: [] }],
    ['rbx-brain-', { label: 'Roblox task playbooks (roblox-brain)', items: [] }],
    ['luau-', { label: 'Luau language & Open Cloud (luau-skills)', items: [] }],
    ['rbx-practices-', { label: 'Coding standards & script layout (roblox-best-practices)', items: [] }],
    ['rbx-dev-', { label: 'Full-lifecycle dev companion (roblox-dev-skill)', items: [] }],
  ]);
  const other = [];
  for (const s of skills) {
    // Longest prefix first: 'luau-' is a suffix-free prefix of nothing here,
    // but 'rbx-suite-'/'rbx-brain-' must be tested before any shorter key is
    // added later, so match on the most specific key that applies.
    const key = [...groups.keys()]
      .filter((k) => s.dir.startsWith(k))
      .sort((a, b) => b.length - a.length)[0];
    if (key) groups.get(key).items.push(s);
    else other.push(s);
  }
  const result = [...groups.values()].filter((g) => g.items.length);
  if (other.length) result.push({ label: 'Other', items: other });
  return result;
}

/**
 * Render the skill catalogue that gets embedded into the slash command.
 *
 * The command is the only thing Claude reads on `/mentat-rbxs`, so if the
 * skills are not named there the agent has no reason to look for them — this
 * index is the wiring, not decoration.
 */
function renderSkillIndex(skills, { maxDescription = 110 } = {}) {
  if (!skills.length) {
    return 'No Roblox skills are installed. Re-run Setup > Install skills to add them.';
  }
  const lines = [`${skills.length} Roblox/Luau skills are installed at \`~/.claude/skills\`.`, ''];
  for (const g of groupByNamespace(skills)) {
    lines.push(`**${g.label}**`);
    for (const s of g.items) {
      let d = (s.description || '').replace(/\s+/g, ' ').trim();
      // Upstream descriptions run to 300+ chars; the full text lives in the
      // skill itself. Truncate on a word boundary so the index stays scannable.
      if (d.length > maxDescription) {
        d = d.slice(0, maxDescription).replace(/[\s,;:.]+\S*$/, '') + '…';
      }
      lines.push(`- \`${s.dir}\`${d ? ' — ' + d : ''}`);
    }
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

/**
 * Copy vendored skills into ~/.claude/skills.
 *
 * Per-skill replace (rm -rf then copy) rather than wiping the whole skills
 * directory: users have their own unrelated skills in there, and destroying
 * them would be a data-loss bug. Only directories we ship are touched.
 */
function installSkills(skillsSrc, homedir, { fsImpl = fs } = {}) {
  const skills = listVendoredSkills(skillsSrc, fsImpl);
  const dest = skillsDir(homedir);
  fsImpl.mkdirSync(dest, { recursive: true });

  const installed = [];
  const failed = [];
  for (const s of skills) {
    const target = path.join(dest, s.dir);
    try {
      fsImpl.rmSync(target, { recursive: true, force: true });
      fsImpl.cpSync(s.path, target, { recursive: true });
      installed.push(s.dir);
    } catch (e) {
      failed.push({ dir: s.dir, error: e.message });
    }
  }
  return { installed, failed, total: skills.length, dest };
}

/** Count installed skills that we ship (used for Setup tab status). */
function skillsStatus(skillsSrc, homedir, { fsImpl = fs } = {}) {
  const vendored = listVendoredSkills(skillsSrc, fsImpl);
  const dest = skillsDir(homedir);
  let present = 0;
  for (const s of vendored) {
    try {
      if (fsImpl.existsSync(path.join(dest, s.dir, 'SKILL.md'))) present += 1;
    } catch {
      /* treat unreadable as absent */
    }
  }
  return { vendored: vendored.length, present, installed: present > 0 && present === vendored.length, dest };
}

module.exports = {
  skillsDir,
  parseSkillMeta,
  listVendoredSkills,
  groupByNamespace,
  renderSkillIndex,
  installSkills,
  skillsStatus,
};
