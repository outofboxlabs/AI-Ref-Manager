// Minimal, safe Markdown -> HTML for AI answers. All input is escaped first;
// only a fixed set of constructs is turned back into markup.

(function () {
  'use strict';

  function esc(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function inline(s, opts) {
    let out = esc(s);
    out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
    out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    out = out.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
    out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    if (opts && opts.refs) {
      out = out.replace(/\[#(\d+)\]/g, (m, n) => `<a href="#" class="ref-link" data-ref="${n}">[${n}]</a>`);
    }
    return out;
  }

  function render(md, opts = {}) {
    const lines = String(md || '').replace(/\r\n/g, '\n').split('\n');
    const html = [];
    let list = null; // 'ul' | 'ol'
    let para = [];
    let code = null;

    const flushPara = () => {
      if (para.length) html.push(`<p>${inline(para.join(' '), opts)}</p>`);
      para = [];
    };
    const closeList = () => {
      if (list) html.push(`</${list}>`);
      list = null;
    };

    for (const line of lines) {
      if (code !== null) {
        if (/^```/.test(line)) {
          html.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`);
          code = null;
        } else code.push(line);
        continue;
      }
      if (/^```/.test(line)) { flushPara(); closeList(); code = []; continue; }
      const h = /^(#{1,4})\s+(.*)$/.exec(line);
      if (h) { flushPara(); closeList(); const lvl = Math.min(h[1].length + 2, 6); html.push(`<h${lvl}>${inline(h[2], opts)}</h${lvl}>`); continue; }
      const ul = /^\s*[-*•]\s+(.*)$/.exec(line);
      const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
      if (ul || ol) {
        flushPara();
        const want = ul ? 'ul' : 'ol';
        if (list !== want) { closeList(); html.push(`<${want}>`); list = want; }
        html.push(`<li>${inline((ul || ol)[1], opts)}</li>`);
        continue;
      }
      if (/^\s*>\s?/.test(line)) { flushPara(); closeList(); html.push(`<blockquote>${inline(line.replace(/^\s*>\s?/, ''), opts)}</blockquote>`); continue; }
      if (!line.trim()) { flushPara(); closeList(); continue; }
      if (list) closeList();
      para.push(line.trim());
    }
    if (code !== null) html.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`);
    flushPara();
    closeList();
    return html.join('\n');
  }

  globalThis.Markdown = { render, esc };
})();
