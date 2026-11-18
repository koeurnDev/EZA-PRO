/**
 * ⚡ EZA PRO - Preload Script
 * Security bridge between Electron and web content
 */

const { contextBridge, ipcRenderer } = require('electron');

const backendUrlArgument = process.argv.find(argument => argument.startsWith('--backend-url='));
const backendUrl = backendUrlArgument ? backendUrlArgument.slice('--backend-url='.length) : '';
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(backendUrl)) {
  throw new Error('A valid local backend URL was not provided to the renderer.');
}

// Expose protected methods to renderer process
contextBridge.exposeInMainWorld('electronAPI', {
  backendUrl,
  // Native folder picker
  openFolderDialog: (options) => ipcRenderer.invoke('open-folder-dialog', options),
  
  // Native file picker
  openFileDialog: (options) => ipcRenderer.invoke('open-file-dialog', options),
  openFilesDialog: (options) => ipcRenderer.invoke('open-files-dialog', options),
  
  // Native save dialog
  saveFileDialog: (options) => ipcRenderer.invoke('save-file-dialog', options),

  // Gemini API key management (the key is never read back into the renderer)
  saveGeminiApiKey: (apiKey) => ipcRenderer.invoke('gemini-key:save', apiKey),
  removeGeminiApiKey: () => ipcRenderer.invoke('gemini-key:remove'),
  listGeminiAccounts: () => ipcRenderer.invoke('gemini-accounts:list'),
  addGeminiAccount: (account) => ipcRenderer.invoke('gemini-accounts:add', account),
  batchAddGeminiAccounts: (payload) => ipcRenderer.invoke('gemini-accounts:batch-add', payload),
  updateGeminiAccount: (accountId, updates) => ipcRenderer.invoke('gemini-accounts:update', accountId, updates),
  switchGeminiAccount: (accountId) => ipcRenderer.invoke('gemini-accounts:switch', accountId),
  deleteGeminiAccount: (accountId) => ipcRenderer.invoke('gemini-accounts:delete', accountId),
  
  // Platform info
  platform: process.platform,
  
  // App version
  version: require('./package.json').version,

  // Warranty & maintenance support helpers
  openExternalLink: (url) => ipcRenderer.invoke('support:open-external', url),
  revealSupportLogs: () => ipcRenderer.invoke('support:reveal-logs'),
  openExportFolder: (targetPath) => ipcRenderer.invoke('export:open-folder', targetPath),
  
  // Node path utilities (safe to expose)
  path: {
    join: (...args) => require('path').join(...args),
    basename: (p) => require('path').basename(p),
    dirname: (p) => require('path').dirname(p),
    extname: (p) => require('path').extname(p)
  }
});

console.log('⚡ Preload script loaded - Electron APIs exposed');
