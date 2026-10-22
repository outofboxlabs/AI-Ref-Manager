// Finding identifiers (DOI, arXiv id) in extracted PDF text, and mapping
// Crossref / arXiv API responses into library items.

const DOI_RE = /\b(10\.\d{4,9}\/[^\s"<>]+)/i;
const ARXIV_RE = /\barXiv:\s*(\d{4}\.\d{4,5})(v\d+)?/i;
const ARXIV_URL_RE = /arxiv\.org\/(?:abs|pdf)\/(\d{4}\.\d{4,5})(v\d+)?/i;

function cleanDoi(doi) {
  return String(doi || '')
    .replace(/^https?:\/\/(dx\.)?doi\.org\//i, '')
    .replace(/^doi:\s*/i, '')
    .replace(/[.,;:)\]}>]+$/, '')
    .trim();
}

function findDoi(text) {
  const m = DOI_RE.exec(String(text || ''));
  return m ? cleanDoi(m[1]) : '';
}

function findArxivId(text) {
  const s = String(text || '');
  const m = ARXIV_RE.exec(s) || ARXIV_URL_RE.exec(s);
  return m ? m[1] : '';
}

const CROSSREF_TYPES = {
  'journal-article': 'article',
  'proceedings-article': 'inproceedings',
  'book': 'book',
  'monograph': 'book',
  'edited-book': 'book',
  'book-chapter': 'chapter',
  'dissertation': 'thesis',
  'report': 'report',
  'posted-content': 'preprint',
};

function stripTags(s) {
  return String(s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Map a Crossref `message` object to item fields. */
function fromCrossref(msg) {
  if (!msg) return null;
  const date = msg.issued?.['date-parts']?.[0] || msg.published?.['date-parts']?.[0] || [];
  return {
    type: CROSSREF_TYPES[msg.type] || 'misc',
    title: stripTags((msg.title || [])[0] || ''),
    authors: (msg.author || []).map((a) => ({ given: a.given || '', family: a.family || a.name || '' })),
    year: date[0] ? String(date[0]) : '',
    journal: stripTags((msg['container-title'] || [])[0] || ''),
    volume: msg.volume || '',
    issue: msg.issue || '',
    pages: msg.page || '',
    publisher: msg.publisher || '',
    doi: cleanDoi(msg.DOI),
    url: msg.URL || '',
    abstract: stripTags(msg.abstract || '').replace(/^Abstract\s*/i, ''),
  };
}

/** Parse the Atom feed returned by export.arxiv.org/api/query. */
function fromArxivAtom(xml) {
  const entry = /<entry>([\s\S]*?)<\/entry>/.exec(String(xml || ''));
  if (!entry) return null;
  const e = entry[1];
  const tag = (name) => {
    const m = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`).exec(e);
    return m ? decodeXml(m[1]).replace(/\s+/g, ' ').trim() : '';
  };
  const authors = [...e.matchAll(/<author>\s*<name>([\s\S]*?)<\/name>/g)].map((m) => decodeXml(m[1]).trim());
  const id = tag('id');
  const doi = tag('arxiv:doi');
  return {
    type: doi ? 'article' : 'preprint',
    title: tag('title'),
    authors,
    year: tag('published').slice(0, 4),
    journal: tag('arxiv:journal_ref') || (doi ? '' : 'arXiv'),
    doi,
    url: id,
    arxiv: (id.match(/(\d{4}\.\d{4,5})/) || [''])[0],
    abstract: tag('summary'),
  };
}

function decodeXml(s) {
  return String(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Normalized token-overlap similarity for comparing titles (0..1). */
function titleSimilarity(a, b) {
  const tok = (s) => new Set(String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 2));
  const A = tok(a);
  const B = tok(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return (2 * inter) / (A.size + B.size);
}

module.exports = { findDoi, findArxivId, cleanDoi, fromCrossref, fromArxivAtom, titleSimilarity };
