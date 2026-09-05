'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const S = require('../lib/skills');

const REPO_SKILLS = path.join(__dirname, '..', 'skills');

function tmpdir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Build a fake vendored-skills tree. */
function makeSkillTree(spec) {
  const root = tmpdir('skills-src-');
  for (const [dir, body] of Object.entries(spec)) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
    if (body !== null) fs.writeFileSync(path.join(root, dir, 'SKILL.md'), body);
  }
  return root;
}

const FM = (name, desc) => `---\nname: ${name}\ndescription: "${desc}"\n---\n\n# ${name}\n`;

// ─── parseSkillMeta ────────────────────────────────────────────────────────

test('parseSkillMeta extracts name and description', () => {
  const m = S.parseSkillMeta(FM('roblox-core', 'Luau fundamentals'));
  assert.strictEqual(m.name, 'roblox-core');
  assert.strictEqual(m.description, 'Luau fundamentals');
});

test('parseSkillMeta strips a leading UTF-8 BOM', () => {
  // 23 upstream luau-skills files ship a BOM; a BOM before `---` makes a
  // strict parser see no frontmatter and silently drop the skill.
  const m = S.parseSkillMeta('\uFEFF' + FM('luau-core', 'Pure Luau'));
  assert.ok(m, 'BOM-prefixed frontmatter must still parse');
  assert.strictEqual(m.name, 'luau-core');
});

test('parseSkillMeta strips surrounding quotes from description', () => {
  assert.strictEqual(S.parseSkillMeta(FM('a', 'has: colon')).description, 'has: colon');
  const single = "---\nname: a\ndescription: 'quoted'\n---\n";
  assert.strictEqual(S.parseSkillMeta(single).description, 'quoted');
});

test('parseSkillMeta returns null without frontmatter or name', () => {
  assert.strictEqual(S.parseSkillMeta('# plain markdown'), null);
  assert.strictEqual(S.parseSkillMeta('---\ndescription: no name\n---\n'), null);
  assert.strictEqual(S.parseSkillMeta(''), null);
  assert.strictEqual(S.parseSkillMeta(null), null);
});

test('parseSkillMeta reads YAML block-scalar descriptions', () => {
  // MSayib/roblox-dev-skill writes `description: >` with the text on following
  // indented lines. A single-line parser returns ">" — which is TRUTHY, so a
  // `if (description)` check passes and the index renders a bullet reading
  // just ">". Same false-safety shape as `.length > 0` on a string.
  const folded = [
    '---',
    'name: roblox-dev-skill',
    'description: >',
    '  Core scripting and engine skill.',
    '  Covers architecture and networking.',
    'other: value',
    '---',
    '',
  ].join('\n');
  const m = S.parseSkillMeta(folded);
  assert.strictEqual(m.name, 'roblox-dev-skill');
  assert.strictEqual(m.description, 'Core scripting and engine skill. Covers architecture and networking.');
  assert.ok(m.description.length > 20, 'must not collapse to the ">" marker');
});

test('parseSkillMeta reads literal block scalars and stops at the next key', () => {
  const literal = '---\nname: x\ndescription: |\n  line one\n  line two\nname2: y\n---\n';
  const m = S.parseSkillMeta(literal);
  assert.strictEqual(m.description, 'line one line two');
});

test('every vendored skill has a usable description', () => {
  // Guards the whole set against the ">" failure and against a truncated
  // frontmatter that yields a one-character description.
  const thin = S.listVendoredSkills(REPO_SKILLS).filter((s) => s.description.length < 20);
  assert.deepStrictEqual(thin.map((s) => s.dir), [], 'skills with unusable descriptions');
});

test('parseSkillMeta tolerates a missing description', () => {
  const m = S.parseSkillMeta('---\nname: bare\n---\n');
  assert.strictEqual(m.name, 'bare');
  assert.strictEqual(m.description, '');
});

// ─── listVendoredSkills ───────────────────────────────────────────────────

test('listVendoredSkills finds skill dirs and skips dirs without SKILL.md', () => {
  const root = makeSkillTree({
    'zeta-skill': FM('zeta', 'z'),
    'alpha-skill': FM('alpha', 'a'),
    'not-a-skill': null, // dir with no SKILL.md
  });
  const got = S.listVendoredSkills(root);
  assert.deepStrictEqual(got.map((s) => s.dir), ['alpha-skill', 'zeta-skill']);
});

test('listVendoredSkills sorts even when the directory scan does not', () => {
  // This filesystem's readdirSync already returns names in sorted order, so a
  // real temp tree CANNOT distinguish "sorted" from "unsorted" — an earlier
  // version of this test passed with the sort deleted. Inject a fake fs that
  // yields deliberately unsorted entries; now only the sort can produce the
  // expected order.
  const names = ['m-skill', 'z-skill', 'a-skill', 'q-skill', 'b-skill'];
  const fakeFs = {
    readdirSync: () => names.map((n) => ({ name: n, isDirectory: () => true })),
    readFileSync: (p) => FM(path.basename(path.dirname(p)), 'desc'),
  };
  const got = S.listVendoredSkills('/fake', fakeFs).map((s) => s.dir);
  assert.notDeepStrictEqual(names, [...names].sort(), 'control: input is unsorted');
  assert.deepStrictEqual(got, [...names].sort(), 'output must be sorted');
});

test('listVendoredSkills skips dirs whose SKILL.md has no frontmatter', () => {
  const root = makeSkillTree({ good: FM('good', 'g'), bad: '# no frontmatter' });
  assert.deepStrictEqual(S.listVendoredSkills(root).map((s) => s.dir), ['good']);
});

test('listVendoredSkills returns [] for a missing directory', () => {
  assert.deepStrictEqual(S.listVendoredSkills('/definitely/not/here'), []);
});

// ─── namespacing / index rendering ────────────────────────────────────────

test('groupByNamespace routes each prefix to its own group', () => {
  const skills = [
    { dir: 'rbx-suite-roblox-core', name: 'a', description: '' },
    { dir: 'rbx-brain-roblox-gui', name: 'b', description: '' },
    { dir: 'luau-luau-types', name: 'c', description: '' },
    { dir: 'mystery-skill', name: 'd', description: '' },
  ];
  const g = S.groupByNamespace(skills);
  const labels = g.map((x) => x.label);
  assert.strictEqual(g.length, 4, 'three namespaces plus Other');
  assert.ok(labels[3].includes('Other'));
  assert.deepStrictEqual(g[0].items.map((i) => i.dir), ['rbx-suite-roblox-core']);
  assert.deepStrictEqual(g[3].items.map((i) => i.dir), ['mystery-skill']);
});

test('groupByNamespace omits empty groups', () => {
  const g = S.groupByNamespace([{ dir: 'luau-x', name: 'x', description: '' }]);
  assert.strictEqual(g.length, 1);
  assert.ok(g[0].label.includes('luau-skills'));
});

test('renderSkillIndex names every skill directory', () => {
  const skills = [
    { dir: 'rbx-suite-roblox-mcp', name: 'roblox-mcp', description: 'MCP server' },
    { dir: 'luau-luau-core', name: 'luau-core', description: 'Pure Luau' },
  ];
  const out = S.renderSkillIndex(skills);
  // The index IS the wiring: a skill absent here is one the agent never loads.
  for (const s of skills) assert.ok(out.includes(s.dir), `index must name ${s.dir}`);
  assert.ok(out.includes('2 Roblox/Luau skills'), 'index states the count');
});

test('renderSkillIndex truncates long descriptions on a word boundary', () => {
  const long = 'word '.repeat(80).trim();
  const out = S.renderSkillIndex([{ dir: 'd', name: 'n', description: long }]);
  const line = out.split('\n').find((l) => l.startsWith('- `d`'));
  assert.ok(line.length < 200, 'long description must be truncated');
  assert.ok(line.endsWith('…'), 'truncation marked with an ellipsis');
  assert.ok(!/\s…$/.test(line), 'no dangling space before the ellipsis');
});

test('renderSkillIndex collapses newlines inside a description', () => {
  const out = S.renderSkillIndex([{ dir: 'd', name: 'n', description: 'one\ntwo' }]);
  const body = out.split('\n').filter((l) => l.startsWith('- `d`'));
  assert.strictEqual(body.length, 1, 'a multi-line description must stay on one bullet');
  assert.ok(body[0].includes('one two'));
});

test('renderSkillIndex says so when nothing is installed', () => {
  const out = S.renderSkillIndex([]);
  assert.ok(/no roblox skills/i.test(out));
  assert.ok(/setup/i.test(out), 'points the user at the fix');
});

// ─── installSkills ────────────────────────────────────────────────────────

test('installSkills copies skills into ~/.claude/skills', () => {
  const src = makeSkillTree({ 'rbx-suite-a': FM('a', 'A'), 'luau-b': FM('b', 'B') });
  const home = tmpdir('home-');
  const r = S.installSkills(src, home);
  assert.strictEqual(r.total, 2);
  assert.deepStrictEqual(r.installed.sort(), ['luau-b', 'rbx-suite-a']);
  assert.deepStrictEqual(r.failed, []);
  for (const d of ['rbx-suite-a', 'luau-b']) {
    assert.ok(fs.existsSync(path.join(home, '.claude', 'skills', d, 'SKILL.md')));
  }
});

test('installSkills copies nested reference files, not just SKILL.md', () => {
  // 53 of 54 vendored skills carry a references/ dir; copying only SKILL.md
  // would strip the material the skill points at.
  const src = makeSkillTree({ 'rbx-suite-a': FM('a', 'A') });
  fs.mkdirSync(path.join(src, 'rbx-suite-a', 'references'));
  fs.writeFileSync(path.join(src, 'rbx-suite-a', 'references', 'deep.md'), 'detail');
  const home = tmpdir('home-');
  S.installSkills(src, home);
  const copied = path.join(home, '.claude', 'skills', 'rbx-suite-a', 'references', 'deep.md');
  assert.strictEqual(fs.readFileSync(copied, 'utf8'), 'detail');
});

test('installSkills preserves unrelated user skills', () => {
  // Wiping the whole skills dir would be data loss; only our dirs may be touched.
  const src = makeSkillTree({ 'rbx-suite-a': FM('a', 'A') });
  const home = tmpdir('home-');
  const mine = path.join(home, '.claude', 'skills', 'my-own-skill');
  fs.mkdirSync(mine, { recursive: true });
  fs.writeFileSync(path.join(mine, 'SKILL.md'), FM('my-own-skill', 'precious'));
  S.installSkills(src, home);
  assert.ok(fs.existsSync(path.join(mine, 'SKILL.md')), 'user skill must survive install');
});

test('installSkills is idempotent and replaces stale files', () => {
  const src = makeSkillTree({ 'rbx-suite-a': FM('a', 'A') });
  const home = tmpdir('home-');
  S.installSkills(src, home);
  const stale = path.join(home, '.claude', 'skills', 'rbx-suite-a', 'stale.md');
  fs.writeFileSync(stale, 'old');
  const r = S.installSkills(src, home);
  assert.deepStrictEqual(r.installed, ['rbx-suite-a']);
  assert.ok(!fs.existsSync(stale), 'stale file from a previous version must be removed');
});

// ─── skillsStatus ─────────────────────────────────────────────────────────

test('skillsStatus reports partial vs complete installs', () => {
  const src = makeSkillTree({ a: FM('a', 'A'), b: FM('b', 'B') });
  const home = tmpdir('home-');

  let st = S.skillsStatus(src, home);
  assert.strictEqual(st.vendored, 2);
  assert.strictEqual(st.present, 0);
  assert.strictEqual(st.installed, false);

  S.installSkills(src, home);
  st = S.skillsStatus(src, home);
  assert.strictEqual(st.present, 2);
  assert.strictEqual(st.installed, true);

  // Remove one: a partial install must NOT report installed, or startup would
  // skip the repair.
  fs.rmSync(path.join(home, '.claude', 'skills', 'a'), { recursive: true, force: true });
  st = S.skillsStatus(src, home);
  assert.strictEqual(st.present, 1);
  assert.strictEqual(st.installed, false, 'partial install must report not-installed');
});

test('skillsDir points at ~/.claude/skills', () => {
  assert.strictEqual(S.skillsDir('/home/x'), path.join('/home/x', '.claude', 'skills'));
});

// ─── the real vendored tree ───────────────────────────────────────────────

test('vendored skills tree is present and fully parseable', () => {
  const skills = S.listVendoredSkills(REPO_SKILLS);
  // Positive control: if this scan silently returned nothing, every assertion
  // below would vacuously pass.
  assert.ok(skills.length >= 50, `expected 50+ vendored skills, got ${skills.length}`);

  const dirs = fs.readdirSync(REPO_SKILLS, { withFileTypes: true })
    .filter((e) => e.isDirectory()).length;
  assert.strictEqual(skills.length, dirs, 'every vendored dir must parse as a skill');

  for (const s of skills) {
    assert.ok(s.name, `${s.dir} has a name`);
    assert.ok(s.description, `${s.dir} has a description`);
  }
});

test('vendored skills carry every namespace', () => {
  const dirs = S.listVendoredSkills(REPO_SKILLS).map((s) => s.dir);
  for (const p of ['rbx-suite-', 'rbx-brain-', 'luau-', 'rbx-practices-', 'rbx-dev-']) {
    assert.ok(dirs.some((d) => d.startsWith(p)), `missing namespace ${p}`);
  }
});

test('every namespace is grouped, none falls through to Other', () => {
  // A new upstream added to vendor-skills.sh without a matching group entry
  // would silently land in "Other" — correct output, but it loses the label
  // that tells the agent what the source is good for.
  const groups = S.groupByNamespace(S.listVendoredSkills(REPO_SKILLS));
  const other = groups.find((g) => g.label === 'Other');
  assert.strictEqual(other, undefined, `ungrouped: ${other && other.items.map((i) => i.dir)}`);
});

test('groupByNamespace prefers the longest matching prefix', () => {
  // 'rbx-practices-' and 'rbx-dev-' must not be captured by a shorter 'rbx-'
  // key if one is ever added. Assert the property directly.
  const skills = [
    { dir: 'rbx-practices-best-practices', name: 'a', description: '' },
    { dir: 'rbx-dev-roblox-dev', name: 'b', description: '' },
  ];
  const g = S.groupByNamespace(skills);
  assert.strictEqual(g.length, 2, 'each must land in its own group');
  for (const grp of g) assert.strictEqual(grp.items.length, 1);
});

test('no vendored SKILL.md retains a UTF-8 BOM', () => {
  const bom = [];
  for (const s of S.listVendoredSkills(REPO_SKILLS)) {
    const b = fs.readFileSync(path.join(s.path, 'SKILL.md'));
    if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) bom.push(s.dir);
  }
  assert.deepStrictEqual(bom, [], 'BOM breaks frontmatter discovery');
});

test('namespacing keeps colliding upstream skill names distinct', () => {
  // 6 names collide across the three upstreams; a flat install would overwrite
  // and leave the user with fewer skills than reported.
  const skills = S.listVendoredSkills(REPO_SKILLS);
  const dirs = new Set(skills.map((s) => s.dir));
  assert.strictEqual(dirs.size, skills.length, 'directory names must be unique');

  const byName = new Map();
  for (const s of skills) byName.set(s.name, (byName.get(s.name) || 0) + 1);
  const collided = [...byName.entries()].filter(([, n]) => n > 1);
  assert.ok(collided.length > 0, 'positive control: upstream names really do collide');
});
