#!/bin/sh
# Refresh the vendored agent skills from their three MIT upstreams.
#
# Vendoring (rather than fetching at install time) keeps Setup working offline
# and pins a known-good skill set per app version. Run this deliberately, then
# READ THE DIFF before committing — these files are prose, so a large diff is
# expected and worth skimming for upstream changes you disagree with.
set -e
cd "$(dirname "$0")/.."

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# repo:namespace — namespace prefixes exist because 6 skill directory names
# collide across the upstreams; installing flat would silently overwrite.
SETS="nonlooped/roblox-suite:rbx-suite TabooHarmony/roblox-brain:rbx-brain luumenlabs/luau-skills:luau andrian-syh/roblox-best-practices-skill:rbx-practices MSayib/roblox-dev-skill:rbx-dev"

rm -rf skills
mkdir -p skills

for pair in $SETS; do
  repo=$(echo "$pair" | cut -d: -f1)
  pfx=$(echo "$pair" | cut -d: -f2)
  name=$(basename "$repo")
  echo "==> $repo"
  git clone -q --depth 1 "https://github.com/$repo.git" "$TMP/$name"
  sha=$(cd "$TMP/$name" && git rev-parse --short HEAD)
  echo "    $sha"

  # find, not a glob: luau-skills nests skills two levels deep.
  # A repo whose SKILL.md sits at the ROOT (MSayib) would yield the clone dir
  # itself, so basename would be the repo name; name that case after the
  # skill's own frontmatter `name` instead.
  find "$TMP/$name" -name SKILL.md | while read -r sk; do
    d=$(dirname "$sk")
    if [ "$d" = "$TMP/$name" ]; then
      base=$(sed -n 's/^name:[[:space:]]*//p' "$sk" | head -1 | tr -d '"'"'"'')
      [ -n "$base" ] || base="$name"
    else
      base=$(basename "$d")
    fi
    out="skills/$pfx-$base"
    mkdir -p "$out"
    # Copy everything the skill ships (references/, scripts/, tests/, and
    # deeper dirs like cases/ and patterns/) — an allowlist of known subdir
    # names silently drops whatever a future upstream adds. Only VCS and
    # packaging metadata are excluded, and only when the skill IS the repo root.
    for item in "$d"/* "$d"/.[!.]*; do
      [ -e "$item" ] || continue
      case "$(basename "$item")" in
        .git|.github|node_modules|LICENSE|LICENCE|README.md|metadata.json|evals) continue ;;
      esac
      cp -R "$item" "$out/"
    done
  done
  echo "$name $sha" >> "$TMP/shas"
done

# Strip UTF-8 BOMs. luau-skills ships 23 BOM-prefixed files; a BOM before the
# opening `---` hides the frontmatter from parsers that require it at byte 0,
# making the skill undiscoverable. lib/skills.js tolerates a BOM defensively,
# but the vendored copies are cleaned so other tooling sees valid frontmatter.
python3 - <<'PY'
import os
n = 0
for root, _, files in os.walk('skills'):
    for f in files:
        if not f.endswith('.md'):
            continue
        p = os.path.join(root, f)
        b = open(p, 'rb').read()
        if b.startswith(b'\xef\xbb\xbf'):
            open(p, 'wb').write(b[3:])
            n += 1
print(f'    stripped BOM from {n} file(s)')
PY

echo "==> $(ls -d skills/*/ | wc -l) skills vendored"
echo "    update the commit table in skills/ATTRIBUTION.md:"
cat "$TMP/shas"
echo "==> now run: node --test 'test/*.js'"
