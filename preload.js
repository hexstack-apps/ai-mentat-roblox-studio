const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Projects
  getProjects: () => ipcRenderer.invoke('projects:list'),
  addProject: (proj) => ipcRenderer.invoke('projects:add', proj),
  removeProject: (name) => ipcRenderer.invoke('projects:remove', name),
  selectProject: (name) => ipcRenderer.invoke('projects:select', name),
  getActiveProject: () => ipcRenderer.invoke('projects:active'),
  initProject: (name, path) => ipcRenderer.invoke('projects:init', name, path),

  // Rojo
  rojoStatus: () => ipcRenderer.invoke('rojo:status'),
  onRojoLog: (cb) => ipcRenderer.on('rojo:log', (_, t) => cb(t)),
  openLogsDir: () => ipcRenderer.invoke('shell:open-logs-dir'),
  rojoStart: () => ipcRenderer.invoke('rojo:start'),
  rojoStop: () => ipcRenderer.invoke('rojo:stop'),
  rojoCheck: () => ipcRenderer.invoke('rojo:check'),

  // MCP (Roblox Studio)
  mcpStatus: () => ipcRenderer.invoke('mcp:status'),
  mcpInstall: () => ipcRenderer.invoke('mcp:install'),
  mcpUninstall: () => ipcRenderer.invoke('mcp:uninstall'),

  skillsStatus: () => ipcRenderer.invoke('skills:status'),
  skillsInstall: () => ipcRenderer.invoke('skills:install'),

  // Studio
  studioStatus: () => ipcRenderer.invoke('studio:status'),
  studioLaunch: () => ipcRenderer.invoke('studio:launch'),

  // Plugin
  pluginStatus: () => ipcRenderer.invoke('plugin:status'),
  pluginInstall: () => ipcRenderer.invoke('plugin:install'),

  // PTY terminal
  ptySpawn: (cols, rows, skipPerms) => ipcRenderer.invoke('pty:spawn', cols, rows, skipPerms),
  ptyWrite: (data) => ipcRenderer.send('pty:write', data),
  ptyResize: (cols, rows) => ipcRenderer.send('pty:resize', cols, rows),
  ptyKill: () => ipcRenderer.send('pty:kill'),
  onPtyData: (cb) => { ipcRenderer.removeAllListeners('pty:data'); ipcRenderer.on('pty:data', (_, data) => cb(data)); },
  onPtyExit: (cb) => { ipcRenderer.removeAllListeners('pty:exit'); ipcRenderer.on('pty:exit', () => cb()); },

  openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),
  openFolder: (p) => ipcRenderer.invoke('shell:open-folder', p),
  selectFolder: () => ipcRenderer.invoke('dialog:select-folder'),


  // Auto-update
  onUpdateAvailable: (cb) => ipcRenderer.on('update:available', (_, info) => cb(info)),
  onUpdateDownloaded: (cb) => ipcRenderer.on('update:downloaded', (_, info) => cb(info)),
  installUpdate: () => ipcRenderer.invoke('update:install'),
});
