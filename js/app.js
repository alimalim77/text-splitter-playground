(() => {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  /* ------------------------------------------------------------------ data */

  const SAMPLES = {
    Article:
      'Large language models can only read a limited amount of text at once. Before a document can be searched, it has to be cut into smaller pieces called chunks.\n\n' +
      'The simplest strategy is to cut on one separator, such as a blank line. It is fast and predictable, but it has a weakness: a long paragraph with no blank line inside it stays in one piece, no matter how big it is.\n\n' +
      'A recursive splitter is more careful. It tries the biggest boundary first, paragraphs, and only when a piece is still too large does it fall back to lines, then words, then single characters.\n\n' +
      'Good chunks keep related sentences together. That is why overlap exists: repeating a little text from the end of one chunk at the start of the next keeps context from being lost at the cut.',
    Markdown:
      '# Vector search in five minutes\n\n' +
      'Vector search finds text by meaning instead of exact words.\n\n' +
      '## Step 1: Embed\n\n' +
      'Turn every chunk into a list of numbers with an embedding model.\nChunks about similar things end up close together.\n\n' +
      '## Step 2: Store\n\n' +
      '- Keep the vector\n- Keep the original text\n- Keep metadata such as the source file and page\n\n' +
      '## Step 3: Retrieve\n\n' +
      'Embed the question, find the nearest chunks, and hand them to the model as context. If the chunks were cut badly, the answer will be too.',
    'Python code':
      'def load(path):\n    with open(path) as f:\n        return f.read()\n\n\n' +
      'def embed(chunks, model):\n    vectors = []\n    for chunk in chunks:\n        vectors.append(model.encode(chunk))\n    return vectors\n\n\n' +
      'class Index:\n    def __init__(self):\n        self.items = []\n\n' +
      '    def add(self, vector, text):\n        self.items.append((vector, text))\n\n' +
      '    def search(self, query, k=3):\n        scored = sorted(self.items, key=lambda it: distance(it[0], query))\n        return [text for _, text in scored[:k]]',
    'No blank lines':
      'This sample is one long paragraph with no blank lines anywhere in it, which makes it a useful stress test. ' +
      'A splitter that only knows how to cut on blank lines has nothing to cut on here, so it has to return the whole thing as a single oversized chunk. ' +
      'A recursive splitter notices that the paragraph separator is missing, moves down its ladder to the next separator, and keeps going until the pieces are small enough. ' +
      'Switch between the two splitters with this sample loaded and compare what comes out.',
  };

  const DEFAULT_LADDER = ['\n\n', '\n', ' ', ''];
  const CHAR_SEPS = ['\n\n', '\n', '. ', ' ', ''];

  const state = {
    mode: 'recursive',
    text: SAMPLES.Article,
    chunkSize: 120,
    overlap: 20,
    charSep: '\n\n',
    ladder: DEFAULT_LADDER.slice(),
    showWs: false,
    view: 'chunks',
    step: 0,
  };

  let result = { chunks: [], events: [], truncated: false };
  let timer = null;
  let startStep = 0;

  /* --------------------------------------------------------------- helpers */

  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const showSep = (s) => JSON.stringify(s);
  const parseSep = (raw) => raw.replace(/\\(n|t|r|\\)/g, (m, c) => ({ n: '\n', t: '\t', r: '\r', '\\': '\\' }[c]));
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const WS = { ' ': '·', '\t': '→\t', '\n': '↵\n' };

  function fmt(s) {
    const h = esc(s);
    return state.showWs ? h.replace(/[ \t\n]/g, (c) => `<span class="ws">${WS[c]}</span>`) : h;
  }

  function preview(s, max = 46) {
    const flat = s.replace(/\n/g, '↵');
    return `<q>${esc(flat.length > max ? flat.slice(0, max) + '…' : flat)}</q>`;
  }

  /**
   * Paint `text` with a set of possibly overlapping layers.
   * A layer is { start, end, cls?, k? } where k is a chunk index (gives colour).
   */
  function paint(text, layers) {
    const cuts = new Set([0, text.length]);
    for (const l of layers) {
      if (l.end <= l.start) continue;
      cuts.add(Math.max(0, l.start));
      cuts.add(Math.min(text.length, l.end));
    }
    const pts = [...cuts].sort((a, b) => a - b);
    let html = '';
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      const cls = [];
      const ks = [];
      for (const l of layers) {
        if (l.start <= a && l.end >= b && l.end > l.start) {
          if (l.k != null) ks.push(l.k);
          if (l.cls) cls.push(l.cls);
        }
      }
      let attr = '';
      if (ks.length === 1) {
        cls.push('ck', 'k' + (ks[0] % 6));
        attr = ` data-chunks="${ks[0]}"`;
      } else if (ks.length > 1) {
        const first = ks[0];
        const last = ks[ks.length - 1];
        cls.push('ck', 'ov');
        attr = ` data-chunks="${ks.join(' ')}" style="--a:var(--k${first % 6});--b:var(--k${last % 6})"`;
      }
      const body = fmt(text.slice(a, b));
      html += cls.length ? `<span class="${cls.join(' ')}"${attr}>${body}</span>` : body;
    }
    return html;
  }

  function run(mode, trace) {
    const base = { chunkSize: state.chunkSize, chunkOverlap: state.overlap, trace };
    return mode === 'character'
      ? Splitter.splitCharacter(state.text, { ...base, separator: state.charSep })
      : Splitter.splitRecursive(state.text, { ...base, separators: state.ladder });
  }

  function summarise(chunks) {
    const lens = chunks.map((c) => c.text.length);
    const wordChar = /[\p{L}\p{N}]/u;
    let overlap = 0;
    let midWord = 0;
    chunks.forEach((c, i) => {
      if (i > 0) overlap += Math.max(0, chunks[i - 1].end - c.start);
      const before = state.text[c.end - 1];
      const after = state.text[c.end];
      if (before && after && wordChar.test(before) && wordChar.test(after)) midWord++;
    });
    return {
      count: chunks.length,
      avg: lens.length ? Math.round(lens.reduce((a, b) => a + b, 0) / lens.length) : 0,
      max: lens.length ? Math.max(...lens) : 0,
      oversize: chunks.filter((c) => c.oversize).length,
      overlap,
      midWord,
    };
  }

  /* ---------------------------------------------------------------- render */

  function renderControls() {
    $$('input[name="mode"]').forEach((r) => (r.checked = r.value === state.mode));
    $('#sepCharField').hidden = state.mode !== 'character';
    $('#sepRecField').hidden = state.mode !== 'recursive';

    $('#chunkSize').value = Math.min(state.chunkSize, 500);
    $('#chunkSizeNum').value = state.chunkSize;
    $('#overlap').max = Math.min(Math.max(state.chunkSize - 1, 0), 500);
    $('#overlap').value = state.overlap;
    $('#overlapNum').value = state.overlap;

    const seps = CHAR_SEPS.includes(state.charSep) ? CHAR_SEPS : [...CHAR_SEPS, state.charSep];
    $('#sepChar').innerHTML = seps
      .map((s, i) => `<button type="button" class="chip mono${s === state.charSep ? ' on' : ''}" data-i="${i}">${esc(showSep(s))}</button>`)
      .join('');
    $('#sepChar').dataset.seps = JSON.stringify(seps);

    $('#ladderEdit').innerHTML = state.ladder
      .map(
        (s, i) =>
          `${i ? '<span class="arrow">→</span>' : ''}<span class="rung">` +
          `<button type="button" data-act="left" data-i="${i}" title="Move earlier"${i === 0 ? ' disabled' : ''}>‹</button>` +
          `<b>${esc(showSep(s))}</b>` +
          `<button type="button" data-act="right" data-i="${i}" title="Move later"${i === state.ladder.length - 1 ? ' disabled' : ''}>›</button>` +
          `<button type="button" data-act="del" data-i="${i}" title="Remove"${state.ladder.length === 1 ? ' disabled' : ''}>×</button>` +
          `</span>`
      )
      .join('');

    $$('.tabs button').forEach((b) => b.setAttribute('aria-selected', b.dataset.view === state.view));
    $$('.view').forEach((v) => (v.hidden = v.id !== 'view-' + state.view));
    $('#padCount').textContent = `${state.text.length.toLocaleString()} characters`;
  }

  function renderCode() {
    const lines =
      state.mode === 'character'
        ? [
            'from langchain_text_splitters import CharacterTextSplitter',
            '',
            'splitter = CharacterTextSplitter(',
            `    separator=${showSep(state.charSep)},`,
            `    chunk_size=${state.chunkSize},`,
            `    chunk_overlap=${state.overlap},`,
            ')',
          ]
        : [
            'from langchain_text_splitters import RecursiveCharacterTextSplitter',
            '',
            'splitter = RecursiveCharacterTextSplitter(',
            `    separators=[${state.ladder.map(showSep).join(', ')}],`,
            `    chunk_size=${state.chunkSize},`,
            `    chunk_overlap=${state.overlap},`,
            ')',
          ];
    lines.push('chunks = splitter.split_text(text)', `# -> ${plural(result.chunks.length, 'chunk')}`);
    $('#code').textContent = lines.join('\n');
  }

  function renderStats() {
    const s = summarise(result.chunks);
    const cell = (value, label, bad) => `<div class="stat${bad ? ' bad' : ''}"><b>${value}</b><span>${label}</span></div>`;
    $('#stats').innerHTML =
      cell(s.count, 'chunks') +
      cell(s.avg, 'average length') +
      cell(s.max, `longest (limit ${state.chunkSize})`, s.max > state.chunkSize) +
      cell(s.oversize, 'over the limit', s.oversize > 0) +
      cell(s.overlap, 'overlapping chars');

    const tips = [];
    if (!state.text.trim()) {
      tips.push(['', 'The editor pad is empty. Type something or pick a sample.']);
    } else if (state.mode === 'character') {
      const sep = state.charSep;
      if (sep !== '' && !state.text.includes(sep)) {
        tips.push(['warn', `The separator <code>${esc(showSep(sep))}</code> never appears in this text, so there is nothing to cut on and the whole text comes back as one chunk.`]);
      } else if (s.oversize) {
        tips.push(['warn', `${plural(s.oversize, 'chunk')} ${s.oversize === 1 ? 'is' : 'are'} bigger than chunk_size. The character splitter only cuts at <code>${esc(showSep(sep))}</code>, so a piece with no separator inside it can never be made smaller. Switch to the recursive splitter to see the difference.`]);
      } else {
        tips.push(['good', `Every chunk fits. That holds only because each piece between <code>${esc(showSep(sep))}</code> separators happens to be at most ${state.chunkSize} characters.`]);
      }
    } else {
      const deepest = result.events.reduce((best, e) => (e.frame.sep != null && e.frame.depth > best.depth ? e.frame : best), { depth: -1 });
      if (s.oversize) {
        tips.push(['warn', `${plural(s.oversize, 'chunk')} ${s.oversize === 1 ? 'is' : 'are'} bigger than chunk_size because the ladder ran out of separators. Add <code>""</code> as the last rung to guarantee every chunk fits.`]);
      } else if (deepest.depth >= 0) {
        tips.push(['good', `Every chunk fits. To get there the splitter went ${deepest.depth === 0 ? 'no deeper than the first level' : plural(deepest.depth, 'level') + ' deep'}, down to the separator <code>${esc(showSep(deepest.sep))}</code>.`]);
      }
    }
    if (s.midWord) {
      tips.push(['warn', `${plural(s.midWord, 'chunk')} ${s.midWord === 1 ? 'ends' : 'end'} in the middle of a word.`]);
    }
    if (state.overlap > 0 && s.count > 1 && s.overlap === 0) {
      tips.push(['', `chunk_overlap is ${state.overlap}, but no chunks overlap. Overlap is built from whole pieces: if the last piece of a chunk is longer than ${state.overlap} characters, nothing is carried over.`]);
    }
    if (result.truncated) {
      tips.push(['', `Step through is capped at ${Splitter.MAX_EVENTS.toLocaleString()} steps for this input. The chunks shown are still complete.`]);
    }
    $('#insights').innerHTML = tips.map(([cls, html]) => `<li class="${cls}">${html}</li>`).join('');
  }

  function renderChunks() {
    const { chunks } = result;
    const layers = chunks.map((c) => ({ start: c.start, end: c.end, k: c.index }));
    $('#textOut').innerHTML = state.text ? paint(state.text, layers) : '<span class="empty">Nothing to split yet.</span>';

    $('#cards').innerHTML = chunks
      .map((c, i) => {
        const shared = i > 0 ? Math.max(0, Math.min(chunks[i - 1].end - c.start, c.text.length)) : 0;
        const body = shared ? `<mark>${fmt(c.text.slice(0, shared))}</mark>${fmt(c.text.slice(shared))}` : fmt(c.text);
        const pct = Math.min(100, (c.text.length / state.chunkSize) * 100);
        return (
          `<article class="card${c.oversize ? ' over' : ''}" data-chunk="${i}">` +
          `<header class="k${i % 6}"><span>Chunk ${i + 1}</span><span class="len">${c.text.length} / ${state.chunkSize}</span></header>` +
          `<div class="bar"><i style="width:${pct}%"></i></div>` +
          `<pre>${body}</pre>` +
          `<footer>${shared ? `first ${shared} chars repeat chunk ${i}` : i ? 'no overlap with previous' : 'first chunk'}${c.oversize ? ' · over the limit' : ''}</footer>` +
          `</article>`
        );
      })
      .join('');
  }

  /* ----------------------------------------------------------- step through */

  function narrate(ev) {
    const f = ev.frame;
    const size = state.chunkSize;
    const sep = f.sep == null ? '' : `<code>${esc(showSep(f.sep))}</code>`;
    const n = ev.chunkCount;
    switch (ev.type) {
      case 'split': {
        const count = plural(f.pieces.length, 'piece');
        if (state.mode === 'character') {
          return ev.found
            ? [`Split the whole text on ${sep}`, `That gives ${count}. The separator itself is thrown away here and put back between pieces when they are merged into a chunk.`]
            : [`Look for ${sep}`, `It never appears, so the whole text is a single piece. There is no other separator to fall back on.`];
        }
        const skipped = f.skipped.length ? `${f.skipped.map((s) => `<code>${esc(showSep(s))}</code>`).join(', ')} ${f.skipped.length === 1 ? 'does' : 'do'} not appear in this section, so move down the ladder. ` : '';
        const scope = f.depth === 0 ? 'the whole text' : `this ${f.scope[1] - f.scope[0]}-character section`;
        if (f.sep === '') return [`Level ${f.depth}: last resort, split into single characters`, `${skipped}Nothing coarser is left, so ${scope} becomes ${count} of one character each. They will be packed back together up to chunk_size.`];
        if (!ev.found) return [`Level ${f.depth}: no separator matches`, `${skipped}The ladder is exhausted, so ${scope} stays as one piece.`];
        return [`Level ${f.depth}: split on ${sep}`, `${skipped}Splitting ${scope} gives ${count}. Each separator stays attached to the start of the piece after it, so no text is lost.`];
      }
      case 'add':
        return ev.over
          ? [`Add piece to the buffer`, `${preview(ev.piece.text)} is ${ev.piece.text.length} characters, which is already more than chunk_size (${size}). This splitter has no way to cut inside a piece, so it will go out as an oversized chunk.`]
          : [`Add piece to the buffer`, `${preview(ev.piece.text)} (${ev.piece.text.length} chars) fits. The buffer now holds ${plural(ev.buffer.count, 'piece')}, ${ev.total} of ${size} characters.`];
      case 'emit':
        if (!ev.chunk) return [`Buffer holds only whitespace`, `After trimming there is nothing left, so no chunk is produced.`];
        return ev.final
          ? [`No more pieces: emit chunk ${n}`, `Whatever is left in the buffer is joined and emitted. Chunk ${n} is ${ev.chunk.text.length} characters after trimming whitespace.`]
          : [`Buffer is full: emit chunk ${n}`, `The next piece ${preview(ev.next.text, 28)} (${ev.next.text.length} chars) would push the buffer from ${ev.total} past ${size}. So the buffer is joined and emitted as chunk ${n} (${ev.chunk.text.length} chars after trimming).`];
      case 'trim': {
        const dropped = ev.dropped ? ev.dropped.count : 0;
        return ev.buffer
          ? [`Keep the tail as overlap`, `Dropped ${plural(dropped, 'piece')} from the front. The last ${plural(ev.buffer.count, 'piece')} (${ev.total} chars) fit inside chunk_overlap (${state.overlap}) and still leave room for the next piece, so they stay and will open the next chunk too.`]
          : [`Nothing kept as overlap`, state.overlap === 0 ? `chunk_overlap is 0, so the buffer is emptied and the next chunk starts fresh.` : `The buffer is emptied: no tail of whole pieces fits within chunk_overlap (${state.overlap}) while leaving room for the next piece. The next chunk starts fresh.`];
      }
      case 'recurse':
        return [`Piece too big: go one level deeper`, `${preview(ev.piece.text)} is ${ev.piece.text.length} characters, not under chunk_size (${size}). Only this piece gets re-split, using the rest of the ladder: ${f.next.map((s) => `<code>${esc(showSep(s))}</code>`).join(', ')}.`];
      case 'raw':
        return [`Too big, and out of separators: emit chunk ${n} as is`, `${preview(ev.piece.text)} is ${ev.piece.text.length} characters but there is nothing finer left on the ladder to split it with, so it becomes an oversized chunk.`];
      default:
        return [`Done: ${plural(result.chunks.length, 'chunk')}`, `Every piece has been placed. Open the Chunks tab to inspect them, or change a setting and step through again.`];
    }
  }

  function renderSteps() {
    const events = result.events;
    if (!events.length) return;
    state.step = Math.max(0, Math.min(state.step, events.length - 1));
    const ev = events[state.step];
    const f = ev.frame;

    $('#stepSlider').max = events.length - 1;
    $('#stepSlider').value = state.step;
    $('#stepLabel').textContent = `step ${state.step + 1} of ${events.length}`;
    $('#stepPrev').disabled = $('#stepFirst').disabled = state.step === 0;
    $('#stepNext').disabled = state.step === events.length - 1;
    $('#stepNextChunk').disabled = !events.slice(state.step + 1).some(isChunkEvent);
    $('#stepPlay').textContent = timer ? '⏸ Pause' : '▶ Play';

    // Separator ladder
    const ladder = state.mode === 'character' ? [state.charSep] : state.ladder;
    const activeAt = ladder.indexOf(f.sep);
    $('#ladder').innerHTML =
      `<span class="lab">${state.mode === 'character' ? 'separator' : 'ladder'}</span>` +
      ladder
        .map((s, i) => {
          const cls = i === activeAt ? 'active' : f.skipped.includes(s) ? 'skip' : activeAt > -1 && i < activeAt ? 'used' : '';
          return `${i ? '<span class="arrow">→</span>' : ''}<span class="r ${cls}">${esc(showSep(s))}</span>`;
        })
        .join('') +
      (state.mode === 'recursive' ? `<span class="depth">recursion level ${f.depth}</span>` : '');

    const [title, body] = narrate(ev);
    $('#narr').innerHTML = `<h3>${title}</h3><p>${body}</p>`;

    // Buffer meter
    const total = ev.type === 'add' || ev.type === 'trim' || ev.type === 'emit' ? ev.total : 0;
    const count = ev.buffer ? ev.buffer.count : 0;
    $('#meter').innerHTML =
      `<div class="row"><span>buffer: ${total} / ${state.chunkSize} chars · ${plural(count, 'piece')}</span><span>chunk_size ${state.chunkSize}</span></div>` +
      `<div class="track"><div class="fill${total > state.chunkSize ? ' over' : ''}" style="width:${Math.min(100, (total / state.chunkSize) * 100)}%"></div>` +
      (state.overlap > 0 ? `<div class="mark" style="left:${(state.overlap / state.chunkSize) * 100}%"><span>overlap ${state.overlap}</span></div>` : '') +
      `</div>`;

    // Text
    const layers = [];
    result.chunks.slice(0, ev.chunkCount).forEach((c) => {
      const fresh = (ev.type === 'emit' || ev.type === 'raw') && ev.chunk === c;
      layers.push({ start: c.start, end: c.end, k: c.index, cls: fresh ? 'fresh' : '' });
    });
    layers.push({ start: f.scope[0], end: f.scope[1], cls: 'scope' });
    if (ev.type === 'split' && f.pieces.length <= 600) {
      f.pieces.forEach((p, i) => layers.push({ start: p.start, end: p.end, cls: 'p' + (i % 2) }));
    }
    if (ev.buffer && ev.type !== 'emit') layers.push({ start: ev.buffer.start, end: ev.buffer.end, cls: 'buf' });
    if (ev.dropped) layers.push({ start: ev.dropped.start, end: ev.dropped.end, cls: 'dropped' });
    if (ev.piece && ev.type !== 'trim') layers.push({ start: ev.piece.start, end: ev.piece.end, cls: 'cur' });

    const box = $('#stepText');
    box.innerHTML = paint(state.text, layers);
    const focus = $('.cur, .fresh, .dropped, .buf, .p0', box);
    if (focus) {
      const top = focus.offsetTop;
      if (top < box.scrollTop + 20 || top > box.scrollTop + box.clientHeight - 60) {
        box.scrollTop = Math.max(0, top - box.clientHeight / 3);
      }
    }
  }

  const isChunkEvent = (e) => (e.type === 'emit' && e.chunk) || e.type === 'raw';

  function stopPlay() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  function goTo(step) {
    state.step = step;
    renderSteps();
  }

  function togglePlay() {
    if (timer) {
      stopPlay();
    } else {
      if (state.step >= result.events.length - 1) state.step = 0;
      timer = setInterval(() => {
        if (state.step >= result.events.length - 1) stopPlay();
        else state.step++;
        renderSteps();
      }, Number($('#stepSpeed').value));
    }
    renderSteps();
  }

  /* --------------------------------------------------------------- compare */

  function renderCompare() {
    const rows = [
      ['character', 'Character splitter', `separator ${showSep(state.charSep)}`],
      ['recursive', 'Recursive character splitter', `separators ${state.ladder.map(showSep).join(' → ')}`],
    ].map(([mode, name, detail]) => {
      const chunks = mode === state.mode ? result.chunks : run(mode, false).chunks;
      return { mode, name, detail, chunks, s: summarise(chunks) };
    });
    const tallest = Math.max(state.chunkSize, ...rows.map((r) => r.s.max)) * 1.12;

    const html = rows
      .map(
        (r) =>
          `<div class="cmp${r.mode === state.mode ? ' current' : ''}">` +
          `<div class="cmp-head"><h3>${r.name}</h3><span><code>${esc(r.detail)}</code></span></div>` +
          `<div class="cmp-head" style="margin-top:6px">` +
          `<span><b>${r.s.count}</b> chunks</span><span><b>${r.s.avg}</b> average</span><span><b>${r.s.max}</b> longest</span>` +
          `<span class="${r.s.oversize ? 'bad' : ''}"><b>${r.s.oversize}</b> over the limit</span>` +
          `<span class="${r.s.midWord ? 'bad' : ''}"><b>${r.s.midWord}</b> cut mid-word</span></div>` +
          `<div class="bars">` +
          r.chunks.map((c) => `<i class="${c.oversize ? 'over' : ''}" style="height:${(c.text.length / tallest) * 100}%" title="Chunk ${c.index + 1}: ${c.text.length} chars"></i>`).join('') +
          `<div class="limit" style="bottom:${(state.chunkSize / tallest) * 100}%"><span>${state.chunkSize}</span></div>` +
          `</div></div>`
      )
      .join('');

    const [ch, re] = rows.map((r) => r.s);
    let verdict;
    if (!state.text.trim()) verdict = 'Add some text to compare the two splitters.';
    else if (ch.oversize && !re.oversize) verdict = `The character splitter leaves ${plural(ch.oversize, 'chunk')} over the limit (longest ${ch.max}). The recursive splitter keeps every chunk at or under ${state.chunkSize} by falling back to finer separators.`;
    else if (!ch.oversize && !re.oversize) verdict = 'Both respect chunk_size on this text. The character splitter only manages it because its pieces happen to be small enough; the recursive splitter would cope with any text.';
    else verdict = 'Both produce oversized chunks here. For the recursive splitter that means the ladder has no fine enough separator: add "" as the last rung.';
    $('#compare').innerHTML = html + `<p class="verdict">${esc(verdict)}</p>`;
  }

  /* ---------------------------------------------------------------- update */

  function update({ keepStep = false } = {}) {
    state.chunkSize = Math.max(1, Math.min(5000, Math.floor(state.chunkSize) || 1));
    state.overlap = Math.max(0, Math.min(Math.floor(state.overlap) || 0, state.chunkSize - 1));
    stopPlay();
    result = run(state.mode, true);
    if (!keepStep) state.step = 0;
    renderControls();
    renderCode();
    renderStats();
    if (state.view === 'chunks') renderChunks();
    if (state.view === 'steps') renderSteps();
    if (state.view === 'compare') renderCompare();
    try {
      localStorage.setItem('chunklab', JSON.stringify({ ...state, step: 0 }));
    } catch (e) { /* storage unavailable: the page works without it */ }
  }

  /* ---------------------------------------------------------------- events */

  function bind() {
    $('#samples').innerHTML = Object.keys(SAMPLES)
      .map((name) => `<button type="button" class="chip" data-sample="${esc(name)}">${esc(name)}</button>`)
      .join('');
    $('#samples').addEventListener('click', (e) => {
      const name = e.target.dataset.sample;
      if (!name) return;
      state.text = SAMPLES[name];
      $('#pad').value = state.text;
      update();
    });

    $('#pad').addEventListener('input', (e) => {
      state.text = e.target.value;
      update();
    });

    $$('input[name="mode"]').forEach((r) =>
      r.addEventListener('change', () => {
        state.mode = r.value;
        update();
      })
    );

    const num = (id, key) =>
      $(id).addEventListener('input', (e) => {
        if (e.target.value === '') return;
        state[key] = Number(e.target.value);
        update();
      });
    num('#chunkSize', 'chunkSize');
    num('#overlap', 'overlap');
    $('#chunkSizeNum').addEventListener('change', (e) => { state.chunkSize = Number(e.target.value); update(); });
    $('#overlapNum').addEventListener('change', (e) => { state.overlap = Number(e.target.value); update(); });

    $('#sepChar').addEventListener('click', (e) => {
      if (e.target.dataset.i == null) return;
      state.charSep = JSON.parse($('#sepChar').dataset.seps)[Number(e.target.dataset.i)];
      update();
    });
    const useCustom = () => {
      const raw = $('#sepCustom').value;
      if (raw === '') return;
      state.charSep = parseSep(raw);
      $('#sepCustom').value = '';
      update();
    };
    $('#sepCustomBtn').addEventListener('click', useCustom);
    $('#sepCustom').addEventListener('keydown', (e) => e.key === 'Enter' && useCustom());

    $('#ladderEdit').addEventListener('click', (e) => {
      const { act, i } = e.target.dataset;
      if (!act) return;
      const at = Number(i);
      const l = state.ladder;
      if (act === 'del' && l.length > 1) l.splice(at, 1);
      if (act === 'left' && at > 0) [l[at - 1], l[at]] = [l[at], l[at - 1]];
      if (act === 'right' && at < l.length - 1) [l[at + 1], l[at]] = [l[at], l[at + 1]];
      update();
    });
    const addSep = () => {
      const sep = parseSep($('#sepAdd').value);
      $('#sepAdd').value = '';
      if (state.ladder.includes(sep)) return;
      // New rungs go just above "" so the last resort stays last.
      const end = state.ladder.indexOf('');
      if (end === -1 || sep === '') state.ladder.push(sep);
      else state.ladder.splice(end, 0, sep);
      update();
    };
    $('#sepAddBtn').addEventListener('click', addSep);
    $('#sepAdd').addEventListener('keydown', (e) => e.key === 'Enter' && addSep());
    $('#sepReset').addEventListener('click', () => {
      state.ladder = DEFAULT_LADDER.slice();
      update();
    });

    $('#copyCode').addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText($('#code').textContent);
        $('#copyCode').textContent = 'Copied';
      } catch (e) {
        $('#copyCode').textContent = 'Select and copy manually';
      }
      setTimeout(() => ($('#copyCode').textContent = 'Copy'), 1500);
    });

    $$('.tabs button').forEach((b) =>
      b.addEventListener('click', () => {
        state.view = b.dataset.view;
        update({ keepStep: true });
      })
    );
    $('#showWs').addEventListener('change', (e) => {
      state.showWs = e.target.checked;
      update({ keepStep: true });
    });

    // Hover a chunk in the text or its card to find the other one.
    const highlight = (ids) => {
      $$('.hl').forEach((el) => el.classList.remove('hl'));
      ids.forEach((id) => {
        $$(`#textOut [data-chunks~="${id}"]`).forEach((el) => el.classList.add('hl'));
        const card = $(`#cards [data-chunk="${id}"]`);
        if (card) card.classList.add('hl');
      });
    };
    $('#textOut').addEventListener('mouseover', (e) => {
      const el = e.target.closest('[data-chunks]');
      highlight(el ? el.dataset.chunks.split(' ') : []);
    });
    $('#textOut').addEventListener('mouseleave', () => highlight([]));
    $('#textOut').addEventListener('click', (e) => {
      const el = e.target.closest('[data-chunks]');
      const card = el && $(`#cards [data-chunk="${el.dataset.chunks.split(' ')[0]}"]`);
      if (card) card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
    $('#cards').addEventListener('mouseover', (e) => {
      const card = e.target.closest('[data-chunk]');
      highlight(card ? [card.dataset.chunk] : []);
    });
    $('#cards').addEventListener('mouseleave', () => highlight([]));
    $('#cards').addEventListener('click', (e) => {
      const card = e.target.closest('[data-chunk]');
      const el = card && $(`#textOut [data-chunks~="${card.dataset.chunk}"]`);
      if (el) $('#textOut').scrollTop = Math.max(0, el.offsetTop - 40);
    });

    // Stepper
    $('#stepFirst').addEventListener('click', () => { stopPlay(); goTo(0); });
    $('#stepPrev').addEventListener('click', () => { stopPlay(); goTo(state.step - 1); });
    $('#stepNext').addEventListener('click', () => { stopPlay(); goTo(state.step + 1); });
    $('#stepNextChunk').addEventListener('click', () => {
      stopPlay();
      const next = result.events.findIndex((e, i) => i > state.step && isChunkEvent(e));
      if (next !== -1) goTo(next);
    });
    $('#stepPlay').addEventListener('click', togglePlay);
    $('#stepSpeed').addEventListener('change', () => {
      if (timer) { stopPlay(); togglePlay(); }
    });
    $('#stepSlider').addEventListener('input', (e) => { stopPlay(); goTo(Number(e.target.value)); });
    document.addEventListener('keydown', (e) => {
      if (state.view !== 'steps' || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
      if (e.key === 'ArrowRight') { stopPlay(); goTo(state.step + 1); }
      if (e.key === 'ArrowLeft') { stopPlay(); goTo(state.step - 1); }
    });

    $('#themeBtn').addEventListener('click', () => {
      const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      document.documentElement.dataset.theme = next;
      try { localStorage.setItem('chunklab-theme', next); } catch (e) { /* ignore */ }
    });
  }

  function restore() {
    let theme = window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    try {
      theme = localStorage.getItem('chunklab-theme') || theme;
      const saved = JSON.parse(localStorage.getItem('chunklab') || 'null');
      if (saved && typeof saved.text === 'string' && Array.isArray(saved.ladder) && saved.ladder.length) {
        for (const key of Object.keys(state)) if (typeof saved[key] === typeof state[key]) state[key] = saved[key];
      }
    } catch (e) { /* ignore */ }
    // Links can open a specific view: ?mode=character&view=steps&step=12&theme=dark
    const q = new URLSearchParams(location.search);
    if (['character', 'recursive'].includes(q.get('mode'))) state.mode = q.get('mode');
    if (['chunks', 'steps', 'compare'].includes(q.get('view'))) state.view = q.get('view');
    if (['light', 'dark'].includes(q.get('theme'))) theme = q.get('theme');
    startStep = Math.max(0, parseInt(q.get('step'), 10) || 0);
    document.documentElement.dataset.theme = theme;
  }

  restore();
  bind();
  $('#pad').value = state.text;
  $('#showWs').checked = state.showWs;
  state.step = startStep;
  update({ keepStep: true });
})();
