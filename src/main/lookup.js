// Online metadata lookup: Crossref (DOIs, title search) and arXiv.

const { fromCrossref, fromArxivAtom, cleanDoi, titleSimilarity } = require('./identifiers');

const UA = 'RefMind/0.1 (desktop reference manager; https://github.com/outofboxlabs/ai-ref-manager)';

async function getJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} from ${new URL(url).host}`);
  return res.json();
}

async function lookupDoi(doi) {
  const d = cleanDoi(doi);
  if (!d) return null;
  const json = await getJson(`https://api.crossref.org/works/${encodeURIComponent(d)}`);
  return fromCrossref(json.message);
}

async function lookupArxiv(id) {
  const res = await fetch(`https://export.arxiv.org/api/query?id_list=${encodeURIComponent(id)}`, {
    headers: { 'User-Agent': UA },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`${res.status} from arXiv`);
  return fromArxivAtom(await res.text());
}

/**
 * Search Crossref by title (and optionally first author). Returns the best
 * match only if its title is close enough to be the same work.
 */
async function searchByTitle(title, author = '') {
  if (!title || title.length < 10) return null;
  const q = new URLSearchParams({ 'query.bibliographic': title, rows: '5' });
  if (author) q.set('query.author', author);
  const json = await getJson(`https://api.crossref.org/works?${q}`);
  let best = null;
  let bestScore = 0;
  for (const msg of json.message?.items || []) {
    const s = titleSimilarity(title, (msg.title || [])[0]);
    if (s > bestScore) { bestScore = s; best = msg; }
  }
  return bestScore >= 0.85 ? fromCrossref(best) : null;
}

module.exports = { lookupDoi, lookupArxiv, searchByTitle };
