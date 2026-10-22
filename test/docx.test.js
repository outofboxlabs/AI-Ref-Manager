const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const JSZip = require('jszip');
const { readDocx, writePatched, extractCslCitations } = require('../src/main/docx');
const { tmpDir, makeDocx } = require('./helpers');

test('reads paragraph text and styles, and rewrites paragraphs keeping the rest', async () => {
  const dir = tmpDir();
  const f = await makeDocx(['Hello (Smith, 2020).', { text: 'References', style: 'Heading1' }, { runs: [{ text: 'Smith, J. ' }, { text: 'old', italic: true }] }], path.join(dir, 'a.docx'));
  const doc = await readDocx(f);
  assert.deepEqual(doc.paragraphs.map((p) => p.text), ['Hello (Smith, 2020).', 'References', 'Smith, J. old']);
  assert.equal(doc.paragraphs[1].style, 'Heading1');

  const out = path.join(dir, 'b.docx');
  await writePatched(doc, [{ paragraph: 2, html: 'Smith, J. (2020). Title. <i>Journal &amp; Co</i>, 1.' }], out);
  const doc2 = await readDocx(out);
  assert.deepEqual(doc2.paragraphs.map((p) => p.text), ['Hello (Smith, 2020).', 'References', 'Smith, J. (2020). Title. Journal & Co, 1.']);
  const xml = await (await JSZip.loadAsync(fs.readFileSync(out))).file('word/document.xml').async('string');
  assert.match(xml, /<w:rFonts w:ascii="Times New Roman"\/><w:i\/><w:iCs\/><\/w:rPr><w:t xml:space="preserve">Journal &amp; Co<\/w:t>/);
  // The original file is untouched.
  assert.equal((await readDocx(f)).paragraphs[2].text, 'Smith, J. old');
});

test('rejects files that are not .docx', async () => {
  const f = path.join(tmpDir(), 'x.docx');
  fs.writeFileSync(f, 'not a zip');
  await assert.rejects(readDocx(f), /not a valid \.docx/);
});

test('extracts CSL-JSON from Mendeley/Zotero citation fields', () => {
  const json = JSON.stringify({ citationItems: [{ itemData: { title: 'A {braced} title', DOI: '10.1/x', author: [{ family: 'Smith', given: 'J' }], issued: { 'date-parts': [[2020]] } } }] });
  const xml = `<w:r><w:instrText>ADDIN CSL_CITATION ${json.slice(0, 30).replace(/&/g, '&amp;').replace(/"/g, '&quot;')}</w:instrText></w:r><w:r><w:instrText>${json.slice(30).replace(/"/g, '&quot;')}</w:instrText></w:r>`;
  const [item] = extractCslCitations(xml);
  assert.equal(item.title, 'A {braced} title');
  assert.equal(item.DOI, '10.1/x');
});
