import assert from 'node:assert/strict';
import test from 'node:test';
import type { ModelAvailability, ModelProfile, ModelSettingsSnapshot } from '@multivac/contracts';
import {
  authenticationTypeLabel,
  availabilityView,
  defaultModelWarning,
  draftReasoningLevels,
  draftReasoningSource,
  protocolLabel,
  reasoningLabel,
} from '../src/features/models/model-profile-view.js';

function profile(patch: Partial<ModelProfile> = {}): ModelProfile {
  return {
    profileId: 'fixture-openai',
    displayName: 'GPT Fixture',
    provider: 'fixture',
    modelId: 'gpt-fixture',
    protocol: 'openai-responses',
    endpoint: null,
    reasoning: 'auto',
    capabilities: { source: 'pi-catalog', input: ['text'], contextWindow: 1000, maxOutputTokens: 100, reasoning: true },
    ...patch,
  };
}

function availability(patch: Partial<ModelAvailability> = {}): ModelAvailability {
  return {
    profileId: 'fixture-openai',
    authenticated: true,
    available: true,
    authenticationType: 'api_key',
    reason: null,
    message: null,
    ...patch,
  };
}

test('可用状态：可用写 Pi 的确认，不可用按原因给出短标签与 Pi 的说明', () => {
  assert.deepEqual(availabilityView(availability()), {
    available: true, state: 'ok', label: '可用', message: 'Pi 当前已确认该模型具备有效认证并可用。',
  });
  const missing = availabilityView(availability({
    authenticated: false, available: false, authenticationType: null, reason: 'AUTH_MISSING', message: 'Pi 当前未检测到有效认证。',
  }));
  assert.equal(missing.state, 'auth');
  assert.equal(missing.label, '未认证');
  assert.equal(missing.message, 'Pi 当前未检测到有效认证。');
  assert.equal(availabilityView(availability({ available: false, reason: 'CONFIGURATION_INVALID' })).label, '配置需修复');
  assert.equal(availabilityView(availability({ available: false, reason: 'CONFIGURATION_INVALID' })).state, 'invalid');
  assert.equal(availabilityView(availability({ authenticated: false, available: false, reason: 'MODEL_NOT_FOUND' })).label, '未找到模型');
  assert.equal(availabilityView(availability({ available: false, reason: 'MODEL_UNAVAILABLE' })).label, '当前不可用');
  // 认证快照待刷新时（合并出的占位）：状态未知，说明照写。
  const pending = availabilityView(availability({
    authenticated: false, available: false, authenticationType: null, reason: 'RUNTIME_ERROR', message: '认证状态待刷新。',
  }));
  assert.equal(pending.state, 'unknown');
  assert.equal(pending.message, '认证状态待刷新。');
  assert.equal(availabilityView(undefined).label, '状态未知');
});

test('配置的显示：协议写名称，推理能力写来源，认证类型放在次要位置', () => {
  assert.equal(protocolLabel('openai-responses'), 'OpenAI Responses');
  assert.equal(protocolLabel('anthropic-messages'), 'Anthropic Messages');
  assert.equal(reasoningLabel(profile()), '支持（Pi 目录）');
  assert.equal(reasoningLabel(profile({ reasoning: 'disabled' })), '不支持（手动设置）');
  assert.equal(reasoningLabel(profile({ capabilities: null })), '未知');
  assert.equal(authenticationTypeLabel(availability()), 'API Key');
  assert.equal(authenticationTypeLabel(availability({ authenticationType: 'oauth' })), 'OAuth');
  assert.equal(authenticationTypeLabel(undefined), '未认证');
});

test('编辑中的推理能力来源：手动设置优先；自动时只在连到的模型没变时沿用 Pi 的判断', () => {
  const saved = profile({ capabilities: { source: 'pi-default', input: ['text'], contextWindow: 1000, maxOutputTokens: 100, reasoning: false } });
  const draft = { ...saved, endpoint: null };
  assert.equal(draftReasoningSource({ ...draft, reasoning: 'enabled' }, saved), '手动设置');
  assert.equal(draftReasoningSource(draft, saved), 'Pi 默认');
  assert.equal(draftReasoningSource({ ...draft, displayName: '改名不影响' }, saved), 'Pi 默认');
  assert.equal(draftReasoningSource({ ...draft, modelId: 'other-model' }, saved), null);
  assert.equal(draftReasoningSource({ ...draft, protocol: 'openai-completions' }, saved), null);
  assert.equal(draftReasoningSource(draft, null), null);
});

test('可选推理等级：显示 Pi 为已保存配置给出的等级；不支持时不显示；草稿改了模型或推理设置时等保存后由 Pi 给出', () => {
  const levels = ['minimal', 'low', 'medium', 'high'] as const;
  const capabilities = { source: 'pi-catalog' as const, input: ['text' as const], contextWindow: 1000, maxOutputTokens: 100 };
  const supported = profile({ capabilities: { ...capabilities, reasoning: true, thinkingLevels: [...levels] } });
  const draftOf = (saved: ModelProfile) => ({ ...saved, endpoint: null });

  // 按目录判断：Pi 判断支持时列出等级；改名、改端点不影响。
  assert.deepEqual(draftReasoningLevels(draftOf(supported), supported), { kind: 'levels', levels });
  assert.deepEqual(draftReasoningLevels({ ...draftOf(supported), displayName: '改名', endpoint: 'https://other.example/v1' }, supported),
    { kind: 'levels', levels });
  // 目录支持时手动设为“支持”，Pi 的等级不变。
  assert.deepEqual(draftReasoningLevels({ ...draftOf(supported), reasoning: 'enabled' }, supported), { kind: 'levels', levels });
  // “不支持”一律不显示。
  assert.deepEqual(draftReasoningLevels({ ...draftOf(supported), reasoning: 'disabled' }, supported), { kind: 'none' });
  // 改了连到的模型或新建：保存后由 Pi 给出。
  assert.deepEqual(draftReasoningLevels({ ...draftOf(supported), modelId: 'other-model' }, supported), { kind: 'pending' });
  assert.deepEqual(draftReasoningLevels({ ...draftOf(supported), protocol: 'openai-completions' }, supported), { kind: 'pending' });
  assert.deepEqual(draftReasoningLevels(draftOf(supported), null), { kind: 'pending' });
  assert.deepEqual(draftReasoningLevels({ ...draftOf(supported), reasoning: 'disabled' }, null), { kind: 'none' });

  // Pi 判断不支持（等级只有关闭）：不显示；手动改为“支持”时等级未知，等保存后由 Pi 给出。
  const unsupported = profile({ capabilities: { ...capabilities, reasoning: false, thinkingLevels: ['off'] } });
  assert.deepEqual(draftReasoningLevels(draftOf(unsupported), unsupported), { kind: 'none' });
  assert.deepEqual(draftReasoningLevels({ ...draftOf(unsupported), reasoning: 'enabled' }, unsupported), { kind: 'pending' });

  // 已保存为手动“支持”：保持时列出 Pi 的等级；改回自动要看目录，等保存后由 Pi 给出。
  const manual = profile({ reasoning: 'enabled', capabilities: { ...capabilities, source: 'pi-default', reasoning: true,
    thinkingLevels: ['off', 'minimal', 'low', 'medium', 'high'] } });
  assert.deepEqual(draftReasoningLevels(draftOf(manual), manual),
    { kind: 'levels', levels: ['off', 'minimal', 'low', 'medium', 'high'] });
  assert.deepEqual(draftReasoningLevels({ ...draftOf(manual), reasoning: 'auto' }, manual), { kind: 'pending' });
  // 已保存为手动“不支持”：改为支持或自动都等保存后由 Pi 给出。
  const off = profile({ reasoning: 'disabled', capabilities: { ...capabilities, reasoning: false, thinkingLevels: ['off'] } });
  assert.deepEqual(draftReasoningLevels(draftOf(off), off), { kind: 'none' });
  assert.deepEqual(draftReasoningLevels({ ...draftOf(off), reasoning: 'enabled' }, off), { kind: 'pending' });
  assert.deepEqual(draftReasoningLevels({ ...draftOf(off), reasoning: 'auto' }, off), { kind: 'pending' });

  // 能力读不到（配置需修复）时与来源一样等保存后由 Pi 给出；服务端没有给出等级（旧版本）时不列等级。
  assert.deepEqual(draftReasoningLevels(draftOf(profile({ capabilities: null })), profile({ capabilities: null })), { kind: 'pending' });
  const legacy = profile();
  assert.deepEqual(draftReasoningLevels(draftOf(legacy), legacy), { kind: 'none' });
});

test('默认模型失效的提示：写明原因、保留引用且不自动替换；可用或未设置默认时没有提示', () => {
  const snapshot = (patch: Partial<ModelSettingsSnapshot>): ModelSettingsSnapshot => ({
    revision: 1,
    profiles: [profile(), profile({ profileId: 'other', displayName: 'Other' })],
    defaultProfileId: 'fixture-openai',
    availability: [availability(), availability({ profileId: 'other' })],
    ...patch,
  });
  assert.equal(defaultModelWarning(snapshot({})), null);
  assert.equal(defaultModelWarning(snapshot({ defaultProfileId: null })), null);
  const warning = defaultModelWarning(snapshot({
    availability: [
      availability({ authenticated: false, available: false, authenticationType: null, reason: 'AUTH_MISSING', message: 'Pi 当前未检测到有效认证。' }),
      availability({ profileId: 'other' }),
    ],
  }));
  assert.equal(
    warning,
    '默认模型「GPT Fixture」当前不可用：Pi 当前未检测到有效认证。默认引用已保留，Multivac 不会自动换成其他模型；' +
      '处理好后自动恢复，也可以把其他可用模型设为默认。',
  );
  // 读不到可用状态时同样提示（说明补上句号）。
  assert.match(defaultModelWarning(snapshot({ availability: [] })) ?? '', /^默认模型「GPT Fixture」当前不可用：还没有读到这个模型的可用状态。默认引用已保留/u);
});
