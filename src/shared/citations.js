// Citation formatting, BibTeX/RIS export, and BibTeX/RIS import.
// Pure functions with no Electron/Node dependencies so they can be used from
// the main process, the renderer, and unit tests alike.

(function () {
'use strict';

const STYLES = {
  apa: 'APA 7th',
  mla: 'MLA 9th',
  chicago: 'Chicago (author-date)',
  harvard: 'Harvard',
  ieee: 'IEEE',
  vancouver: 'Vancouver',
};

const BIBTEX_TYPES = {
  article: 'article',
  preprint: 'misc',
  inproceedings: 'inproceedings',
  book: 'book',
  chapter: 'incollection',
  thesis: 'phdthesis',
  report: 'techreport',
  misc: 'misc',
};

const RIS_TYPES = {
  article: 'JOUR',
  preprint: 'UNPB',
  inproceedings: 'CONF',
  book: 'BOOK',
  chapter: 'CHAP',
  thesis: 'THES',
  report: 'RPRT',
  misc: 'GEN',
};

// ---------------------------------------------------------------------------
// Names

/** Parse "Family, Given" or "Given Family" into {given, family}. */
function parseName(raw) {
  const s = String(raw || '').trim().replace(/\s+/g, ' ');
  if (!s) return { given: '', family: '' };
  if (s.includes(',')) {
    const [family, ...rest] = s.split(',');
    return { given: rest.join(',').trim(), family: family.trim() };
  }
  const parts = s.split(' ');
  if (parts.length === 1) return { given: '', family: parts[0] };
  // Keep lowercase particles (van, de, von, ...) with the family name.
  let i = parts.length - 1;
  while (i > 1 && /^[a-z]/.test(parts[i - 1])) i--;
  return { given: parts.slice(0, i).join(' '), family: parts.slice(i).join(' ') };
}

function normalizeAuthors(authors) {
  return (authors || [])
    .map((a) => (typeof a === 'string' ? parseName(a) : { given: a.given || '', family: a.family || '' }))
    .filter((a) => a.given || a.family);
}

/** "John Ronald" -> "J. R." ; "Jean-Paul" -> "J.-P." */
function initials(given, { spaced = true, dots = true } = {}) {
  return String(given || '')
    .split(/\s+/)
    .filter(Boolean)
    .map((word) =>
      word
        .split('-')
        .map((p) => (p ? p[0].toUpperCase() + (dots ? '.' : '') : ''))
        .join('-'),
    )
    .join(spaced ? ' ' : '');
}

function fullName(a) {
  return [a.given, a.family].filter(Boolean).join(' ');
}

function joinList(list, { sep = ', ', last = ', and ', two = ' and ' } = {}) {
  if (list.length <= 1) return list.join('');
  if (list.length === 2) return list[0] + two + list[1];
  return list.slice(0, -1).join(sep) + last + list[list.length - 1];
}

// ---------------------------------------------------------------------------
// Helpers

function clean(s) {
  return String(s ?? '').trim().replace(/\s+/g, ' ');
}

function stripTrailingPeriod(s) {
  return clean(s).replace(/[.\s]+$/, '');
}

/** Sentence-ending punctuation: avoid "Title?." */
function endPunct(s, p = '.') {
  const t = stripTrailingPeriod(s);
  return /[?!]$/.test(t) ? t : t + p;
}

function doiUrl(doi) {
  if (!doi) return '';
  return 'https://doi.org/' + String(doi).replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').trim();
}

function link(item) {
  return item.doi ? doiUrl(item.doi) : item.url || '';
}

function pageRange(pages) {
  return clean(pages).replace(/\s*[-–—]+\s*/g, '–');
}

function containerOf(item) {
  return clean(item.journal || item.booktitle || '');
}

function makeItalic(html) {
  return html ? (s) => (s ? `<i>${escapeHtml(s)}</i>` : '') : (s) => s || '';
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
// Formatted citations. Each formatter returns plain text, or HTML (with only
// <i> markup and escaped text) when opts.html is true.

function formatCitation(item, style = 'apa', opts = {}) {
  const fn = FORMATTERS[style];
  if (!fn) throw new Error(`Unknown citation style: ${style}`);
  const html = !!opts.html;
  const esc = html ? escapeHtml : (s) => s;
  const it = makeItalic(html);
  return fn(item, { esc, it }).replace(/\s+/g, ' ').trim();
}

const FORMATTERS = {
  apa(item, { esc, it }) {
    const authors = normalizeAuthors(item.authors);
    const names = authors.map((a) => [a.family, initials(a.given)].filter(Boolean).join(', '));
    let who;
    if (names.length === 0) who = '';
    else if (names.length <= 20) who = joinList(names, { sep: ', ', last: ', & ', two: ', & ' });
    else who = names.slice(0, 19).join(', ') + ', … ' + names[names.length - 1];
    const year = item.year ? `(${item.year}).` : '(n.d.).';
    const title = endPunct(item.title || 'Untitled');
    const parts = [];
    if (who) parts.push(esc(endPunct(who)), esc(year));
    else parts.push(esc(title), esc(year));
    const container = containerOf(item);
    if (item.type === 'book') {
      if (who) parts.push(it(title));
      if (item.publisher) parts.push(esc(endPunct(item.publisher)));
    } else {
      if (who) parts.push(esc(title));
      if (container) {
        let src = it(container);
        if (item.volume) src += ', ' + it(String(item.volume));
        if (item.issue) src += esc(`(${item.issue})`);
        if (item.pages) src += esc(', ' + pageRange(item.pages));
        parts.push(src + '.');
      } else if (item.publisher) {
        parts.push(esc(endPunct(item.publisher)));
      }
    }
    const url = link(item);
    if (url) parts.push(esc(url));
    return parts.join(' ');
  },

  mla(item, { esc, it }) {
    const authors = normalizeAuthors(item.authors);
    let who = '';
    if (authors.length === 1) who = [authors[0].family, authors[0].given].filter(Boolean).join(', ');
    else if (authors.length === 2)
      who = `${[authors[0].family, authors[0].given].filter(Boolean).join(', ')}, and ${fullName(authors[1])}`;
    else if (authors.length > 2)
      who = `${[authors[0].family, authors[0].given].filter(Boolean).join(', ')}, et al`;
    const parts = [];
    if (who) parts.push(esc(endPunct(who)));
    const container = containerOf(item);
    if (item.type === 'book') {
      parts.push(it(endPunct(item.title || 'Untitled')));
      const pub = [item.publisher, item.year].filter(Boolean).join(', ');
      if (pub) parts.push(esc(pub + '.'));
    } else {
      parts.push(esc(`“${endPunct(item.title || 'Untitled')}”`));
      const bits = [];
      if (container) bits.push(it(container));
      if (item.volume) bits.push(esc(`vol. ${item.volume}`));
      if (item.issue) bits.push(esc(`no. ${item.issue}`));
      if (item.publisher && !container) bits.push(esc(item.publisher));
      if (item.year) bits.push(esc(String(item.year)));
      if (item.pages) bits.push(esc(`pp. ${pageRange(item.pages)}`));
      if (bits.length) parts.push(bits.join(', ') + '.');
    }
    const url = link(item);
    if (url) parts.push(esc(url.replace(/^https?:\/\//, '') + '.'));
    return parts.join(' ');
  },

  chicago(item, { esc, it }) {
    const authors = normalizeAuthors(item.authors);
    const names = authors.map((a, i) =>
      i === 0 ? [a.family, a.given].filter(Boolean).join(', ') : fullName(a),
    );
    let who = '';
    if (names.length > 10) who = names.slice(0, 7).join(', ') + ', et al';
    else who = joinList(names, { sep: ', ', last: ', and ', two: ', and ' });
    const parts = [];
    if (who) parts.push(esc(endPunct(who)));
    parts.push(esc((item.year || 'n.d.') + '.'));
    const container = containerOf(item);
    if (item.type === 'book') {
      parts.push(it(endPunct(item.title || 'Untitled')));
      if (item.publisher) parts.push(esc(endPunct(item.publisher)));
    } else {
      parts.push(esc(`“${endPunct(item.title || 'Untitled')}”`));
      if (container) {
        let src = it(container);
        if (item.volume) src += esc(' ' + item.volume);
        if (item.issue) src += esc(` (${item.issue})`);
        if (item.pages) src += esc(': ' + pageRange(item.pages));
        parts.push(src + '.');
      }
    }
    const url = link(item);
    if (url) parts.push(esc(url + '.'));
    return parts.join(' ');
  },

  harvard(item, { esc, it }) {
    const authors = normalizeAuthors(item.authors);
    const names = authors.map((a) => [a.family, initials(a.given, { spaced: false })].filter(Boolean).join(', '));
    let who = '';
    if (names.length > 3) who = names[0] + ' et al.';
    else who = joinList(names, { sep: ', ', last: ' and ', two: ' and ' });
    const parts = [];
    parts.push(esc(`${who ? who + ' ' : ''}(${item.year || 'n.d.'})`));
    const container = containerOf(item);
    if (item.type === 'book') {
      parts.push(it(stripTrailingPeriod(item.title || 'Untitled')) + '.');
      if (item.publisher) parts.push(esc(endPunct(item.publisher)));
    } else {
      let s = esc(`‘${stripTrailingPeriod(item.title || 'Untitled')}’`);
      if (container) {
        s += ', ' + it(container);
        if (item.volume) s += esc(`, ${item.volume}`);
        if (item.issue) s += esc(`(${item.issue})`);
        if (item.pages) s += esc(`, pp. ${pageRange(item.pages)}`);
      }
      parts.push(s + '.');
    }
    const url = link(item);
    if (url) parts.push(esc(item.doi ? `doi:${item.doi}.` : `Available at: ${url}.`));
    return parts.join(' ');
  },

  ieee(item, { esc, it }) {
    const authors = normalizeAuthors(item.authors);
    const names = authors.map((a) => [initials(a.given), a.family].filter(Boolean).join(' '));
    let who = '';
    if (names.length > 6) who = names[0] + ' et al.';
    else who = joinList(names, { sep: ', ', last: ', and ', two: ' and ' });
    const parts = [];
    const container = containerOf(item);
    if (item.type === 'book') {
      let s = who ? esc(who + ', ') : '';
      s += it(stripTrailingPeriod(item.title || 'Untitled')) + '.';
      parts.push(s);
      const pub = [item.publisher, item.year].filter(Boolean).join(', ');
      if (pub) parts.push(esc(pub + '.'));
    } else {
      let s = who ? esc(who + ', ') : '';
      s += esc(`“${stripTrailingPeriod(item.title || 'Untitled')},”`);
      const bits = [];
      if (container) bits.push((item.type === 'inproceedings' ? esc('in ') : '') + it(container));
      if (item.volume) bits.push(esc(`vol. ${item.volume}`));
      if (item.issue) bits.push(esc(`no. ${item.issue}`));
      if (item.pages) bits.push(esc(`pp. ${pageRange(item.pages)}`));
      if (item.year) bits.push(esc(String(item.year)));
      parts.push(s + (bits.length ? ' ' + bits.join(', ') : '') + '.');
    }
    if (item.doi) parts.push(esc(`doi: ${item.doi}.`));
    else if (item.url) parts.push(esc(`[Online]. Available: ${item.url}`));
    return parts.join(' ');
  },

  vancouver(item, { esc, it }) {
    const authors = normalizeAuthors(item.authors);
    const names = authors.map((a) =>
      [a.family, initials(a.given, { spaced: false, dots: false }).replace(/-/g, '')].filter(Boolean).join(' '),
    );
    let who = names.length > 6 ? names.slice(0, 6).join(', ') + ', et al' : names.join(', ');
    const parts = [];
    if (who) parts.push(esc(endPunct(who)));
    parts.push(esc(endPunct(item.title || 'Untitled')));
    const container = containerOf(item);
    if (item.type === 'book') {
      const pub = [item.publisher, item.year].filter(Boolean).join('; ');
      if (pub) parts.push(esc(pub + '.'));
    } else {
      let s = container ? it(container) + '. ' : '';
      s += esc(String(item.year || ''));
      if (item.volume) s += esc(`;${item.volume}`);
      if (item.issue) s += esc(`(${item.issue})`);
      if (item.pages) s += esc(`:${pageRange(item.pages).replace('–', '-')}`);
      if (s.trim()) parts.push(s + '.');
    }
    if (item.doi) parts.push(esc(`doi:${item.doi}`));
    return parts.join(' ');
  },
};

/** Short in-text citation, e.g. "(Smith & Jones, 2020)". */
function inTextCitation(item, style = 'apa') {
  const authors = normalizeAuthors(item.authors);
  const year = item.year || 'n.d.';
  const fam = authors.map((a) => a.family || a.given);
  if (style === 'ieee' || style === 'vancouver') return '[1]';
  if (style === 'mla') {
    if (!fam.length) return `(“${clean(item.title).split(' ').slice(0, 3).join(' ')}”)`;
    return `(${fam.length > 2 ? fam[0] + ' et al.' : fam.join(' and ')})`;
  }
  let who;
  if (!fam.length) who = clean(item.title).split(' ').slice(0, 3).join(' ');
  else if (fam.length === 1) who = fam[0];
  else if (fam.length === 2) who = fam.join(style === 'apa' ? ' & ' : ' and ');
  else who = fam[0] + ' et al.';
  return `(${who}${style === 'chicago' ? ' ' : ', '}${year})`;
}

// ---------------------------------------------------------------------------
// BibTeX

function bibtexEscape(s) {
  return String(s ?? '')
    .replace(/\\/g, '\\textbackslash{}')
    .replace(/([&%$#_])/g, '\\$1')
    .replace(/([{}])/g, '\\$1')
    .replace(/~/g, '\\textasciitilde{}')
    .replace(/\^/g, '\\textasciicircum{}');
}

function asciiFold(s) {
  return String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]/g, '');
}

const STOPWORDS = new Set(['a', 'an', 'the', 'on', 'of', 'in', 'for', 'and', 'to', 'with', 'from', 'at', 'by']);

/** Citation key like "smith2020attention". */
function citeKey(item) {
  const authors = normalizeAuthors(item.authors);
  const fam = asciiFold(authors[0]?.family || authors[0]?.given || 'anon').toLowerCase();
  const word =
    clean(item.title)
      .split(/\s+/)
      .map((w) => asciiFold(w).toLowerCase())
      .find((w) => w && !STOPWORDS.has(w)) || '';
  return `${fam || 'anon'}${item.year || ''}${word}`;
}

/** Assign unique keys across a list (smith2020a, smith2020b, ...). */
function uniqueKeys(items) {
  const seen = new Map();
  const keys = items.map((it) => it.citeKey || citeKey(it));
  const counts = keys.reduce((m, k) => m.set(k, (m.get(k) || 0) + 1), new Map());
  return keys.map((k) => {
    if (counts.get(k) === 1) return k;
    const n = seen.get(k) || 0;
    seen.set(k, n + 1);
    return k + String.fromCharCode(97 + (n % 26)) + (n >= 26 ? Math.floor(n / 26) : '');
  });
}

function toBibTeX(items) {
  const list = Array.isArray(items) ? items : [items];
  const keys = uniqueKeys(list);
  return list
    .map((item, i) => {
      const type = BIBTEX_TYPES[item.type] || 'misc';
      const authors = normalizeAuthors(item.authors);
      const fields = [];
      const add = (k, v) => {
        if (v !== undefined && v !== null && String(v).trim() !== '') fields.push([k, v]);
      };
      add('title', `{${bibtexEscape(clean(item.title))}}`);
      add('author', authors.map((a) => bibtexEscape([a.family, a.given].filter(Boolean).join(', '))).join(' and '));
      const container = containerOf(item);
      if (type === 'article') add('journal', bibtexEscape(container));
      else if (type === 'inproceedings' || type === 'incollection') add('booktitle', bibtexEscape(container));
      else if (container) add('howpublished', bibtexEscape(container));
      add('year', item.year);
      add('volume', bibtexEscape(item.volume));
      add('number', bibtexEscape(item.issue));
      add('pages', bibtexEscape(clean(item.pages).replace(/\s*[-–—]+\s*/g, '--')));
      if (type === 'phdthesis') add('school', bibtexEscape(item.publisher));
      else if (type === 'techreport') add('institution', bibtexEscape(item.publisher));
      else add('publisher', bibtexEscape(item.publisher));
      add('doi', item.doi);
      add('url', item.url);
      if (item.arxiv) {
        add('eprint', item.arxiv);
        add('archivePrefix', 'arXiv');
      }
      add('abstract', bibtexEscape(clean(item.abstract)));
      const kw = [...new Set([...(item.keywords || []), ...(item.tags || [])])];
      add('keywords', bibtexEscape(kw.join(', ')));
      const body = fields.map(([k, v]) => `  ${k} = {${v}}`).join(',\n');
      return `@${type}{${keys[i]},\n${body}\n}`;
    })
    .join('\n\n') + '\n';
}

// ---------------------------------------------------------------------------
// RIS

function toRIS(items) {
  const list = Array.isArray(items) ? items : [items];
  return list
    .map((item) => {
      const lines = [];
      const add = (tag, v) => {
        if (v !== undefined && v !== null && String(v).trim() !== '') lines.push(`${tag}  - ${clean(v)}`);
      };
      add('TY', RIS_TYPES[item.type] || 'GEN');
      for (const a of normalizeAuthors(item.authors)) add('AU', [a.family, a.given].filter(Boolean).join(', '));
      add('TI', item.title);
      const container = containerOf(item);
      if (item.type === 'article') add('JO', container);
      else add('T2', container);
      add('PY', item.year);
      add('VL', item.volume);
      add('IS', item.issue);
      if (item.pages) {
        const [sp, ep] = clean(item.pages).split(/\s*[-–—]+\s*/);
        add('SP', sp);
        add('EP', ep);
      }
      add('PB', item.publisher);
      add('DO', item.doi);
      add('UR', item.url);
      add('AB', item.abstract);
      for (const k of new Set([...(item.keywords || []), ...(item.tags || [])])) add('KW', k);
      if (item.notes) add('N1', item.notes);
      lines.push('ER  - ');
      return lines.join('\r\n');
    })
    .join('\r\n\r\n') + '\r\n';
}

// ---------------------------------------------------------------------------
// Import

const BIBTEX_TYPE_MAP = {
  article: 'article',
  inproceedings: 'inproceedings',
  conference: 'inproceedings',
  book: 'book',
  incollection: 'chapter',
  inbook: 'chapter',
  phdthesis: 'thesis',
  mastersthesis: 'thesis',
  techreport: 'report',
  misc: 'misc',
  unpublished: 'preprint',
};

const LATEX_ACCENTS = { '"': '̈', "'": '́', '`': '̀', '^': '̂', '~': '̃', c: '̧', v: '̌', '=': '̄', '.': '̇', u: '̆', H: '̋' };

function delatex(s) {
  return String(s || '')
    .replace(/\\([`'^"~=.uvHc])\s*\{?\s*([A-Za-z])\s*\}?/g, (_, acc, ch) => (ch + (LATEX_ACCENTS[acc] || '')).normalize('NFC'))
    .replace(/\\ss\b\{?\}?/g, 'ß')
    .replace(/\\([&%$#_{}])/g, '$1')
    .replace(/\\textbackslash\{\}/g, '\\')
    .replace(/--/g, '–')
    .replace(/[{}]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Parse BibTeX text into item objects (subset of fields we care about). */
function parseBibTeX(text) {
  const items = [];
  const src = String(text || '');
  let i = 0;
  while ((i = src.indexOf('@', i)) !== -1) {
    const m = /^@\s*([A-Za-z]+)\s*([{(])/.exec(src.slice(i));
    if (!m) { i++; continue; }
    const type = m[1].toLowerCase();
    const close = m[2] === '{' ? '}' : ')';
    let j = i + m[0].length;
    // Find matching close, respecting nested braces.
    let depth = 1;
    let k = j;
    for (; k < src.length && depth > 0; k++) {
      const c = src[k];
      if (c === '{' || (close === ')' && c === '(')) depth++;
      else if (c === close || (close === ')' && c === ')') || c === '}') depth--;
    }
    const body = src.slice(j, k - 1);
    i = k;
    if (type === 'comment' || type === 'preamble' || type === 'string') continue;
    const comma = body.indexOf(',');
    if (comma === -1) continue;
    const key = body.slice(0, comma).trim();
    const fields = parseBibFields(body.slice(comma + 1));
    const item = {
      type: BIBTEX_TYPE_MAP[type] || 'misc',
      citeKey: key,
      title: delatex(fields.title),
      authors: (fields.author ? splitBibAuthors(fields.author) : []).map((a) => parseName(delatex(a))),
      journal: delatex(fields.journal || fields.booktitle || fields.journaltitle || ''),
      year: (String(fields.year || fields.date || '').match(/\d{4}/) || [''])[0],
      volume: delatex(fields.volume),
      issue: delatex(fields.number || fields.issue),
      pages: delatex(fields.pages),
      publisher: delatex(fields.publisher || fields.school || fields.institution || ''),
      doi: delatex(fields.doi),
      url: delatex(fields.url),
      abstract: delatex(fields.abstract),
      keywords: fields.keywords ? delatex(fields.keywords).split(/[,;]\s*/).filter(Boolean) : [],
    };
    if ((fields.archiveprefix || '').toLowerCase() === 'arxiv' && fields.eprint) {
      item.arxiv = delatex(fields.eprint);
      if (item.type === 'misc') item.type = 'preprint';
    }
    if (fields.file) item.file = fields.file;
    items.push(item);
  }
  return items;
}

function splitBibAuthors(s) {
  // Split on " and " at brace depth 0.
  const out = [];
  let depth = 0;
  let cur = '';
  const tokens = s.split(/(\s+and\s+|[{}])/i);
  for (const t of tokens) {
    if (t === '{') depth++;
    if (t === '}') depth--;
    if (depth === 0 && /^\s+and\s+$/i.test(t)) {
      out.push(cur);
      cur = '';
    } else cur += t;
  }
  if (cur.trim()) out.push(cur);
  return out.map((a) => a.trim()).filter(Boolean);
}

function parseBibFields(s) {
  const fields = {};
  let i = 0;
  while (i < s.length) {
    const m = /^[\s,]*([A-Za-z][\w-]*)\s*=\s*/.exec(s.slice(i));
    if (!m) break;
    const name = m[1].toLowerCase();
    i += m[0].length;
    let value = '';
    if (s[i] === '{') {
      let depth = 0;
      let j = i;
      for (; j < s.length; j++) {
        if (s[j] === '{') depth++;
        else if (s[j] === '}') { depth--; if (depth === 0) break; }
      }
      value = s.slice(i + 1, j);
      i = j + 1;
    } else if (s[i] === '"') {
      let j = i + 1;
      let depth = 0;
      for (; j < s.length; j++) {
        if (s[j] === '{') depth++;
        else if (s[j] === '}') depth--;
        else if (s[j] === '"' && depth === 0 && s[j - 1] !== '\\') break;
      }
      value = s.slice(i + 1, j);
      i = j + 1;
    } else {
      const m2 = /^[^,}\s]+/.exec(s.slice(i));
      value = m2 ? m2[0] : '';
      i += value.length;
    }
    fields[name] = value;
  }
  return fields;
}

const RIS_TYPE_MAP = Object.fromEntries(Object.entries(RIS_TYPES).map(([k, v]) => [v, k]));
Object.assign(RIS_TYPE_MAP, { JFULL: 'article', EJOUR: 'article', CPAPER: 'inproceedings', ECHAP: 'chapter', EBOOK: 'book' });

function parseRIS(text) {
  const items = [];
  let cur = null;
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^([A-Z][A-Z0-9])\s{2}-\s?(.*)$/.exec(line);
    if (!m) continue;
    const [, tag, raw] = m;
    const v = raw.trim();
    if (tag === 'TY') {
      cur = { type: RIS_TYPE_MAP[v] || 'misc', authors: [], keywords: [], title: '', journal: '' };
      continue;
    }
    if (!cur) continue;
    if (tag === 'ER') { items.push(cur); cur = null; continue; }
    switch (tag) {
      case 'AU': case 'A1': case 'A2': if (tag !== 'A2') cur.authors.push(parseName(v)); break;
      case 'TI': case 'T1': cur.title = v; break;
      case 'JO': case 'JF': case 'T2': case 'BT': if (!cur.journal) cur.journal = v; break;
      case 'PY': case 'Y1': case 'DA': if (!cur.year) cur.year = (v.match(/\d{4}/) || [''])[0]; break;
      case 'VL': cur.volume = v; break;
      case 'IS': cur.issue = v; break;
      case 'SP': cur.pages = v + (cur.pages && cur.pages.startsWith('–') ? cur.pages : ''); break;
      case 'EP': cur.pages = (cur.pages || '') + '–' + v; break;
      case 'PB': cur.publisher = v; break;
      case 'DO': cur.doi = v; break;
      case 'UR': if (!cur.url) cur.url = v; break;
      case 'AB': case 'N2': cur.abstract = v; break;
      case 'KW': cur.keywords.push(v); break;
      case 'N1': cur.notes = v; break;
    }
  }
  return items;
}

const api = {
  STYLES,
  parseName,
  normalizeAuthors,
  formatCitation,
  inTextCitation,
  citeKey,
  toBibTeX,
  toRIS,
  parseBibTeX,
  parseRIS,
  escapeHtml,
};

// Usable both as a CommonJS module (main process, tests) and as a plain
// <script> in the sandboxed renderer.
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else globalThis.Citations = api;
})();
