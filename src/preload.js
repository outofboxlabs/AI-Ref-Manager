// Exposes a narrow, promise-based API to the sandboxed renderer.

const { contextBridge, ipcRenderer, webUtils } = require('electron');

async function call(channel, ...args) {
  const r = await ipcRenderer.invoke(channel, ...args);
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

function on(channel, cb) {
  const listener = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('api', {
  getLibrary: () => call('library:get'),
  search: (q) => call('library:search', q),
  addItem: (fields) => call('item:add', fields),
  updateItem: (id, patch) => call('item:update', id, patch),
  updateItems: (ids, patch) => call('items:update', ids, patch),
  removeItems: (ids) => call('items:remove', ids),

  importPdfDialog: () => call('import:pdfDialog'),
  importFiles: (files) => call('import:paths', [...files].map((f) => webUtils.getPathForFile(f)).filter(Boolean)),
  importRefsDialog: () => call('import:refsDialog'),
  importIdentifier: (s) => call('import:identifier', s),
  attachPdf: (id) => call('item:attachPdf', id),
  refreshMetadata: (id) => call('item:refreshMetadata', id),

  pdfUrl: (id) => call('item:pdfUrl', id),
  openPdf: (id) => call('item:openPdf', id),
  showPdf: (id) => call('item:showPdf', id),
  openExternal: (url) => call('openExternal', url),
  exportItems: (ids, format) => call('export', ids, format),

  addCollection: (name, parentId) => call('collection:add', name, parentId),
  renameCollection: (id, name) => call('collection:rename', id, name),
  removeCollection: (id) => call('collection:remove', id),
  renameTag: (from, to) => call('tag:rename', from, to),

  summarize: (id) => call('ai:summarize', id),
  chat: (id, history, reqId) => call('ai:chat', id, history, reqId),
  askLibrary: (ids, history, reqId) => call('ai:askLibrary', ids, history, reqId),

  checkDocxDialog: () => call('check:openDialog'),
  checkDocxFile: (file) => call('check:path', webUtils.getPathForFile(file)),
  checkResolve: (checkId, index, input) => call('check:resolve', checkId, index, input),
  checkAccept: (checkId, index, candidateIndex) => call('check:accept', checkId, index, candidateIndex),
  checkSetApply: (checkId, indexes, value) => call('check:setApply', checkId, indexes, value),
  checkSave: (checkId, style) => call('check:save', checkId, style),
  checkAddToLibrary: (checkId) => call('check:addToLibrary', checkId),
  saveText: (content, defaultName, ext) => call('saveText', content, defaultName, ext),

  getSettings: () => call('settings:get'),
  updateSettings: (patch) => call('settings:update', patch),
  testKey: () => call('settings:testKey'),
  openDataDir: () => call('settings:openDataDir'),

  onLibraryChanged: (cb) => on('library:changed', cb),
  onImportProgress: (cb) => on('import:progress', cb),
  onAiDelta: (cb) => on('ai:delta', cb),
  onCheckProgress: (cb) => on('check:progress', cb),
});
