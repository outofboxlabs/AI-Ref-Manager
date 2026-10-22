// Finding citations in manuscript text: in-text citations (author–year and
// numeric), the reference list, and cross-checking the two.
// Pure functions; used by the document checker and unit tests.

(function () {
  'use strict';

  const YEAR = String.raw`(?:1[5-9]\d{2}|20\d{2})[a-z]?`;
  const YEAR_RE = new RegExp(String.raw`\b(${YEAR})\b|\b(n\.\s?d\.)|\b(in press|forthcoming)\b`, 'gi');
  const NAME = String.raw`(?:(?:van|von|de|der|den|del|della|di|da|du|la|le|ter|ten|al|el|bin|ibn|dos|das)\s+){0,3}[A-ZÀ-ɏ][\p{L}'’\-]+`;
  const BIB_HEADING_RE = /^\s*(?:\d+(?:\.\d+)*\.?\s+|[IVX]+\.\s+)?(references?|reference list|bibliography|works cited|literature cited|literature|sources|cited literature|references and notes|referências|referencias|bibliografía|bibliographie|literaturverzeichnis|literatur)\s*:?\s*$/i;
  const STOP_HEADING_RE = /^\s*(?:\d+\.?\s+)?(appendix|appendices|supplementary|supporting information|tables?|figures?|figure legends|footnotes|author contributions|acknowledge?ments?|funding|conflicts? of interest|data availability)\b/i;
  const NOT_AUTHORS = new Set(['see', 'eg', 'e.g', 'cf', 'ie', 'i.e', 'also', 'and', 'in', 'table', 'figure', 'fig', 'section', 'chapter', 'page', 'pp', 'p', 'vol', 'no', 'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december', 'since', 'until', 'from', 'by', 'before', 'after', 'during', 'circa', 'ca', 'approx', 'n', 'study', 'studies', 'data', 'year', 'years', 'wave', 'cohort', 'survey', 'census']);

  /** Lowercase ASCII-folded surname for matching ("Müller-Lüdenscheidt" -> "mullerludenscheidt"). */
  function normName(s) {
    return String(s || '')
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/^(van|von|de|der|den|del|della|di|da|du|la|le|ter|ten)\s+/g, '')
      .replace(/[^a-z]/g, '');
  }

  function normYear(y) {
    const s = String(y || '').toLowerCase().replace(/\s/g, '');
    if (/^n\.?d\.?$/.test(s)) return 'n.d.';
    return s;
  }

  // ---------------------------------------------------------------------------
  // Reference-list detection

  /**
   * Split document paragraphs into body and reference list.
   * paragraphs: [{text, style}] -> {bodyEnd, bibStart, bibEnd, heading}
   * bibStart/bibEnd are paragraph indexes (end exclusive); -1 when not found.
   */
  function findBibliography(paragraphs) {
    let heading = -1;
    for (let i = paragraphs.length - 1; i >= 0; i--) {
      const t = paragraphs[i].text.trim();
      if (t.length < 40 && BIB_HEADING_RE.test(t)) { heading = i; break; }
    }
    if (heading !== -1) {
      let end = paragraphs.length;
      for (let i = heading + 1; i < paragraphs.length; i++) {
        const p = paragraphs[i];
        const t = p.text.trim();
        if (!t) continue;
        if (t.length < 60 && (STOP_HEADING_RE.test(t) || (/^heading/i.test(p.style || '') && !looksLikeReference(t)))) { end = i; break; }
      }
      return { bodyEnd: heading, bibStart: heading + 1, bibEnd: end, heading };
    }
    // No heading: take the trailing run of reference-looking paragraphs.
    let start = paragraphs.length;
    let blanks = 0;
    for (let i = paragraphs.length - 1; i >= 0; i--) {
      const t = paragraphs[i].text.trim();
      if (!t) { if (++blanks > 3) break; continue; }
      if (looksLikeReference(t)) { start = i; blanks = 0; } else break;
    }
    const count = paragraphs.slice(start).filter((p) => p.text.trim()).length;
    if (count >= 3) return { bodyEnd: start, bibStart: start, bibEnd: paragraphs.length, heading: -1 };
    return { bodyEnd: paragraphs.length, bibStart: -1, bibEnd: -1, heading: -1 };
  }

  function looksLikeReference(t) {
    if (t.length < 25 || t.length > 2000) return false;
    const hasYear = new RegExp(String.raw`\b${YEAR}\b|n\.\s?d\.`).test(t);
    const startsLikeRef = /^\s*(\[\d+\]|\d+[.)]\s)/.test(t) || new RegExp(String.raw`^\s*${NAME},?\s+(?:[A-Z]\.|[A-Z][a-z]+)`, 'u').test(t);
    return hasYear && startsLikeRef;
  }

  // ---------------------------------------------------------------------------
  // Parsing reference-list entries (heuristic; AI parsing refines this)

  function parseEntryHeuristic(raw) {
    let text = String(raw || '').replace(/\s+/g, ' ').trim();
    const out = { raw: text, number: null, firstAuthor: '', year: '', title: '', doi: '', url: '' };
    const num = /^\s*(?:\[(\d+)\]|(\d+)[.)])\s*/.exec(text);
    if (num) {
      out.number = Number(num[1] || num[2]);
      text = text.slice(num[0].length);
    }
    const doi = /\b(10\.\d{4,9}\/[^\s"<>]+)/i.exec(text);
    if (doi) out.doi = doi[1].replace(/[.,;)\]]+$/, '');
    const url = /https?:\/\/[^\s<>"]+/i.exec(text);
    if (url && !/doi\.org/i.test(url[0])) out.url = url[0].replace(/[.,;)\]]+$/, '');
    const y = new RegExp(String.raw`\((${YEAR}|n\.\s?d\.|in press)[^)]*\)|\b(${YEAR})\b`, 'i').exec(text);
    if (y) out.year = normYear(y[1] || y[2]);
    const fa = new RegExp(String.raw`^\s*(${NAME})`, 'u').exec(text);
    if (fa) out.firstAuthor = fa[1].trim();
    // Title: APA-like "Author (Year). Title. Journal" or IEEE-like ', "Title," '
    const quoted = /[“"]([^”"]{10,}?)[,.]?[”"]/.exec(text);
    if (quoted) out.title = quoted[1].trim();
    else if (y && y[0].startsWith('(')) {
      const after = text.slice(y.index + y[0].length).replace(/^[.,\s]+/, '');
      const m = /^(.{10,}?[^A-Z])[.?!](?:\s|$)/.exec(after);
      if (m) out.title = m[1].trim();
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // In-text citations

  function cleanAuthorText(s) {
    return String(s || '')
      .replace(/^[\s,;:]*(?:see also|see|e\.g\.,?|eg,?|cf\.,?|i\.e\.,?|for (?:a )?(?:review|example|instance)s?,?|as cited in|reviewed in|but see|also)\s+/i, '')
      .replace(/[\s,]+$/, '')
      .trim();
  }

  /** "Smith, Jones, & Lee" / "Smith et al." -> {first, second, etAl, count} */
  function splitCitedAuthors(s) {
    const t = cleanAuthorText(s);
    const etAl = /\bet\s+al\.?/i.test(t);
    const names = t.replace(/\bet\s+al\.?/i, '').split(/\s*(?:,|&|\band\b)\s*/).map((x) => x.trim()).filter(Boolean);
    return { first: names[0] || '', second: names[1] || '', etAl, count: names.length };
  }

  function isAuthorish(s) {
    const t = cleanAuthorText(s);
    if (!t || t.length > 120) return false;
    const first = t.split(/[\s,]+/)[0];
    if (!/^[A-ZÀ-ɏ]/u.test(first) && !/^(van|von|de|der|den|del|di|da|du|la|le)$/i.test(first)) return false;
    if (NOT_AUTHORS.has(first.toLowerCase().replace(/\.$/, ''))) return false;
    return /^[\p{L}'’.\-\s,&]+$/u.test(t.replace(/\bet al\.?/i, ''));
  }

  /**
   * Extract in-text citations from body paragraphs.
   * Returns [{kind:'author-year'|'numeric', text, paragraph, firstAuthor, secondAuthor, etAl, year, numbers, context}]
   */
  function extractCitations(paragraphs) {
    const out = [];
    paragraphs.forEach((p, pi) => {
      const text = p.text;
      if (!text || !text.trim()) return;
      const ctx = (i, len) => text.slice(Math.max(0, i - 60), Math.min(text.length, i + len + 60)).replace(/\s+/g, ' ').trim();
      const taken = [];
      const overlaps = (s, e) => taken.some(([a, b]) => s < b && e > a);

      // Numeric: [1], [1, 3], [2–5], [1-3, 7]
      for (const m of text.matchAll(/\[(\d{1,4}(?:\s*[-–—,]\s*\d{1,4})*)\]/g)) {
        const numbers = [];
        for (const part of m[1].split(',')) {
          const r = part.split(/[-–—]/).map((x) => parseInt(x, 10));
          if (r.length === 2 && r[1] >= r[0] && r[1] - r[0] < 200) for (let n = r[0]; n <= r[1]; n++) numbers.push(n);
          else if (!Number.isNaN(r[0])) numbers.push(r[0]);
        }
        out.push({ kind: 'numeric', text: m[0], paragraph: pi, numbers, context: ctx(m.index, m[0].length) });
        taken.push([m.index, m.index + m[0].length]);
      }

      // Narrative: Smith (2020), Smith and Jones (2019a, 2020), Smith et al. (2018)
      const narrative = new RegExp(
        String.raw`(${NAME}(?:\s+et\s+al\.?|\s*(?:,\s*${NAME})*,?\s+(?:and|&)\s+${NAME})?)(?:['’]s)?\s+\(((?:${YEAR}|n\.\s?d\.|in press)(?:\s*[,;]\s*(?:${YEAR}|n\.\s?d\.|in press))*)(?:,\s*(?:p|pp)\.\s*[\d\-–]+)?\)`,
        'gu',
      );
      for (const m of text.matchAll(narrative)) {
        if (!isAuthorish(m[1])) continue;
        const a = splitCitedAuthors(m[1]);
        for (const y of m[2].split(/[,;]/).map((s) => s.trim()).filter(Boolean)) {
          out.push({ kind: 'author-year', text: m[0], paragraph: pi, firstAuthor: a.first, secondAuthor: a.etAl ? '' : a.second, etAl: a.etAl, authorCount: a.count, year: normYear(y), context: ctx(m.index, m[0].length) });
        }
        taken.push([m.index, m.index + m[0].length]);
      }

      // Parenthetical: (Smith, 2020; Jones & Lee, 2019a, 2021; see Brown et al., 2018, p. 4)
      for (const m of text.matchAll(/\(([^()]{4,600})\)/g)) {
        if (overlaps(m.index, m.index + m[0].length)) continue;
        if (!new RegExp(String.raw`\b${YEAR}\b|n\.\s?d\.|in press`, 'i').test(m[1])) continue;
        let found = false;
        for (const part of m[1].split(';')) {
          YEAR_RE.lastIndex = 0;
          const first = YEAR_RE.exec(part);
          if (!first) continue;
          const authorText = part.slice(0, first.index);
          if (!isAuthorish(authorText)) continue;
          const a = splitCitedAuthors(authorText);
          // Every year after the authors belongs to them: "Smith, 2019, 2020a".
          const years = [...part.slice(first.index).replace(/,\s*(?:p|pp|para|ch|chap|sec)\.?\s*[\divxlc\-–]+.*$/i, '').matchAll(new RegExp(YEAR_RE.source, 'gi'))].map((y) => normYear(y[0]));
          for (const y of years) {
            out.push({ kind: 'author-year', text: m[0], paragraph: pi, firstAuthor: a.first, secondAuthor: a.etAl ? '' : a.second, etAl: a.etAl, authorCount: a.count, year: y, context: ctx(m.index, m[0].length) });
            found = true;
          }
        }
        if (found) taken.push([m.index, m.index + m[0].length]);
      }
    });
    return out;
  }

  /** "numeric" or "author-year", by which kind of citation dominates. */
  function citationStyle(cites) {
    const n = cites.filter((c) => c.kind === 'numeric').length;
    return n > cites.length - n ? 'numeric' : 'author-year';
  }

  // ---------------------------------------------------------------------------
  // Cross-checking

  function editDistance(a, b) {
    if (a === b) return 0;
    const dp = Array.from({ length: a.length + 1 }, (_, i) => [i]);
    for (let j = 1; j <= b.length; j++) dp[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
      for (let j = 1; j <= b.length; j++) {
        dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
    }
    return dp[a.length][b.length];
  }

  /**
   * Match citations to reference entries.
   * entries: [{firstAuthor, year, number, ...}] (index = position in list)
   * Returns {citations: [...with matches:[entryIndex], problem], uncited: [entryIndex]}
   */
  function crossCheck(cites, entries) {
    const style = citationStyle(cites);
    const used = new Set();
    const byNumber = new Map();
    entries.forEach((e, i) => byNumber.set(e.number || i + 1, i));

    const results = cites.map((c) => {
      if (c.kind === 'numeric') {
        const matches = [];
        const missing = [];
        for (const n of c.numbers) {
          if (byNumber.has(n)) { matches.push(byNumber.get(n)); used.add(byNumber.get(n)); } else missing.push(n);
        }
        return { ...c, matches, problem: missing.length ? `No reference numbered ${missing.join(', ')} in the reference list` : '' };
      }
      const fa = normName(c.firstAuthor);
      const y = normYear(c.year);
      const yBase = y.replace(/[a-z]$/, '');
      const exact = [];
      const sameAuthor = [];
      const similar = [];
      entries.forEach((e, i) => {
        const ea = normName(e.firstAuthor);
        const ey = normYear(e.year);
        if (!ea) return;
        const nameOk = ea === fa || (fa.length > 3 && (ea.startsWith(fa) || fa.startsWith(ea)));
        // "2020" matches "2020a" and vice versa (suffix added on one side only).
        const eBase = ey.replace(/[a-z]$/, '');
        const yearOk = ey === y || (eBase === yBase && (ey === eBase || y === yBase));
        if (nameOk && yearOk) exact.push(i);
        else if (nameOk) sameAuthor.push(i);
        else if (ey === y && fa.length > 3 && editDistance(ea, fa) <= Math.max(1, Math.floor(fa.length / 5))) similar.push(i);
      });
      let matches = exact;
      let problem = '';
      if (exact.length > 1 && c.secondAuthor) {
        // Disambiguate "Smith & Jones, 2020" vs "Smith & Lee, 2020".
        const narrowed = exact.filter((i) => normName(entries[i].secondAuthor || '') === normName(c.secondAuthor));
        if (narrowed.length) matches = narrowed;
      }
      if (matches.length > 1) {
        problem = `Ambiguous: ${matches.length} references by ${c.firstAuthor} in ${c.year} — add a/b suffixes to the years`;
      } else if (!matches.length) {
        if (sameAuthor.length) {
          const ys = [...new Set(sameAuthor.map((i) => entries[i].year))].join(', ');
          problem = `Year mismatch: cited as ${c.year}, but the reference list has ${c.firstAuthor} ${ys}`;
          matches = sameAuthor.length === 1 ? sameAuthor : [];
        } else if (similar.length) {
          problem = `Spelling: “${c.firstAuthor}” not in the reference list — did you mean “${entries[similar[0]].firstAuthor}”?`;
          matches = [similar[0]];
        } else {
          problem = 'Missing from the reference list';
        }
      }
      matches.forEach((i) => used.add(i));
      return { ...c, matches, problem };
    });

    const uncited = entries.map((_, i) => i).filter((i) => !used.has(i));
    return { style, citations: results, uncited };
  }

  const api = { findBibliography, looksLikeReference, parseEntryHeuristic, extractCitations, citationStyle, crossCheck, normName, normYear, editDistance };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else globalThis.InText = api;
})();
