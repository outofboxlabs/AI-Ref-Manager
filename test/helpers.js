// Test helpers: build small .docx files and fake lookup services.

const fs = require('fs');
const os = require('os');
const path = require('path');
const JSZip = require('jszip');

function tmpDir(prefix = 'refmind-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** paragraphs: string | {text, style, runs: [{text, italic}]} */
async function makeDocx(paragraphs, file) {
  const body = paragraphs
    .map((p) => {
      const o = typeof p === 'string' ? { text: p } : p;
      const pPr = o.style ? `<w:pPr><w:pStyle w:val="${o.style}"/></w:pPr>` : '';
      const runs = (o.runs || [{ text: o.text }])
        .map((r) => `<w:r><w:rPr><w:rFonts w:ascii="Times New Roman"/>${r.italic ? '<w:i/>' : ''}</w:rPr><w:t xml:space="preserve">${esc(r.text)}</w:t></w:r>`)
        .join('');
      return `<w:p>${pPr}${runs}</w:p>`;
    })
    .join('');
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr/></w:body></w:document>`);
  fs.writeFileSync(file, await zip.generateAsync({ type: 'nodebuffer' }));
  return file;
}

const RECORDS = {
  '10.1038/nature14539': {
    type: 'article', title: 'Deep learning', authors: [{ given: 'Yann', family: 'LeCun' }, { given: 'Yoshua', family: 'Bengio' }, { given: 'Geoffrey', family: 'Hinton' }],
    year: '2015', journal: 'Nature', volume: '521', issue: '7553', pages: '436-444', publisher: 'Springer Science and Business Media LLC', doi: '10.1038/nature14539', url: '',
  },
  '10.1109/cvpr.2016.90': {
    type: 'inproceedings', title: 'Deep Residual Learning for Image Recognition', authors: [{ given: 'Kaiming', family: 'He' }, { given: 'Xiangyu', family: 'Zhang' }, { given: 'Shaoqing', family: 'Ren' }, { given: 'Jian', family: 'Sun' }],
    year: '2016', journal: '2016 IEEE Conference on Computer Vision and Pattern Recognition (CVPR)', volume: '', issue: '', pages: '770-778', publisher: 'IEEE', doi: '10.1109/cvpr.2016.90', url: '',
  },
  '10.1145/3065386': {
    type: 'article', title: 'ImageNet classification with deep convolutional neural networks', authors: [{ given: 'Alex', family: 'Krizhevsky' }, { given: 'Ilya', family: 'Sutskever' }, { given: 'Geoffrey E.', family: 'Hinton' }],
    year: '2017', journal: 'Communications of the ACM', volume: '60', issue: '6', pages: '84-90', publisher: 'ACM', doi: '10.1145/3065386', url: '',
  },
};

/** Fake Crossref: DOI lookups from RECORDS; search returns records whose title words appear in the query. */
function fakeLookup() {
  const calls = [];
  return {
    calls,
    lookupDoi: async (doi) => {
      calls.push(['doi', doi]);
      const r = RECORDS[doi.toLowerCase()];
      if (!r) throw new Error('404 Not Found from api.crossref.org');
      return { ...r };
    },
    lookupArxiv: async () => null,
    searchBibliographic: async (raw) => {
      calls.push(['search', raw]);
      const q = raw.toLowerCase();
      return Object.values(RECORDS).filter((r) => r.title.toLowerCase().split(' ').filter((w) => w.length > 3).every((w) => q.includes(w))).map((r) => ({ ...r }));
    },
    doiFromPage: async (url) => (url.includes('cvpr') ? '10.1109/cvpr.2016.90' : ''),
    searchByTitle: async () => null,
  };
}

module.exports = { tmpDir, makeDocx, fakeLookup, RECORDS };

/** Write a minimal one-page PDF containing the given text lines. */
function makePdf(lines, file) {
  const content = ['BT', '/F1 11 Tf', '50 760 Td', '14 TL']
    .concat(lines.map((l) => `(${l.replace(/[()\\]/g, (c) => '\\' + c)}) Tj T*`))
    .concat(['ET'])
    .join('\n');
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  fs.writeFileSync(file, pdf);
  return file;
}

module.exports.makePdf = makePdf;
