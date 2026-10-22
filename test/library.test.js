const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { Library } = require('../src/main/store');
const { importPdf, resolveMetadata } = require('../src/main/importer');
const { extractPdf } = require('../src/main/pdf');
const { fromCrossref, fromArxivAtom, findDoi } = require('../src/main/identifiers');
const { tmpDir, makePdf, fakeLookup } = require('./helpers');

test('library add/update/search/collections persist to disk', () => {
  const dir = tmpDir();
  const lib = new Library(dir);
  const a = lib.add({ title: 'Deep learning', authors: [{ given: 'Yann', family: 'LeCun' }], year: '2015', tags: ['review'] });
  lib.add({ title: 'Attention is all you need', authors: [{ given: 'Ashish', family: 'Vaswani' }], year: '2017' });
  lib.setText(a.id, 'convolutional networks backpropagation');
  const col = lib.addCollection('Thesis');
  lib.update(a.id, { collections: [col.id], notes: 'important' });

  const again = new Library(dir);
  assert.equal(again.list().length, 2);
  assert.deepEqual(again.search('lecun').map((h) => h.id), [a.id]);
  assert.deepEqual(again.search('backpropagation').map((h) => h.id), [a.id]);
  assert.equal(again.search('lecun attention').length, 0);
  assert.deepEqual(again.allTags(), [{ name: 'review', count: 1 }]);
  again.removeCollection(col.id);
  assert.deepEqual(again.get(a.id).collections, []);
});

test('extracts text from a PDF', async () => {
  const f = makePdf(['A Study of Things', 'Jane Doe', 'doi:10.1038/nature14539'], path.join(tmpDir(), 'p.pdf'));
  const { pages, numPages } = await extractPdf(f);
  assert.equal(numPages, 1);
  assert.match(pages[0], /A Study of Things/);
  assert.equal(findDoi(pages[0]), '10.1038/nature14539');
});

test('importing a PDF with a DOI fills metadata from Crossref and detects duplicates', async () => {
  const dir = tmpDir();
  const lib = new Library(path.join(dir, 'lib'));
  const f = makePdf(['Deep learning', 'https://doi.org/10.1038/nature14539'], path.join(dir, 'paper.pdf'));
  const deps = { lookup: fakeLookup() };
  const r = await importPdf(lib, f, { settings: { onlineLookup: true }, deps });
  assert.equal(r.source, 'crossref');
  assert.equal(r.item.title, 'Deep learning');
  assert.equal(r.item.journal, 'Nature');
  assert.ok(r.item.file);
  const dup = await importPdf(lib, f, { settings: { onlineLookup: true }, deps });
  assert.equal(dup.duplicate, true);
  assert.equal(lib.list().length, 1);
});

test('falls back to AI extraction when no identifier is found', async () => {
  const extractMetadata = async () => ({ title: 'A Paper Without DOI', authors: [{ given: 'A', family: 'B' }], year: '2021', journal: '', doi: '' });
  const r = await resolveMetadata('A Paper Without DOI\nA. B.\n2021', { settings: { apiKey: 'k', model: 'm', onlineLookup: false }, deps: { ai: { extractMetadata } } });
  assert.equal(r.source, 'ai');
  assert.equal(r.fields.title, 'A Paper Without DOI');
});

test('maps Crossref and arXiv responses', () => {
  const it = fromCrossref({ type: 'journal-article', title: ['T <i>x</i>'], author: [{ given: 'A', family: 'B' }], issued: { 'date-parts': [[2020, 1]] }, 'container-title': ['J'], DOI: '10.1/X', abstract: '<jats:p>Abstract Hello</jats:p>' });
  assert.equal(it.title, 'T x');
  assert.equal(it.year, '2020');
  assert.equal(it.abstract, 'Hello');
  const ax = fromArxivAtom('<feed><entry><id>http://arxiv.org/abs/1706.03762v7</id><published>2017-06-12</published><title>Attention Is All\n You Need</title><summary>S</summary><author><name>Ashish Vaswani</name></author></entry></feed>');
  assert.equal(ax.title, 'Attention Is All You Need');
  assert.equal(ax.arxiv, '1706.03762');
  assert.equal(ax.type, 'preprint');
});
