import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { jsonSha256Fingerprint } from '../src/modules/fingerprint.js';
import { notesFingerprint } from '../src/modules/notes/note.js';
import { fingerprint as taskFingerprint } from '../src/application/task-service.js';
import { internalToolArgumentsFingerprint } from '../src/modules/internal-tools/internal-tool.js';

/**
 * 已持久化的命令指纹按原编码核对；这些用例固定各账本的编码规则，
 * 调整公共函数时若改变任一结果，历史命令重放会变成冲突。
 */
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

test('JSON 原样编码指纹：字段顺序敏感，undefined 字段省略，数组顺序保留', () => {
  assert.equal(jsonSha256Fingerprint({ b: 1, a: [2, 1] }), sha256('{"b":1,"a":[2,1]}'));
  assert.notEqual(jsonSha256Fingerprint({ a: 1, b: 2 }), jsonSha256Fingerprint({ b: 2, a: 1 }));
  assert.equal(jsonSha256Fingerprint({ a: 1, skipped: undefined }), jsonSha256Fingerprint({ a: 1 }));
  assert.equal(jsonSha256Fingerprint({ a: null }), sha256('{"a":null}'));
  assert.equal(notesFingerprint(['create', { id: 'n' }]), sha256('["create",{"id":"n"}]'));
});

test('任务命令指纹：按键排序、不取哈希，数组顺序保留', () => {
  assert.equal(taskFingerprint({ b: 1, a: [2, 1] }), '{"a":[2,1],"b":1}');
  assert.equal(taskFingerprint({ a: 1, b: 2 }), taskFingerprint({ b: 2, a: 1 }));
  assert.equal(taskFingerprint({ a: null }), '{"a":null}');
});

test('内部工具参数指纹：按键排序后取哈希，undefined 按 null 编码', () => {
  assert.equal(internalToolArgumentsFingerprint({ b: 1, a: [2, 1] }), sha256('{"a":[2,1],"b":1}'));
  assert.equal(internalToolArgumentsFingerprint({ a: undefined }), sha256('{"a":null}'));
});
