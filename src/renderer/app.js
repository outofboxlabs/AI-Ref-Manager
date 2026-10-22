// Renderer: UI state and rendering for the library, detail pane, AI chat and
// settings. Talks to the main process only through window.api (preload.js).

(function () {
  'use strict';

  const api = window.api;
  const { formatCitation, STYLES, escapeHtml: esc } = window.Citations;
  const $ = (sel) => document.querySelector(sel);

  const TYPE_LABELS = {
    article: 'Journal article', preprint: 'Preprint', inproceedings: 'Conference paper', book: 'Book',
    chapter: 'Book chapter', thesis: 'Thesis', report: 'Report', misc: 'Other',
  };

  const state = {
    items: [],
    collections: [],
    tags: [],
    view: { kind: 'all' },
    search: '',
    searchHits: null, // Map id -> score, or null when not searching
    sort: 'added',
    selected: new Set(),
    anchor: null,
    current: null,
    tab: 'info',
    settings: null,
    busy: new Set(), // item ids with an AI request in flight
    ask: { history: [], refs: [] },
  };

  // -------------------------------------------------------------------------
  // Utilities

  function toast(msg, kind = '') {
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.textContent = msg;
    $('#toasts').appendChild(el);
    setTimeout(() => el.remove(), kind === 'error' ? 7000 : 3500);
  }

  async function attempt(fn, errPrefix = '') {
    try {
      return await fn();
    } catch (e) {
      toast(errPrefix + (e.message || e), 'error');
      return undefined;
    }
  }

  function authorLine(item, max = 3) {
    const a = (item.authors || []).map((x) => [x.given, x.family].filter(Boolean).join(' '));
    if (!a.length) return '';
    return a.length > max ? `${a.slice(0, max).join(', ')} et al.` : a.join(', ');
  }

  function itemById(id) {
    return state.items.find((i) => i.id === id);
  }

  function debounce(fn, ms) {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  }

  let reqCounter = 0;
  const deltaHandlers = new Map();
  api.onAiDelta(({ reqId, delta }) => deltaHandlers.get(reqId)?.(delta));

  // -------------------------------------------------------------------------
  // Modal helper

  function modal({ title, body, actions }) {
    return new Promise((resolve) => {
      $('#modal-title').textContent = title;
      const bodyEl = $('#modal-body');
      bodyEl.innerHTML = '';
      if (typeof body === 'string') bodyEl.innerHTML = body;
      else if (body) bodyEl.appendChild(body);
      const actionsEl = $('#modal-actions');
      actionsEl.innerHTML = '';
      const close = (v) => { $('#modal').classList.add('hidden'); document.removeEventListener('keydown', onKey); resolve(v); };
      const onKey = (e) => {
        if (e.key === 'Escape') close(null);
        if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA') {
          const primary = actions.find((a) => a.primary);
          if (primary) { e.preventDefault(); close(primary.value(bodyEl)); }
        }
      };
      for (const a of actions) {
        const b = document.createElement('button');
        b.textContent = a.label;
        if (a.primary) b.className = 'primary';
        b.onclick = () => close(a.value ? a.value(bodyEl) : null);
        actionsEl.appendChild(b);
      }
      document.addEventListener('keydown', onKey);
      $('#modal').classList.remove('hidden');
      bodyEl.querySelector('input, select, textarea')?.focus();
    });
  }

  async function prompt(title, label, value = '', placeholder = '') {
    const body = document.createElement('div');
    body.innerHTML = `<label>${esc(label)}<input type="text" placeholder="${esc(placeholder)}" /></label>`;
    body.querySelector('input').value = value;
    return modal({
      title,
      body,
      actions: [
        { label: 'Cancel' },
        { label: 'OK', primary: true, value: (b) => b.querySelector('input').value.trim() || null },
      ],
    });
  }

  async function pick(title, label, options) {
    const body = document.createElement('div');
    body.innerHTML = `<label>${esc(label)}<select>${options.map((o) => `<option value="${esc(o.value)}">${esc(o.label)}</option>`).join('')}</select></label>`;
    return modal({
      title,
      body,
      actions: [{ label: 'Cancel' }, { label: 'OK', primary: true, value: (b) => b.querySelector('select').value }],
    });
  }

  // -------------------------------------------------------------------------
  // Data

  function applySnapshot(snap) {
    state.items = snap.items;
    state.collections = snap.collections;
    state.tags = snap.tags;
    for (const id of [...state.selected]) if (!itemById(id)) state.selected.delete(id);
    if (state.current && !itemById(state.current)) state.current = null;
    renderSidebar();
    renderList();
    renderDetail(false);
  }

  const runSearch = debounce(async () => {
    const q = state.search.trim();
    if (!q) state.searchHits = null;
    else {
      const hits = await attempt(() => api.search(q));
      state.searchHits = new Map((hits || []).map((h) => [h.id, h.score]));
    }
    renderList();
  }, 180);

  function visibleItems() {
    const v = state.view;
    const weekAgo = Date.now() - 7 * 864e5;
    let list = state.items.filter((it) => {
      switch (v.kind) {
        case 'favorites': return it.favorite;
        case 'unread': return !it.read;
        case 'recent': return new Date(it.addedAt).getTime() > weekAgo;
        case 'nosummary': return !it.summary;
        case 'nopdf': return !it.file;
        case 'collection': return (it.collections || []).includes(v.id);
        case 'tag': return (it.tags || []).includes(v.id);
        default: return true;
      }
    });
    if (state.searchHits) {
      list = list.filter((it) => state.searchHits.has(it.id));
      return list.sort((a, b) => state.searchHits.get(b.id) - state.searchHits.get(a.id));
    }
    const first = (it) => (it.authors?.[0]?.family || it.authors?.[0]?.given || '￿').toLowerCase();
    const cmp = {
      added: (a, b) => (b.addedAt || '').localeCompare(a.addedAt || ''),
      title: (a, b) => (a.title || '').localeCompare(b.title || ''),
      year: (a, b) => String(b.year || 0).localeCompare(String(a.year || 0)),
      author: (a, b) => first(a).localeCompare(first(b)),
    }[state.sort];
    return list.sort(cmp);
  }

  // -------------------------------------------------------------------------
  // Sidebar

  function navItem({ label, count, active, onClick, actions, cls = '', drop }) {
    const li = document.createElement('li');
    li.className = (active ? 'active ' : '') + cls;
    li.innerHTML = `<span class="label"></span>${count !== undefined ? `<span class="count">${count}</span>` : ''}`;
    li.querySelector('.label').textContent = label;
    li.onclick = onClick;
    if (actions) {
      const box = document.createElement('span');
      box.className = 'row-actions';
      for (const [text, title, fn] of actions) {
        const b = document.createElement('button');
        b.textContent = text;
        b.title = title;
        b.onclick = (e) => { e.stopPropagation(); fn(); };
        box.appendChild(b);
      }
      li.appendChild(box);
    }
    if (drop) {
      // Drag references from the list onto a collection.
      li.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('application/x-refmind-ids')) { e.preventDefault(); li.classList.add('drop-target'); } });
      li.addEventListener('dragleave', () => li.classList.remove('drop-target'));
      li.addEventListener('drop', (e) => {
        e.preventDefault();
        e.stopPropagation();
        li.classList.remove('drop-target');
        const ids = JSON.parse(e.dataTransfer.getData('application/x-refmind-ids') || '[]');
        if (ids.length) drop(ids);
      });
    }
    return li;
  }

  function setView(view) {
    state.view = view;
    renderSidebar();
    renderList();
  }

  function renderSidebar() {
    const v = state.view;
    const lib = $('#nav-library');
    lib.innerHTML = '';
    const count = (fn) => state.items.filter(fn).length;
    const weekAgo = Date.now() - 7 * 864e5;
    const views = [
      ['all', 'All references', state.items.length],
      ['recent', 'Recently added', count((i) => new Date(i.addedAt).getTime() > weekAgo)],
      ['favorites', 'Favorites', count((i) => i.favorite)],
      ['unread', 'Unread', count((i) => !i.read)],
      ['nosummary', 'Not yet summarized', count((i) => !i.summary)],
      ['nopdf', 'Missing PDF', count((i) => !i.file)],
    ];
    for (const [kind, label, n] of views) {
      lib.appendChild(navItem({ label, count: n, active: v.kind === kind, onClick: () => setView({ kind }) }));
    }

    const cols = $('#nav-collections');
    cols.innerHTML = '';
    const addCol = (c, depth) => {
      cols.appendChild(
        navItem({
          label: c.name,
          count: count((i) => (i.collections || []).includes(c.id)),
          active: v.kind === 'collection' && v.id === c.id,
          cls: depth ? 'child' : '',
          onClick: () => setView({ kind: 'collection', id: c.id, name: c.name }),
          drop: async (ids) => {
            await attempt(() => api.updateItems(ids, { addCollection: c.id }));
            toast(`Added ${ids.length} to “${c.name}”`);
          },
          actions: [
            ['+', 'New sub-collection', async () => { const n = await prompt('New sub-collection', 'Name'); if (n) attempt(() => api.addCollection(n, c.id)); }],
            ['✎', 'Rename', async () => { const n = await prompt('Rename collection', 'Name', c.name); if (n) attempt(() => api.renameCollection(c.id, n)); }],
            ['✕', 'Delete collection (keeps the references)', async () => {
              const ok = await modal({ title: 'Delete collection?', body: `<p>Delete “${esc(c.name)}” and its sub-collections? The references stay in your library.</p>`, actions: [{ label: 'Cancel' }, { label: 'Delete', primary: true, value: () => true }] });
              if (ok) { await attempt(() => api.removeCollection(c.id)); if (v.kind === 'collection' && v.id === c.id) setView({ kind: 'all' }); }
            }],
          ],
        }),
      );
      if (depth < 4) for (const child of state.collections.filter((x) => x.parentId === c.id)) addCol(child, depth + 1);
    };
    for (const c of state.collections.filter((x) => !x.parentId)) addCol(c, 0);
    if (!state.collections.length) cols.innerHTML = '<li class="muted small" style="cursor:default">No collections yet</li>';

    const tags = $('#nav-tags');
    tags.innerHTML = '';
    for (const t of state.tags) {
      tags.appendChild(
        navItem({
          label: t.name,
          count: t.count,
          active: v.kind === 'tag' && v.id === t.name,
          onClick: () => setView({ kind: 'tag', id: t.name, name: t.name }),
          actions: [['✎', 'Rename tag', async () => { const n = await prompt('Rename tag', 'Tag', t.name); if (n && n !== t.name) attempt(() => api.renameTag(t.name, n)); }]],
        }),
      );
    }
    if (!state.tags.length) tags.innerHTML = '<li class="muted small" style="cursor:default">Tags you add appear here</li>';
  }

  // -------------------------------------------------------------------------
  // List

  function viewTitle() {
    const v = state.view;
    const names = { all: 'All references', recent: 'Recently added', favorites: 'Favorites', unread: 'Unread', nosummary: 'Not yet summarized', nopdf: 'Missing PDF' };
    if (v.kind === 'collection') return state.collections.find((c) => c.id === v.id)?.name || 'Collection';
    if (v.kind === 'tag') return `# ${v.id}`;
    return names[v.kind];
  }

  function renderList() {
    const list = visibleItems();
    $('#list-title').textContent = viewTitle() + (state.searchHits ? ` — search “${state.search.trim()}”` : '');
    const tbody = $('#rows');
    tbody.innerHTML = '';
    const frag = document.createDocumentFragment();
    for (const it of list) {
      const tr = document.createElement('tr');
      tr.dataset.id = it.id;
      tr.draggable = true;
      if (state.selected.has(it.id)) tr.classList.add('selected');
      if (!it.read) tr.classList.add('unread');
      const busy = state.busy.has(it.id);
      tr.innerHTML = `
        <td class="c-star"><span class="star ${it.favorite ? 'on' : ''}" title="Favorite">${it.favorite ? '★' : '☆'}</span></td>
        <td><div class="r-title">${esc(it.title || 'Untitled')}${it.file ? '<span class="pdf-badge">PDF</span>' : ''}</div><div class="r-authors">${esc(authorLine(it, 4))}</div></td>
        <td class="c-year">${esc(it.year || '')}</td>
        <td class="c-src"><div class="r-src">${esc(it.journal || it.publisher || '')}</div></td>
        <td class="c-ai">${busy ? '<span class="spinner ai-dot"></span>' : it.summary ? '<span class="ai-dot" title="Summarized">✦</span>' : ''}</td>`;
      frag.appendChild(tr);
    }
    tbody.appendChild(frag);
    const empty = state.items.length === 0;
    $('#empty').classList.toggle('hidden', !empty);
    $('#status').textContent = empty ? '' : `${list.length} of ${state.items.length} references` + (state.selected.size > 1 ? ` · ${state.selected.size} selected` : '');
    renderBulkBar();
  }

  function renderBulkBar() {
    const n = state.selected.size;
    $('#bulk-bar').classList.toggle('hidden', n < 2);
    $('#bulk-count').textContent = `${n} selected`;
  }

  function selectRow(id, e) {
    const ids = visibleItems().map((i) => i.id);
    if (e && e.shiftKey && state.anchor) {
      const a = ids.indexOf(state.anchor);
      const b = ids.indexOf(id);
      if (a !== -1 && b !== -1) {
        if (!(e.metaKey || e.ctrlKey)) state.selected.clear();
        for (let i = Math.min(a, b); i <= Math.max(a, b); i++) state.selected.add(ids[i]);
      }
    } else if (e && (e.metaKey || e.ctrlKey)) {
      if (state.selected.has(id)) state.selected.delete(id);
      else state.selected.add(id);
      state.anchor = id;
    } else {
      state.selected = new Set([id]);
      state.anchor = id;
    }
    const changed = state.current !== id;
    state.current = state.selected.has(id) ? id : [...state.selected][0] || null;
    for (const tr of document.querySelectorAll('#rows tr')) tr.classList.toggle('selected', state.selected.has(tr.dataset.id));
    renderBulkBar();
    $('#status').textContent = `${ids.length} of ${state.items.length} references` + (state.selected.size > 1 ? ` · ${state.selected.size} selected` : '');
    if (changed) renderDetail(true);
  }

  $('#rows').addEventListener('click', (e) => {
    const tr = e.target.closest('tr');
    if (!tr) return;
    if (e.target.classList.contains('star')) {
      const it = itemById(tr.dataset.id);
      attempt(() => api.updateItem(it.id, { favorite: !it.favorite }));
      return;
    }
    selectRow(tr.dataset.id, e);
  });
  $('#rows').addEventListener('dblclick', (e) => {
    const tr = e.target.closest('tr');
    if (!tr) return;
    const it = itemById(tr.dataset.id);
    if (it.file) attempt(() => api.openPdf(it.id));
  });
  $('#rows').addEventListener('dragstart', (e) => {
    const tr = e.target.closest('tr');
    if (!tr) return;
    if (!state.selected.has(tr.dataset.id)) selectRow(tr.dataset.id);
    e.dataTransfer.setData('application/x-refmind-ids', JSON.stringify([...state.selected]));
    e.dataTransfer.effectAllowed = 'copy';
  });

  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, textarea, select') || !$('#modal').classList.contains('hidden')) return;
    const ids = visibleItems().map((i) => i.id);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const i = ids.indexOf(state.current);
      const next = ids[Math.max(0, Math.min(ids.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
      if (next) {
        selectRow(next, e.shiftKey ? { shiftKey: true } : null);
        document.querySelector(`#rows tr[data-id="${next}"]`)?.scrollIntoView({ block: 'nearest' });
      }
    } else if ((e.key === 'a' || e.key === 'A') && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      state.selected = new Set(ids);
      renderList();
    } else if (e.key === 'Delete' || (e.key === 'Backspace' && (e.metaKey || e.ctrlKey))) {
      if (state.selected.size) attempt(() => api.removeItems([...state.selected]));
    } else if ((e.key === 'f' || e.key === 'F') && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      $('#search').focus();
    }
  });

  $('#sort').addEventListener('change', (e) => { state.sort = e.target.value; renderList(); });
  $('#search').addEventListener('input', (e) => { state.search = e.target.value; runSearch(); });

  // Bulk actions
  $('#bulk-bar').addEventListener('click', async (e) => {
    const action = e.target.dataset.bulk;
    if (!action) return;
    const ids = [...state.selected];
    if (action === 'tag') {
      const t = await prompt('Add tag', `Tag for ${ids.length} references`, '', 'e.g. thesis-ch2');
      if (t) attempt(() => api.updateItems(ids, { addTags: [t] }));
    } else if (action === 'collection') {
      if (!state.collections.length) return toast('Create a collection first (+ next to Collections).');
      const c = await pick('Add to collection', 'Collection', state.collections.map((c) => ({ value: c.id, label: c.name })));
      if (c) attempt(() => api.updateItems(ids, { addCollection: c }));
    } else if (action === 'read') {
      attempt(() => api.updateItems(ids, { read: true }));
    } else if (action === 'export') {
      exportDialog(ids);
    } else if (action === 'delete') {
      attempt(() => api.removeItems(ids));
    }
  });

  async function exportDialog(ids) {
    const fmt = await pick('Export references', 'Format', [
      { value: 'bibtex', label: 'BibTeX (.bib) — LaTeX, Overleaf' },
      { value: 'ris', label: 'RIS (.ris) — Word, EndNote, Zotero, Mendeley' },
      ...Object.entries(STYLES).map(([k, v]) => ({ value: k, label: `Bibliography text — ${v}` })),
    ]);
    if (!fmt) return;
    const p = await attempt(() => api.exportItems(ids, fmt));
    if (p) toast(`Exported ${ids.length} reference${ids.length === 1 ? '' : 's'} to ${p}`);
  }

  // -------------------------------------------------------------------------
  // Detail pane

  function renderDetail(reset) {
    const it = state.current && itemById(state.current);
    $('#detail-empty').classList.toggle('hidden', !!it);
    $('#detail-body').classList.toggle('hidden', !it);
    if (!it) return;
    if (reset) {
      // Mark as read when opened, after a short dwell.
      clearTimeout(renderDetail.readTimer);
      if (!it.read) renderDetail.readTimer = setTimeout(() => { if (state.current === it.id) api.updateItem(it.id, { read: true }); }, 4000);
    }
    $('#d-type').textContent = TYPE_LABELS[it.type] || 'Reference';
    $('#d-title').textContent = it.title || 'Untitled';
    $('#d-authors').textContent = authorLine(it, 8);
    $('#d-pub').textContent = [it.journal || it.publisher, it.year, it.doi ? `doi:${it.doi}` : ''].filter(Boolean).join(' · ');
    $('#d-open-pdf').disabled = !it.file;
    $('#d-attach').textContent = it.file ? 'Replace PDF' : 'Attach PDF';
    $('#d-fav').textContent = it.favorite ? '★' : '☆';
    $('#d-fav').classList.toggle('on', !!it.favorite);
    $('#d-read').textContent = it.read ? 'Mark unread' : 'Mark read';

    const form = $('#info-form');
    const active = document.activeElement;
    const editing = form.contains(active) && !reset;
    if (!editing) fillForm(it);
    renderCollectionsChips(it);
    $('#d-meta-source').textContent = it.metadataSource ? `Metadata from ${{ crossref: 'Crossref', arxiv: 'arXiv', ai: 'AI extraction', 'ai+crossref': 'AI + Crossref', none: 'PDF file' }[it.metadataSource] || it.metadataSource}` : '';

    if (reset || document.activeElement !== $('#notes')) $('#notes').value = it.notes || '';
    renderSummary(it);
    if (reset) renderChat(it);
    if (state.tab === 'pdf' && reset) renderPdf(it);
  }

  function fillForm(it) {
    const f = $('#info-form').elements;
    f.type.value = it.type || 'article';
    f.title.value = it.title || '';
    f.authors.value = (it.authors || []).map((a) => [a.family, a.given].filter(Boolean).join(', ')).join('\n');
    for (const k of ['year', 'journal', 'volume', 'issue', 'pages', 'publisher', 'doi', 'url', 'abstract']) f[k].value = it[k] || '';
    f.tags.value = (it.tags || []).join(', ');
  }

  function readForm() {
    const f = $('#info-form').elements;
    return {
      type: f.type.value,
      title: f.title.value.trim(),
      authors: f.authors.value.split('\n').map((s) => s.trim()).filter(Boolean).map((s) => {
        if (s.includes(',')) { const [family, ...g] = s.split(','); return { family: family.trim(), given: g.join(',').trim() }; }
        const p = s.split(/\s+/); return { given: p.slice(0, -1).join(' '), family: p[p.length - 1] };
      }),
      year: f.year.value.trim(),
      journal: f.journal.value.trim(),
      volume: f.volume.value.trim(),
      issue: f.issue.value.trim(),
      pages: f.pages.value.trim(),
      publisher: f.publisher.value.trim(),
      doi: f.doi.value.trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i, ''),
      url: f.url.value.trim(),
      abstract: f.abstract.value.trim(),
      tags: [...new Set(f.tags.value.split(',').map((t) => t.trim()).filter(Boolean))],
    };
  }

  const saveForm = debounce(() => {
    if (state.current) attempt(() => api.updateItem(state.current, readForm()));
  }, 500);
  $('#info-form').addEventListener('input', saveForm);
  $('#info-form').addEventListener('change', saveForm);

  function renderCollectionsChips(it) {
    const box = $('#d-collections');
    box.innerHTML = '';
    if (!state.collections.length) {
      box.innerHTML = '<span class="muted small">No collections yet.</span>';
      return;
    }
    for (const c of state.collections) {
      const on = (it.collections || []).includes(c.id);
      const chip = document.createElement('span');
      chip.className = 'chip' + (on ? ' on' : '');
      chip.textContent = (on ? '✓ ' : '') + c.name;
      chip.onclick = () => attempt(() => api.updateItems([it.id], on ? { removeCollection: c.id } : { addCollection: c.id }));
      box.appendChild(chip);
    }
  }

  const saveNotes = debounce(async () => {
    if (!state.current) return;
    await attempt(() => api.updateItem(state.current, { notes: $('#notes').value }));
    $('#notes-status').textContent = 'Saved';
    setTimeout(() => ($('#notes-status').textContent = ''), 1500);
  }, 600);
  $('#notes').addEventListener('input', saveNotes);

  // Tabs
  document.querySelector('.tabs').addEventListener('click', (e) => {
    const t = e.target.dataset.tab;
    if (!t) return;
    state.tab = t;
    for (const b of document.querySelectorAll('.tabs button')) b.classList.toggle('active', b.dataset.tab === t);
    for (const p of document.querySelectorAll('.tab-panel')) p.classList.toggle('hidden', p.dataset.panel !== t);
    const it = itemById(state.current);
    if (t === 'pdf' && it) renderPdf(it);
    if (t === 'chat') $('#chat-text').focus();
  });

  async function renderPdf(it) {
    const holder = $('#pdf-holder');
    holder.innerHTML = '';
    if (!it.file) {
      holder.innerHTML = '<div class="pdf-none">No PDF attached. Use <b>Attach PDF</b> above.</div>';
      return;
    }
    const url = await attempt(() => api.pdfUrl(it.id));
    if (!url || state.current !== it.id) return;
    const frame = document.createElement('iframe');
    frame.src = url;
    frame.title = 'PDF';
    holder.appendChild(frame);
  }

  // Header actions
  $('#d-open-pdf').onclick = () => attempt(() => api.openPdf(state.current));
  $('#d-attach').onclick = async () => {
    const r = await attempt(() => api.attachPdf(state.current));
    if (r) { toast('PDF attached'); if (state.tab === 'pdf') renderPdf(r); }
  };
  $('#d-fav').onclick = () => { const it = itemById(state.current); attempt(() => api.updateItem(it.id, { favorite: !it.favorite })); };
  $('#d-read').onclick = () => { const it = itemById(state.current); clearTimeout(renderDetail.readTimer); attempt(() => api.updateItem(it.id, { read: !it.read })); };
  $('#d-delete').onclick = () => attempt(() => api.removeItems([state.current]));
  $('#d-refresh').onclick = async () => {
    const b = $('#d-refresh');
    b.disabled = true;
    b.innerHTML = '<span class="spinner"></span> Looking up…';
    const r = await attempt(() => api.refreshMetadata(state.current));
    b.disabled = false;
    b.textContent = '↻ Refresh metadata';
    if (r) { fillForm(r); toast('Metadata updated'); }
  };

  $('#d-style').addEventListener('change', (e) => attempt(() => api.updateSettings({ citationStyle: e.target.value }).then((s) => (state.settings = s))));
  $('#d-copy').onclick = async () => {
    const it = itemById(state.current);
    const style = $('#d-style').value;
    const text = formatCitation(it, style);
    const html = formatCitation(it, style, { html: true });
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'text/plain': new Blob([text], { type: 'text/plain' }), 'text/html': new Blob([html], { type: 'text/html' }) })]);
    } catch {
      await navigator.clipboard.writeText(text);
    }
    toast(`Copied ${STYLES[style]} citation`);
  };

  // -------------------------------------------------------------------------
  // AI summary

  function renderSummary(it) {
    const el = $('#summary-content');
    const s = it.summary;
    const busy = state.busy.has(it.id);
    if (!s) {
      el.innerHTML = `<div class="ai-cta">
        <div class="empty-icon">✦</div>
        <p>Get a TL;DR, key findings, methods and limitations for this paper.<br/>Suggested topic tags come along with it.</p>
        <button class="ai" id="btn-summarize" ${busy ? 'disabled' : ''}>${busy ? '<span class="spinner"></span> Reading the paper…' : '✦ Summarize with AI'}</button>
        ${!state.settings?.hasApiKey ? '<p class="small">Requires an Anthropic API key — add it in Settings (⚙).</p>' : ''}
      </div>`;
      el.querySelector('#btn-summarize').onclick = () => summarize(it.id);
      return;
    }
    const list = (arr) => (arr && arr.length ? `<ul>${arr.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : '<p class="muted">—</p>');
    const newTags = (s.keywords || []).filter((k) => !(it.tags || []).includes(k));
    el.innerHTML = `<div class="summary">
      <div class="tldr">${esc(s.tldr)}</div>
      <h4>Summary</h4>${s.summary.split(/\n{2,}/).map((p) => `<p>${esc(p)}</p>`).join('')}
      <h4>Research question</h4><p>${esc(s.research_question)}</p>
      <h4>Methods</h4><p>${esc(s.methods)}</p>
      <h4>Key findings</h4>${list(s.key_findings)}
      <h4>Limitations</h4>${list(s.limitations)}
      <h4>Suggested tags</h4>
      <div class="chips" id="sugg-tags">${(s.keywords || []).map((k) => `<span class="chip ${(it.tags || []).includes(k) ? 'on' : ''}" data-tag="${esc(k)}">${(it.tags || []).includes(k) ? '✓ ' : '+ '}${esc(k)}</span>`).join('')}</div>
      ${newTags.length > 1 ? '<button class="link" id="add-all-tags">Add all suggested tags</button>' : ''}
      <div class="meta"><span>Generated ${s.createdAt ? new Date(s.createdAt).toLocaleDateString() : ''}${s.model ? ' · ' + esc(s.model) : ''}</span>
        <button class="link" id="btn-resummarize" ${busy ? 'disabled' : ''}>${busy ? 'Regenerating…' : 'Regenerate'}</button>
        <button class="link" id="btn-copy-summary">Copy</button></div>
    </div>`;
    el.querySelector('#sugg-tags').onclick = (e) => {
      const t = e.target.dataset.tag;
      if (!t) return;
      const tags = it.tags || [];
      attempt(() => api.updateItem(it.id, { tags: tags.includes(t) ? tags.filter((x) => x !== t) : [...tags, t] }));
    };
    el.querySelector('#add-all-tags')?.addEventListener('click', () => attempt(() => api.updateItem(it.id, { tags: [...new Set([...(it.tags || []), ...s.keywords])] })));
    el.querySelector('#btn-resummarize').onclick = () => summarize(it.id);
    el.querySelector('#btn-copy-summary').onclick = () => {
      const text = `${it.title}\n\nTL;DR: ${s.tldr}\n\n${s.summary}\n\nKey findings:\n${(s.key_findings || []).map((x) => '- ' + x).join('\n')}\n\nLimitations:\n${(s.limitations || []).map((x) => '- ' + x).join('\n')}`;
      navigator.clipboard.writeText(text);
      toast('Summary copied');
    };
  }

  async function summarize(id) {
    if (!(await ensureKey())) return;
    state.busy.add(id);
    renderList();
    renderDetail(false);
    const r = await attempt(() => api.summarize(id), 'Summary failed: ');
    state.busy.delete(id);
    renderList();
    renderDetail(false);
    if (r) toast(`Summarized “${(r.title || '').slice(0, 60)}”`);
  }

  async function ensureKey() {
    if (state.settings?.hasApiKey) return true;
    toast('Add your Anthropic API key in Settings to use AI features.', 'error');
    openSettings();
    return false;
  }

  // -------------------------------------------------------------------------
  // Chat (one paper, and the whole library)

  function addMsg(log, role, html, { raw = false } = {}) {
    const el = document.createElement('div');
    el.className = `msg ${role}`;
    if (raw) el.textContent = html;
    else el.innerHTML = html;
    log.appendChild(el);
    log.scrollTop = log.scrollHeight;
    return el;
  }

  function suggestions(box, list, onPick) {
    box.innerHTML = '';
    for (const s of list) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = s;
      b.onclick = () => onPick(s);
      box.appendChild(b);
    }
  }

  const PAPER_SUGGESTIONS = ['What is the main contribution?', 'Explain the method in simple terms', 'What datasets and metrics are used?', 'What are the weaknesses?', 'How could I build on this work?'];

  function renderChat(it) {
    const log = $('#chat-log');
    log.innerHTML = '';
    for (const m of it.chat || []) addMsg(log, m.role, m.role === 'user' ? m.content : Markdown.render(m.content), { raw: m.role === 'user' });
    suggestions($('#chat-suggest'), (it.chat || []).length ? [] : PAPER_SUGGESTIONS, (s) => sendChat(s));
    $('#chat-text').placeholder = it.file || it.abstract ? 'Ask about this paper…' : 'Attach a PDF to chat about the full paper';
  }

  async function streamInto(log, call, { refs } = {}) {
    const el = addMsg(log, 'assistant', '<span class="typing"></span>');
    let acc = '';
    const reqId = `r${++reqCounter}`;
    deltaHandlers.set(reqId, (d) => {
      acc += d;
      el.innerHTML = Markdown.render(acc, { refs }) + '<span class="typing"></span>';
      if (log.scrollHeight - log.scrollTop - log.clientHeight < 120) log.scrollTop = log.scrollHeight;
    });
    try {
      const result = await call(reqId);
      // The final text replaces the streamed text (a refusal fallback can restart the answer).
      const text = typeof result === 'string' ? result : result.text;
      el.innerHTML = Markdown.render(text, { refs });
      return result;
    } catch (e) {
      el.className = 'msg error';
      el.textContent = e.message;
      return null;
    } finally {
      deltaHandlers.delete(reqId);
    }
  }

  async function sendChat(text) {
    const it = itemById(state.current);
    if (!it || !text.trim() || state.busy.has('chat:' + it.id)) return;
    if (!(await ensureKey())) return;
    const history = [...(it.chat || []), { role: 'user', content: text.trim() }];
    const log = $('#chat-log');
    addMsg(log, 'user', text.trim(), { raw: true });
    $('#chat-text').value = '';
    suggestions($('#chat-suggest'), [], () => {});
    state.busy.add('chat:' + it.id);
    const r = await streamInto(log, (reqId) => api.chat(it.id, history, reqId));
    state.busy.delete('chat:' + it.id);
    if (r === null) it.chat = history.slice(0, -1); // keep failed question out of history
  }

  $('#chat-form').addEventListener('submit', (e) => { e.preventDefault(); sendChat($('#chat-text').value); });
  $('#chat-text').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(e.target.value); } });
  $('#chat-clear').onclick = async () => {
    const it = itemById(state.current);
    if (!it) return;
    await attempt(() => api.updateItem(it.id, { chat: [] }));
    renderChat(itemById(state.current));
  };

  // Ask library
  const LIB_SUGGESTIONS = ['What are the main themes across my library?', 'Which papers disagree with each other, and on what?', 'Suggest a reading order for a newcomer', 'Draft a short literature review paragraph with citations'];

  function openAsk() {
    $('#ask-drawer').classList.remove('hidden');
    const scope = $('#ask-scope');
    const opts = [['all', `Whole library (${state.items.length})`], ['view', `Current view: ${viewTitle()} (${visibleItems().length})`]];
    if (state.selected.size > 1) opts.push(['selected', `Selected (${state.selected.size})`]);
    const prev = scope.value;
    scope.innerHTML = opts.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('');
    if (opts.some(([v]) => v === prev)) scope.value = prev;
    if (!state.ask.history.length) suggestions($('#ask-suggest'), LIB_SUGGESTIONS, (s) => sendAsk(s));
    $('#ask-text').focus();
  }

  function scopeIds() {
    const v = $('#ask-scope').value;
    if (v === 'selected') return [...state.selected];
    if (v === 'view') return visibleItems().map((i) => i.id);
    return [];
  }

  let askBusy = false;
  async function sendAsk(text) {
    if (!text.trim() || askBusy) return;
    if (!(await ensureKey())) return;
    const log = $('#ask-log');
    const ids = scopeIds();
    const scopeKey = $('#ask-scope').value + ':' + ids.join(',');
    if (state.ask.scopeKey && state.ask.scopeKey !== scopeKey) {
      // Reference numbers depend on the scope; start over when it changes.
      state.ask.history = [];
      log.innerHTML = '';
    }
    state.ask.scopeKey = scopeKey;
    const history = [...state.ask.history, { role: 'user', content: text.trim() }];
    addMsg(log, 'user', text.trim(), { raw: true });
    $('#ask-text').value = '';
    suggestions($('#ask-suggest'), [], () => {});
    askBusy = true;
    const r = await streamInto(log, (reqId) => api.askLibrary(ids, history, reqId), { refs: true });
    askBusy = false;
    if (r) {
      state.ask.history = [...history, { role: 'assistant', content: r.text }];
      state.ask.refs = r.refs;
    }
  }

  $('#btn-ask').onclick = openAsk;
  $('#ask-close').onclick = () => $('#ask-drawer').classList.add('hidden');
  $('#ask-form').addEventListener('submit', (e) => { e.preventDefault(); sendAsk($('#ask-text').value); });
  $('#ask-text').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendAsk(e.target.value); } });
  $('#ask-clear').onclick = () => {
    state.ask = { history: [], refs: [] };
    $('#ask-log').innerHTML = '';
    suggestions($('#ask-suggest'), LIB_SUGGESTIONS, (s) => sendAsk(s));
  };
  $('#ask-log').addEventListener('click', (e) => {
    const a = e.target.closest('.ref-link');
    if (!a) return;
    e.preventDefault();
    const id = state.ask.refs[Number(a.dataset.ref) - 1];
    if (!id || !itemById(id)) return toast('That reference is no longer in your library.');
    if (!visibleItems().some((i) => i.id === id)) { state.search = ''; $('#search').value = ''; state.searchHits = null; setView({ kind: 'all' }); }
    selectRow(id);
    document.querySelector(`#rows tr[data-id="${id}"]`)?.scrollIntoView({ block: 'center' });
  });
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[target="_blank"]');
    if (a) { e.preventDefault(); api.openExternal(a.href); }
  });

  // -------------------------------------------------------------------------
  // Import

  function reportImport(results) {
    if (!results || !results.length) return;
    const added = results.filter((r) => r.id && !r.duplicate && !r.error);
    const dups = results.filter((r) => r.duplicate);
    const errs = results.filter((r) => r.error);
    const warns = results.filter((r) => r.warnings && r.warnings.length);
    const parts = [];
    if (added.length) parts.push(`Added ${added.length} reference${added.length === 1 ? '' : 's'}`);
    if (dups.length) parts.push(`${dups.length} already in library`);
    if (errs.length) parts.push(`${errs.length} failed`);
    toast(parts.join(' · ') || 'Nothing imported', errs.length ? 'error' : '');
    for (const r of errs) toast(`${r.file}: ${r.error}`, 'error');
    for (const r of warns.slice(0, 3)) toast(`${r.file}: ${r.warnings[0]}`);
    const first = added[0] || dups[0];
    if (first) {
      setView({ kind: 'all' });
      selectRow(first.id);
    }
  }

  api.onImportProgress((p) => {
    $('#status').innerHTML = p.finished ? '' : `<span class="spinner"></span> Importing ${p.done + 1} of ${p.total}: ${esc(p.file)} — reading and identifying…`;
  });

  $('#btn-add-pdf').onclick = async () => reportImport(await attempt(() => api.importPdfDialog()));
  $('#btn-import-refs').onclick = async () => reportImport(await attempt(() => api.importRefsDialog()));
  $('#btn-add-id').onclick = async () => {
    const s = await prompt('Add by identifier', 'DOI, DOI link, or arXiv id', '', '10.1038/nature14539  or  2106.09685');
    if (!s) return;
    $('#status').innerHTML = '<span class="spinner"></span> Looking up…';
    const r = await attempt(() => api.importIdentifier(s));
    $('#status').textContent = '';
    if (r) {
      toast(r.duplicate ? 'Already in your library' : `Added “${r.item.title}”`);
      setView({ kind: 'all' });
      selectRow(r.item.id);
    }
  };

  let dragDepth = 0;
  const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
  window.addEventListener('dragenter', (e) => { if (hasFiles(e)) { dragDepth++; $('#drop-overlay').classList.remove('hidden'); } });
  window.addEventListener('dragleave', (e) => { if (hasFiles(e) && --dragDepth <= 0) { dragDepth = 0; $('#drop-overlay').classList.add('hidden'); } });
  window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('drop', async (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    $('#drop-overlay').classList.add('hidden');
    const docx = [...e.dataTransfer.files].find((f) => /\.docx$/i.test(f.name));
    if (docx) return window.Checker.checkFile(docx);
    const files = [...e.dataTransfer.files].filter((f) => /\.(pdf|bib|ris)$/i.test(f.name));
    if (!files.length) return toast('Drop PDF, .bib, .ris or .docx files.', 'error');
    reportImport(await attempt(() => api.importFiles(files)));
  });

  // -------------------------------------------------------------------------
  // Collections

  $('#btn-new-collection').onclick = async () => {
    const n = await prompt('New collection', 'Name', '', 'e.g. Thesis — Chapter 2');
    if (n) attempt(() => api.addCollection(n));
  };

  // -------------------------------------------------------------------------
  // Settings

  async function openSettings() {
    const s = state.settings;
    const body = document.createElement('div');
    body.innerHTML = `
      <label>Anthropic API key
        <input type="password" id="s-key" placeholder="${s.hasApiKey ? `Saved (${esc(s.apiKeyHint)}) — paste a new key to replace` : 'sk-ant-…'}" ${s.apiKeyFromEnv ? 'disabled' : ''} />
      </label>
      <div class="note">${s.apiKeyFromEnv ? 'Using the ANTHROPIC_API_KEY environment variable.' : 'Get a key at console.anthropic.com. ' + (s.keyEncrypted || !s.hasApiKey ? 'It is stored encrypted with your system keychain.' : 'Stored in the app settings file.')}
        Your PDFs are sent to Anthropic only when you use an AI feature.</div>
      <label>AI model
        <select id="s-model">${s.models.map((m) => `<option value="${m.id}" ${m.id === s.model ? 'selected' : ''}>${esc(m.label)}</option>`).join('')}</select>
      </label>
      <label>Default citation style
        <select id="s-style">${Object.entries(s.styles).map(([k, v]) => `<option value="${k}" ${k === s.citationStyle ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select>
      </label>
      <label class="check"><input type="checkbox" id="s-online" ${s.onlineLookup ? 'checked' : ''}/> Look up metadata online (Crossref, arXiv)</label>
      <label class="check"><input type="checkbox" id="s-autometa" ${s.autoMetadata ? 'checked' : ''}/> Use AI to extract metadata when no DOI is found</label>
      <label class="check"><input type="checkbox" id="s-autosum" ${s.autoSummarize ? 'checked' : ''}/> Summarize new PDFs automatically</label>
      <div class="note">Library folder: ${esc(s.dataDir)} <button class="link" id="s-open-dir" type="button">Open</button></div>`;
    body.querySelector('#s-open-dir').onclick = () => api.openDataDir();
    const result = await modal({
      title: 'Settings',
      body,
      actions: [
        { label: 'Cancel' },
        {
          label: 'Save',
          primary: true,
          value: (b) => ({
            ...(b.querySelector('#s-key').value.trim() ? { apiKey: b.querySelector('#s-key').value.trim() } : {}),
            model: b.querySelector('#s-model').value,
            citationStyle: b.querySelector('#s-style').value,
            onlineLookup: b.querySelector('#s-online').checked,
            autoMetadata: b.querySelector('#s-autometa').checked,
            autoSummarize: b.querySelector('#s-autosum').checked,
          }),
        },
      ],
    });
    if (!result) return;
    const updated = await attempt(() => api.updateSettings(result));
    if (!updated) return;
    state.settings = updated;
    $('#d-style').value = updated.citationStyle;
    if (result.apiKey) {
      toast('Checking API key…');
      const ok = await attempt(() => api.testKey(), 'API key check failed: ');
      if (ok !== undefined) toast('API key works ✓');
    } else toast('Settings saved');
    renderDetail(false);
  }
  $('#btn-settings').onclick = openSettings;

  window.App = { toast, modal, attempt, esc, get settings() { return state.settings; } };

  // -------------------------------------------------------------------------
  // Boot

  async function init() {
    state.settings = await api.getSettings();
    $('#d-style').innerHTML = Object.entries(STYLES).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('');
    $('#d-style').value = state.settings.citationStyle;
    api.onLibraryChanged(applySnapshot);
    applySnapshot(await api.getLibrary());
    const first = visibleItems()[0];
    if (first) selectRow(first.id);
    if (!state.settings.hasApiKey && state.items.length === 0) {
      setTimeout(() => toast('Tip: add your Anthropic API key in Settings (⚙) to enable AI summaries, chat and metadata extraction.'), 800);
    }
  }

  init();
})();
