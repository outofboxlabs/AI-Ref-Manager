const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { checkDocument, verifyWithInput, saveCorrectedDocx } = require('../src/main/checker');
const { readDocx } = require('../src/main/docx');
const { tmpDir, makeDocx, fakeLookup } = require('./helpers');

async function sample(dir) {
  return makeDocx([
    'Deep learning (LeCun et al., 2015; Krizhevsky et al., 2012). ResNets (He et al., 2016). Others (Smith, 2020).',
    { text: 'References', style: 'Heading1' },
    'He, K., Zhang, X., Ren, S., & Sun, J. (2016). Deep residual learning for image recognition. In Proceedings of the IEEE Conference on Computer Vision and Pattern Recognition (pp. 770–778).',
    'Krizhevsky, A., Sutskever, I., & Hinton, G. E. (2012). ImageNet classification with deep convolutional neural networks. Advances in Neural Information Processing Systems, 25, 1097–1105.',
    'LeCun, Y., Bengio, Y., & Hinton, G. (2014). Deep learning. Nature, 521(7553), 436–444. https://doi.org/10.1038/nature14539',
    'Jones, P. (2019). A hard to find report. Some Institute.',
  ], path.join(dir, 'paper.docx'));
}

test('verifies, corrects and flags references in a Word document', async () => {
  const dir = tmpDir();
  const r = await checkDocument(await sample(dir), { settings: { onlineLookup: true }, deps: { lookup: fakeLookup() } });
  const [he, kr, lecun, jones] = r.refs;

  assert.equal(he.status, 'corrected');
  assert.deepEqual(he.issues, ['DOI missing (10.1109/cvpr.2016.90)']);
  assert.equal(lecun.status, 'corrected');
  assert.deepEqual(lecun.issues, ['Year: written as 2014, published 2015']);
  assert.equal(lecun.source, 'Crossref (DOI)');
  // A later reprint is a "likely" match the user must confirm, never auto-applied.
  assert.equal(kr.status, 'likely');
  assert.equal(kr.apply, false);
  assert.equal(jones.status, 'notfound');

  assert.equal(r.counts.citations, 4);
  assert.match(r.citations.find((c) => c.firstAuthor === 'LeCun').problem, /Year mismatch/);
  assert.match(r.citations.find((c) => c.firstAuthor === 'Smith').problem, /Missing/);
  assert.deepEqual(r.uncited, [3]);
});

test('accepts a DOI or a publisher link from the user', async () => {
  const lookup = fakeLookup();
  const entry = { raw: 'He, K. (2016). Deep residual learning for image recognition. CVPR.', year: '2016', firstAuthor: 'He' };
  const byDoi = await verifyWithInput(entry, 'https://doi.org/10.1109/CVPR.2016.90', { deps: { lookup } });
  assert.equal(byDoi.status, 'confirmed');
  assert.equal(byDoi.corrected.doi, '10.1109/cvpr.2016.90');
  assert.equal(byDoi.note, '');

  const byPage = await verifyWithInput(entry, 'https://publisher.example/cvpr-paper', { deps: { lookup } });
  assert.equal(byPage.corrected.doi, '10.1109/cvpr.2016.90');

  const plain = await verifyWithInput({ raw: 'Jones, P. (2019). Report. Inst.', year: '2019', firstAuthor: 'Jones', title: 'Report' }, 'https://inst.example/report.pdf', { deps: { lookup } });
  assert.equal(plain.status, 'confirmed');
  assert.equal(plain.corrected.url, 'https://inst.example/report.pdf');

  const wrong = await verifyWithInput({ raw: 'Jones, P. (2019). An internal report. Inst.', year: '2019', firstAuthor: 'Jones' }, '10.1038/nature14539', { deps: { lookup } });
  assert.equal(wrong.status, 'likely');
  assert.equal(wrong.apply, false);
  assert.match(wrong.note, /different work/);

  await assert.rejects(verifyWithInput(entry, '10.9999/nope', { deps: { lookup } }), /404/);
});

test('saves a corrected copy with only the accepted references rewritten', async () => {
  const dir = tmpDir();
  const r = await checkDocument(await sample(dir), { settings: {}, deps: { lookup: fakeLookup() } });
  const out = path.join(dir, 'fixed.docx');
  const saved = await saveCorrectedDocx(r, 'apa', out);
  assert.equal(saved.replaced, 2);
  const texts = (await readDocx(out)).paragraphs.map((p) => p.text);
  assert.match(texts[2], /^He, K\., Zhang, X\., Ren, S\., & Sun, J\. \(2016\)\. Deep Residual Learning .* https:\/\/doi\.org\/10\.1109\/cvpr\.2016\.90$/);
  assert.match(texts[3], /\(2012\)/); // unconfirmed match left as written
  assert.match(texts[4], /^LeCun, Y\., Bengio, Y\., & Hinton, G\. \(2015\)\./);
  assert.equal(texts[5], 'Jones, P. (2019). A hard to find report. Some Institute.');
});

test('uses AI parsing when an API key is set and keeps year suffixes', async () => {
  const dir = tmpDir();
  const f = await makeDocx(['Text (Smith, 2020a).', 'References', 'Smith, J. (2020a). Something. J, 1.', 'Smith, J. (2020b). Other. J, 2.', 'Lee, K. (2019). Third. J, 3.'], path.join(dir, 'p.docx'));
  const parseReferences = async (_cfg, raws) => raws.map((raw, i) => ({ index: i, authors: [{ given: 'J', family: raw.split(',')[0] }], year: raw.match(/\d{4}/)[0], title: 'x', doi: '', url: '' }));
  const r = await checkDocument(f, { settings: { apiKey: 'k', model: 'm', onlineLookup: false }, deps: { ai: { parseReferences } } });
  assert.equal(r.refs[0].year, '2020a');
  assert.deepEqual(r.citations[0].matches, [0]);
  assert.equal(r.citations[0].problem, '');
});
