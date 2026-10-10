import test from 'node:test';
import assert from 'node:assert/strict';
import { IMAGE_LIMITS, acceptImages, canSendWithImages, draftImageOf, sentImages } from './image-draft.js';

const MiB = 1024 * 1024;
const file = (size, name = 'a.png') => ({ name, size });

test('数量或总大小超限时整批拒绝', () => {
  const four = Array.from({ length: IMAGE_LIMITS.count }, () => ({ size: MiB }));
  assert.deepEqual(acceptImages(four, [file(MiB)]), { accepted: [], error: '最多 4 张图片，总大小不超过 20 MiB。' });
  assert.equal(acceptImages([{ size: 9 * MiB }, { size: 9 * MiB }], [file(3 * MiB)]).error, '最多 4 张图片，总大小不超过 20 MiB。');
});

test('单张超过 10 MiB 时跳过该张，其余照常加入', () => {
  const result = acceptImages([], [file(11 * MiB, 'big.png'), file(MiB, 'small.png')]);
  assert.deepEqual(result.accepted.map((item) => item.name), ['small.png']);
  assert.equal(result.error, '单图上限为 10 MiB。');
  assert.equal(acceptImages([], [file(MiB)]).error, '');
});

test('粘贴的图片没有文件名时称为剪贴板图片，上传完成前不能发送', () => {
  const item = draftImageOf(file(MiB, ''), 'k', 'blob:1');
  assert.equal(item.name, '剪贴板图片');
  assert.equal(item.status, 'uploading');
  assert.equal(canSendWithImages('', [item]), false);
  const ready = { ...item, status: 'ready' };
  assert.equal(canSendWithImages('', [ready]), true);
  assert.equal(canSendWithImages('', []), false);
  assert.deepEqual(sentImages([ready, { ...item, key: 'x', status: 'error' }]), [{ url: 'blob:1', alt: '剪贴板图片' }]);
});
