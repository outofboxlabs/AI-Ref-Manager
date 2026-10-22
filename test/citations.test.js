const test = require('node:test');
const assert = require('node:assert/strict');
const c = require('../src/shared/citations');

const article = {
  type: 'article',
  title: 'Deep learning',
  authors: [{ given: 'Yann', family: 'LeCun' }, { given: 'Yoshua', family: 'Bengio' }, { given: 'Geoffrey', family: 'Hinton' }],
  year: '2015', journal: 'Nature', volume: '521', issue: '7553', pages: '436-444', doi: '10.1038/nature14539',
};

test('APA formats authors, year, journal, volume(issue), pages and DOI', () => {
  assert.equal(
    c.formatCitation(article, 'apa'),
    'LeCun, Y., Bengio, Y., & Hinton, G. (2015). Deep learning. Nature, 521(7553), 436–444. https://doi.org/10.1038/nature14539',
  );
  assert.match(c.formatCitation(article, 'apa', { html: true }), /<i>Nature<\/i>, <i>521<\/i>\(7553\)/);
});

test('other styles render the key parts', () => {
  assert.equal(c.formatCitation(article, 'ieee'), 'Y. LeCun, Y. Bengio, and G. Hinton, “Deep learning,” Nature, vol. 521, no. 7553, pp. 436–444, 2015. doi: 10.1038/nature14539.');
  assert.match(c.formatCitation(article, 'mla'), /^LeCun, Yann, et al\. “Deep learning\.” Nature, vol\. 521, no\. 7553, 2015, pp\. 436–444\./);
  assert.match(c.formatCitation(article, 'vancouver'), /^LeCun Y, Bengio Y, Hinton G\. Deep learning\. Nature\. 2015;521\(7553\):436-444\./);
  assert.match(c.formatCitation(article, 'harvard'), /^LeCun, Y\., Bengio, Y\. and Hinton, G\. \(2015\) ‘Deep learning’, Nature, 521\(7553\), pp\. 436–444\./);
  assert.match(c.formatCitation(article, 'chicago'), /^LeCun, Yann, Yoshua Bengio, and Geoffrey Hinton\. 2015\. “Deep learning\.” Nature 521 \(7553\): 436–444\./);
});

test('HTML output escapes text', () => {
  const html = c.formatCitation({ ...article, title: 'A <b> & C' }, 'apa', { html: true });
  assert.ok(html.includes('A &lt;b&gt; &amp; C'));
});

test('parseName handles both orders and particles', () => {
  assert.deepEqual(c.parseName('Hinton, Geoffrey E.'), { given: 'Geoffrey E.', family: 'Hinton' });
  assert.deepEqual(c.parseName('Ludwig van Beethoven'), { given: 'Ludwig', family: 'van Beethoven' });
});

test('BibTeX export round-trips through the importer', () => {
  const bib = c.toBibTeX([article, { ...article, title: 'Deep learning again' }]);
  assert.match(bib, /@article\{lecun2015deep[a-z],/);
  const back = c.parseBibTeX(bib);
  assert.equal(back.length, 2);
  assert.equal(back[0].title, 'Deep learning');
  assert.deepEqual(back[0].authors[2], { given: 'Geoffrey', family: 'Hinton' });
  assert.equal(back[0].pages, '436–444');
  assert.equal(back[0].doi, '10.1038/nature14539');
});

test('BibTeX import handles LaTeX accents, quotes and Mendeley file fields', () => {
  const [it] = c.parseBibTeX(`@inproceedings{x, title = "{M}{\\"u}ller's {Method}", author = {M{\\"u}ller, J{\\"o}rg and van der Berg, A.}, booktitle={Proc. X}, year = 2020, file = {:home/a.pdf:pdf}}`);
  assert.equal(it.type, 'inproceedings');
  assert.equal(it.title, "Müller's Method");
  assert.deepEqual(it.authors[0], { given: 'Jörg', family: 'Müller' });
  assert.equal(it.authors[1].family, 'van der Berg');
  assert.equal(it.year, '2020');
  assert.equal(it.file, ':home/a.pdf:pdf');
});

test('RIS export and import', () => {
  const ris = c.toRIS([article]);
  assert.match(ris, /^TY {2}- JOUR/);
  assert.match(ris, /SP {2}- 436\r\nEP {2}- 444/);
  const [back] = c.parseRIS(ris);
  assert.equal(back.title, 'Deep learning');
  assert.equal(back.journal, 'Nature');
  assert.equal(back.pages, '436–444');
});

test('in-text citations', () => {
  assert.equal(c.inTextCitation(article, 'apa'), '(LeCun et al., 2015)');
  assert.equal(c.inTextCitation({ ...article, authors: article.authors.slice(0, 2) }, 'apa'), '(LeCun & Bengio, 2015)');
});
