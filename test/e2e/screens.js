// Drives the real app through its main screens and saves screenshots.
// Usage: electron test/e2e/screens.js <outDir>   (lookups are faked; no network needed)

const path = require('path');
const fs = require('fs');
const { app, dialog, BrowserWindow } = require('electron');
const { tmpDir, makeDocx, fakeLookup } = require('../helpers');

const outDir = path.resolve(process.argv[process.argv.length - 1]);
fs.mkdirSync(outDir, { recursive: true });
const dataDir = tmpDir('refmind-e2e-');
process.env.REFMIND_DATA_DIR = dataDir;

// Seed a small library.
const { Library } = require('../../src/main/store');
const lib = new Library(dataDir);
const col = lib.addCollection('Thesis — Chapter 2');
lib.addCollection('Deep learning');
const seed = [
  { title: 'Attention Is All You Need', authors: [{ given: 'Ashish', family: 'Vaswani' }, { given: 'Noam', family: 'Shazeer' }, { given: 'Niki', family: 'Parmar' }, { given: 'Jakob', family: 'Uszkoreit' }], year: '2017', journal: 'Advances in Neural Information Processing Systems', volume: '30', type: 'inproceedings', tags: ['transformers', 'nlp'], collections: [col.id], read: true, favorite: true,
    abstract: 'The dominant sequence transduction models are based on complex recurrent or convolutional neural networks. We propose a new simple network architecture, the Transformer, based solely on attention mechanisms.',
    summary: { tldr: 'Introduces the Transformer, a sequence model built only from attention that beats recurrent models on translation while training far faster.', summary: 'The paper replaces recurrence and convolution with multi-head self-attention, positional encodings and feed-forward layers. On WMT 2014 English–German and English–French translation it sets new state-of-the-art BLEU scores at a fraction of the training cost.', research_question: 'Can a model based solely on attention match or beat recurrent and convolutional sequence models?', methods: 'Encoder–decoder with stacked multi-head self-attention; trained on WMT 2014 EN–DE (4.5M pairs) and EN–FR (36M pairs) on 8 P100 GPUs.', key_findings: ['28.4 BLEU on EN–DE, +2 over previous best including ensembles', '41.8 BLEU on EN–FR after 3.5 days of training', 'Generalizes to English constituency parsing'], limitations: ['Quadratic cost in sequence length', 'Evaluated mainly on translation'], keywords: ['transformers', 'attention', 'machine translation', 'nlp'], model: 'claude-opus-5-5', createdAt: new Date().toISOString() } },
  { title: 'Deep learning', authors: [{ given: 'Yann', family: 'LeCun' }, { given: 'Yoshua', family: 'Bengio' }, { given: 'Geoffrey', family: 'Hinton' }], year: '2015', journal: 'Nature', volume: '521', issue: '7553', pages: '436–444', doi: '10.1038/nature14539', tags: ['review'], read: false },
  { title: 'Deep Residual Learning for Image Recognition', authors: [{ given: 'Kaiming', family: 'He' }, { given: 'Xiangyu', family: 'Zhang' }, { given: 'Shaoqing', family: 'Ren' }, { given: 'Jian', family: 'Sun' }], year: '2016', journal: 'IEEE Conference on Computer Vision and Pattern Recognition (CVPR)', pages: '770–778', type: 'inproceedings', tags: ['vision'], collections: [col.id] },
  { title: 'BERT: Pre-training of Deep Bidirectional Transformers for Language Understanding', authors: [{ given: 'Jacob', family: 'Devlin' }, { given: 'Ming-Wei', family: 'Chang' }, { given: 'Kenton', family: 'Lee' }, { given: 'Kristina', family: 'Toutanova' }], year: '2019', journal: 'Proceedings of NAACL-HLT', pages: '4171–4186', type: 'inproceedings', tags: ['transformers', 'nlp'] },
];
for (const s of seed.reverse()) lib.add(s);

// Fake network lookups and the file dialog.
Object.assign(require('../../src/main/lookup'), fakeLookup());
const docPath = path.join(dataDir, 'Chapter 2 draft.docx');
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [docPath] });

require('../../src/main/main.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.on('browser-window-created', (_e, win) => {
  win.webContents.once('did-finish-load', async () => {
    const js = (code) => win.webContents.executeJavaScript(code);
    const shot = async (name) => {
      await sleep(500);
      fs.writeFileSync(path.join(outDir, name), (await win.webContents.capturePage()).toPNG());
    };
    try {
      await makeDocx([
        { text: 'Chapter 2: Background', style: 'Heading1' },
        'Deep learning has transformed computer vision (LeCun et al., 2015; Krizhevsky et al., 2012). Residual networks made very deep models trainable (He et al., 2016). Transformers now dominate language tasks (Vaswani et al., 2017; Devlin et al., 2018), although some argue otherwise (Smith, 2020).',
        { text: 'References', style: 'Heading1' },
        'He, K., Zhang, X., Ren, S., & Sun, J. (2016). Deep residual learning for image recognition. In Proceedings of the IEEE Conference on Computer Vision and Pattern Recognition (pp. 770–778).',
        'Krizhevsky, A., Sutskever, I., & Hinton, G. E. (2012). ImageNet classification with deep convolutional neural networks. Advances in Neural Information Processing Systems, 25, 1097–1105.',
        'LeCun, Y., Bengio, Y., & Hinton, G. (2014). Deep learning. Nature, 521(7553), 436–444. https://doi.org/10.1038/nature14539',
        'Devlin, J., Chang, M.-W., Lee, K., & Toutanova, K. (2019). BERT: Pre-training of deep bidirectional transformers for language understanding. NAACL.',
        'Jones, P. (2019). An internal report that is hard to find. Some Institute.',
      ], docPath);
      await sleep(800);
      await js(`document.querySelector('#rows tr').click()`);
      await js(`document.querySelector('[data-tab="summary"]').click()`);
      await shot('1-library-summary.png');
      await js(`document.querySelector('[data-tab="info"]').click()`);
      await shot('2-library-details.png');
      await js(`document.querySelector('#btn-check-doc').click()`);
      for (let i = 0; i < 50 && !(await js(`!!document.querySelector('#ck-body:not(.hidden)')`)); i++) await sleep(200);
      await shot('3-check-needs-input.png');
      await js(`document.querySelector('[data-cktab="refs"]').click()`);
      await shot('4-check-references.png');
      await js(`document.querySelector('[data-cktab="cites"]').click()`);
      await shot('5-check-citations.png');
      // Resolve the unsure reference with a link and look at the result.
      await js(`document.querySelector('[data-cktab="input"]').click()`);
      await js(`(() => { const i = [...document.querySelectorAll('[data-input]')].pop(); i.value = 'https://doi.org/10.1109/cvpr.2016.90'; })()`);
      await shot('6-check-input-filled.png');
      await js(`[...document.querySelectorAll('[data-resolve]')].pop().click()`);
      await sleep(800);
      await js(`document.querySelector('[data-cktab="refs"]').click()`);
      await shot('7-check-after-input.png');
    } catch (err) {
      console.error(err);
      process.exitCode = 1;
    }
    app.quit();
  });
});
