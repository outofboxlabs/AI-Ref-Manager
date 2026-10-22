// Reading and patching .docx files (Office Open XML) without Word.
// We only need paragraph text, paragraph styles, Mendeley/Zotero citation
// fields, and the ability to rewrite whole paragraphs of the reference list.

const fs = require('fs');
const JSZip = require('jszip');

function decodeXml(s) {
  return String(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&');
}

function encodeXml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Locate top-level <w:p> elements in an XML part, handling nested paragraphs
 * (text boxes) by tracking depth. Returns [{start, end, xml}].
 */
function findParagraphs(xml) {
  const out = [];
  const re = /<w:p(?=[\s>/])[^>]*?(\/?)>|<\/w:p>/g;
  let depth = 0;
  let start = -1;
  let m;
  while ((m = re.exec(xml))) {
    if (m[0] === '</w:p>') {
      depth--;
      if (depth === 0 && start !== -1) {
        out.push({ start, end: m.index + m[0].length, xml: xml.slice(start, m.index + m[0].length) });
        start = -1;
      }
    } else if (m[1] === '/') {
      if (depth === 0) out.push({ start: m.index, end: m.index + m[0].length, xml: m[0] });
    } else {
      if (depth === 0) start = m.index;
      depth++;
    }
  }
  return out;
}

/** Visible text of a paragraph (field instructions and deleted text excluded). */
function paragraphText(pxml) {
  let text = '';
  // Drop tracked deletions, field instruction text and nested text boxes' duplicates.
  const cleaned = pxml.replace(/<w:del\b[\s\S]*?<\/w:del>/g, '').replace(/<w:instrText\b[\s\S]*?<\/w:instrText>/g, '');
  const re = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\/>|<w:br\/>|<w:noBreakHyphen\/>|<w:sym [^>]*w:char="([0-9A-F]+)"[^>]*\/>/g;
  let m;
  while ((m = re.exec(cleaned))) {
    if (m[0].startsWith('<w:tab')) text += '\t';
    else if (m[0].startsWith('<w:br')) text += '\n';
    else if (m[0].startsWith('<w:noBreakHyphen')) text += '-';
    else if (m[2]) text += String.fromCodePoint(parseInt(m[2], 16) > 0xf000 ? parseInt(m[2], 16) - 0xf000 : parseInt(m[2], 16));
    else text += decodeXml(m[1]);
  }
  return text;
}

function paragraphStyle(pxml) {
  const m = /<w:pStyle\s+w:val="([^"]+)"/.exec(pxml);
  return m ? m[1] : '';
}

/**
 * Citation-manager fields embedded in the document: Mendeley and Zotero both
 * store CSL-JSON in "ADDIN ... CSL_CITATION {json}" field codes.
 */
function extractCslCitations(xml) {
  const instr = [...xml.matchAll(/<w:instrText\b[^>]*>([\s\S]*?)<\/w:instrText>/g)].map((m) => decodeXml(m[1])).join('');
  const out = [];
  let i = 0;
  while ((i = instr.indexOf('CSL_CITATION', i)) !== -1) {
    const start = instr.indexOf('{', i);
    if (start === -1) break;
    // Walk to the matching brace (JSON strings may contain braces).
    let depth = 0;
    let inStr = false;
    let end = -1;
    for (let k = start; k < instr.length; k++) {
      const c = instr[k];
      if (inStr) {
        if (c === '\\') k++;
        else if (c === '"') inStr = false;
      } else if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) { end = k; break; } }
    }
    if (end === -1) break;
    try {
      const json = JSON.parse(instr.slice(start, end + 1));
      for (const ci of json.citationItems || []) if (ci.itemData) out.push(ci.itemData);
    } catch {
      /* ignore malformed field */
    }
    i = end;
  }
  return out;
}

/** Convert a CSL-JSON item (from Mendeley/Zotero fields) to our item shape. */
function fromCsl(d) {
  const types = { 'article-journal': 'article', 'paper-conference': 'inproceedings', book: 'book', chapter: 'chapter', thesis: 'thesis', report: 'report', 'article': 'preprint' };
  const year = d.issued?.['date-parts']?.[0]?.[0] || (String(d.issued?.raw || d.issued?.literal || '').match(/\d{4}/) || [''])[0];
  return {
    type: types[d.type] || 'misc',
    title: d.title || '',
    authors: (d.author || []).map((a) => ({ given: a.given || '', family: a.family || a.literal || '' })),
    year: year ? String(year) : '',
    journal: d['container-title'] || '',
    volume: d.volume ? String(d.volume) : '',
    issue: d.issue ? String(d.issue) : '',
    pages: d.page ? String(d.page) : '',
    publisher: d.publisher || '',
    doi: d.DOI || '',
    url: d.URL || '',
    abstract: d.abstract || '',
  };
}

/**
 * Read a .docx. Returns {paragraphs: [{text, style, part, start, end}], csl: [...], zip, parts}.
 * Footnotes and endnotes are appended after the main body, flagged with part.
 */
async function readDocx(filePath) {
  const buf = fs.readFileSync(filePath);
  let zip;
  try {
    zip = await JSZip.loadAsync(buf);
  } catch {
    throw new Error('This is not a valid .docx file. Old .doc files must be saved as .docx in Word first.');
  }
  const main = zip.file('word/document.xml');
  if (!main) throw new Error('No document body found in this .docx file.');
  const parts = { 'word/document.xml': await main.async('string') };
  for (const extra of ['word/footnotes.xml', 'word/endnotes.xml']) {
    const f = zip.file(extra);
    if (f) parts[extra] = await f.async('string');
  }
  const paragraphs = [];
  const csl = [];
  for (const [part, xml] of Object.entries(parts)) {
    for (const p of findParagraphs(xml)) {
      paragraphs.push({ text: paragraphText(p.xml), style: paragraphStyle(p.xml), part, start: p.start, end: p.end });
    }
    csl.push(...extractCslCitations(xml).map(fromCsl));
  }
  return { paragraphs, csl, zip, parts };
}

// ---------------------------------------------------------------------------
// Writing

/** First run's properties in a paragraph, minus italics/bold, as a base for new runs. */
function baseRunProps(pxml) {
  const m = /<w:r\b[^>]*>\s*(<w:rPr>[\s\S]*?<\/w:rPr>)/.exec(pxml);
  if (!m) return '';
  return m[1].replace(/<w:(i|iCs|b|bCs|u|highlight|color)\b[^>]*\/>/g, '').replace(/<w:rStyle\b[^>]*\/>/g, '');
}

/**
 * Turn simple HTML (text with <i>…</i>) into Word runs.
 */
function runsFromHtml(html, rPr) {
  const runs = [];
  const re = /<i>([\s\S]*?)<\/i>|([^<]+)/g;
  let m;
  const unesc = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  while ((m = re.exec(html))) {
    const italic = m[1] !== undefined;
    const text = unesc(italic ? m[1] : m[2]);
    if (!text) continue;
    const props = italic ? (rPr ? rPr.replace('</w:rPr>', '<w:i/><w:iCs/></w:rPr>') : '<w:rPr><w:i/><w:iCs/></w:rPr>') : rPr;
    runs.push(`<w:r>${props}<w:t xml:space="preserve">${encodeXml(text)}</w:t></w:r>`);
  }
  return runs.join('');
}

/** Replace a paragraph's content, keeping its paragraph properties (style, indent). */
function replaceParagraph(pxml, html) {
  const open = /^<w:p\b[^>]*>/.exec(pxml)[0];
  const pPr = (/<w:pPr>[\s\S]*?<\/w:pPr>/.exec(pxml) || [''])[0];
  return `${open}${pPr}${runsFromHtml(html, baseRunProps(pxml))}</w:p>`;
}

/**
 * Write a copy of the document with some paragraphs replaced.
 * replacements: [{paragraph: index into doc.paragraphs, html}]
 */
async function writePatched(doc, replacements, outPath) {
  const byPart = new Map();
  for (const r of replacements) {
    const p = doc.paragraphs[r.paragraph];
    if (!p) continue;
    if (!byPart.has(p.part)) byPart.set(p.part, []);
    byPart.get(p.part).push({ ...r, p });
  }
  for (const [part, list] of byPart) {
    let xml = doc.parts[part];
    // Apply from the end so earlier offsets stay valid.
    list.sort((a, b) => b.p.start - a.p.start);
    for (const { p, html } of list) {
      xml = xml.slice(0, p.start) + replaceParagraph(xml.slice(p.start, p.end), html) + xml.slice(p.end);
    }
    doc.zip.file(part, xml);
  }
  const buf = await doc.zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  fs.writeFileSync(outPath, buf);
  // Restore original parts so the same doc object can be written again.
  for (const part of byPart.keys()) doc.zip.file(part, doc.parts[part]);
  return outPath;
}

module.exports = { readDocx, writePatched, findParagraphs, paragraphText, extractCslCitations, fromCsl, runsFromHtml, replaceParagraph };
