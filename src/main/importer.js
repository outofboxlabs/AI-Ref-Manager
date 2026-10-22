// Import pipeline: PDF -> text -> identifiers -> online lookup -> AI
// extraction -> library item. Each step is best-effort; the item is always
// created, with whatever metadata could be found.

const path = require('path');
const { Library } = require('./store');
const { extractPdf } = require('./pdf');
const { findDoi, findArxivId } = require('./identifiers');
const lookup = require('./lookup');
const ai = require('./ai');

function nonEmpty(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    if (v === undefined || v === null) continue;
    if (typeof v === 'string' && !v.trim()) continue;
    if (Array.isArray(v) && !v.length) continue;
    out[k] = v;
  }
  return out;
}

function titleFromFilename(file) {
  return path.basename(file, path.extname(file)).replace(/[_-]+/g, ' ').trim();
}

/**
 * Resolve metadata for a PDF's text. Returns {fields, source, warnings}.
 * deps lets tests replace the network/AI calls.
 */
async function resolveMetadata(text, { settings, deps = {} } = {}) {
  const L = { ...lookup, ...deps.lookup };
  const A = { extractMetadata: ai.extractMetadata, ...deps.ai };
  const warnings = [];
  const online = settings.onlineLookup !== false;
  const head = text.slice(0, 20000);

  const doi = findDoi(head);
  const arxiv = findArxivId(head);

  if (online && doi) {
    try {
      const m = await L.lookupDoi(doi);
      if (m && m.title) return { fields: { ...nonEmpty(m), ...(arxiv ? { arxiv } : {}) }, source: 'crossref', warnings };
    } catch (e) {
      warnings.push(`Crossref lookup failed: ${e.message}`);
    }
  }
  if (online && arxiv) {
    try {
      const m = await L.lookupArxiv(arxiv);
      if (m && m.title) return { fields: nonEmpty(m), source: 'arxiv', warnings };
    } catch (e) {
      warnings.push(`arXiv lookup failed: ${e.message}`);
    }
  }

  const aiCfg = settings.ai ? settings.ai() : settings;
  if (settings.autoMetadata !== false && aiCfg.apiKey && head.trim()) {
    try {
      const m = nonEmpty(await A.extractMetadata(aiCfg, head));
      if (doi && !m.doi) m.doi = doi;
      if (arxiv) m.arxiv = arxiv;
      // Prefer the canonical record when AI found a DOI or a title Crossref knows.
      if (online && (m.doi || m.title)) {
        try {
          const first = m.authors?.[0]?.family || '';
          const c = m.doi ? await L.lookupDoi(m.doi) : await L.searchByTitle(m.title, first);
          if (c && c.title) return { fields: { ...m, ...nonEmpty(c) }, source: 'ai+crossref', warnings };
        } catch (e) {
          warnings.push(`Crossref lookup failed: ${e.message}`);
        }
      }
      return { fields: m, source: 'ai', warnings };
    } catch (e) {
      warnings.push(`AI metadata extraction failed: ${e.message}`);
    }
  }

  return { fields: nonEmpty({ doi, arxiv }), source: 'none', warnings };
}

/** Import one PDF into the library. Returns {item, duplicate, source, warnings}. */
async function importPdf(lib, filePath, { settings, deps } = {}) {
  const hash = Library.hashFile(filePath);
  const dup = lib.findDuplicate({ fileHash: hash });
  if (dup) return { item: dup, duplicate: true, source: 'duplicate', warnings: [] };

  let pages = [];
  let info = {};
  let numPages = 0;
  const warnings = [];
  try {
    ({ pages, info, numPages } = await (deps?.extractPdf || extractPdf)(filePath));
  } catch (e) {
    warnings.push(`Could not read PDF text: ${e.message}`);
  }
  const text = pages.join('\n\n');
  if (!text.trim() && !warnings.length) warnings.push('No text found in this PDF (it may be a scan). AI features will use the PDF directly.');

  const meta = await resolveMetadata(text, { settings, deps });
  warnings.push(...meta.warnings);
  const fields = meta.fields;

  const byIds = lib.findDuplicate({ doi: fields.doi, arxiv: fields.arxiv });
  if (byIds && !byIds.file) {
    // Existing reference without a PDF (e.g. from a BibTeX import): attach it.
    const { file, fileHash } = lib.importFile(filePath, byIds.id);
    lib.setText(byIds.id, text);
    const item = lib.update(byIds.id, {});
    Object.assign(item, { file, fileHash, numPages });
    lib.save();
    return { item, duplicate: false, attached: true, source: meta.source, warnings };
  }

  if (!fields.title) fields.title = (info.Title && String(info.Title).trim()) || titleFromFilename(filePath);
  if (!fields.authors && info.Author) fields.authors = String(info.Author).split(/;|,| and /).map((s) => s.trim()).filter(Boolean).map((n) => {
    const parts = n.split(' ');
    return { given: parts.slice(0, -1).join(' '), family: parts[parts.length - 1] };
  });

  const item = lib.add(fields);
  const { file, fileHash } = lib.importFile(filePath, item.id);
  Object.assign(item, { file, fileHash, numPages, metadataSource: meta.source });
  lib.save();
  lib.setText(item.id, text);
  return { item, duplicate: false, source: meta.source, warnings };
}

module.exports = { importPdf, resolveMetadata, titleFromFilename };
