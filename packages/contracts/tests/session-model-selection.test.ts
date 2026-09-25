import assert from 'node:assert/strict';
import test from 'node:test';
import { Check } from 'typebox/value';
import { SetSessionModelSchema, SetSessionThinkingLevelSchema, SessionModelSelectionSchema } from '../src/session-model-selection.js';

test('选择命令按会话 id 受理，并限定 commandId、目标 revision 和 SDK 等级枚举', () => {
  const command = { commandId: 'model-1', sessionId: 'global-coordinator', revision: 0, profileId: 'profile-1' };
  assert.equal(Check(SetSessionModelSchema, command), true);
  // 工作会话同样可以选模；会话 id 只接受受控字符集。
  assert.equal(Check(SetSessionModelSchema, { ...command, sessionId: 'work-session' }), true);
  for (const invalid of [
    { ...command, sessionId: 'work session' }, { ...command, sessionId: '' }, { ...command, revision: -1 },
    { ...command, revision: 0.5 }, { ...command, commandId: '' },
    { ...command, profileId: '../secret' }, { ...command, apiKey: 'secret' },
  ]) assert.equal(Check(SetSessionModelSchema, invalid), false);
  const thinking = { commandId: 'think-1', sessionId: 'global-coordinator', revision: 1, thinkingLevel: 'high' };
  assert.equal(Check(SetSessionThinkingLevelSchema, thinking), true);
  assert.equal(Check(SetSessionThinkingLevelSchema, { ...thinking, thinkingLevel: 'ultra' }), false);
  assert.equal(Check(SetSessionThinkingLevelSchema, { ...thinking, revision: Number.MAX_SAFE_INTEGER + 1 }), false);
});

test('基础模型允许空 profile 引用，公开选择禁止 Pi 原始对象与凭据', () => {
  const selection = { sessionId: 'global-coordinator', profileId: null, source: 'base', provider: 'openai', modelId: 'gpt-4.1-mini',
    thinkingLevel: 'off', availableThinkingLevels: ['off'], revision: 0, availability: { available: true, reason: null, message: null } };
  assert.equal(Check(SessionModelSelectionSchema, selection), true);
  assert.equal(Check(SessionModelSelectionSchema, { ...selection, piModel: {} }), false);
  assert.equal(Check(SessionModelSelectionSchema, { ...selection, availableThinkingLevels: ['unknown'] }), false);
});
