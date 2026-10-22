// Manuscript reference checker: reads a .docx, finds in-text citations and
// the reference list, verifies each reference against Crossref / arXiv,
// proposes corrections, and flags what it cannot confirm.

const path = require('path');
const { readDocx, writePatched } = require('./docx');
const intext = require('../shared/intext');
const citations = require('../shared/citations');
const { findDoi, findArxivId, cleanDoi, titleSimilarity } = require('./identifiers');
const lookup = require('./lookup');
const ai = require('./ai');

// ---------------------------------------------------------------------------
// Comparison helpers

function tokens(s) {
  return String(s || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/<[^>]+>/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1);
}

/** Fraction of `needle`'s words that occur in `haystack` (0..1). */
function containment(needle, haystack) {
  const n = tokens(needle);
  if (!n.length) return 0;
  const h = new Set(tokens(haystack));
  return n.filter((w) => h.has(w)).length / n.length;
}

function yearBase(y) {
  return String(y || '').replace(/[a-z]$/i, '');
}

function firstPage(pages) {
  return (String(pages || '').match(/[A-Za-z]?\d+/) || [''])[0];
}

/**
 * Score how well a found record matches the entry as written.
 * Returns {title, author, year, score}.
 */
function matchScore(entry, rec) {
  const raw = entry.raw;
  const title = containment(rec.title, raw);
  const fam = intext.normName(rec.authors?.[0]?.family || '');
  const rawNames = new Set(tokens(raw).map(intext.normName));
  const author = fam ? rawNames.has(fam) || intext.normName(entry.firstAuthor) === fam : false;
  const year = !!rec.year && yearBase(entry.year) === String(rec.year);
  return { title, author, year, score: title * 0.7 + (author ? 0.2 : 0) + (year ? 0.1 : 0) };
}

/** Differences between the entry as written and the published record. */
function findIssues(entry, rec, m) {
  const issues = [];
  const raw = entry.raw;
  if (!m.author && rec.authors?.length) issues.push(`First author: the published record lists ${rec.authors[0].family}`);
  if (rec.year && entry.year && yearBase(entry.year) !== String(rec.year) && entry.year !== 'n.d.') {
    issues.push(`Year: written as ${entry.year}, published ${rec.year}`);
  } else if (rec.year && !entry.year) issues.push(`Year missing (${rec.year})`);
  if (m.title < 0.97) issues.push(m.title < 0.8 ? 'Title differs substantially from the published title' : 'Title wording differs slightly from the published title');
  if (rec.authors?.length > 1 && rec.authors.length <= 20) {
    const rawNames = new Set(tokens(raw).map(intext.normName));
    const missing = rec.authors.filter((a) => a.family && !rawNames.has(intext.normName(a.family)));
    const etAl = /et\s+al/i.test(raw);
    if (missing.length && !(etAl && missing.length >= rec.authors.length - 7)) {
      issues.push(`Authors missing or misspelled: ${missing.slice(0, 4).map((a) => a.family).join(', ')}${missing.length > 4 ? '…' : ''}`);
    }
  }
  if (rec.journal && containment(rec.journal, raw) < 0.6) issues.push(`Source: the record says “${rec.journal}”`);
  if (rec.volume && !new RegExp(`\\b${rec.volume.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(raw)) issues.push(`Volume missing or differs (${rec.volume})`);
  if (rec.issue && !new RegExp(`\\b${rec.issue.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(raw) && rec.type === 'article') issues.push(`Issue missing or differs (${rec.issue})`);
  const fp = firstPage(rec.pages);
  if (fp && !raw.includes(fp) && !/\bArticle\b/i.test(raw)) issues.push(`Pages missing or differ (${rec.pages})`);
  if (rec.doi && !entry.doi) issues.push(`DOI missing (${rec.doi})`);
  else if (rec.doi && entry.doi && cleanDoi(entry.doi).toLowerCase() !== rec.doi.toLowerCase()) issues.push(`DOI differs: published DOI is ${rec.doi}`);
  return issues;
}

/** Combine the published record with what only the author knows (year suffix, URL). */
function correctedItem(entry, rec) {
  const item = { ...rec };
  const suffix = /^(\d{4})([a-z])$/i.exec(entry.year || '');
  if (suffix && suffix[1] === String(rec.year)) item.year = entry.year;
  if (!item.doi && entry.url) item.url = entry.url;
  return item;
}

function classify(m, issues, viaDoi) {
  if (viaDoi ? m.title >= 0.75 || (m.author && m.year) : m.title >= 0.9 && m.author && m.year) {
    return issues.length ? 'corrected' : 'correct';
  }
  if (m.title >= 0.8 && (m.author || m.year)) return 'likely';
  return 'unsure';
}

// ---------------------------------------------------------------------------
// Verifying one entry

async function verifyEntry(entry, { csl = [], online = true, deps = {} } = {}) {
  const L = { ...lookup, ...deps.lookup };
  const result = { status: 'unsure', record: null, corrected: null, issues: [], candidates: [], source: '', note: '' };

  const consider = (rec, source, viaDoi = false) => {
    if (!rec || !rec.title) return false;
    const m = matchScore(entry, rec);
    const issues = findIssues(entry, rec, m);
    const status = classify(m, issues, viaDoi);
    const rank = { correct: 4, corrected: 3, likely: 2, unsure: 1 }[status];
    const curRank = { correct: 4, corrected: 3, likely: 2, unsure: 1, notfound: 0 }[result.status];
    if (rank > curRank || (rank === curRank && m.score > (result.match?.score || 0))) {
      Object.assign(result, { status, record: rec, corrected: correctedItem(entry, rec), issues, source, match: m });
    }
    if (m.title >= 0.5) result.candidates.push({ ...rec, score: Math.round(m.score * 100) });
    return status === 'correct' || status === 'corrected';
  };

  // 1. Data embedded by Mendeley/Zotero (already linked to a record).
  const cslHit = csl.find((c) => c.title && containment(c.title, entry.raw) >= 0.9);
  if (cslHit && cslHit.doi) entry = { ...entry, doi: entry.doi || cslHit.doi };

  if (!online) {
    if (cslHit && consider(cslHit, 'citation manager')) return result;
    result.status = 'unsure';
    result.note = 'Online lookup is turned off in Settings.';
    return result;
  }

  try {
    // 2. DOI written in the entry.
    if (entry.doi) {
      try {
        if (consider(await L.lookupDoi(entry.doi), 'Crossref (DOI)', true)) return result;
      } catch (e) {
        result.note = /404/.test(e.message) ? `The DOI ${entry.doi} does not resolve.` : e.message;
      }
    }
    // 3. arXiv id.
    const arxiv = findArxivId(entry.raw);
    if (arxiv) {
      try {
        if (consider(await L.lookupArxiv(arxiv), 'arXiv', true)) return result;
      } catch { /* fall through to search */ }
    }
    // 4. Search Crossref with the entry text.
    const found = await L.searchBibliographic(entry.raw, 3);
    for (const rec of found) consider(rec, 'Crossref (search)');
    if (cslHit) consider(cslHit, 'citation manager');
  } catch (e) {
    result.note = `Lookup failed: ${e.message}`;
  }
  if (!result.record) result.status = 'notfound';
  result.candidates = result.candidates.filter((c, i, a) => a.findIndex((x) => (x.doi || x.title) === (c.doi || c.title)) === i).slice(0, 3);
  return result;
}

/**
 * Re-verify an entry using a DOI, arXiv id, or link the user supplied.
 */
async function verifyWithInput(entry, input, { deps = {} } = {}) {
  const L = { ...lookup, ...deps.lookup };
  const s = String(input || '').trim();
  if (!s) throw new Error('Enter a DOI or a link.');
  let rec = null;
  let source = '';
  const arxiv = findArxivId(s) || (/^\d{4}\.\d{4,5}(v\d+)?$/.test(s) ? s.replace(/v\d+$/, '') : '');
  let doi = findDoi(s) || (/^10\./.test(s) ? cleanDoi(s) : '');
  if (!doi && !arxiv && /^https?:\/\//i.test(s)) {
    try {
      doi = await L.doiFromPage(s);
    } catch {
      /* page not readable; treated as a plain link below */
    }
  }
  if (doi) {
    rec = await L.lookupDoi(doi);
    source = 'your DOI';
  } else if (arxiv) {
    rec = await L.lookupArxiv(arxiv);
    source = 'your arXiv id';
  }
  if (rec && rec.title) {
    const m = matchScore(entry, rec);
    const issues = findIssues(entry, rec, m);
    // A DOI pointing at a different work stays in review until the user explicitly accepts it.
    const mismatch = m.title < 0.5 && !m.author;
    const note = mismatch ? 'The record behind this identifier looks like a different work — check it, then use “Use this” to accept it anyway.' : '';
    return { status: mismatch ? 'likely' : 'confirmed', apply: !mismatch, record: rec, corrected: correctedItem(entry, rec), issues, source, match: m, candidates: [], note };
  }
  if (/^https?:\/\//i.test(s)) {
    // A link with no DOI (report, web page, book): keep the entry as written, add the URL.
    const p = entry.parsed || {};
    const item = {
      type: p.type || 'misc',
      title: p.title || entry.title || '',
      authors: p.authors || (entry.firstAuthor ? [{ given: '', family: entry.firstAuthor }] : []),
      year: entry.year,
      journal: p.journal || '',
      volume: p.volume || '',
      issue: p.issue || '',
      pages: p.pages || '',
      publisher: p.publisher || '',
      url: s,
    };
    return { status: 'confirmed', record: null, corrected: item, issues: entry.url ? [] : ['Link added'], source: 'your link', candidates: [], note: 'No DOI found at this link; the reference is kept as written with the link added.' };
  }
  throw new Error('No record found for that DOI / id.');
}

// ---------------------------------------------------------------------------
// Whole document

async function mapLimit(list, limit, fn) {
  const out = new Array(list.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, list.length) }, async () => {
      while (next < list.length) {
        const i = next++;
        out[i] = await fn(list[i], i);
      }
    }),
  );
  return out;
}

async function checkDocument(filePath, { settings = {}, onProgress = () => {}, deps = {} } = {}) {
  onProgress({ stage: 'Reading document' });
  const doc = await readDocx(filePath);
  const main = doc.paragraphs.filter((p) => p.part === 'word/document.xml');
  const notes = doc.paragraphs.filter((p) => p.part !== 'word/document.xml');
  const bib = intext.findBibliography(main);

  const body = [...main.slice(0, bib.bodyEnd), ...notes];
  const cites = intext.extractCitations(body);

  const entryIdx = [];
  if (bib.bibStart !== -1) for (let i = bib.bibStart; i < bib.bibEnd; i++) if (main[i].text.trim().length > 10) entryIdx.push(i);
  let entries = entryIdx.map((i, n) => {
    const e = intext.parseEntryHeuristic(main[i].text);
    return { ...e, paragraph: i, number: e.number || n + 1 };
  });

  const warnings = [];
  const aiCfg = { apiKey: settings.apiKey, model: settings.model };
  if (entries.length && aiCfg.apiKey) {
    onProgress({ stage: `Reading ${entries.length} references with AI` });
    try {
      const parsed = await (deps.ai?.parseReferences || ai.parseReferences)(aiCfg, entries.map((e) => e.raw));
      entries = entries.map((e, i) => {
        const p = parsed[i];
        if (!p) return e;
        const fam = p.authors?.[0]?.family;
        // Keep the heuristic year when it carries a suffix the AI dropped.
        const year = p.year && !(e.year && e.year.startsWith(p.year) && e.year.length > p.year.length) ? intext.normYear(p.year) : e.year;
        return { ...e, parsed: p, firstAuthor: fam || e.firstAuthor, secondAuthor: p.authors?.[1]?.family || '', year, title: p.title || e.title, doi: e.doi || cleanDoi(p.doi || ''), url: e.url || p.url || '' };
      });
    } catch (err) {
      warnings.push(`AI parsing failed, used basic parsing instead: ${err.message}`);
    }
  } else if (entries.length) {
    warnings.push('Add an Anthropic API key in Settings for more accurate reference parsing.');
  }

  const cross = intext.crossCheck(cites, entries);

  const online = settings.onlineLookup !== false;
  let done = 0;
  const verifications = await mapLimit(entries, 4, async (e) => {
    const r = await verifyEntry(e, { csl: doc.csl, online, deps });
    onProgress({ stage: 'Verifying references', done: ++done, total: entries.length });
    return r;
  });

  const refs = entries.map((e, i) => {
    const v = verifications[i];
    const citedBy = cross.citations.filter((c) => c.matches.includes(i)).length;
    // Only rewrite entries with confirmed fixes by default; correct ones stay as written.
    return { ...e, ...v, index: i, citedBy, apply: v.status === 'corrected' };
  });

  const counts = {
    citations: cites.length,
    references: refs.length,
    correct: refs.filter((r) => r.status === 'correct').length,
    corrected: refs.filter((r) => r.status === 'corrected').length,
    likely: refs.filter((r) => r.status === 'likely').length,
    unsure: refs.filter((r) => r.status === 'unsure' || r.status === 'notfound').length,
    citationProblems: cross.citations.filter((c) => c.problem).length,
    uncited: cross.uncited.length,
  };
  if (bib.bibStart === -1) warnings.unshift('No reference list found. Add a heading such as “References” before it.');
  if (!cites.length) warnings.push('No in-text citations found.');

  return {
    file: filePath,
    fileName: path.basename(filePath),
    style: cross.style,
    bibHeading: bib.heading,
    citations: cross.citations,
    uncited: cross.uncited,
    refs,
    counts,
    warnings,
    doc,
  };
}

/**
 * Format the corrected reference list text for an entry, in the given style.
 * Returns HTML (with <i>) for Word, numbering preserved for numeric styles.
 */
function entryHtml(ref, style, numeric) {
  const html = citations.formatCitation(ref.corrected, style, { html: true });
  if (!numeric) return html;
  return style === 'vancouver' ? `${ref.number}. ${html}` : `[${ref.number}] ${html}`;
}

/** Save a copy of the document with accepted references rewritten. */
async function saveCorrectedDocx(result, style, outPath) {
  const numeric = result.style === 'numeric';
  const reps = result.refs
    .filter((r) => r.apply && r.corrected)
    // Body paragraphs come first in doc.paragraphs, so entry indexes line up.
    .map((r) => ({ paragraph: r.paragraph, html: entryHtml(r, style, numeric) }));
  await writePatched(result.doc, reps, outPath);
  return { path: outPath, replaced: reps.length };
}

module.exports = { checkDocument, verifyEntry, verifyWithInput, saveCorrectedDocx, entryHtml, matchScore, findIssues, containment };
