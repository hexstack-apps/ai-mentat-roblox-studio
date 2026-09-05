'use strict';
//
// Project-registry persistence, extracted from electron-main.js for testing.
// Takes the settings file path as an argument rather than deriving it from
// Electron's userData dir, so tests can point it at a temp file.

const fs = require('fs');
const path = require('path');

/** Shape returned when there is no readable settings file yet. */
function emptySettings() {
  return { projects: [], activeProject: null };
}

/**
 * Read settings, returning a valid empty registry on ANY failure.
 *
 * Deliberately total: a corrupt or missing file must not stop the app from
 * starting. The cost is that a damaged file is silently replaced on next save,
 * which is why saveSettings writes atomically — losing the registry to a
 * truncated write is the failure this pair is designed to prevent.
 *
 * Also normalises the shape: a hand-edited file missing `projects` used to
 * crash every caller with "cannot read property find of undefined".
 */
function loadSettings(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!raw || typeof raw !== 'object') return emptySettings();
    return {
      projects: Array.isArray(raw.projects) ? raw.projects : [],
      activeProject: typeof raw.activeProject === 'string' ? raw.activeProject : null,
    };
  } catch {
    return emptySettings();
  }
}

/**
 * Write settings atomically.
 *
 * write-then-rename, because rename is atomic within a filesystem: a crash
 * mid-write leaves either the old file or the new one, never a truncated file.
 * Writing in place would risk losing the entire project registry to a power
 * cut or a kill during the write.
 */
function saveSettings(file, data) {
  const tmp = file + '.tmp';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

/**
 * Resolve the active project's path, or null.
 *
 * Returns null when the active name refers to a project that has since been
 * removed — the settings file can name an activeProject that is not in the
 * list, and callers must not receive undefined.
 */
function activeProjectPath(settings) {
  if (!settings || !Array.isArray(settings.projects)) return null;
  const proj = settings.projects.find((p) => p && p.name === settings.activeProject);
  return (proj && proj.path) || null;
}

/**
 * Add a project, keeping names unique.
 *
 * Returns a NEW settings object rather than mutating: the caller decides when
 * to persist, and a failed write then cannot leave in-memory state that
 * disagrees with disk. Adding an existing name selects it instead of creating
 * a duplicate, since the registry is keyed by name.
 */
function addProject(settings, name, projPath) {
  const s = { projects: [...(settings.projects || [])], activeProject: settings.activeProject };
  if (!s.projects.find((p) => p.name === name)) s.projects.push({ name, path: projPath });
  s.activeProject = name;
  return s;
}

/**
 * Remove a project by name.
 *
 * Clears activeProject when the removed project was active, so the app never
 * points at a project that is gone. Falls back to null, not to another
 * project — silently switching the user to a different codebase would be worse
 * than showing "no project selected".
 */
function removeProject(settings, name) {
  const projects = (settings.projects || []).filter((p) => p.name !== name);
  const activeProject = settings.activeProject === name ? null : settings.activeProject;
  return { projects, activeProject };
}

/** Select an existing project; unknown names are rejected, not stored. */
function selectProject(settings, name) {
  const exists = (settings.projects || []).some((p) => p.name === name);
  return exists
    ? { projects: settings.projects, activeProject: name }
    : { projects: settings.projects, activeProject: settings.activeProject };
}

/**
 * The Rojo project scaffold written by `projects:init`.
 *
 * Kept as data so a test can assert the generated default.project.json is
 * valid JSON with the tree Rojo expects — a malformed scaffold only surfaces
 * when `rojo serve` refuses to start, long after the folder was created.
 */
function rojoProjectScaffold(name) {
  return {
    name,
    tree: {
      $className: 'DataModel',
      ServerScriptService: { $path: 'src/ServerScriptService' },
      ReplicatedStorage: { $path: 'src/ReplicatedStorage' },
      StarterPlayer: { $path: 'src/StarterPlayer' },
    },
  };
}

const SCAFFOLD_DIRS = ['src/ServerScriptService', 'src/ReplicatedStorage', 'src/StarterPlayer'];

module.exports = {
  emptySettings,
  loadSettings,
  saveSettings,
  activeProjectPath,
  addProject,
  removeProject,
  selectProject,
  rojoProjectScaffold,
  SCAFFOLD_DIRS,
};
