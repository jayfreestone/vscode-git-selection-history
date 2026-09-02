(function () {
  const vscode = acquireVsCodeApi();
  const app = document.getElementById('app');
  let state = { title: 'History for Selection', status: 'ready', entries: [] };
  let selected = 0;
  let pendingFocus = false;
  let tokens = {};          // entry id -> { left: {lineNo: spans}, right: {lineNo: spans} }
  let tokenTimer;
  let firstState = true;

  // Survives the panel being hidden and re-created: { commitsWidth, title, selected }.
  const saved = vscode.getState() || {};
  const remember = patch => vscode.setState(Object.assign(saved, patch));
  if (saved.commitsWidth) { document.documentElement.style.setProperty('--commits-w', saved.commitsWidth + 'px'); }

  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function render() {
    if (state.status === 'loading') {
      app.innerHTML = toolbar('Loading commits...') + '<div class="empty-state">Running git log -L...</div>';
      return;
    }
    if (state.status === 'error') {
      app.innerHTML = toolbar('') + `<div class="empty-state error">${esc(state.message || 'Something went wrong')}</div>`;
      return;
    }
    if (!state.entries.length) {
      app.innerHTML = toolbar('') + '<div class="empty-state">No commits touch the selected lines. Select some lines and run "Git: Show History for Selection".</div>';
      return;
    }
    selected = Math.min(selected, state.entries.length - 1);
    app.innerHTML = toolbar('Up/Down: navigate  Enter: open full diff  Esc: back to editor') + `
      <div class="split">
        <div class="commits" tabindex="0" role="listbox">
          <table><thead><tr><th>Subject</th><th class="author">Author</th><th class="date">Date</th><th class="hash">Hash</th></tr></thead>
          <tbody>${state.entries.map((c, i) => `
            <tr role="option" class="${c.kind}" data-i="${i}" aria-selected="${i === selected}">
              <td title="${esc(c.subject)}">${esc(c.subject)}</td>
              <td class="author" title="${esc(c.author)}">${esc(c.author)}</td>
              <td class="date" title="${esc(c.ago)}">${esc(c.date || c.ago)}</td>
              <td class="hash">${esc(c.short)}</td>
            </tr>`).join('')}
          </tbody></table>
        </div>
        <div class="splitter"></div>
        <div class="detail"><div class="meta"></div><div class="diff"></div></div>
      </div>`;
    renderDetail();
    wire();
    if (pendingFocus) { pendingFocus = false; focusList(); }
  }

  function toolbar(hint) {
    return `<div class="toolbar"><span class="title" title="${esc(state.title)}">${esc(state.title)}</span><span class="hint">${esc(hint)}</span></div>`;
  }

  function describe(c) {
    if (c.kind === 'unstaged') { return 'Working tree vs index (not staged yet). ' + esc(c.right.path); }
    if (c.kind === 'staged') { return 'Index vs HEAD (staged, not committed). ' + esc(c.right.path); }
    const rename = c.left && c.left.path !== c.right.path ? ` (renamed from ${esc(c.left.path)})` : '';
    return `${esc(c.author)} committed ${esc(c.ago)} (${esc(c.date)}) in ${esc(c.short)}${c.parents.length === 0 ? ', initial commit' : ''}. ${esc(c.right.path)}${rename}`;
  }

  function renderDetail() {
    const c = state.entries[selected];
    if (!c) { return; }
    const meta = app.querySelector('.meta');
    meta.innerHTML = `<div class="subject">${esc(c.subject)}</div><div class="sub">${describe(c)}</div>${c.body ? `<div class="body">${esc(c.body)}</div>` : ''}`;
    renderDiff(c);
    for (const tr of app.querySelectorAll('tbody tr[role=option]')) {
      tr.setAttribute('aria-selected', String(+tr.dataset.i === selected));
    }
    const sel = app.querySelector('tbody tr[aria-selected="true"]');
    if (sel) { sel.scrollIntoView({ block: 'nearest' }); }
    if (!tokens[c.id]) { requestTokens(c.id); }
  }

  function renderDiff(c) {
    const tk = tokens[c.id] || { left: {}, right: {} };
    const rows = [];
    for (const h of c.hunks) {
      rows.push(`<tr class="hunk"><td colspan="4">@@ -${h.oldStart},${h.oldLen} +${h.newStart},${h.newLen} @@ ${esc(h.context)}</td></tr>`);
      for (const r of pairRows(h)) {
        rows.push(`<tr>${cell(r.l, tk.left)}${cell(r.r, tk.right)}</tr>`);
      }
    }
    app.querySelector('.diff').innerHTML = `<table>${rows.join('')}</table>`;
  }

  function requestTokens(id) {
    clearTimeout(tokenTimer);
    tokenTimer = setTimeout(() => vscode.postMessage({ type: 'tokens', id }), 50);
  }

  function highlighted(text, spans) {
    if (!spans || !spans.length) { return esc(text) || ' '; }
    return spans.map(([t, color, style]) => {
      const css = (color ? `color:${color};` : '') + (style & 1 ? 'font-style:italic;' : '') + (style & 2 ? 'font-weight:bold;' : '')
        + (style & 4 ? 'text-decoration:underline;' : '') + (style & 8 ? 'text-decoration:line-through;' : '');
      return css ? `<span style="${css}">${esc(t)}</span>` : esc(t);
    }).join('') || ' ';
  }

  function cell(side, spansByLine) {
    if (!side) { return '<td class="no empty"></td><td class="code empty"></td>'; }
    return `<td class="no ${side.kind}">${side.no}</td><td class="code ${side.kind}">${highlighted(side.text, spansByLine && spansByLine[side.no])}</td>`;
  }

  // Pair removed/added runs side by side; context lines align 1:1.
  function pairRows(h) {
    const out = [];
    let oldNo = h.oldStart, newNo = h.newStart, i = 0;
    const lines = h.lines;
    while (i < lines.length) {
      if (lines[i].kind === 'ctx') {
        out.push({ l: { kind: 'ctx', text: lines[i].text, no: oldNo++ }, r: { kind: 'ctx', text: lines[i].text, no: newNo++ } });
        i++;
        continue;
      }
      const dels = [], adds = [];
      while (i < lines.length && lines[i].kind === 'del') { dels.push(lines[i++]); }
      while (i < lines.length && lines[i].kind === 'add') { adds.push(lines[i++]); }
      if (!dels.length && !adds.length) { i++; continue; }
      for (let k = 0; k < Math.max(dels.length, adds.length); k++) {
        out.push({
          l: dels[k] ? { kind: 'del', text: dels[k].text, no: oldNo++ } : null,
          r: adds[k] ? { kind: 'add', text: adds[k].text, no: newNo++ } : null,
        });
      }
    }
    return out;
  }

  function select(i) {
    if (i < 0 || i >= state.entries.length || i === selected) { return; }
    selected = i;
    remember({ selected });
    renderDetail();
  }

  function focusList() {
    const list = app.querySelector('.commits');
    if (list) { list.focus(); }
  }

  function wire() {
    const list = app.querySelector('.commits');
    list.addEventListener('keydown', e => {
      switch (e.key) {
        case 'ArrowDown': select(selected + 1); break;
        case 'ArrowUp': select(selected - 1); break;
        case 'Home': select(0); break;
        case 'End': select(state.entries.length - 1); break;
        case 'PageDown': select(Math.min(selected + 10, state.entries.length - 1)); break;
        case 'PageUp': select(Math.max(selected - 10, 0)); break;
        case 'Enter': vscode.postMessage({ type: 'openDiff', id: state.entries[selected].id }); break;
        case 'Escape': vscode.postMessage({ type: 'focusEditor' }); break;
        default: return;
      }
      e.preventDefault();
    });
    list.addEventListener('click', e => {
      const tr = e.target.closest('tr[role=option]');
      if (tr) { select(+tr.dataset.i); }
    });
    list.addEventListener('dblclick', e => {
      const tr = e.target.closest('tr[role=option]');
      if (tr) { vscode.postMessage({ type: 'openDiff', id: state.entries[+tr.dataset.i].id }); }
    });

    const splitter = app.querySelector('.splitter');
    const commits = app.querySelector('.commits');
    splitter.addEventListener('pointerdown', e => {
      splitter.setPointerCapture(e.pointerId);
      splitter.classList.add('dragging');
      let w;
      const move = ev => {
        w = Math.max(200, ev.clientX - commits.getBoundingClientRect().left);
        document.documentElement.style.setProperty('--commits-w', w + 'px');
      };
      const up = () => {
        if (w) { remember({ commitsWidth: w }); }
        splitter.classList.remove('dragging');
        splitter.removeEventListener('pointermove', move);
        splitter.removeEventListener('pointerup', up);
      };
      splitter.addEventListener('pointermove', move);
      splitter.addEventListener('pointerup', up);
    });
  }

  window.addEventListener('message', e => {
    const msg = e.data;
    if (msg.type === 'state') {
      state = msg.state;
      // A re-created panel restores its row; every later update is a new lookup.
      selected = firstState && state.title === saved.title ? saved.selected || 0 : 0;
      firstState = false;
      remember({ title: state.title, selected });
      tokens = {};
      render();
    } else if (msg.type === 'tokens') {
      tokens[msg.id] = { left: msg.left || {}, right: msg.right || {} };
      const c = state.entries[selected];
      if (c && c.id === msg.id && app.querySelector('.diff')) { renderDiff(c); }
    } else if (msg.type === 'theme') {
      tokens = {};
      const c = state.entries[selected];
      if (c && app.querySelector('.diff')) { renderDetail(); }
    } else if (msg.type === 'focus') {
      if (state.status === 'ready' && state.entries.length) { focusList(); } else { pendingFocus = true; }
    }
  });

  render();
  vscode.postMessage({ type: 'ready' });
})();
