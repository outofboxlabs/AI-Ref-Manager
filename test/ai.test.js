const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const ai = require('../src/main/ai');
const { tmpDir } = require('./helpers');

test('Opus and Sonnet requests opt into server-side refusal fallbacks; Haiku does not', () => {
  assert.deepEqual(ai.baseParams('claude-opus-5-5'), { model: 'claude-opus-5-5', betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' });
  assert.deepEqual(ai.baseParams('claude-haiku-5-5'), { model: 'claude-haiku-5-5' });
});

test('papers are sent as PDF when possible, otherwise as text, never truncated', () => {
  const dir = tmpDir();
  const pdf = path.join(dir, 'a.pdf');
  fs.writeFileSync(pdf, '%PDF-1.4 tiny');
  assert.equal(ai.paperDocument({ pdfPath: pdf, numPages: 3 }).source.type, 'base64');
  assert.equal(ai.paperDocument({ pdfPath: pdf, numPages: 900, text: 'hello' }).source.type, 'text');
  assert.throws(() => ai.paperDocument({ text: 'x'.repeat(4_000_000) }), /too long/);
  assert.throws(() => ai.paperDocument({}), /Attach a PDF/);
});

test('library catalog numbers entries for [#n] citations', () => {
  const cat = ai.buildCatalog([{ title: 'A', authors: [{ given: 'X', family: 'Y' }], year: '2020' }, { title: 'B', summary: { summary: 'S', key_findings: ['k'] } }]);
  assert.match(cat, /^\[#1\] A\nAuthors: X Y\nPublished: 2020/);
  assert.match(cat, /\[#2\] B\nSummary: S\nKey findings: k/);
});

test('AI features explain a missing key', () => {
  assert.rejects(ai.summarize({ apiKey: '', model: 'claude-opus-5-5' }, {}), /API key/);
});
