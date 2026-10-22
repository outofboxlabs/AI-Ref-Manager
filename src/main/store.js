// Local library storage: a single library.json for items and collections,
// plus files/<id>.pdf (imported PDFs) and text/<id>.txt (extracted full text,
// used for search and as AI context when a PDF is too big to send).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const EDITABLE_FIELDS = [
  'type', 'title', 'authors', 'year', 'journal', 'volume', 'issue', 'pages', 'publisher',
  'doi', 'url', 'arxiv', 'abstract', 'keywords', 'tags', 'collections', 'favorite', 'read',
  'notes', 'citeKey', 'summary', 'chat',
];

function newId() {
  return crypto.randomBytes(8).toString('hex');
}

class Library {
  constructor(dataDir) {
    this.dir = dataDir;
    this.filesDir = path.join(dataDir, 'files');
    this.textDir = path.join(dataDir, 'text');
    this.dbPath = path.join(dataDir, 'library.json');
    fs.mkdirSync(this.filesDir, { recursive: true });
    fs.mkdirSync(this.textDir, { recursive: true });
    this.data = { version: 1, items: [], collections: [] };
    if (fs.existsSync(this.dbPath)) {
      this.data = { ...this.data, ...JSON.parse(fs.readFileSync(this.dbPath, 'utf8')) };
    }
    this.textCache = new Map();
  }

  save() {
    // Write-then-rename so a crash mid-write never corrupts the library.
    const tmp = this.dbPath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.dbPath);
  }

  // --- items ---------------------------------------------------------------

  list() {
    return this.data.items;
  }

  get(id) {
    return this.data.items.find((i) => i.id === id) || null;
  }

  add(fields) {
    const now = new Date().toISOString();
    const item = {
      id: newId(),
      type: 'article',
      title: '',
      authors: [],
      year: '',
      journal: '',
      tags: [],
      keywords: [],
      collections: [],
      favorite: false,
      read: false,
      notes: '',
      summary: null,
      chat: [],
      file: null,
      fileHash: null,
      addedAt: now,
      updatedAt: now,
    };
    for (const k of EDITABLE_FIELDS) if (fields[k] !== undefined) item[k] = fields[k];
    if (fields.file) item.file = fields.file;
    if (fields.fileHash) item.fileHash = fields.fileHash;
    this.data.items.unshift(item);
    this.save();
    return item;
  }

  update(id, patch) {
    const item = this.get(id);
    if (!item) throw new Error(`No item ${id}`);
    for (const k of EDITABLE_FIELDS) if (patch[k] !== undefined) item[k] = patch[k];
    item.updatedAt = new Date().toISOString();
    this.save();
    return item;
  }

  remove(id) {
    const item = this.get(id);
    if (!item) return;
    this.data.items = this.data.items.filter((i) => i.id !== id);
    if (item.file) fs.rmSync(this.filePath(item), { force: true });
    fs.rmSync(path.join(this.textDir, `${id}.txt`), { force: true });
    this.textCache.delete(id);
    this.save();
  }

  /** Find an existing item with the same DOI, arXiv id or PDF hash. */
  findDuplicate({ doi, arxiv, fileHash }) {
    const norm = (s) => String(s || '').toLowerCase().trim();
    return (
      this.data.items.find(
        (i) =>
          (doi && norm(i.doi) === norm(doi)) ||
          (arxiv && norm(i.arxiv) === norm(arxiv)) ||
          (fileHash && i.fileHash === fileHash),
      ) || null
    );
  }

  // --- files & text --------------------------------------------------------

  /** Copy a PDF into the library; returns {file, fileHash}. */
  importFile(srcPath, id) {
    const buf = fs.readFileSync(srcPath);
    const fileHash = crypto.createHash('sha256').update(buf).digest('hex');
    const file = `${id}.pdf`;
    fs.writeFileSync(path.join(this.filesDir, file), buf);
    return { file, fileHash };
  }

  static hashFile(srcPath) {
    return crypto.createHash('sha256').update(fs.readFileSync(srcPath)).digest('hex');
  }

  filePath(item) {
    return item && item.file ? path.join(this.filesDir, item.file) : null;
  }

  setText(id, text) {
    fs.writeFileSync(path.join(this.textDir, `${id}.txt`), text || '');
    this.textCache.set(id, text || '');
  }

  getText(id) {
    if (this.textCache.has(id)) return this.textCache.get(id);
    const p = path.join(this.textDir, `${id}.txt`);
    const t = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
    this.textCache.set(id, t);
    return t;
  }

  // --- search --------------------------------------------------------------

  /**
   * Keyword search over metadata, notes, AI summary and full text. Every
   * query term must match somewhere. Results are ranked: title > authors >
   * abstract/summary/tags > full text.
   */
  search(query, { fullText = true } = {}) {
    const terms = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return this.data.items.map((i) => ({ id: i.id, score: 0 }));
    const out = [];
    for (const item of this.data.items) {
      const fields = [
        [item.title, 10],
        [(item.authors || []).map((a) => `${a.given} ${a.family}`).join(' '), 6],
        [[item.journal, item.year, item.doi].join(' '), 4],
        [[item.abstract, (item.tags || []).join(' '), (item.keywords || []).join(' '), item.notes].join(' '), 3],
        [item.summary ? JSON.stringify(item.summary) : '', 2],
      ].map(([s, w]) => [String(s || '').toLowerCase(), w]);
      let score = 0;
      let all = true;
      for (const t of terms) {
        let best = 0;
        for (const [s, w] of fields) if (s.includes(t)) best = Math.max(best, w);
        if (!best && fullText && this.getText(item.id).toLowerCase().includes(t)) best = 1;
        if (!best) { all = false; break; }
        score += best;
      }
      if (all) out.push({ id: item.id, score });
    }
    return out.sort((a, b) => b.score - a.score);
  }

  // --- collections ---------------------------------------------------------

  listCollections() {
    return this.data.collections;
  }

  addCollection(name, parentId = null) {
    const c = { id: newId(), name: String(name).trim() || 'Untitled', parentId };
    this.data.collections.push(c);
    this.save();
    return c;
  }

  renameCollection(id, name) {
    const c = this.data.collections.find((x) => x.id === id);
    if (c) { c.name = String(name).trim() || c.name; this.save(); }
    return c;
  }

  removeCollection(id) {
    // Remove the collection and its sub-collections; items stay in the library.
    const doomed = new Set([id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const c of this.data.collections) {
        if (c.parentId && doomed.has(c.parentId) && !doomed.has(c.id)) { doomed.add(c.id); grew = true; }
      }
    }
    this.data.collections = this.data.collections.filter((c) => !doomed.has(c.id));
    for (const item of this.data.items) item.collections = (item.collections || []).filter((c) => !doomed.has(c));
    this.save();
  }

  allTags() {
    const counts = new Map();
    for (const i of this.data.items) for (const t of i.tags || []) counts.set(t, (counts.get(t) || 0) + 1);
    return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([name, count]) => ({ name, count }));
  }
}

module.exports = { Library };
