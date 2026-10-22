// Electron main process: window, IPC handlers, and wiring between the
// renderer and the library / import / AI modules.

const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const { Library } = require('./store');
const { Settings } = require('./settings');
const { importPdf, resolveMetadata } = require('./importer');
const lookup = require('./lookup');
const ai = require('./ai');
const { findDoi, findArxivId, cleanDoi } = require('./identifiers');
const citations = require('../shared/citations');

let win;
let lib;
let settings;

function dataDir() {
  return process.env.REFMIND_DATA_DIR || path.join(app.getPath('userData'), 'library');
}

function importCfg() {
  return { ...settings.data, ...settings.ai() };
}

function snapshot() {
  return { items: lib.list(), collections: lib.listCollections(), tags: lib.allTags() };
}

function notifyChanged() {
  if (win && !win.isDestroyed()) win.webContents.send('library:changed', snapshot());
}

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 980,
    minHeight: 600,
    title: 'RefMind',
    backgroundColor: '#f7f7f5',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      plugins: true, // built-in PDF viewer
    },
  });
  win.removeMenu?.();
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // Open external links in the user's browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file:')) {
      e.preventDefault();
      if (/^https?:/.test(url)) shell.openExternal(url);
    }
  });

  if (process.env.REFMIND_SCREENSHOT) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        const img = await win.webContents.capturePage();
        fs.writeFileSync(process.env.REFMIND_SCREENSHOT, img.toPNG());
        app.quit();
      }, Number(process.env.REFMIND_SCREENSHOT_DELAY || 1500));
    });
  }
}

// ---------------------------------------------------------------------------
// IPC

function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      return { ok: true, value: await fn(event, ...args) };
    } catch (err) {
      console.error(`[${channel}]`, err);
      return { ok: false, error: err.message || String(err) };
    }
  });
}

function paperFor(item) {
  return { pdfPath: lib.filePath(item), numPages: item.numPages, text: lib.getText(item.id), title: item.title };
}

function registerIpc() {
  handle('library:get', () => snapshot());
  handle('library:search', (_e, q) => lib.search(q));

  handle('item:add', (_e, fields) => {
    const item = lib.add(fields);
    notifyChanged();
    return item;
  });
  handle('item:update', (_e, id, patch) => {
    const item = lib.update(id, patch);
    notifyChanged();
    return item;
  });
  handle('items:update', (_e, ids, patchFn) => {
    // patchFn is a plain description: {addTags, removeTags, addCollection, removeCollection, favorite, read}
    for (const id of ids) {
      const it = lib.get(id);
      if (!it) continue;
      const p = {};
      if (patchFn.addTags) p.tags = [...new Set([...(it.tags || []), ...patchFn.addTags])];
      if (patchFn.removeTags) p.tags = (p.tags || it.tags || []).filter((t) => !patchFn.removeTags.includes(t));
      if (patchFn.addCollection) p.collections = [...new Set([...(it.collections || []), patchFn.addCollection])];
      if (patchFn.removeCollection) p.collections = (it.collections || []).filter((c) => c !== patchFn.removeCollection);
      if (patchFn.favorite !== undefined) p.favorite = patchFn.favorite;
      if (patchFn.read !== undefined) p.read = patchFn.read;
      lib.update(id, p);
    }
    notifyChanged();
    return true;
  });
  handle('items:remove', async (_e, ids) => {
    const { response } = await dialog.showMessageBox(win, {
      type: 'warning',
      buttons: ['Delete', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: ids.length === 1 ? 'Delete this reference and its PDF?' : `Delete ${ids.length} references and their PDFs?`,
      detail: 'This cannot be undone.',
    });
    if (response !== 0) return false;
    for (const id of ids) lib.remove(id);
    notifyChanged();
    return true;
  });

  // --- import ---------------------------------------------------------------

  async function importPaths(event, paths) {
    const results = [];
    const pdfs = paths.filter((p) => /\.pdf$/i.test(p));
    const bibs = paths.filter((p) => /\.(bib|ris)$/i.test(p));
    let n = 0;
    for (const p of pdfs) {
      n++;
      event.sender.send('import:progress', { done: n - 1, total: pdfs.length, file: path.basename(p) });
      try {
        const r = await importPdf(lib, p, { settings: importCfg() });
        results.push({ file: path.basename(p), id: r.item.id, title: r.item.title, duplicate: r.duplicate, attached: r.attached, source: r.source, warnings: r.warnings });
        notifyChanged();
        if (!r.duplicate && settings.data.autoSummarize && settings.getApiKey()) summarizeItem(r.item.id).catch(() => {});
      } catch (err) {
        results.push({ file: path.basename(p), error: err.message });
      }
    }
    for (const p of bibs) results.push(...importReferenceFile(p));
    event.sender.send('import:progress', { done: pdfs.length, total: pdfs.length, finished: true });
    notifyChanged();
    return results;
  }

  handle('import:pdfDialog', async (event) => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Add PDFs',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    if (r.canceled) return [];
    return importPaths(event, r.filePaths);
  });
  handle('import:paths', (event, paths) => importPaths(event, paths));

  function importReferenceFile(p) {
    const text = fs.readFileSync(p, 'utf8');
    const parsed = /\.ris$/i.test(p) ? citations.parseRIS(text) : citations.parseBibTeX(text);
    const out = [];
    for (const fields of parsed) {
      const dup = lib.findDuplicate({ doi: fields.doi, arxiv: fields.arxiv });
      if (dup) { out.push({ file: path.basename(p), id: dup.id, title: dup.title, duplicate: true }); continue; }
      const { file, ...rest } = fields;
      const item = lib.add(rest);
      // Mendeley/Zotero BibTeX exports often include a file path; attach it when it exists.
      const pdf = file && String(file).split(';').map((s) => s.replace(/^:|:pdf$|:application\/pdf$/gi, '').replace(/\\:/g, ':')).find((s) => /\.pdf$/i.test(s) && fs.existsSync(s));
      if (pdf) {
        Object.assign(item, lib.importFile(pdf, item.id));
        lib.save();
      }
      out.push({ file: path.basename(p), id: item.id, title: item.title, source: 'bibtex' });
    }
    return out;
  }

  handle('import:refsDialog', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Import BibTeX / RIS',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'BibTeX / RIS', extensions: ['bib', 'ris', 'txt'] }],
    });
    if (r.canceled) return [];
    const results = r.filePaths.flatMap(importReferenceFile);
    notifyChanged();
    return results;
  });

  handle('import:identifier', async (_e, raw) => {
    const s = String(raw || '').trim();
    const arxiv = findArxivId(s) || (/^\d{4}\.\d{4,5}(v\d+)?$/.test(s) ? s.replace(/v\d+$/, '') : '');
    const doi = arxiv ? '' : findDoi(s) || cleanDoi(s);
    const dup = lib.findDuplicate({ doi, arxiv });
    if (dup) return { item: dup, duplicate: true };
    let fields = null;
    if (arxiv) fields = await lookup.lookupArxiv(arxiv);
    else if (/^10\./.test(doi)) fields = await lookup.lookupDoi(doi);
    else throw new Error('Enter a DOI (10.xxxx/...) or an arXiv id (2101.01234).');
    if (!fields || !fields.title) throw new Error('No record found for that identifier.');
    const item = lib.add(fields);
    notifyChanged();
    return { item, duplicate: false };
  });

  handle('item:attachPdf', async (_e, id) => {
    const r = await dialog.showOpenDialog(win, { title: 'Attach PDF', properties: ['openFile'], filters: [{ name: 'PDF', extensions: ['pdf'] }] });
    if (r.canceled) return null;
    const item = lib.get(id);
    const { file, fileHash } = lib.importFile(r.filePaths[0], id);
    const { extractPdf } = require('./pdf');
    try {
      const { pages, numPages } = await extractPdf(lib.filePath({ file }));
      lib.setText(id, pages.join('\n\n'));
      item.numPages = numPages;
    } catch {
      /* keep the file even if text extraction fails */
    }
    Object.assign(item, { file, fileHash });
    lib.save();
    notifyChanged();
    return item;
  });

  handle('item:refreshMetadata', async (_e, id) => {
    const item = lib.get(id);
    const text = lib.getText(id);
    let fields = {};
    let warnings = [];
    if (item.doi && settings.data.onlineLookup) fields = (await lookup.lookupDoi(item.doi)) || {};
    else if (item.arxiv && settings.data.onlineLookup) fields = (await lookup.lookupArxiv(item.arxiv)) || {};
    else if (text) {
      const cfg = importCfg();
      ({ fields, warnings } = await resolveMetadata(text, { settings: { ...cfg, autoMetadata: true } }));
    } else throw new Error('Nothing to look up: add a DOI or attach a PDF first.');
    const clean = Object.fromEntries(Object.entries(fields).filter(([, v]) => v && (!Array.isArray(v) || v.length)));
    if (!Object.keys(clean).length) throw new Error(warnings[0] || 'No metadata found.');
    const updated = lib.update(id, clean);
    notifyChanged();
    return updated;
  });

  // --- files ----------------------------------------------------------------

  handle('item:pdfUrl', (_e, id) => {
    const p = lib.filePath(lib.get(id));
    return p && fs.existsSync(p) ? pathToFileURL(p).href : null;
  });
  handle('item:openPdf', async (_e, id) => {
    const p = lib.filePath(lib.get(id));
    if (!p) throw new Error('No PDF attached.');
    const err = await shell.openPath(p);
    if (err) throw new Error(err);
    return true;
  });
  handle('item:showPdf', (_e, id) => {
    const p = lib.filePath(lib.get(id));
    if (p) shell.showItemInFolder(p);
    return true;
  });
  handle('openExternal', (_e, url) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return true;
  });

  // --- export ---------------------------------------------------------------

  handle('export', async (_e, ids, format) => {
    const items = ids.map((id) => lib.get(id)).filter(Boolean);
    const ext = { bibtex: 'bib', ris: 'ris' }[format] || 'txt';
    const r = await dialog.showSaveDialog(win, {
      title: 'Export references',
      defaultPath: `references.${ext}`,
      filters: [{ name: format.toUpperCase(), extensions: [ext] }],
    });
    if (r.canceled) return null;
    let content;
    if (format === 'bibtex') content = citations.toBibTeX(items);
    else if (format === 'ris') content = citations.toRIS(items);
    else {
      const sorted = [...items].sort((a, b) => citations.formatCitation(a, format).localeCompare(citations.formatCitation(b, format)));
      content = (format === 'ieee' || format === 'vancouver' ? items : sorted)
        .map((it, i) => (format === 'ieee' ? `[${i + 1}] ` : format === 'vancouver' ? `${i + 1}. ` : '') + citations.formatCitation(it, format))
        .join('\n\n') + '\n';
    }
    fs.writeFileSync(r.filePath, content);
    return r.filePath;
  });

  // --- collections ----------------------------------------------------------

  handle('collection:add', (_e, name, parentId) => {
    const c = lib.addCollection(name, parentId);
    notifyChanged();
    return c;
  });
  handle('collection:rename', (_e, id, name) => {
    const c = lib.renameCollection(id, name);
    notifyChanged();
    return c;
  });
  handle('collection:remove', (_e, id) => {
    lib.removeCollection(id);
    notifyChanged();
    return true;
  });
  handle('tag:rename', (_e, from, to) => {
    for (const it of lib.list()) {
      if ((it.tags || []).includes(from)) {
        const tags = [...new Set(it.tags.map((t) => (t === from ? to : t)).filter(Boolean))];
        lib.update(it.id, { tags });
      }
    }
    notifyChanged();
    return true;
  });

  // --- AI -------------------------------------------------------------------

  handle('ai:summarize', (_e, id) => summarizeItem(id));

  handle('ai:chat', async (event, id, history, reqId) => {
    const item = lib.get(id);
    const text = await ai.chatWithPaper(settings.ai(), paperFor(item), history, (delta) =>
      event.sender.send('ai:delta', { reqId, delta }),
    );
    lib.update(id, { chat: [...history, { role: 'assistant', content: text }] });
    return text;
  });

  handle('ai:askLibrary', async (event, ids, history, reqId) => {
    const items = (ids && ids.length ? ids.map((i) => lib.get(i)) : lib.list()).filter(Boolean);
    const text = await ai.askLibrary(settings.ai(), items, history, (delta) => event.sender.send('ai:delta', { reqId, delta }));
    return { text, refs: items.map((i) => i.id) };
  });

  // --- settings -------------------------------------------------------------

  handle('settings:get', () => ({ ...settings.public(), models: ai.MODELS, styles: citations.STYLES, dataDir: dataDir() }));
  handle('settings:update', (_e, patch) => ({ ...settings.update(patch), models: ai.MODELS, styles: citations.STYLES, dataDir: dataDir() }));
  handle('settings:testKey', () => ai.testKey(settings.ai()));
  handle('settings:openDataDir', () => shell.openPath(dataDir()));
}

async function summarizeItem(id) {
  const item = lib.get(id);
  if (!item) throw new Error('Item not found.');
  const summary = await ai.summarize(settings.ai(), paperFor(item));
  summary.model = settings.data.model;
  summary.createdAt = new Date().toISOString();
  const keywords = summary.keywords || [];
  const updated = lib.update(id, { summary, keywords: [...new Set([...(item.keywords || []), ...keywords])] });
  notifyChanged();
  return updated;
}

// ---------------------------------------------------------------------------

app.whenReady().then(() => {
  fs.mkdirSync(dataDir(), { recursive: true });
  lib = new Library(dataDir());
  settings = new Settings(dataDir(), safeStorage);
  registerIpc();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
