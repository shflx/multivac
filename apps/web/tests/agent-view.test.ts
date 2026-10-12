import assert from 'node:assert/strict';
import test from 'node:test';
import type { ModelProfile, ModelSettingsSnapshot } from '@multivac/contracts';
import {
  agentListSummary,
  agentModelLabel,
  agentModelReview,
  agentThinkingLabel,
  agentThinkingLevels,
  modelChange,
} from '../src/features/agents/agent-view.js';

function profile(profileId: string, displayName: string, capabilities: ModelProfile['capabilities']): ModelProfile {
  return {
    profileId, displayName, provider: 'fixture', modelId: profileId, protocol: 'openai-responses',
    endpoint: null, reasoning: 'auto', capabilities,
  };
}

const capabilities = { source: 'pi-catalog', input: ['text'], contextWindow: 1000, maxOutputTokens: 100 } as const;

const snapshot = {
  revision: 1,
  defaultProfileId: 'deep',
  profiles: [
    profile('deep', '深度模型', { ...capabilities, input: ['text'], reasoning: true, thinkingLevels: ['off', 'low', 'high'] }),
    profile('fast', '快速模型', { ...capabilities, input: ['text'], reasoning: false }),
  ],
  availability: [],
} as unknown as ModelSettingsSnapshot;

test('列表摘要：协调者标“固定配置”，其他写用途，没写时说明未填写', () => {
  assert.equal(agentListSummary({ fixed: true, description: '全局对话' }), '固定配置');
  assert.equal(agentListSummary({ fixed: false, description: '审查代码改动' }), '审查代码改动');
  assert.equal(agentListSummary({ fixed: false, description: '' }), '未填写用途');
});

test('模型与推理等级的显示名：跟随默认时写明当前默认模型，已删除的配置保留原 ID', () => {
  assert.equal(agentModelLabel({ modelProfileId: null, thinkingLevel: null }, snapshot), '跟随默认（深度模型）');
  assert.equal(agentModelLabel({ modelProfileId: null, thinkingLevel: null }, null), '跟随默认模型');
  assert.equal(agentModelLabel({ modelProfileId: 'fast', thinkingLevel: null }, snapshot), '快速模型');
  assert.equal(agentModelLabel({ modelProfileId: 'gone', thinkingLevel: null }, snapshot), 'gone');
  assert.equal(agentThinkingLabel(null), '模型默认等级');
  assert.equal(agentThinkingLabel('high'), '高');
});

test('可选推理等级来自所选模型的 Pi 能力；跟随默认或不支持推理时不能指定', () => {
  assert.deepEqual(agentThinkingLevels(snapshot, 'deep'), ['off', 'low', 'high']);
  assert.deepEqual(agentThinkingLevels(snapshot, 'fast'), []);
  assert.deepEqual(agentThinkingLevels(snapshot, null), []);
  assert.deepEqual(agentThinkingLevels(null, 'deep'), []);
});

test('换模型时一并提交推理等级：跟随默认或新模型不支持时回到模型默认，否则保留', () => {
  assert.deepEqual(modelChange({ modelProfileId: 'deep', thinkingLevel: 'high' }, null, snapshot), { modelProfileId: null, thinkingLevel: null });
  assert.deepEqual(modelChange({ modelProfileId: 'deep', thinkingLevel: 'high' }, 'fast', snapshot), { modelProfileId: 'fast', thinkingLevel: null });
  assert.deepEqual(modelChange({ modelProfileId: 'fast', thinkingLevel: null }, 'deep', snapshot), { modelProfileId: 'deep', thinkingLevel: null });
  assert.deepEqual(modelChange({ modelProfileId: 'deep', thinkingLevel: 'low' }, 'deep', snapshot), { modelProfileId: 'deep', thinkingLevel: 'low' });
});

test('模型待核对时说明不会自动换模型；其他状态不提示', () => {
  assert.equal(agentModelReview({ status: 'ready', modelName: '深度模型', message: null }), null);
  assert.equal(agentModelReview({ status: 'default', modelName: null, message: null }), null);
  assert.equal(agentModelReview(undefined), null);
  const review = agentModelReview({ status: 'review', modelName: null, message: '引用的模型配置已删除，请重新选择模型。' });
  assert.match(review!, /^模型待核对：引用的模型配置已删除，请重新选择模型。用它的任务不能启动/u);
  assert.match(agentModelReview({ status: 'review', modelName: null, message: '不可用' })!, /^模型待核对：不可用。/u);
});
