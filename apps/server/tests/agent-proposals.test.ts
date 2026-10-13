import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Check } from 'typebox/value';
import {
  AssistantToolResultSchema,
  CreateAgentProposalPreviewSchema,
  GLOBAL_ASSISTANT_SESSION_ID,
  ProposalSchema,
  type ModelSettingsSnapshot,
  type Proposal,
  type WorkbenchEvent,
} from '@multivac/contracts';
import { AgentService } from '../src/application/agent-service.js';
import { InternalToolService, MULTIVAC_INTERNAL_TOOLS } from '../src/application/internal-tools/index.js';
import type { InternalToolTurn } from '../src/application/internal-tools/internal-tool-service.js';
import { createAgentKind } from '../src/application/proposals/agent-proposals.js';
import { ProposalService, ProposalServiceError } from '../src/application/proposals/proposal-service.js';
import { WorkbenchEvents } from '../src/application/workbench-events.js';
import type { InternalToolOutcome } from '../src/modules/internal-tools/internal-tool.js';
import {
  SqliteAssistantStore,
  SqliteInternalToolCallRepository,
  SqliteProposalRepository,
} from '../src/storage/sqlite-assistant-store.js';
import { testDataDir } from './fixtures/test-environment.js';

/**
 * 对话中提议新建智能体（真实的 SQLite、智能体服务、提议服务与内部工具账本）：
 * - 提议只生成确认卡，卡上写全配置与提议时的模型名，校验与设置页保存同一套；
 * - 确认时按当前模型配置重新核对，模型名或可用性变了就过期、什么也不建；
 * - 执行参数只来自提议记录，确认后才登记；取消与已执行的冲突按提议服务既有语义。
 */

type Ok = Extract<InternalToolOutcome, { ok: true }>;
type Failed = Extract<InternalToolOutcome, { ok: false }>;

const CAPABILITIES = {
  source: 'pi-catalog' as const, input: ['text' as const], contextWindow: 1000, maxOutputTokens: 100,
  reasoning: true, thinkingLevels: ['off' as const, 'low' as const, 'high' as const],
};

function profile(profileId: string, displayName: string) {
  return {
    profileId, displayName, provider: 'p', modelId: profileId, protocol: 'openai-responses' as const,
    endpoint: null, reasoning: 'auto' as const, capabilities: CAPABILITIES,
  };
}

const READY_AVAILABILITY = {
  profileId: 'ready', authenticated: true, available: true, authenticationType: 'api_key' as const,
  reason: null, message: null,
};
const BROKEN_AVAILABILITY = {
  profileId: 'broken', authenticated: false, available: false, authenticationType: null,
  reason: 'AUTH_MISSING', message: '缺少认证。',
};

function snapshot(): ModelSettingsSnapshot {
  return {
    revision: 1, defaultProfileId: 'ready',
    profiles: [profile('ready', '可用模型'), profile('broken', '未认证模型')],
    availability: [READY_AVAILABILITY, BROKEN_AVAILABILITY],
  };
}

async function withWorld(run: (world: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'multivac-agent-proposals-'));
  const world = await setup(root);
  try {
    await run(world);
  } finally {
    world.store.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function setup(root: string) {
  const store = new SqliteAssistantStore(join(testDataDir(root), 'multivac.sqlite'));
  const models = { current: snapshot() };
  const events = new WorkbenchEvents();
  const published: WorkbenchEvent[] = [];
  events.subscribe((event) => published.push(event));
  let ids = 0;
  const agents = new AgentService({
    repository: store.agents,
    modelSettings: { getSnapshot: async () => models.current },
    events,
    newId: () => `agent-${ids += 1}`,
  });
  const proposals = new ProposalService({
    repository: new SqliteProposalRepository(store),
    workbenchEvents: events,
    kinds: [createAgentKind({ agents })],
  });
  const turn: InternalToolTurn = { commandId: 'turn-1', windowId: 'window-a', view: null };
  const tools = new InternalToolService({
    tools: MULTIVAC_INTERNAL_TOOLS,
    // 应用中只把查询与提议所需的服务交给内部工具；新建智能体只在提议种类中。
    services: { transcripts: { readMessages: () => [] } } as never,
    calls: new SqliteInternalToolCallRepository(store),
    currentTurn: () => turn,
    proposals,
  });
  let calls = 0;
  const invoke = async (toolName: string, args: Record<string, unknown>, toolCallId = `call-${calls += 1}`) => {
    const outcome = await tools.invoke(
      { assistantSessionId: GLOBAL_ASSISTANT_SESSION_ID, toolName, toolCallId, args },
      new AbortController().signal,
    );
    if (outcome.ok) assert.equal(Check(AssistantToolResultSchema, outcome.result), true, JSON.stringify(outcome.result));
    return outcome;
  };
  const ok = async (toolName: string, args: Record<string, unknown>, toolCallId?: string): Promise<Ok> => {
    const outcome = await invoke(toolName, args, toolCallId);
    assert.equal(outcome.ok, true, outcome.ok ? undefined : outcome.reason);
    return outcome as Ok;
  };
  const failed = async (toolName: string, args: Record<string, unknown>) => {
    const outcome = await invoke(toolName, args);
    assert.equal(outcome.ok, false, outcome.ok ? outcome.content : undefined);
    return (outcome as Failed).reason;
  };
  /** 提出并返回生成的那一张提议。 */
  const propose = async (args: Record<string, unknown>): Promise<{ outcome: Ok; proposal: Proposal }> => {
    const toolCallId = `call-${calls += 1}`;
    const outcome = await ok('propose_create_agent', args, toolCallId);
    const proposal = proposals.list(GLOBAL_ASSISTANT_SESSION_ID).find((item) => item.toolCallId === toolCallId);
    assert.ok(proposal, '应当生成提议');
    assert.equal(Check(ProposalSchema, proposal), true);
    return { outcome, proposal };
  };
  const decide = (proposalId: string, decision: 'confirm' | 'cancel') =>
    proposals.decide(GLOBAL_ASSISTANT_SESSION_ID, proposalId, decision, { windowId: 'window-b', commandId: null });
  const names = async () => (await agents.list()).agents.map((agent) => agent.name);
  return { root, store, agents, proposals, models, published, invoke, ok, failed, propose, decide, names };
}

test('新建智能体：卡上写全配置与模型名，确认前不登记；确认后出现在列表，回执带“设置 · 智能体”', async () => {
  await withWorld(async ({ propose, decide, names, published, agents }) => {
    const { outcome, proposal } = await propose({
      name: ' 研究 ', description: ' 调研与资料整理 ', modelProfileId: 'ready', thinkingLevel: 'high', instructions: '保留来源。',
    });

    // 工具只说“已提出，等待确认”，配置已规范化并补上提议时的模型名；智能体还没有登记。
    assert.equal(outcome.result.summary, '已提出，等待你确认');
    assert.match(outcome.content, /等待用户在对话中的确认卡上确认；确认之前没有执行任何操作/u);
    assert.equal(proposal.title, '新建智能体「研究」');
    assert.deepEqual(proposal.preview, {
      name: '研究', description: '调研与资料整理', modelProfileId: 'ready', modelName: '可用模型',
      thinkingLevel: 'high', instructions: '保留来源。',
    });
    assert.equal(Check(CreateAgentProposalPreviewSchema, proposal.preview), true);
    assert.equal(proposal.problem, null);
    assert.deepEqual(await names(), ['Multivac（协调）', '通用执行']);

    // 确认：按卡上的配置登记，回执说明模型与入口。
    const executed = await decide(proposal.proposalId, 'confirm');
    assert.equal(executed.status, 'executed');
    assert.deepEqual(executed.outcome, {
      summary: '已创建智能体「研究」，模型：可用模型 · high；可在新建任务时选用。',
      refs: [],
      receipt: {
        headline: '已创建智能体「研究」',
        detail: '模型：可用模型 · high；可在新建任务时选用，修改或删除请到设置 · 智能体',
        actions: [{ kind: 'open-management-page', page: 'agents' }],
      },
    });
    const created = (await agents.list()).agents.find((agent) => agent.name === '研究')!;
    assert.deepEqual(
      [created.description, created.modelProfileId, created.thinkingLevel, created.instructions, created.revision],
      ['调研与资料整理', 'ready', 'high', '保留来源。', 1],
    );
    assert.equal(published.filter((event) => event.type === 'agent.changed').length, 1);

    // 同一张卡重复确认幂等，不会建出第二个。
    assert.equal((await decide(proposal.proposalId, 'confirm')).status, 'executed');
    assert.deepEqual(await names(), ['Multivac（协调）', '通用执行', '研究']);
    assert.equal(published.filter((event) => event.type === 'agent.changed').length, 1);
  });
});

test('跟随默认模型：不给模型与推理等级时卡上写明默认模型，执行结果也说默认模型', async () => {
  await withWorld(async ({ propose, decide, agents }) => {
    const { proposal } = await propose({ name: '随手记' });
    assert.deepEqual(proposal.preview, {
      name: '随手记', description: '', modelProfileId: null, modelName: null, thinkingLevel: null, instructions: '',
    });
    assert.equal(proposal.problem, null);

    const executed = await decide(proposal.proposalId, 'confirm');
    assert.equal(executed.status, 'executed');
    assert.equal(executed.outcome!.summary, '已创建智能体「随手记」，模型：默认模型；可在新建任务时选用。');
    assert.equal(executed.outcome!.receipt!.detail, '模型：默认模型；可在新建任务时选用，修改或删除请到设置 · 智能体');
    assert.deepEqual(
      (await agents.list()).agents.find((agent) => agent.name === '随手记')!.modelProfileId, null,
    );
  });
});

test('不合规的提议：卡上写明原因、不能确认，确认时也过期，什么也不登记', async () => {
  await withWorld(async ({ propose, decide, names, failed }) => {
    const cases = await Promise.all([
      propose({ name: '   ' }),
      propose({ name: '甲', thinkingLevel: 'high' }),
      propose({ name: '通用执行' }),
      propose({ name: '乙', modelProfileId: 'broken' }),
      propose({ name: '丙', modelProfileId: 'missing-profile' }),
    ]);
    assert.deepEqual(cases.map(({ proposal }) => proposal.problem), [
      '智能体名称不能为空。',
      '指定推理等级时需要同时选择模型；跟随默认模型时使用模型的默认等级。',
      '已有名为「通用执行」的智能体，请换一个名称。',
      '不能保存为智能体的模型：缺少认证。',
      '不能保存为智能体的模型：引用的模型配置已删除，请重新选择模型。',
    ]);
    assert.deepEqual(cases.map(({ outcome }) => outcome.result.summary), Array(5).fill('已提出，但目前不能执行'));
    assert.match(cases[0]!.outcome.content, /但目前不能执行：智能体名称不能为空。/u);
    assert.deepEqual(await names(), ['Multivac（协调）', '通用执行']);

    // 不合法的卡不能靠确认执行：重新校验不通过即过期。
    const expired = await decide(cases[0]!.proposal.proposalId, 'confirm');
    assert.deepEqual([expired.status, expired.reason], ['expired', '智能体名称不能为空。']);
    assert.deepEqual(await names(), ['Multivac（协调）', '通用执行']);

    // 参数不符合 schema 的调用根本不会生成卡：工具自己说清哪里不对。
    const reason = await failed('propose_create_agent', { name: '丁', modelProfileId: 'ready', extra: true });
    assert.match(reason, /参数不符合要求/u);
    assert.match(reason, /调用没有执行/u);
  });
});

test('确认时按当前配置重新核对：模型名或可用性变了就过期，不登记', async () => {
  await withWorld(async ({ propose, decide, names, models }) => {
    const renamed = await propose({ name: '研究', modelProfileId: 'ready', thinkingLevel: 'high' });
    models.current = {
      ...models.current, revision: 2,
      profiles: [profile('ready', '改名后的模型'), profile('broken', '未认证模型')],
    };
    const changed = await decide(renamed.proposal.proposalId, 'confirm');
    assert.deepEqual([changed.status, changed.reason], [
      'expired', '智能体配置已变化：模型将是「改名后的模型 · high」（卡上是「可用模型 · high」）。',
    ]);

    // 模型变成不可用：核对给出的原因是与设置页同一句。
    const unavailable = await propose({ name: '资料整理', modelProfileId: 'ready' });
    models.current = {
      ...models.current, revision: 3,
      availability: [
        { ...READY_AVAILABILITY, authenticated: false, available: false, reason: 'AUTH_MISSING', message: '缺少认证。' },
        BROKEN_AVAILABILITY,
      ],
    };
    const broken = await decide(unavailable.proposal.proposalId, 'confirm');
    assert.deepEqual([broken.status, broken.reason], ['expired', '不能保存为智能体的模型：缺少认证。']);

    // 两次都没有登记任何智能体，卡上写明最终状态。
    assert.deepEqual(await names(), ['Multivac（协调）', '通用执行']);
  });
});

test('取消与冲突：取消后不能再确认；已执行不能再取消；重复的工具调用只生成一张卡', async () => {
  await withWorld(async ({ propose, decide, proposals, names, ok }) => {
    const first = await propose({ name: '甲', modelProfileId: 'ready' });
    assert.equal((await decide(first.proposal.proposalId, 'cancel')).status, 'cancelled');
    await assert.rejects(
      decide(first.proposal.proposalId, 'confirm'),
      (error: unknown) => error instanceof ProposalServiceError && error.code === 'PROPOSAL_CONFLICT',
    );

    const second = await propose({ name: '乙', modelProfileId: 'ready' });
    assert.equal((await decide(second.proposal.proposalId, 'confirm')).status, 'executed');
    await assert.rejects(
      decide(second.proposal.proposalId, 'cancel'),
      (error: unknown) => error instanceof ProposalServiceError && error.code === 'PROPOSAL_CONFLICT' &&
        error.message === '提议已确认并执行，不能再取消。',
    );

    // 同一次工具调用重放（同一个 toolCallId）只生成一张卡。
    const args = { name: '丙', modelProfileId: 'ready' };
    assert.equal((await ok('propose_create_agent', args, 'call-replay')).result.summary, '已提出，等待你确认');
    assert.equal((await ok('propose_create_agent', args, 'call-replay')).result.summary, '已提出，等待你确认');
    const cards = proposals.list(GLOBAL_ASSISTANT_SESSION_ID).filter((item) => item.toolCallId === 'call-replay');
    assert.equal(cards.length, 1);
    assert.equal(cards[0]!.status, 'pending');
    assert.deepEqual(await names(), ['Multivac（协调）', '通用执行', '乙']);
  });
});
