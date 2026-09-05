#!/bin/sh
# Mutation checks for lib/skills.js.
#
# Each mutation is a plausible regression. A mutation that produces NO test
# failure means the suite does not actually constrain that behaviour, so the
# check fails loudly rather than reporting a comfortable pass.
#
# Every mutation asserts its needle EXISTS before patching: a sed no-op is
# silent, and a mutation that patched nothing would "pass" while testing
# nothing.
set -e
cd "$(dirname "$0")/.."

LIB=lib/skills.js
BAK=/tmp/skills.js.orig
cp "$LIB" "$BAK"
restore() { cp "$BAK" "$LIB"; }
trap restore EXIT

CAUGHT=0
TOTAL=0

mutate() {
  desc="$1"; needle="$2"; repl="$3"
  TOTAL=$((TOTAL + 1))
  restore
  if ! grep -qF "$needle" "$LIB"; then
    echo "BROKEN MUTATION ($desc): needle not found — check is vacuous"
    exit 1
  fi
  python3 - "$LIB" "$needle" "$repl" <<'PY'
import sys
p, needle, repl = sys.argv[1], sys.argv[2], sys.argv[3]
t = open(p).read()
assert needle in t, 'needle vanished'
open(p, 'w').write(t.replace(needle, repl, 1))
PY
  if ! diff -q "$BAK" "$LIB" >/dev/null; then
    if node --test 'test/*.js' >/dev/null 2>&1; then
      echo "NOT CAUGHT: $desc"
    else
      echo "caught:     $desc"
      CAUGHT=$((CAUGHT + 1))
    fi
  else
    echo "SKIP (no-op): $desc"
    exit 1
  fi
}

# 1. Stop stripping the BOM -> 3 luau skills become undiscoverable.
mutate "BOM not stripped" \
  "const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;" \
  "const body = text;"

# 2. Drop the sort -> command index reshuffles between installs.
mutate "listVendoredSkills unsorted" \
  "out.sort((a, b) => (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0));" \
  ""

# 3. Accept skills with no frontmatter -> unroutable skills get installed.
mutate "parseSkillMeta accepts missing name" \
  "  const name = pick('name');
  if (!name) return null;" \
  "  const name = pick('name') || 'unknown';"

# 4. Wipe the whole skills dir -> destroys the user's own skills.
mutate "installSkills wipes dest dir" \
  "      fsImpl.rmSync(target, { recursive: true, force: true });" \
  "      fsImpl.rmSync(dest, { recursive: true, force: true });"

# 5. Copy only SKILL.md -> references/ material is lost.
mutate "installSkills non-recursive copy" \
  "      fsImpl.cpSync(s.path, target, { recursive: true });" \
  "      fsImpl.mkdirSync(target, { recursive: true }); fsImpl.cpSync(path.join(s.path, 'SKILL.md'), path.join(target, 'SKILL.md'));"

# 6. Report a partial install as complete -> startup skips the repair.
mutate "skillsStatus installed on partial" \
  "installed: present > 0 && present === vendored.length" \
  "installed: present > 0"

# 7. Omit skill dirs from the index -> agent is never told they exist.
mutate "renderSkillIndex omits dir names" \
  "lines.push(\`- \\\`\${s.dir}\\\`\${d ? ' — ' + d : ''}\`);" \
  "lines.push(\`- \${d}\`);"

# 8. Empty index renders as empty string -> silent, no pointer to the fix.
mutate "renderSkillIndex silent when empty" \
  "    return 'No Roblox skills are installed. Re-run Setup > Install skills to add them.';" \
  "    return '';"

# 9. Don't collapse whitespace -> multi-line description breaks the bullet list.
mutate "renderSkillIndex keeps newlines" \
  "let d = (s.description || '').replace(/\\s+/g, ' ').trim();" \
  "let d = (s.description || '');"

# 10. Namespace grouping ignores prefixes -> everything lands in Other.
mutate "groupByNamespace ignores prefix" \
  "      .filter((k) => s.dir.startsWith(k))" \
  "      .filter(() => false)"

# 11. A vendored namespace with no group entry falls through to "Other":
#     output still renders, but loses the label saying what the source is for.
mutate "namespace group missing for a vendored prefix" \
  "    ['rbx-practices-', { label: 'Coding standards & script layout (roblox-best-practices)', items: [] }]," \
  ""

# 12. Block-scalar descriptions collapse to ">" -- truthy, so it renders a
#     bullet reading just ">" instead of failing loudly.
mutate "block scalar description not expanded" \
  "    if (v === '' || v === '>' || v === '|' || v === '>-' || v === '|-') {" \
  "    if (false) {"

restore
echo "---"
echo "mutations: $TOTAL | caught: $CAUGHT"
[ "$CAUGHT" -eq "$TOTAL" ] || { echo "SUITE DOES NOT DISCRIMINATE"; exit 1; }
echo "all mutations caught"
