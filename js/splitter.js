/*
 * Text splitters, re-implemented in plain JavaScript so they can be traced.
 *
 * The logic follows LangChain's CharacterTextSplitter and
 * RecursiveCharacterTextSplitter (langchain_text_splitters) step for step:
 *   - CharacterTextSplitter: split on ONE separator, then merge pieces.
 *   - RecursiveCharacterTextSplitter: try a ladder of separators, and re-split
 *     only the pieces that are still too big with the next separator down.
 *
 * Unlike the Python originals, every piece remembers where it came from in the
 * source text (start/end offsets), and every decision is recorded as an event.
 * That is what the visualisation is drawn from.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Splitter = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MAX_EVENTS = 20000;

  /** Split `text` on `sep`. Pieces carry offsets into the original document. */
  function splitOn(text, offset, sep, keep) {
    const out = [];
    const push = (s, e) => {
      if (e > s) out.push({ text: text.slice(s, e), start: offset + s, end: offset + e });
    };
    if (sep === '') {
      // Empty separator = one piece per character (whole code points).
      let i = 0;
      for (const ch of text) {
        push(i, i + ch.length);
        i += ch.length;
      }
      return out;
    }
    let from = 0;
    let pieceStart = 0;
    let idx;
    while ((idx = text.indexOf(sep, from)) !== -1) {
      push(pieceStart, idx);
      // keep = true leaves the separator glued to the start of the next piece.
      pieceStart = keep ? idx : idx + sep.length;
      from = idx + sep.length;
    }
    push(pieceStart, text.length);
    return out;
  }

  function makeChunk(pieces, joiner, strip) {
    let text = pieces.map((p) => p.text).join(joiner);
    let start = pieces[0].start;
    let end = pieces[pieces.length - 1].end;
    if (strip) {
      const lead = text.length - text.trimStart().length;
      const trail = text.length - text.trimEnd().length;
      text = text.trim();
      if (!text) return null;
      start = Math.min(start + lead, end);
      end = Math.max(end - trail, start);
    } else if (!text) {
      return null;
    }
    return { text, start, end, pieces: pieces.length };
  }

  function makeContext(trace) {
    const ctx = {
      chunks: [],
      events: [],
      truncated: false,
      emit(ev, frame) {
        if (!trace) return;
        if (ctx.events.length >= MAX_EVENTS) {
          ctx.truncated = true;
          return;
        }
        ev.frame = frame;
        ev.chunkCount = ctx.chunks.length;
        ctx.events.push(ev);
      },
      addChunk(chunk, cfg) {
        chunk.index = ctx.chunks.length;
        chunk.oversize = chunk.text.length > cfg.chunkSize;
        ctx.chunks.push(chunk);
        return chunk;
      },
    };
    return ctx;
  }

  const span = (buf) =>
    buf.length ? { start: buf[0].start, end: buf[buf.length - 1].end, count: buf.length } : null;

  /**
   * Greedily pack small pieces into chunks of at most chunkSize characters,
   * carrying the tail of each chunk into the next one as overlap.
   * (LangChain: TextSplitter._merge_splits)
   */
  function merge(pieces, joiner, cfg, ctx, frame) {
    const { chunkSize, chunkOverlap } = cfg;
    const joinLen = joiner.length;
    let buf = [];
    let total = 0;

    const flush = (final, next) => {
      const chunk = makeChunk(buf, joiner, cfg.strip);
      if (chunk) ctx.addChunk(chunk, cfg);
      ctx.emit({ type: 'emit', chunk, buffer: span(buf), total, final, next }, frame);
    };

    for (const piece of pieces) {
      const len = piece.text.length;
      if (total + len + (buf.length ? joinLen : 0) > chunkSize && buf.length) {
        flush(false, piece);
        // Drop pieces from the front until what is left fits the overlap
        // budget AND leaves room for the incoming piece.
        const dropped = [];
        while (
          total > chunkOverlap ||
          (total + len + (buf.length ? joinLen : 0) > chunkSize && total > 0)
        ) {
          total -= buf[0].text.length + (buf.length > 1 ? joinLen : 0);
          dropped.push(buf.shift());
        }
        ctx.emit({ type: 'trim', dropped: span(dropped), buffer: span(buf), total, piece }, frame);
      }
      buf.push(piece);
      total += len + (buf.length > 1 ? joinLen : 0);
      ctx.emit({ type: 'add', piece, buffer: span(buf), total, over: total > chunkSize }, frame);
    }
    if (buf.length) flush(true, null);
  }

  function normalise(opts) {
    const chunkSize = Math.max(1, Math.floor(opts.chunkSize || 1));
    const chunkOverlap = Math.max(0, Math.min(Math.floor(opts.chunkOverlap || 0), chunkSize));
    return { chunkSize, chunkOverlap, strip: opts.stripWhitespace !== false };
  }

  /** CharacterTextSplitter: one separator, dropped on split, re-inserted on merge. */
  function splitCharacter(text, opts) {
    const cfg = normalise(opts);
    const sep = opts.separator == null ? '\n\n' : opts.separator;
    const ctx = makeContext(opts.trace !== false);
    const pieces = splitOn(text, 0, sep, false);
    const frame = { depth: 0, sep, scope: [0, text.length], pieces, skipped: [], next: [] };
    ctx.emit({ type: 'split', found: sep === '' || text.includes(sep) }, frame);
    merge(pieces, sep, cfg, ctx, frame);
    ctx.emit({ type: 'done' }, frame);
    return { chunks: ctx.chunks, events: ctx.events, truncated: ctx.truncated };
  }

  /** RecursiveCharacterTextSplitter: a ladder of separators, coarse to fine. */
  function splitRecursive(text, opts) {
    const cfg = normalise(opts);
    const separators = opts.separators && opts.separators.length ? opts.separators : ['\n\n', '\n', ' ', ''];
    const keep = opts.keepSeparator !== false;
    const ctx = makeContext(opts.trace !== false);

    function recurse(part, offset, seps, depth) {
      // Pick the first separator on the ladder that actually occurs here.
      let sep = seps[seps.length - 1];
      let next = [];
      const skipped = [];
      for (let i = 0; i < seps.length; i++) {
        const s = seps[i];
        if (s === '') {
          sep = s;
          break;
        }
        if (part.includes(s)) {
          sep = s;
          next = seps.slice(i + 1);
          break;
        }
        skipped.push(s);
      }

      const pieces = splitOn(part, offset, sep, keep);
      const frame = { depth, sep, scope: [offset, offset + part.length], pieces, skipped, next };
      ctx.emit({ type: 'split', found: sep === '' || part.includes(sep) }, frame);

      const joiner = keep ? '' : sep;
      let good = [];
      const mergeGood = () => {
        if (good.length) merge(good, joiner, cfg, ctx, frame);
        good = [];
      };

      for (const piece of pieces) {
        if (piece.text.length < cfg.chunkSize) {
          good.push(piece);
          continue;
        }
        mergeGood();
        if (!next.length) {
          // Nothing finer to split with: the piece goes out as it is.
          const chunk = ctx.addChunk(
            { text: piece.text, start: piece.start, end: piece.end, pieces: 1 },
            cfg
          );
          ctx.emit({ type: 'raw', piece, chunk }, frame);
        } else {
          ctx.emit({ type: 'recurse', piece }, frame);
          recurse(piece.text, piece.start, next, depth + 1);
        }
      }
      mergeGood();
    }

    recurse(text, 0, separators, 0);
    ctx.emit(
      { type: 'done' },
      { depth: 0, sep: null, scope: [0, text.length], pieces: [], skipped: [], next: [] }
    );
    return { chunks: ctx.chunks, events: ctx.events, truncated: ctx.truncated };
  }

  return { splitCharacter, splitRecursive, splitOn, MAX_EVENTS };
});
