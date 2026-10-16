import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { NoteSummary } from '@multivac/contracts';
import { reuseNoteSummaries } from '../src/features/notes/note-summary-cache.js';

const a: NoteSummary = { id: 'a', title: 'A', revision: 1, createdAt: '2026-01-01', updatedAt: '2026-01-01' };
const b: NoteSummary = { ...a, id: 'b', title: 'B' };

test('相同摘要重读保留数组和条目身份，改名/版本/顺序变化仍送达', () => {
  const previous = [a, b];
  assert.equal(reuseNoteSummaries(previous, [{ ...a }, { ...b }]), previous);
  const changed = reuseNoteSummaries(previous, [{ ...a, revision: 2, title: '新标题' }, { ...b }]);
  assert.equal(changed[0]!.revision, 2);
  assert.equal(changed[0]!.title, '新标题');
  assert.equal(changed[1], b);
  assert.deepEqual(reuseNoteSummaries(previous, [{ ...b }, { ...a }]), [b, a]);
  assert.deepEqual(reuseNoteSummaries(previous, [{ ...b }]), [b]);
  assert.notEqual(reuseNoteSummaries(previous, [{ ...a, updatedAt: '2026-01-02' }, b])[0], a);
});
