#!/bin/sh
# Mutation check: reintroduce each fixed bug and assert the suite goes RED.
# A green suite proves nothing until a broken build fails it.
#
# Run: sh test/discriminates.sh
cd "$(dirname "$0")/.." || exit 1
PASS=0; FAIL=0

mutate() {
  desc=$1; file=$2; from=$3; to=$4
  cp "$file" "$file.bak"
  # Use python for literal (non-regex) replacement.
  python3 - "$file" "$from" "$to" <<'PY'
import sys
p,f,t=sys.argv[1],sys.argv[2],sys.argv[3]
s=open(p).read()
if f not in s:
    print("MUTATION-NOOP"); sys.exit(9)
open(p,'w').write(s.replace(f,t,1))
PY
  rc=$?
  if [ $rc -eq 9 ]; then
    echo "  SKIP (no-op, pattern absent): $desc"
    mv "$file.bak" "$file"; FAIL=$((FAIL+1)); return
  fi
  if node --test 'test/*.js' >/dev/null 2>&1; then
    echo "  NOT CAUGHT: $desc"
    FAIL=$((FAIL+1))
  else
    echo "  caught:     $desc"
    PASS=$((PASS+1))
  fi
  mv "$file.bak" "$file"
}

echo "Mutation testing (each must be CAUGHT):"

mutate "linux plugin dir falls back to macOS path" lib/platform.js \
  "  if (platform === 'linux') {
    const prefix = env.WINEPREFIX || path.join(home, '.wine');" \
  "  if (false) {
    const prefix = env.WINEPREFIX || path.join(home, '.wine');"

mutate "studioStatusCommand loses its linux branch" lib/platform.js \
  "  if (platform === 'linux') {
    return { cmd: 'pgrep -f RobloxStudioBeta.exe'" \
  "  if (false) {
    return { cmd: 'pgrep -f RobloxStudioBeta.exe'"

mutate "shellQuote stops quoting spaces" lib/platform.js \
  "return /[^A-Za-z0-9_@%+=:,./-]/.test(s) ? \"'\" + s.replace(/'/g, \`'\\\\''\`) + \"'\" : s;" \
  "return s;"

mutate "buildPath drops the PATH fallback" lib/platform.js \
  "const base = envPath || (isWin ? '' : '/usr/bin:/bin');" \
  "const base = envPath;"

mutate "buildPath appends user dirs instead of prepending" lib/platform.js \
  "return extra.join(sep) + sep + base;" \
  "return base + sep + extra.join(sep);"

mutate "win32 mcp path reverts to the unexpanded %LOCALAPPDATA%" lib/platform.js \
  "return { command: 'cmd.exe', args: ['/c', path.join(local, 'Roblox', 'mcp.bat')] };" \
  "return { command: 'cmd.exe', args: ['/c', '%LOCALAPPDATA%\\\\Roblox\\\\mcp.bat'] };"

mutate "loadSettings stops normalising a missing projects array" lib/settings.js \
  "      projects: Array.isArray(raw.projects) ? raw.projects : []," \
  "      projects: raw.projects,"

mutate "saveSettings writes in place (non-atomic)" lib/settings.js \
  "  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);" \
  "  fs.writeFileSync(file, JSON.stringify(data, null, 2));"

mutate "removeProject leaves a dangling activeProject" lib/settings.js \
  "  const activeProject = settings.activeProject === name ? null : settings.activeProject;" \
  "  const activeProject = settings.activeProject;"

mutate "addProject mutates its input" lib/settings.js \
  "  const s = { projects: [...(settings.projects || [])], activeProject: settings.activeProject };" \
  "  const s = settings;"

mutate "selectProject accepts unknown names" lib/settings.js \
  "  return exists
    ? { projects: settings.projects, activeProject: name }" \
  "  return true
    ? { projects: settings.projects, activeProject: name }"

echo
echo "caught $PASS / $((PASS+FAIL))"
[ "$FAIL" -eq 0 ] || exit 1
