// Claude-powered features: metadata extraction, paper summaries, chat with a
// paper, and questions across the whole library.

const fs = require('fs');
const Anthropic = require('@anthropic-ai/sdk');

const MODELS = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5 (best quality)' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 (faster, cheaper)' },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5 (fastest, cheapest)' },
];
const DEFAULT_MODEL = 'claude-opus-5-5';

// Request-size limits for sending a PDF directly.
const MAX_PDF_BYTES = 30 * 1024 * 1024;
const MAX_PDF_PAGES = 600;
// ~4 chars/token; stay well inside the 1M-token context window.
const MAX_TEXT_CHARS = 3_200_000;

class AIError extends Error {}

function makeClient(apiKey) {
  if (!apiKey) throw new AIError('Add your Anthropic API key in Settings to use AI features.');
  return new Anthropic({ apiKey });
}

/**
 * Common request options. Opus and Sonnet opt into server-side refusal
 * fallbacks so a classifier decline is retried on Anthropic's recommended
 * model instead of failing; Haiku has no server-side fallback.
 */
function baseParams(model) {
  const p = { model };
  if (!model.startsWith('claude-haiku')) {
    p.betas = ['server-side-fallback-2026-07-01'];
    p.fallbacks = 'default';
  }
  return p;
}

function textOf(message) {
  if (message.stop_reason === 'refusal') {
    throw new AIError('Claude declined this request. Try rephrasing, or pick a different model in Settings.');
  }
  return message.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
}

function friendlyError(err) {
  if (err instanceof AIError) return err;
  if (err instanceof Anthropic.AuthenticationError) return new AIError('Your Anthropic API key was rejected. Check it in Settings.');
  if (err instanceof Anthropic.PermissionDeniedError) return new AIError('Your API key does not have access to this model.');
  if (err instanceof Anthropic.NotFoundError) return new AIError('Model not found. Pick another model in Settings.');
  if (err instanceof Anthropic.RateLimitError) return new AIError('Rate limited by the Anthropic API. Wait a moment and try again.');
  if (err instanceof Anthropic.BadRequestError) return new AIError(`The API rejected the request: ${err.message}`);
  if (err instanceof Anthropic.APIConnectionError) return new AIError('Could not reach the Anthropic API. Check your internet connection.');
  if (err instanceof Anthropic.APIError) return new AIError(`Anthropic API error (${err.status}): ${err.message}`);
  return err;
}

async function run(client, params, onText) {
  try {
    const stream = client.beta.messages.stream(params);
    if (onText) stream.on('text', (delta) => onText(delta));
    return await stream.finalMessage();
  } catch (err) {
    throw friendlyError(err);
  }
}

async function runJson(client, params) {
  const msg = await run(client, params);
  const text = textOf(msg);
  try {
    return JSON.parse(text);
  } catch {
    throw new AIError(msg.stop_reason === 'max_tokens' ? 'The AI response was cut off. Try again.' : 'The AI returned malformed data. Try again.');
  }
}

// ---------------------------------------------------------------------------
// Paper content as a document block

/**
 * Build the document block for a paper: the PDF itself when it fits the API
 * limits (Claude then sees figures and tables too), otherwise its extracted
 * text. Throws rather than silently truncating.
 */
function paperDocument({ pdfPath, numPages, text, title }) {
  if (pdfPath && fs.existsSync(pdfPath)) {
    const size = fs.statSync(pdfPath).size;
    if (size <= MAX_PDF_BYTES && (!numPages || numPages <= MAX_PDF_PAGES)) {
      return {
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: fs.readFileSync(pdfPath).toString('base64') },
        title: title || undefined,
        cache_control: { type: 'ephemeral' },
      };
    }
  }
  if (!text || !text.trim()) {
    throw new AIError('This item has no PDF or extracted text to work from. Attach a PDF first.');
  }
  if (text.length > MAX_TEXT_CHARS) {
    throw new AIError('This document is too long to send to the AI in one piece.');
  }
  return {
    type: 'document',
    source: { type: 'text', media_type: 'text/plain', data: text },
    title: title || undefined,
    cache_control: { type: 'ephemeral' },
  };
}

// ---------------------------------------------------------------------------
// Metadata extraction

const METADATA_SCHEMA = {
  type: 'object',
  properties: {
    type: { type: 'string', enum: ['article', 'preprint', 'inproceedings', 'book', 'chapter', 'thesis', 'report', 'misc'] },
    title: { type: 'string' },
    authors: {
      type: 'array',
      items: {
        type: 'object',
        properties: { given: { type: 'string' }, family: { type: 'string' } },
        required: ['given', 'family'],
        additionalProperties: false,
      },
    },
    year: { type: 'string', description: 'Four-digit publication year, or empty' },
    journal: { type: 'string', description: 'Journal, conference or container title, or empty' },
    volume: { type: 'string' },
    issue: { type: 'string' },
    pages: { type: 'string' },
    publisher: { type: 'string' },
    doi: { type: 'string', description: 'DOI without https://doi.org/ prefix, or empty' },
    abstract: { type: 'string' },
    keywords: { type: 'array', items: { type: 'string' } },
  },
  required: ['type', 'title', 'authors', 'year', 'journal', 'volume', 'issue', 'pages', 'publisher', 'doi', 'abstract', 'keywords'],
  additionalProperties: false,
};

const METADATA_SYSTEM = `You extract bibliographic metadata from the opening pages of academic documents.
Return only what the text supports. Leave a field empty ("" or []) rather than guessing.
Copy the title and abstract verbatim, fixing only broken hyphenation and line breaks.
List authors in order; split each name into given and family names.
Do not include affiliations, emails or footnote markers in names.`;

async function extractMetadata({ apiKey, model }, text) {
  const client = makeClient(apiKey);
  return runJson(client, {
    ...baseParams(model),
    max_tokens: 4000,
    output_config: { effort: 'low', format: { type: 'json_schema', schema: METADATA_SCHEMA } },
    system: METADATA_SYSTEM,
    messages: [
      {
        role: 'user',
        content: `Extract the metadata from this document's opening pages:\n\n<document>\n${text.slice(0, 20000)}\n</document>`,
      },
    ],
  });
}

// ---------------------------------------------------------------------------
// Summaries

const SUMMARY_SCHEMA = {
  type: 'object',
  properties: {
    tldr: { type: 'string', description: 'One sentence, under 35 words' },
    summary: { type: 'string', description: 'One or two paragraphs' },
    research_question: { type: 'string' },
    methods: { type: 'string' },
    key_findings: { type: 'array', items: { type: 'string' } },
    limitations: { type: 'array', items: { type: 'string' } },
    keywords: { type: 'array', items: { type: 'string' }, description: '3 to 8 short topical tags, lowercase' },
  },
  required: ['tldr', 'summary', 'research_question', 'methods', 'key_findings', 'limitations', 'keywords'],
  additionalProperties: false,
};

const SUMMARY_SYSTEM = `You are a research assistant writing reading notes for a researcher's reference library.
Write for an expert reader in plain, precise language. Report what the paper claims and shows;
do not add outside facts. Include concrete numbers (effect sizes, accuracies, sample sizes) when the paper reports them.
For limitations, include both those the authors state and clear methodological ones a careful reviewer would note.`;

async function summarize({ apiKey, model }, paper) {
  const client = makeClient(apiKey);
  return runJson(client, {
    ...baseParams(model),
    max_tokens: 16000,
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: SUMMARY_SCHEMA } },
    system: SUMMARY_SYSTEM,
    messages: [
      {
        role: 'user',
        content: [paperDocument(paper), { type: 'text', text: 'Write reading notes for this paper.' }],
      },
    ],
  });
}

// ---------------------------------------------------------------------------
// Chat with one paper

const CHAT_SYSTEM = `You are a research assistant helping a researcher understand a paper in their library.
Answer from the paper. When you rely on a specific passage, mention the section or page.
If the paper does not answer the question, say so, and clearly label anything you add from general knowledge.
Use Markdown for structure when it helps; keep answers focused.`;

/** history: [{role: 'user'|'assistant', content: string}], ending with the new user question. */
async function chatWithPaper({ apiKey, model }, paper, history, onText) {
  const client = makeClient(apiKey);
  const messages = history.map((m, i) =>
    i === 0
      ? { role: 'user', content: [paperDocument(paper), { type: 'text', text: m.content }] }
      : { role: m.role, content: m.content },
  );
  const msg = await run(
    client,
    {
      ...baseParams(model),
      max_tokens: 32000,
      output_config: { effort: 'medium' },
      cache_control: { type: 'ephemeral' },
      system: CHAT_SYSTEM,
      messages,
    },
    onText,
  );
  return textOf(msg);
}

// ---------------------------------------------------------------------------
// Ask the whole library

const LIBRARY_SYSTEM = `You are a research assistant with access to the catalog of a researcher's reference library.
Each entry starts with a reference number like [#12]. Answer the question using the library.
Cite entries inline with their reference number exactly in the form [#12]. Only cite entries in the catalog.
When the catalog lacks the information needed, say what is missing (for example, papers without summaries)
and suggest what to read or add. Use Markdown for structure when it helps.`;

function buildCatalog(items) {
  return items
    .map((it, i) => {
      const authors = (it.authors || []).map((a) => [a.given, a.family].filter(Boolean).join(' ')).join(', ');
      const lines = [`[#${i + 1}] ${it.title || 'Untitled'}`];
      if (authors) lines.push(`Authors: ${authors}`);
      const pub = [it.journal, it.year].filter(Boolean).join(', ');
      if (pub) lines.push(`Published: ${pub}`);
      if (it.tags?.length) lines.push(`Tags: ${it.tags.join(', ')}`);
      if (it.summary) {
        lines.push(`Summary: ${it.summary.summary}`);
        if (it.summary.key_findings?.length) lines.push(`Key findings: ${it.summary.key_findings.join(' | ')}`);
      } else if (it.abstract) {
        lines.push(`Abstract: ${it.abstract}`);
      }
      if (it.notes) lines.push(`Researcher's notes: ${it.notes}`);
      return lines.join('\n');
    })
    .join('\n\n');
}

async function askLibrary({ apiKey, model }, items, history, onText) {
  const client = makeClient(apiKey);
  if (!items.length) throw new AIError('Your library is empty. Add some papers first.');
  const catalog = buildCatalog(items);
  if (catalog.length > MAX_TEXT_CHARS) throw new AIError('The library catalog is too large to send in one request.');
  const messages = history.map((m, i) =>
    i === 0
      ? {
          role: 'user',
          content: [
            { type: 'text', text: `<library_catalog>\n${catalog}\n</library_catalog>`, cache_control: { type: 'ephemeral' } },
            { type: 'text', text: m.content },
          ],
        }
      : { role: m.role, content: m.content },
  );
  const msg = await run(
    client,
    {
      ...baseParams(model),
      max_tokens: 32000,
      output_config: { effort: 'medium' },
      cache_control: { type: 'ephemeral' },
      system: LIBRARY_SYSTEM,
      messages,
    },
    onText,
  );
  return textOf(msg);
}

async function testKey({ apiKey, model }) {
  const client = makeClient(apiKey);
  const msg = await run(client, {
    ...baseParams(model),
    max_tokens: 1000,
    output_config: { effort: 'low' },
    messages: [{ role: 'user', content: 'Reply with just: OK' }],
  });
  return textOf(msg).trim();
}

module.exports = {
  MODELS,
  DEFAULT_MODEL,
  AIError,
  baseParams,
  paperDocument,
  buildCatalog,
  extractMetadata,
  summarize,
  chatWithPaper,
  askLibrary,
  testKey,
};
