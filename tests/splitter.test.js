// Run with: node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const { splitCharacter, splitRecursive } = require('../js/splitter.js');

const texts = (r) => r.chunks.map((c) => c.text);

test('character splitter matches the LangChain reference example', () => {
  const r = splitCharacter('foo bar baz 123', { separator: ' ', chunkSize: 7, chunkOverlap: 3 });
  assert.deepEqual(texts(r), ['foo bar', 'bar baz', 'baz 123']);
});

test('character splitter without overlap', () => {
  const r = splitCharacter('foo bar baz 123', { separator: ' ', chunkSize: 3, chunkOverlap: 0 });
  assert.deepEqual(texts(r), ['foo', 'bar', 'baz', '123']);
});

test('character splitter cannot break a piece that has no separator in it', () => {
  const r = splitCharacter('short\n\n' + 'x'.repeat(50), { separator: '\n\n', chunkSize: 10, chunkOverlap: 0 });
  assert.deepEqual(texts(r), ['short', 'x'.repeat(50)]);
  assert.equal(r.chunks[1].oversize, true);
});

test('recursive splitter matches the LangChain reference example', () => {
  const text =
    "Hi.\n\nI'm Harrison.\n\nHow? Are? You?\nOkay then f f f f.\n" +
    'This is a weird text to write, but gotta test the splittingggg some how.\n\nBye!\n\n-H.';
  const r = splitRecursive(text, { chunkSize: 10, chunkOverlap: 1 });
  assert.deepEqual(texts(r), [
    'Hi.', "I'm", 'Harrison.', 'How? Are?', 'You?', 'Okay then', 'f f f f.',
    'This is a', 'weird', 'text to', 'write,', 'but gotta', 'test the',
    'splitting', 'gggg', 'some how.', 'Bye!', '-H.',
  ]);
});

test('recursive splitter never exceeds chunk size when "" is on the ladder', () => {
  const text = ('word '.repeat(30) + '\n\n' + 'y'.repeat(200) + '\n').repeat(3);
  for (const chunkSize of [5, 17, 64, 150]) {
    const r = splitRecursive(text, { chunkSize, chunkOverlap: Math.floor(chunkSize / 4) });
    for (const c of r.chunks) assert.ok(c.text.length <= chunkSize, `${c.text.length} > ${chunkSize}`);
  }
});

test('chunk offsets point back at the source text', () => {
  const text = 'Alpha beta gamma.\n\nDelta epsilon zeta eta theta.\nIota kappa.\n\nLambda.';
  const r = splitRecursive(text, { chunkSize: 20, chunkOverlap: 5 });
  for (const c of r.chunks) assert.equal(text.slice(c.start, c.end), c.text);
});

test('a trace is recorded and ends with "done"', () => {
  const r = splitRecursive('one two three four five six', { chunkSize: 10, chunkOverlap: 4 });
  assert.equal(r.events[0].type, 'split');
  assert.equal(r.events.at(-1).type, 'done');
  assert.equal(r.events.filter((e) => e.type === 'emit' && e.chunk).length, r.chunks.length);
});
