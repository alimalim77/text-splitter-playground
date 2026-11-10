# Chunk Lab

An interactive playground that shows how text splitters cut a document into chunks for RAG.

**Live demo: https://alimalim77.github.io/text-splitter-playground/**

Type or paste text into the editor pad, pick a splitter, move the sliders, and watch the chunks change as you go. It covers the two splitters most people meet first:

| Splitter | LangChain class | Idea |
| --- | --- | --- |
| Character | `CharacterTextSplitter` | Cut on one separator, then pack the pieces into chunks. |
| Recursive character | `RecursiveCharacterTextSplitter` | Try a ladder of separators, coarse to fine, and re-split only the pieces that are still too big. |

## What you can do

- **Editor pad** with four sample texts (article, Markdown, Python code, one long paragraph) or your own text.
- **Chunks view**: every chunk gets a colour in the source text. Striped text belongs to two chunks at once, which is the overlap. Hover a chunk to find its card.
- **Step through**: play the algorithm one decision at a time. See the separator ladder, the recursion level, the buffer filling up, a chunk being emitted, and the tail being kept as overlap.
- **Compare**: both splitters on the same text and settings, with chunk-length bars against the `chunk_size` limit.
- **Settings**: `chunk_size`, `chunk_overlap`, the separator, and an editable, reorderable separator ladder.
- **LangChain snippet** that always matches the current settings, ready to copy.
- Links can open a specific state, for example `?mode=character&view=compare` or `?view=steps&step=12`.

## How the splitters work

Both share one **merge** step: pieces are added to a buffer until the next one would push it past `chunk_size`. The buffer is then joined and emitted as a chunk, and pieces are dropped from its front until what is left fits within `chunk_overlap`. That remainder opens the next chunk.

They differ in how the pieces are made:

- **Character splitter** splits the whole text once, on one separator (default `"\n\n"`). It never cuts inside a piece, so a long paragraph with no separator in it comes out as one oversized chunk.
- **Recursive character splitter** takes the first separator on its ladder that appears in the text (default `"\n\n"`, `"\n"`, `" "`, `""`), splits on it, and merges the small pieces. Any piece that is still too big is split again with the rest of the ladder. With `""` as the last rung, every chunk is guaranteed to fit.

The implementation in [`js/splitter.js`](js/splitter.js) follows `langchain_text_splitters` step by step and is checked against LangChain's own reference examples. Lengths are counted in characters, not tokens.

## Run it locally

No build step and no dependencies. Open `index.html`, or serve the folder:

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

Run the tests (Node 18+):

```bash
node --test tests/
```

## Project layout

```
index.html          page structure and the written explanations
css/style.css       light and dark themes
js/splitter.js      both splitters, with source offsets and a decision trace
js/app.js           editor pad, controls and the three views
tests/              unit tests for the splitters
```

## About

Part of an AI engineering teaching series by [Alim Mohammad](https://github.com/alimalim77).
