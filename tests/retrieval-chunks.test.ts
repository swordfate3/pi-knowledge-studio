import assert from 'node:assert/strict';
import test from 'node:test';
import { chunkRetrievalText } from '../src/core/retrieval-chunks.ts';

test('retrieval chunks preserve exact source coverage, whitespace and surrogate boundaries', () => {
  for (const text of ['', ' \n\r\t ', 'short', '😀中 '.repeat(20000), 'x'.repeat(100000), ('Paragraph.\n\nNext sentence。\n').repeat(1000)]) {
    const chunks = chunkRetrievalText(text);
    assert.deepEqual(chunks, chunkRetrievalText(text));
    let covered = 0, rebuilt = '';
    for (const chunk of chunks) {
      assert.ok(chunk.start <= covered);
      assert.ok(chunk.end > covered);
      assert.ok(chunk.text.length <= 1200);
      assert.equal(chunk.text, text.slice(chunk.start, chunk.end));
      assert.ok(!/^[\uDC00-\uDFFF]/.test(chunk.text));
      assert.ok(!/[\uD800-\uDBFF]$/.test(chunk.text));
      if (covered) assert.ok(covered - chunk.start >= 100 && covered - chunk.start <= 101);
      rebuilt += chunk.text.slice(covered - chunk.start);
      covered = chunk.end;
    }
    assert.equal(covered, text.length);
    assert.equal(rebuilt, text);
  }
});
test('retrieval boundaries prefer paragraphs, newlines and sentences near target', () => {
  for (const separator of ['\n\n', '\n', '。', '. ']) {
    const text = 'x'.repeat(790) + separator + 'y'.repeat(2000);
    assert.equal(chunkRetrievalText(text)[0]!.end, 790 + separator.length);
  }
  assert.equal(chunkRetrievalText('x'.repeat(2000))[0]!.end, 800);
  assert.throws(() => chunkRetrievalText('x'.repeat(3_600_000)), /element budget/);
});
