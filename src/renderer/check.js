// Renderer side of the manuscript reference check: runs a check on a .docx,
// shows results, collects DOIs/links for uncertain references, and exports.

(function () {
  'use strict';

  const api = window.api;
  const { toast, attempt, esc } = window.App;
  const { formatCitation, STYLES, toBibTeX, toRIS } = window.Citations;
  const $ = (sel) => document.querySelector(sel);

  const STATUS = {
    correct: ['correct', '✓ Correct'],
    corrected: ['corrected', '✎ Corrected'],
    confirmed: ['confirmed', '✓ Confirmed'],
    likely: ['likely', '? Check match'],
    unsure: ['unsure', '? Unsure'],
    notfound: ['notfound', '✕ Not found'],
  };

  let check = null;
  let tab = 'input';
  let onlyProblems = true;

  function needsInput(r) {
    return r.status === 'unsure' || r.status === 'notfound' || r.status === 'likely';
  }

  function badge(status) {
    const [cls, label] = STATUS[status] || ['unsure', status];
    return `<span class="badge ${cls}">${label}</span>`;
  }

  function formatted(item, style) {
    return formatCitation(item, style, { html: true });
  }

  function numbered(ref, html) {
    if (check.style !== 'numeric') return html;
    return ($('#ck-style').value === 'vancouver' ? `${ref.number}. ` : `[${ref.number}] `) + html;
  }

  function show() {
    $('#check-view').classList.remove('hidden');
  }

  function progress(text) {
    $('#ck-progress').classList.toggle('hidden', !text);
    $('#ck-progress-text').textContent = text || '';
    $('#ck-body').classList.toggle('hidden', !!text);
  }

  api.onCheckProgress((p) => {
    if (!$('#check-view').classList.contains('hidden') && !check) {
      progress(p.total ? `${p.stage}: ${p.done} of ${p.total}…` : `${p.stage}…`);
    }
  });

  async function run(fn) {
    check = null;
    show();
    $('#ck-title').textContent = 'Opening…';
    progress('Reading document');
    const r = await attempt(fn);
    if (!r) {
      progress('');
      $('#check-view').classList.add('hidden');
      return;
    }
    check = r;
    const pref = window.App.settings?.citationStyle || 'apa';
    const def = r.style === 'numeric' ? (['ieee', 'vancouver'].includes(pref) ? pref : 'ieee') : ['ieee', 'vancouver'].includes(pref) ? 'apa' : pref;
    $('#ck-style').value = def;
    tab = r.refs.some(needsInput) ? 'input' : r.counts.citationProblems ? 'cites' : 'refs';
    progress('');
    render();
  }

  // ---------------------------------------------------------------------------
  // Rendering

  function render() {
    if (!check) return;
    const c = check.counts;
    $('#ck-title').textContent = check.fileName;
    const input = check.refs.filter(needsInput).length;
    const stats = [
      ['cites', c.citations, 'in-text citations', ''],
      ['cites', c.citationProblems, 'citation problems', c.citationProblems ? 'bad' : 'good'],
      ['refs', c.references, 'references', ''],
      ['refs', c.correct, 'correct as written', 'good'],
      ['refs', check.refs.filter((r) => r.status === 'corrected' || r.status === 'confirmed').length, 'corrected', 'fix'],
      ['input', input, 'need your input', input ? 'warn' : 'good'],
      ['cites', c.uncited, 'never cited', c.uncited ? 'warn' : 'good'],
    ];
    $('#ck-stats').innerHTML = stats.map(([t, n, label, cls]) => `<div class="stat ${cls}" data-goto="${t}"><b>${n}</b><span>${label}</span></div>`).join('');
    $('#ck-warnings').innerHTML = check.warnings.map((w) => `<div>${esc(w)}</div>`).join('');
    for (const b of document.querySelectorAll('#ck-tabs button')) {
      b.classList.toggle('active', b.dataset.cktab === tab);
      if (b.dataset.cktab === 'input') b.textContent = `Needs your input (${input})`;
      if (b.dataset.cktab === 'refs') b.textContent = `All references (${c.references})`;
      if (b.dataset.cktab === 'cites') b.textContent = `In-text citations (${c.citationProblems} problem${c.citationProblems === 1 ? '' : 's'})`;
    }
    const panel = $('#ck-panel');
    if (tab === 'input') panel.innerHTML = renderInput();
    else if (tab === 'refs') panel.innerHTML = renderRefs();
    else panel.innerHTML = renderCites();
  }

  function renderInput() {
    const rows = check.refs.filter(needsInput);
    if (!rows.length) {
      return '<p class="intro">✓ Every reference was matched to a published record. Review the corrections under <b>All references</b>, then save a corrected copy.</p>';
    }
    const style = $('#ck-style').value;
    return `<p class="intro">These references could not be confirmed automatically. Paste a <b>DOI</b> (10.xxxx/…), a <b>DOI or publisher link</b>, or an <b>arXiv id</b> and press Check —
      or accept a suggested match. Links without a DOI are added to the reference as written.</p>
      <table class="ck"><thead><tr><th class="n">#</th><th>Reference as written</th><th>Best match found</th><th style="width:30%">DOI or link</th></tr></thead><tbody>
      ${rows.map((r) => {
        const cands = (r.status === 'likely' && r.record ? [r.record] : r.candidates || []).slice(0, 2);
        const candHtml = cands.length
          ? cands.map((cand, ci) => `<div class="cand">${formatted(cand, style)}
              <div class="row"><button data-accept="${r.index}" data-cand="${r.status === 'likely' ? -1 : ci}">Use this</button>
              ${cand.doi ? `<a href="https://doi.org/${esc(cand.doi)}" target="_blank">open</a>` : ''}</div></div>`).join('') +
            (r.status === 'likely' && r.issues.length ? `<ul class="issues">${r.issues.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>` : '')
          : `<span class="muted">${esc(r.note || 'No matching record found.')}</span>`;
        const warn = r.status === 'likely' && r.userInput && r.note ? `<div class="problem small" style="margin-top:6px">${esc(r.note)}</div>` : '';
        return `<tr>
          <td class="n">${r.number}</td>
          <td>${badge(r.status)}<div style="margin-top:6px">${esc(r.raw)}</div></td>
          <td>${candHtml}${warn}</td>
          <td><div class="resolve">
            <input type="text" data-input="${r.index}" placeholder="10.1234/abcd  or  https://…" value="${esc(r.userInput || '')}" />
            <button data-resolve="${r.index}">Check</button>
            <div class="note" id="note-${r.index}"></div>
          </div></td></tr>`;
      }).join('')}
      </tbody></table>`;
  }

  function renderRefs() {
    const style = $('#ck-style').value;
    const fixable = check.refs.filter((r) => r.corrected);
    const allOn = fixable.length && fixable.every((r) => r.apply);
    return `<p class="intro">Ticked references are rewritten in the <b>${esc(STYLES[style])}</b> style when you save a corrected copy. Unticked ones stay exactly as written.
      Tick “correct” ones too if you want the whole list reformatted.</p>
      <table class="ck"><thead><tr>
        <th class="apply"><input type="checkbox" id="ck-all" ${allOn ? 'checked' : ''} title="Apply all"/></th>
        <th class="n">#</th><th class="st">Status</th><th>As written</th><th>Corrected</th></tr></thead><tbody>
      ${check.refs.map((r) => `<tr>
        <td class="apply">${r.corrected ? `<input type="checkbox" data-apply="${r.index}" ${r.apply ? 'checked' : ''}/>` : ''}</td>
        <td class="n">${r.number}</td>
        <td class="st">${badge(r.status)}${r.citedBy ? `<div class="src">cited ${r.citedBy}×</div>` : '<div class="src problem">never cited</div>'}</td>
        <td>${esc(r.raw)}</td>
        <td>${r.corrected ? numbered(r, formatted(r.corrected, style)) : `<span class="muted">${needsInput(r) ? 'Needs your input' : '—'}</span>`}
          ${r.issues?.length ? `<ul class="issues">${r.issues.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>` : ''}
          ${r.source ? `<div class="src">Source: ${esc(r.source)}${r.note ? ' · ' + esc(r.note) : ''}</div>` : ''}</td>
      </tr>`).join('')}
      </tbody></table>`;
  }

  function highlight(context, text) {
    const i = context.indexOf(text);
    if (i === -1) return esc(context);
    return esc(context.slice(0, i)) + '<mark>' + esc(text) + '</mark>' + esc(context.slice(i + text.length));
  }

  /** A year mismatch is fixed when the matched reference's corrected year equals the cited year. */
  function resolvedNote(c) {
    if (!/^Year mismatch/.test(c.problem) || c.matches.length !== 1) return '';
    const ref = check.refs[c.matches[0]];
    if (ref.corrected && ref.apply && String(ref.corrected.year) === String(c.year)) {
      return `<div class="small okmark">✓ Fixed by correcting reference #${ref.number} to ${esc(ref.corrected.year)}</div>`;
    }
    if (ref.corrected && String(ref.corrected.year) !== String(c.year)) {
      return `<div class="small muted">The published year is ${esc(ref.corrected.year)} — update the citation in the text.</div>`;
    }
    return '';
  }

  function renderCites() {
    const list = check.citations.filter((c) => !onlyProblems || c.problem);
    const uncited = check.uncited.map((i) => check.refs[i]);
    return `<div class="filter-row"><label><input type="checkbox" id="ck-only" ${onlyProblems ? 'checked' : ''}/> Only show problems</label>
        <span>${check.citations.length} citations found · ${check.style === 'numeric' ? 'numbered style' : 'author–year style'}</span></div>
      ${list.length ? `<table class="ck"><thead><tr><th style="width:22%">Citation</th><th>In context</th><th style="width:28%">Matches</th></tr></thead><tbody>
      ${list.map((c) => `<tr>
        <td>${c.kind === 'numeric' ? esc(c.text) : esc(`${c.firstAuthor}${c.etAl ? ' et al.' : c.secondAuthor ? ' & ' + c.secondAuthor : ''}, ${c.year}`)}</td>
        <td class="ctx">…${highlight(c.context, c.text)}…</td>
        <td>${c.problem ? `<div class="problem">${esc(c.problem)}</div>${resolvedNote(c)}` : ''}
          ${c.matches.map((i) => `<div class="small">${c.problem ? '' : '<span class="okmark">✓</span> '}#${check.refs[i].number} ${esc(check.refs[i].raw.slice(0, 90))}${check.refs[i].raw.length > 90 ? '…' : ''}</div>`).join('')}</td>
      </tr>`).join('')}</tbody></table>` : '<p class="intro">✓ Every in-text citation matches an entry in the reference list.</p>'}
      ${uncited.length ? `<h4 style="margin:18px 0 8px">In the reference list but never cited (${uncited.length})</h4>
        <table class="ck"><tbody>${uncited.map((r) => `<tr><td class="n">${r.number}</td><td>${esc(r.raw)}</td></tr>`).join('')}</tbody></table>` : ''}`;
  }

  // ---------------------------------------------------------------------------
  // Events

  $('#ck-tabs').addEventListener('click', (e) => {
    if (!e.target.dataset.cktab) return;
    tab = e.target.dataset.cktab;
    render();
  });
  $('#ck-stats').addEventListener('click', (e) => {
    const s = e.target.closest('.stat');
    if (s) { tab = s.dataset.goto; render(); }
  });
  $('#ck-style').addEventListener('change', render);
  $('#ck-close').onclick = () => { $('#check-view').classList.add('hidden'); check = null; };

  $('#ck-panel').addEventListener('change', async (e) => {
    if (e.target.id === 'ck-only') { onlyProblems = e.target.checked; render(); return; }
    if (e.target.id === 'ck-all') {
      const r = await attempt(() => api.checkSetApply(check.id, check.refs.filter((x) => x.corrected).map((x) => x.index), e.target.checked));
      if (r) { check = r; render(); }
      return;
    }
    const i = e.target.dataset.apply;
    if (i !== undefined) {
      const r = await attempt(() => api.checkSetApply(check.id, [Number(i)], e.target.checked));
      if (r) check = r;
    }
  });

  async function resolve(index) {
    const input = document.querySelector(`input[data-input="${index}"]`);
    const note = document.getElementById(`note-${index}`);
    const value = input.value.trim();
    if (!value) { input.focus(); return; }
    note.innerHTML = '<span class="spinner"></span> Checking…';
    try {
      check = await api.checkResolve(check.id, index, value);
      const ref = check.refs[index];
      if (ref.status === 'confirmed') toast(`Reference ${ref.number} confirmed${ref.note ? ' — ' + ref.note : ''}`);
      else toast(`Reference ${ref.number}: ${ref.note}`, 'error');
      render();
    } catch (err) {
      note.textContent = err.message;
    }
  }

  $('#ck-panel').addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.resolve !== undefined) resolve(Number(b.dataset.resolve));
    if (b.dataset.accept !== undefined) {
      const r = await attempt(() => api.checkAccept(check.id, Number(b.dataset.accept), Number(b.dataset.cand)));
      if (r) { check = r; render(); }
    }
  });
  $('#ck-panel').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.dataset.input !== undefined) { e.preventDefault(); resolve(Number(e.target.dataset.input)); }
  });

  // ---------------------------------------------------------------------------
  // Output

  function correctedList(style) {
    // Corrected entries where accepted, otherwise as written; numbered docs keep their order.
    const lines = check.refs.map((r) => {
      if (r.corrected && r.apply) return numbered(r, formatCitation(r.corrected, style));
      return r.raw;
    });
    return check.style === 'numeric' ? lines : lines.sort((a, b) => a.localeCompare(b));
  }

  $('#ck-save').onclick = async () => {
    const n = check.refs.filter((r) => r.apply && r.corrected).length;
    if (!n) return toast('Nothing to change: tick the references to correct under “All references”.', 'error');
    const r = await attempt(() => api.checkSave(check.id, $('#ck-style').value));
    if (r) toast(`Saved a corrected copy with ${r.replaced} reference${r.replaced === 1 ? '' : 's'} updated: ${r.path}`);
  };

  $('#ck-copy').onclick = async () => {
    const style = $('#ck-style').value;
    const lines = correctedList(style);
    const html = check.refs.map((r) => `<p>${r.corrected && r.apply ? numbered(r, formatCitation(r.corrected, style, { html: true })) : esc(r.raw)}</p>`);
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'text/plain': new Blob([lines.join('\n')], { type: 'text/plain' }), 'text/html': new Blob([html.join('')], { type: 'text/html' }) })]);
    } catch {
      await navigator.clipboard.writeText(lines.join('\n'));
    }
    toast(`Copied ${lines.length} references`);
  };

  function csvCell(s) {
    return `"${String(s ?? '').replace(/"/g, '""')}"`;
  }

  $('#ck-more').onclick = (e) => {
    document.querySelector('.menu')?.remove();
    const menu = document.createElement('div');
    menu.className = 'menu';
    const r = e.target.getBoundingClientRect();
    menu.style.top = `${r.bottom + 4}px`;
    menu.style.right = `${window.innerWidth - r.right}px`;
    const items = [
      ['BibTeX (.bib) of confirmed references', async () => {
        const items = check.refs.filter((x) => x.corrected && x.status !== 'unsure' && x.status !== 'notfound').map((x) => x.corrected);
        const p = await attempt(() => api.saveText(toBibTeX(items), check.fileName.replace(/\.docx$/i, '.bib'), 'bib'));
        if (p) toast(`Saved ${items.length} references to ${p}`);
      }],
      ['RIS (.ris) of confirmed references', async () => {
        const items = check.refs.filter((x) => x.corrected && x.status !== 'unsure' && x.status !== 'notfound').map((x) => x.corrected);
        const p = await attempt(() => api.saveText(toRIS(items), check.fileName.replace(/\.docx$/i, '.ris'), 'ris'));
        if (p) toast(`Saved ${items.length} references to ${p}`);
      }],
      ['Report (.csv) for every reference and citation', async () => {
        const style = $('#ck-style').value;
        const rows = [['Kind', 'Number', 'Status', 'As written', 'Corrected', 'Issues', 'DOI', 'Source']];
        for (const x of check.refs) rows.push(['reference', x.number, x.status, x.raw, x.corrected ? formatCitation(x.corrected, style) : '', (x.issues || []).join('; '), x.corrected?.doi || '', x.source || '']);
        for (const c of check.citations) rows.push(['citation', c.kind === 'numeric' ? c.numbers.join(',') : `${c.firstAuthor} ${c.year}`, c.problem ? 'problem' : 'ok', c.context, c.matches.map((i) => '#' + check.refs[i].number).join(' '), c.problem, '', '']);
        const p = await attempt(() => api.saveText(rows.map((r) => r.map(csvCell).join(',')).join('\r\n'), check.fileName.replace(/\.docx$/i, ' - reference check.csv'), 'csv'));
        if (p) toast(`Report saved to ${p}`);
      }],
      ['Add confirmed references to my library', async () => {
        const r2 = await attempt(() => api.checkAddToLibrary(check.id));
        if (r2) toast(`Added ${r2.added} to your library${r2.existing ? ` (${r2.existing} were already there)` : ''}, tagged “${check.fileName.replace(/\.docx$/i, '')}”`);
      }],
    ];
    for (const [label, fn] of items) {
      const b = document.createElement('button');
      b.textContent = label;
      b.onclick = () => { menu.remove(); fn(); };
      menu.appendChild(b);
    }
    document.body.appendChild(menu);
    setTimeout(() => document.addEventListener('click', () => menu.remove(), { once: true }), 0);
  };

  // ---------------------------------------------------------------------------

  $('#ck-style').innerHTML = Object.entries(STYLES).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('');
  // A cancelled file dialog resolves to null, which closes the view quietly.
  $('#btn-check-doc').onclick = () => run(() => api.checkDocxDialog());

  window.Checker = {
    checkFile: (file) => run(() => api.checkDocxFile(file)),
  };
})();
