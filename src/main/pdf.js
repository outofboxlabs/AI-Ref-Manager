// PDF text extraction using pdf.js (runs in the main process, no worker).

const fs = require('fs');

let pdfjsPromise = null;
function loadPdfjs() {
  // pdfjs-dist ships ESM only; the legacy build works in plain Node.
  if (!pdfjsPromise) pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs');
  return pdfjsPromise;
}

/**
 * Extract text from a PDF file.
 * Returns {pages: string[], info: {Title, Author, ...}, numPages}.
 */
async function extractPdf(filePath, { maxPages = Infinity } = {}) {
  const pdfjs = await loadPdfjs();
  const data = new Uint8Array(fs.readFileSync(filePath));
  const doc = await pdfjs.getDocument({ data, isEvalSupported: false, useSystemFonts: false, verbosity: 0 }).promise;
  try {
    const pages = [];
    const n = Math.min(doc.numPages, maxPages);
    for (let p = 1; p <= n; p++) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      let text = '';
      let lastY = null;
      for (const it of content.items) {
        if (!('str' in it)) continue;
        const y = it.transform ? it.transform[5] : null;
        if (lastY !== null && y !== null && Math.abs(y - lastY) > 2) text += '\n';
        else if (text && !text.endsWith(' ') && !text.endsWith('\n')) text += ' ';
        text += it.str;
        if (it.hasEOL) text += '\n';
        lastY = y;
      }
      pages.push(text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim());
      page.cleanup();
    }
    let info = {};
    try {
      info = (await doc.getMetadata()).info || {};
    } catch {
      /* metadata is optional */
    }
    return { pages, info, numPages: doc.numPages };
  } finally {
    await doc.destroy();
  }
}

module.exports = { extractPdf };
