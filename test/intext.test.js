const test = require('node:test');
const assert = require('node:assert/strict');
const t = require('../src/shared/intext');

const P = (arr) => arr.map((text) => ({ text }));

test('finds author–year citations in parenthetical and narrative forms', () => {
  const cites = t.extractCitations(P([
    'A (LeCun et al., 2015; Krizhevsky, Sutskever, & Hinton, 2012). Vaswani et al. (2017) and He (2016, p. 4). See (e.g., Smith & Jones, 2019a, 2020; Brown, n.d.).',
  ]));
  const got = cites.map((c) => `${c.firstAuthor} ${c.year}`).sort();
  assert.deepEqual(got, ['Brown n.d.', 'He 2016', 'Krizhevsky 2012', 'LeCun 2015', 'Smith 2019a', 'Smith 2020', 'Vaswani 2017']);
  assert.equal(cites.find((c) => c.firstAuthor === 'Smith').secondAuthor, 'Jones');
});

test('ignores parentheses that are not citations', () => {
  const cites = t.extractCitations(P(['In 2019 (the survey year) we saw growth (Table 2, 2019) and (see Figure 3). Data from (N = 2000).']));
  assert.equal(cites.length, 0);
});

test('expands numeric citations and ranges', () => {
  const [a, b] = t.extractCitations(P(['As shown [2], [4-6, 9].']));
  assert.deepEqual(a.numbers, [2]);
  assert.deepEqual(b.numbers, [4, 5, 6, 9]);
});

test('finds the reference list after its heading and stops at appendices', () => {
  const paras = [{ text: 'Body (Smith, 2020).' }, { text: 'References', style: 'Heading1' }, { text: 'Smith, J. (2020). Title. Journal, 1, 1-2.' }, { text: '' }, { text: 'Appendix A', style: 'Heading1' }, { text: 'Extra' }];
  assert.deepEqual(t.findBibliography(paras), { bodyEnd: 1, bibStart: 2, bibEnd: 4, heading: 1 });
});

test('finds an unheaded reference list from trailing reference-like paragraphs', () => {
  const paras = P(['Intro text.', 'Smith, J. (2020). One. J, 1.', 'Jones, K. (2019). Two. J, 2.', 'Lee, A. (2018). Three. J, 3.']);
  assert.equal(t.findBibliography(paras).bibStart, 1);
});

test('parses reference entries heuristically', () => {
  const e = t.parseEntryHeuristic('[3] LeCun, Y., Bengio, Y. (2015). Deep learning. Nature, 521, 436. https://doi.org/10.1038/nature14539.');
  assert.equal(e.number, 3);
  assert.equal(e.firstAuthor, 'LeCun');
  assert.equal(e.year, '2015');
  assert.equal(e.title, 'Deep learning');
  assert.equal(e.doi, '10.1038/nature14539');
});

test('cross-check reports missing, mismatched, misspelled, ambiguous and uncited references', () => {
  const entries = [
    { firstAuthor: 'LeCun', year: '2015' },
    { firstAuthor: 'Devlin', year: '2019' },
    { firstAuthor: 'Krizhevsky', year: '2012' },
    { firstAuthor: 'Smith', year: '2020', secondAuthor: 'Jones' },
    { firstAuthor: 'Smith', year: '2020', secondAuthor: 'Lee' },
    { firstAuthor: 'Unused', year: '2001' },
  ];
  const cites = t.extractCitations(P(['(LeCun et al., 2015; Devlin et al., 2018; Krizhevski et al., 2012; Nobody, 2010; Smith & Lee, 2020; Smith, 2020)']));
  const r = t.crossCheck(cites, entries);
  const by = (n) => r.citations.find((c) => c.firstAuthor === n && (n !== 'Smith' || c.secondAuthor === ''));
  assert.equal(by('LeCun').problem, '');
  assert.match(by('Devlin').problem, /Year mismatch/);
  assert.match(by('Krizhevski').problem, /did you mean “Krizhevsky”/);
  assert.match(by('Nobody').problem, /Missing/);
  assert.match(by('Smith').problem, /Ambiguous/);
  assert.deepEqual(r.citations.find((c) => c.secondAuthor === 'Lee').matches, [4]);
  assert.deepEqual(r.uncited, [5]);
});

test('numeric cross-check flags numbers with no entry', () => {
  const r = t.crossCheck(t.extractCitations(P(['See [1], [3].'])), [{ number: 1 }, { number: 2 }]);
  assert.equal(r.style, 'numeric');
  assert.match(r.citations[1].problem, /No reference numbered 3/);
  assert.deepEqual(r.uncited, [1]);
});
