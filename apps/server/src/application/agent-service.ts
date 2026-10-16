import { randomUUID } from 'node:crypto';
import {
  CreateAgentSchema, DeleteAgentSchema, UpdateAgentSchema, DEFAULT_AGENT_ID, UNKNOWN_CHANGE_ORIGIN,
  type Agent, type AgentList, type AgentModelState, type AgentReceipt, type AssistantApiErrorCode, type AssistantExecutor,
  type CreateAgent, type DeleteAgent, type ModelSettingsSnapshot, type UpdateAgent, type WorkbenchChangeOrigin,
} from '@multivac/contracts';
import { Check } from 'typebox/value';
import { agentNameKey, presetAgents, type AgentRepository } from '../modules/agents/agent.js';
import type { WorkbenchEventPublisher } from './workbench-events.js';
import { fingerprint } from './task-service.js';

export class AgentServiceError extends Error {
  constructor(readonly code: AssistantApiErrorCode, message: string) { super(message); }
}
function invalid(message: string): never { throw new AgentServiceError('INVALID_REQUEST', message); }

/** 智能体引用的模型状态只读当前模型配置快照计算，与模型页的可用性检查同源。 */
export function agentModelState(agent: Pick<Agent, 'modelProfileId' | 'thinkingLevel'>, snapshot: ModelSettingsSnapshot | null): AgentModelState {
  if (agent.modelProfileId === null) return { status: 'default', modelName: null, message: null };
  if (!snapshot) return { status: 'review', modelName: null, message: '模型配置暂时无法读取，请稍后重试。' };
  const profile = snapshot.profiles.find((item) => item.profileId === agent.modelProfileId);
  if (!profile) return { status: 'review', modelName: null, message: '引用的模型配置已删除，请重新选择模型。' };
  const availability = snapshot.availability.find((item) => item.profileId === profile.profileId);
  if (!availability?.available || !profile.capabilities) {
    return { status: 'review', modelName: profile.displayName, message: availability?.message ?? '模型当前不可用，请修复模型配置或认证。' };
  }
  const levels = profile.capabilities.thinkingLevels;
  if (agent.thinkingLevel !== null && levels && !levels.includes(agent.thinkingLevel)) {
    return { status: 'review', modelName: profile.displayName, message: `该模型不再支持推理等级「${agent.thinkingLevel}」，请重新选择。` };
  }
  return { status: 'ready', modelName: profile.displayName, message: null };
}

export interface AgentServiceOptions {
  repository: AgentRepository;
  /** 当前模型配置快照（含可用性与可选推理等级）；与模型页同一个服务。 */
  modelSettings: { getSnapshot(): Promise<ModelSettingsSnapshot> };
  events?: WorkbenchEventPublisher;
  /** 仍被未结束任务引用时返回说明，拒绝删除；未接入任务时不限制。 */
  usage?: (agentId: string) => string | null;
  /** 协调者当前注册的内部工具名；未接入时为空。 */
  coordinatorTools?: () => readonly string[];
  /** 列表预览只复用本次模型快照；实际发送时另行准入。 */
  executionPreview?: (agent: Agent, snapshot: ModelSettingsSnapshot | null) => AssistantExecutor;
  now?: () => string;
  newId?: () => string;
}

/**
 * 智能体的基础服务：列出、读取、新建、修改与删除。名称唯一；固定的协调者拒绝修改与删除；
 * 默认的通用执行可以编辑但不能删除。模型引用只在保存模型或推理等级时按当前配置校验，
 * 已保存的引用之后失效时保留原值，由读取方显示“待核对”。
 */
export class AgentService {
  private readonly now: () => string;
  private readonly newId: () => string;

  constructor(private readonly options: AgentServiceOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.newId = options.newId ?? randomUUID;
    options.repository.seed(presetAgents(this.now()));
  }

  /** 仅供 Fake E2E 重置：清空后重新补齐预置记录。 */
  resetForTest(): void {
    this.options.repository.clearForTest();
    this.options.repository.seed(presetAgents(this.now()));
  }

  get(agentId: string): Agent {
    const agent = this.options.repository.get(agentId);
    if (!agent) throw new AgentServiceError('NOT_FOUND', '智能体不存在或已删除。');
    return agent;
  }

  /** 可用于任务执行的智能体：存在且不是固定的协调者。 */
  requireExecutable(agentId: string): Agent {
    const agent = this.get(agentId);
    if (agent.fixed) invalid(`「${agent.name}」是固定配置，不能用于执行任务。`);
    return agent;
  }

  async list(): Promise<AgentList> {
    const agents = this.options.repository.list();
    const snapshot = await this.snapshot();
    const invocations = this.options.executionPreview ? Object.fromEntries(agents.filter(agent => !agent.fixed).map(agent => {
      try { return [agent.agentId, { executor: this.options.executionPreview!(agent, snapshot), error: null }] as const; }
      catch (error) { return [agent.agentId, { executor: null, error: error instanceof Error ? error.message : '模型配置无法核对。' }] as const; }
    })) : undefined;
    return {
      ...(invocations ? { invocations } : {}),
      agents,
      modelStates: Object.fromEntries(agents.map((agent) => [agent.agentId, agentModelState(agent, snapshot)])),
      coordinatorTools: [...(this.options.coordinatorTools?.() ?? [])],
    };
  }

  async modelState(agent: Pick<Agent, 'modelProfileId' | 'thinkingLevel'>): Promise<AgentModelState> {
    return agentModelState(agent, await this.snapshot());
  }

  /** 任务启动或继续前的准入：智能体可被任务选用，引用的模型与推理等级当前可用。 */
  async admit(agentId: string): Promise<Agent> {
    const agent = this.requireExecutable(agentId);
    const state = await this.modelState(agent);
    if (state.status === 'review') invalid(`执行智能体「${agent.name}」的模型待核对：${state.message ?? '模型当前不可用。'}请修复模型或更换智能体后再启动。`);
    return agent;
  }

  async create(input: CreateAgent, origin: WorkbenchChangeOrigin = UNKNOWN_CHANGE_ORIGIN): Promise<AgentReceipt> {
    if (!Check(CreateAgentSchema, input)) invalid('智能体参数无效。');
    const fields = {
      name: input.name.trim(), description: input.description?.trim() ?? '',
      modelProfileId: input.modelProfileId ?? null, thinkingLevel: input.thinkingLevel ?? null,
      instructions: input.instructions?.trim() ?? '',
    };
    const key = fingerprint({ kind: 'create-agent', ...fields });
    const replay = this.replay(input.commandId, key);
    if (replay) return { commandId: input.commandId, agent: replay };
    validateFields(fields);
    await this.requireModel(fields);
    let created = false;
    const agent = this.options.repository.transaction(() => {
      const replay = this.replay(input.commandId, key);
      if (replay) return replay;
      this.requireUniqueName(fields.name, null);
      const at = this.now();
      const agent: Agent = { agentId: this.newId(), ...fields, fixed: false, revision: 1, createdAt: at, updatedAt: at };
      this.options.repository.save(agent, null);
      this.options.repository.saveCommand({ commandId: input.commandId, fingerprint: key, result: agent });
      created = true;
      return agent;
    });
    if (created) this.options.events?.publish({ type: 'agent.changed', origin, change: 'created', agent });
    return { commandId: input.commandId, agent };
  }

  async update(agentId: string, input: UpdateAgent, origin: WorkbenchChangeOrigin = UNKNOWN_CHANGE_ORIGIN): Promise<AgentReceipt> {
    if (!Check(UpdateAgentSchema, input) || Object.keys(input.patch).length === 0) invalid('智能体修改参数无效。');
    const patch = { ...input.patch };
    for (const field of ['name', 'description', 'instructions'] as const) {
      if (patch[field] !== undefined) patch[field] = patch[field].trim();
    }
    const key = fingerprint({ kind: 'update-agent', agentId, revision: input.revision, patch });
    const replay = this.replay(input.commandId, key);
    if (replay) return { commandId: input.commandId, agent: replay };
    const current = this.requireEditable(agentId, input.revision);
    const next: Agent = { ...current, ...patch };
    validateFields(next);
    if (next.modelProfileId !== current.modelProfileId || next.thinkingLevel !== current.thinkingLevel) await this.requireModel(next);
    let changed = false;
    const agent = this.options.repository.transaction(() => {
      const replay = this.replay(input.commandId, key);
      if (replay) return replay;
      const latest = this.requireEditable(agentId, input.revision);
      const candidate: Agent = { ...latest, ...patch };
      if (fingerprint(candidate) === fingerprint(latest)) {
        this.options.repository.saveCommand({ commandId: input.commandId, fingerprint: key, result: latest });
        return latest;
      }
      this.requireUniqueName(candidate.name, agentId);
      candidate.revision = latest.revision + 1;
      candidate.updatedAt = this.now();
      this.options.repository.save(candidate, latest.revision);
      this.options.repository.saveCommand({ commandId: input.commandId, fingerprint: key, result: candidate });
      changed = true;
      return candidate;
    });
    if (changed) this.options.events?.publish({ type: 'agent.changed', origin, change: 'updated', agent });
    return { commandId: input.commandId, agent };
  }

  remove(agentId: string, input: DeleteAgent, origin: WorkbenchChangeOrigin = UNKNOWN_CHANGE_ORIGIN): AgentReceipt {
    if (!Check(DeleteAgentSchema, input)) invalid('删除智能体参数无效。');
    const key = fingerprint({ kind: 'delete-agent', agentId, revision: input.revision });
    let deleted = false;
    const agent = this.options.repository.transaction(() => {
      const replay = this.replay(input.commandId, key);
      if (replay) return replay;
      const current = this.requireEditable(agentId, input.revision);
      if (current.agentId === DEFAULT_AGENT_ID) invalid('默认的执行智能体不能删除，可以修改它的配置。');
      const usage = this.options.usage?.(agentId);
      if (usage) invalid(usage);
      this.options.repository.delete(agentId, current.revision);
      this.options.repository.saveCommand({ commandId: input.commandId, fingerprint: key, result: current });
      deleted = true;
      return current;
    });
    if (deleted) this.options.events?.publish({ type: 'agent.changed', origin, change: 'deleted', agent });
    return { commandId: input.commandId, agent };
  }

  private async snapshot(): Promise<ModelSettingsSnapshot | null> {
    try { return await this.options.modelSettings.getSnapshot(); } catch { return null; }
  }

  /** 保存模型或推理等级时复用模型可用性检查：不可用、已删除或等级不受支持的配置不能保存。 */
  private async requireModel(fields: Pick<Agent, 'modelProfileId' | 'thinkingLevel'>): Promise<void> {
    const state = await this.modelState(fields);
    if (state.status === 'review') invalid(`不能保存为智能体的模型：${state.message}`);
  }

  private requireEditable(agentId: string, revision: number): Agent {
    const current = this.get(agentId);
    if (current.fixed) invalid(`「${current.name}」是固定配置，不能修改或删除。`);
    if (current.revision !== revision) throw new AgentServiceError('COMMAND_STATE_MISMATCH', '智能体已变化，请读取最新版本后重试。');
    return current;
  }

  private requireUniqueName(name: string, selfId: string | null): void {
    const existing = this.options.repository.byNameKey(agentNameKey(name));
    if (existing && existing.agentId !== selfId) invalid(`已有名为「${existing.name}」的智能体，请换一个名称。`);
  }

  private replay(commandId: string, key: string): Agent | null {
    const record = this.options.repository.command(commandId);
    if (!record) return null;
    if (record.fingerprint !== key) throw new AgentServiceError('COMMAND_ID_CONFLICT', '同一个命令 ID 不能用于不同操作。');
    return record.result;
  }
}

function validateFields(fields: Pick<Agent, 'name' | 'modelProfileId' | 'thinkingLevel'>): void {
  if (!fields.name) invalid('智能体名称不能为空。');
  if (fields.thinkingLevel !== null && fields.modelProfileId === null) invalid('指定推理等级时需要同时选择模型；跟随默认模型时使用模型的默认等级。');
}
