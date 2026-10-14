import { Bot, Check, LoaderCircle, Lock, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import {
  AGENT_DESCRIPTION_MAX_LENGTH, AGENT_INSTRUCTIONS_MAX_LENGTH, AGENT_NAME_MAX_LENGTH, COORDINATOR_TOOL_GROUPS, DEFAULT_AGENT_ID,
  internalToolDisplay, type Agent, type AgentModelState, type ModelSettingsSnapshot, type UpdateAgent,
} from '@multivac/contracts';
import { ManagementPageActions } from '../../app/management-layout.js';
import { useConfirm } from '../../components/confirm-card.js';
import { SavedMark, useSavedFlash } from '../../components/saved-mark.js';
import { createAgent, deleteAgent, updateAgent } from '../../data/agent-api.js';
import { newCommandId } from '../../data/command-id.js';
import { getModelSettings } from '../../data/model-settings-api.js';
import { useAssistantSession } from '../assistant/assistant-session.js';
import { THINKING_LEVEL_LABELS } from '../models/model-profile-view.js';
import { AgentModelField, type AgentModelValue } from './agent-model-field.js';
import { reloadAgents, useAgents } from './use-agents.js';

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/** 列表行的第二行：协调者标固定配置，其余显示用途，未填用途时说明模型来源。 */
function agentSummary(agent: Agent): string {
  if (agent.fixed) return '固定配置';
  return agent.description || (agent.modelProfileId === null ? '跟随全局默认模型' : '自定义模型');
}

interface AgentsPageProps {
  /** 页面是否正在显示；变为可见时重读模型配置。 */
  active: boolean;
  onManageModels: () => void;
}

/**
 * 管理 · 设置 · 智能体：列表 + 详情，“新建智能体”在页头。智能体是命名的执行配置（模型、推理等级、指令），
 * 在任务确认卡上手动选择，不改变权限边界。协调者是固定配置，只读展示。
 */
export function AgentsPage({ active, onManageModels }: AgentsPageProps) {
  const agents = useAgents();
  const [selectedId, setSelectedId] = useState<string>(DEFAULT_AGENT_ID);
  const [creating, setCreating] = useState(false);
  const [snapshot, setSnapshot] = useState<ModelSettingsSnapshot | null>(null);
  const [modelError, setModelError] = useState('');
  const newButtonRef = useRef<HTMLButtonElement>(null);

  const loadModels = useCallback(async () => {
    try {
      setSnapshot(await getModelSettings());
      setModelError('');
    } catch (error) {
      setModelError(errorText(error, '模型配置读取失败。'));
    }
  }, []);
  useEffect(() => { if (active) { void loadModels(); reloadAgents(); } }, [active, loadModels]);

  if (agents === null) {
    return (
      <div className="management-page-state" data-management-page="agents" aria-live="polite">
        <LoaderCircle className="spin" aria-hidden="true" />
        <p>正在读取智能体</p>
        <button type="button" className="secondary-button" onClick={reloadAgents}><RefreshCw aria-hidden="true" />重试</button>
      </div>
    );
  }

  const selected = agents.agents.find((agent) => agent.agentId === selectedId) ?? agents.agents.find((agent) => agent.agentId === DEFAULT_AGENT_ID) ?? agents.agents[0]!;

  return (
    <div className="projects-page agents-page" data-management-page="agents">
      <ManagementPageActions>
        <button type="button" ref={newButtonRef} className="secondary-button" disabled={creating} onClick={() => setCreating(true)}>
          <Plus aria-hidden="true" />
          新建智能体
        </button>
      </ManagementPageActions>
      <div className="sessions-layout projects-layout">
        <div className="project-list-pane">
          <div className="session-list project-list" role="list" aria-label="智能体列表">
            {agents.agents.map((agent) => {
              const current = !creating && agent.agentId === selected.agentId;
              return (
                <div key={agent.agentId} role="listitem">
                  <button type="button" className={current ? 'selected' : ''} aria-current={current ? 'true' : undefined} data-agent-id={agent.agentId}
                    onClick={() => { setCreating(false); setSelectedId(agent.agentId); }}>
                    <span className="agent-list-icon">{agent.fixed ? <Lock aria-hidden="true" /> : <Bot aria-hidden="true" />}</span>
                    <span className="session-list-copy">
                      <strong>{agent.name}</strong>
                      <small title={agentSummary(agent)}>{agentSummary(agent)}</small>
                    </span>
                  </button>
                </div>
              );
            })}
          </div>
          <p className="settings-list-hint">在任务确认卡中选择执行智能体。模型、推理等级与指令会用于任务执行会话。</p>
        </div>
        {creating ? (
          <NewAgentForm snapshot={snapshot} modelSettingsError={modelError} onManageModels={onManageModels}
            onCreated={(agent) => { setCreating(false); setSelectedId(agent.agentId); reloadAgents(); }}
            onCancel={() => { setCreating(false); requestAnimationFrame(() => newButtonRef.current?.focus()); }} />
        ) : selected.fixed ? (
          <CoordinatorDetail key={selected.agentId} agent={selected} coordinatorTools={agents.coordinatorTools} />
        ) : (
          <AgentDetail key={selected.agentId} agent={selected} modelState={agents.modelStates[selected.agentId] ?? null} snapshot={snapshot} modelSettingsError={modelError}
            onManageModels={onManageModels}
            onDeleted={() => { setSelectedId(DEFAULT_AGENT_ID); reloadAgents(); newButtonRef.current?.focus(); }} />
        )}
      </div>
    </div>
  );
}

/** 把服务端实际注册的内部工具按展示分组归类；未登记分组的工具归入“其他”，空分组不展示。 */
function groupCoordinatorTools(tools: readonly string[]): { label: string; purpose: string; tools: string[] }[] {
  const registered = new Set(tools);
  const grouped = new Set<string>();
  const groups = COORDINATOR_TOOL_GROUPS.map((group) => {
    const members = group.tools.filter((tool) => registered.has(tool));
    members.forEach((tool) => grouped.add(tool));
    return { label: group.label, purpose: group.purpose, tools: members };
  });
  const others = tools.filter((tool) => !grouped.has(tool));
  if (others.length) groups.push({ label: '其他', purpose: '其他内部工具。', tools: others });
  return groups.filter((group) => group.tools.length > 0);
}

/** 协调者当前所用模型：跟随 Multivac 对话的选模，读取中时给出占位。 */
function useCoordinatorModelLabel(): string {
  const data = useAssistantSession()?.model.data;
  if (!data) return '读取中…';
  const { selection } = data;
  const option = selection.profileId ? data.options.find((item) => item.profileId === selection.profileId) : undefined;
  const name = option?.displayName ?? `${selection.provider}/${selection.modelId}`;
  return `${name} · 推理 ${THINKING_LEVEL_LABELS[selection.thinkingLevel]}`;
}

/** 协调者：固定配置，不能修改、删除或用于执行任务。 */
function CoordinatorDetail({ agent, coordinatorTools }: { agent: Agent; coordinatorTools: readonly string[] }) {
  const titleId = useId();
  const modelLabel = useCoordinatorModelLabel();
  const groups = groupCoordinatorTools(coordinatorTools);
  return (
    <section className="session-detail project-detail agent-detail" aria-labelledby={titleId}>
      <div className="project-detail-head">
        <div className="project-title"><span className="agent-heading-icon"><Lock aria-hidden="true" /></span><h2 id={titleId}>{agent.name}</h2><span className="agent-fixed-badge"><Lock aria-hidden="true" />固定配置</span></div>
        <p className="project-title-note">协调者负责理解意图、安排工作和回答进展，不能修改、删除或用于执行任务。</p>
      </div>

      <section className="detail-section" aria-labelledby={`${titleId}-why`}>
        <div className="section-title"><h3 id={`${titleId}-why`}>为什么不能配置</h3></div>
        <p className="agent-fixed-text">
          协调者负责理解你的意图、安排工作和回答进展。它只用内部工具和只读查询，所有有副作用的动作都转交任务会话执行，
          这样每个动作都挂在某个任务上：可追溯、可暂停、可验收，状态可信。开放配置会让这条边界变模糊。
        </p>
      </section>

      <section className="detail-section" aria-labelledby={`${titleId}-model`}>
        <div className="section-title"><h3 id={`${titleId}-model`}>所用模型</h3></div>
        <p className="agent-fixed-text">
          跟随 Multivac 对话当前选择的模型：<strong data-testid="coordinator-model">{modelLabel}</strong>。在对话输入区的模型选择器里切换。
        </p>
      </section>

      <section className="detail-section" aria-labelledby={`${titleId}-tools`}>
        <div className="section-title"><h3 id={`${titleId}-tools`}>内部工具</h3></div>
        {groups.length ? (
          <ul className="coordinator-tools">
            {groups.map((group) => (
              <li key={group.label}>
                <strong>{group.label}</strong>
                <span>{group.purpose}</span>
                <span className="coordinator-tool-names">
                  {group.tools.map((tool) => internalToolDisplay(tool)?.displayName ?? tool).join('、')}
                </span>
              </li>
            ))}
          </ul>
        ) : <p className="agent-fixed-text">暂无已注册的内部工具。</p>}
      </section>
    </section>
  );
}

type SavedPart = 'name' | 'model' | 'instructions';

/** 可编辑的智能体：名称与用途、模型与推理（即改即存）、指令（保存 / 还原）与删除。 */
function AgentDetail({ agent: listed, modelState, snapshot, modelSettingsError, onManageModels, onDeleted }: {
  agent: Agent; modelState: AgentModelState | null; snapshot: ModelSettingsSnapshot | null; modelSettingsError: string;
  onManageModels: () => void; onDeleted: () => void;
}) {
  const confirm = useConfirm();
  const titleId = useId();
  const saved = useSavedFlash<SavedPart>();
  // 保存后先用回执里的新版本，列表重读回来之前连续修改也带着最新 revision。
  const [agent, setAgent] = useState(listed);
  useEffect(() => { setAgent((current) => listed.revision >= current.revision ? listed : current); }, [listed]);
  const [editing, setEditing] = useState<{ name: string; description: string } | null>(null);
  const [editError, setEditError] = useState('');
  const [modelError, setModelError] = useState('');
  const [instructions, setInstructions] = useState(agent.instructions);
  const [instructionsError, setInstructionsError] = useState('');
  const [busy, setBusy] = useState(false);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const deleteButtonRef = useRef<HTMLButtonElement>(null);
  const instructionsRef = useRef<HTMLTextAreaElement>(null);
  const deletable = agent.agentId !== DEFAULT_AGENT_ID;

  // 指令被别处改动时：输入框没有改过就跟着更新，正在编辑的内容原样保留。
  const syncedInstructions = useRef(agent.instructions);
  useEffect(() => {
    const previous = syncedInstructions.current;
    syncedInstructions.current = agent.instructions;
    setInstructions((current) => current.trim() === previous ? agent.instructions : current);
  }, [agent.instructions]);

  /** 提交一次修改；失败原因交给出错的那一处显示。 */
  async function run(patch: UpdateAgent['patch'], fallback: string, showError: (message: string) => void): Promise<boolean> {
    showError('');
    setBusy(true);
    try {
      const receipt = await updateAgent(agent.agentId, { commandId: newCommandId(), revision: agent.revision, patch });
      setAgent(receipt.agent);
      reloadAgents();
      return true;
    } catch (error) {
      showError(errorText(error, fallback));
      return false;
    } finally {
      setBusy(false);
    }
  }

  const identityChanged = editing !== null && (editing.name.trim() !== agent.name || editing.description.trim() !== agent.description);
  const identityValue = editing ?? { name: agent.name, description: agent.description };

  function cancelEdit() {
    if (busy) return;
    setEditing(null);
    setEditError('');
  }

  async function submitEdit(event: FormEvent) {
    event.preventDefault();
    if (!editing || busy) return;
    const name = editing.name.trim();
    if (!name) { setEditError('名称不能为空。'); nameInputRef.current?.focus(); return; }
    const patch: UpdateAgent['patch'] = {};
    if (name !== agent.name) patch.name = name;
    if (editing.description.trim() !== agent.description) patch.description = editing.description.trim();
    if (!Object.keys(patch).length || await run(patch, '保存失败，请重试。', setEditError)) {
      setEditing(null);
      if (Object.keys(patch).length) saved.flash('name');
      requestAnimationFrame(() => nameInputRef.current?.focus());
    } else {
      requestAnimationFrame(() => nameInputRef.current?.focus());
    }
  }

  async function changeModel(next: AgentModelValue) {
    if (await run(next, '模型保存失败，请重试。', setModelError)) saved.flash('model');
  }

  const instructionsChanged = instructions.trim() !== agent.instructions;
  async function saveInstructions(event: FormEvent) {
    event.preventDefault();
    if (!instructionsChanged || busy) return;
    if (await run({ instructions }, '指令保存失败，请重试。', setInstructionsError)) {
      setInstructions(instructions.trim());
      saved.flash('instructions');
    }
  }

  async function remove() {
    await confirm({
      title: `删除智能体「${agent.name}」`,
      description: '删除后不能再在任务确认卡上选择它。',
      details: ['已经结束的任务保留原记录；仍有未完成的任务使用它时不能删除。'],
      icon: Trash2,
      tone: 'danger',
      confirmLabel: '删除',
      action: async () => {
        await deleteAgent(agent.agentId, { commandId: newCommandId(), revision: agent.revision });
        onDeleted();
      },
      fallbackFocus: () => deleteButtonRef.current,
    });
  }

  return (
    <section className="session-detail project-detail agent-detail" aria-labelledby={titleId}>
      <form className="project-detail-head agent-identity" aria-label="名称与用途"
        onBlur={(event) => { if (!identityChanged && !event.currentTarget.contains(event.relatedTarget)) setEditing(null); }}
        onSubmit={(event) => void submitEdit(event)}
        onKeyDown={(event) => { if (editing && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancelEdit(); } }}>
        <span className="agent-heading-icon"><Bot aria-hidden="true" /></span>
        <div className="agent-identity-name">
          <h2 id={titleId} className="agent-text-field" aria-label={agent.name}>
            <span className="agent-text-measure" aria-hidden="true">{identityValue.name || '智能体名称'}</span>
            <input ref={nameInputRef} className="agent-inline-name" aria-label="名称" value={identityValue.name}
              maxLength={AGENT_NAME_MAX_LENGTH} disabled={busy} placeholder="智能体名称" title="点击修改名称，Enter 保存，Esc 撤销"
              aria-invalid={editError ? true : undefined} aria-describedby={editError ? `${titleId}-edit-error` : undefined}
              onFocus={() => { if (!editing) setEditing({ name: agent.name, description: agent.description }); }}
              onChange={(event) => { setEditing({ ...identityValue, name: event.target.value }); setEditError(''); }} />
          </h2>
          <SavedMark saved={saved} target="name" />
        </div>
        <div className="agent-identity-actions">
          {identityChanged ? (
            <>
              <button type="button" className="inline-link" disabled={busy} title="撤销（Esc）" onClick={cancelEdit}>撤销</button>
              <button type="submit" className="primary-button compact" disabled={busy} title="保存（Enter）">
                {busy ? <LoaderCircle className="spin" aria-hidden="true" /> : <Check aria-hidden="true" />}保存
              </button>
            </>
          ) : (
            <button type="button" ref={deleteButtonRef} className="secondary-button danger compact" disabled={busy || !deletable}
              title={deletable ? undefined : '默认的通用执行不能删除'} onClick={() => void remove()}>
              <Trash2 aria-hidden="true" />删除
            </button>
          )}
        </div>
        <div className="agent-identity-description">
          <div className="agent-description-field">
            <span className="agent-description-measure" aria-hidden="true">{`${identityValue.description || '添加用途说明'}\u00a0`}</span>
            <textarea className="agent-inline-description" aria-label="用途" value={identityValue.description} disabled={busy} rows={1}
              maxLength={AGENT_DESCRIPTION_MAX_LENGTH} placeholder="添加用途说明" title="点击修改用途，Enter 保存，Shift+Enter 换行，Esc 撤销"
              onFocus={() => { if (!editing) setEditing({ name: agent.name, description: agent.description }); }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  void submitEdit(event);
                }
              }}
              onChange={(event) => { setEditing({ ...identityValue, description: event.target.value }); setEditError(''); }} />
          </div>
        </div>
        {editing && editError && <p id={`${titleId}-edit-error`} className="form-error agent-identity-error" role="alert">{editError}</p>}
      </form>

      <section className="detail-section agent-model-section" aria-labelledby={`${titleId}-model`}>
        <div className="section-title"><h3 id={`${titleId}-model`}>模型与推理</h3><SavedMark saved={saved} target="model" /></div>
        <AgentModelField snapshot={snapshot} disabled={busy}
          value={{ modelProfileId: agent.modelProfileId, thinkingLevel: agent.thinkingLevel }} onChange={(next) => void changeModel(next)} />
        {modelState?.status === 'review' && listed.revision === agent.revision && <p className="form-error" role="alert">模型待核对：{modelState.message}</p>}
        {(modelError || modelSettingsError) && <p className="form-error" role="alert">{modelError || modelSettingsError}</p>}
        <p className="section-hint">只能选择当前可用的模型。<button type="button" className="inline-link" data-shell-navigation onClick={onManageModels}>管理模型配置</button></p>
      </section>

      <section className="detail-section" aria-labelledby={`${titleId}-instructions`}>
        <div className="section-title"><h3 id={`${titleId}-instructions`}>指令</h3></div>
        <form className="project-constraints-form" onSubmit={(event) => void saveInstructions(event)}>
          <div className="project-constraints-field">
            <textarea ref={instructionsRef} className="agent-instructions" aria-label={`${agent.name} 的指令`} value={instructions}
              maxLength={AGENT_INSTRUCTIONS_MAX_LENGTH} rows={6}
              placeholder="这类工作的约定，例如“结论和证据分开写”。项目默认约束与工作目录的 AGENTS.md 会另外带入。"
              onChange={(event) => { setInstructions(event.target.value); setInstructionsError(''); }} />
            <small>任务启动时作为执行约定带入执行会话，与项目默认约束、AGENTS.md 并列适用。改完点“保存”才生效。</small>
            {instructionsError && <p className="form-error" role="alert">{instructionsError}</p>}
          </div>
          <div className="project-constraints-actions">
            <SavedMark saved={saved} target="instructions" />
            <button type="button" className="secondary-button" aria-label="还原指令" disabled={busy || !instructionsChanged}
              onClick={() => { setInstructions(agent.instructions); setInstructionsError(''); instructionsRef.current?.focus(); }}>还原</button>
            <button type="submit" className="primary-button" aria-label="保存指令" disabled={busy || !instructionsChanged}>保存</button>
          </div>
        </form>
      </section>
    </section>
  );
}

/** 页内新建：名称、用途、模型、推理等级与指令；创建成功后选中新智能体。 */
function NewAgentForm({ snapshot, modelSettingsError, onCreated, onCancel, onManageModels }: {
  snapshot: ModelSettingsSnapshot | null; modelSettingsError: string; onCreated: (agent: Agent) => void; onCancel: () => void; onManageModels: () => void;
}) {
  const titleId = useId();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [model, setModel] = useState<AgentModelValue>({ modelProfileId: null, thinkingLevel: null });
  const [instructions, setInstructions] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // 同一次填写重试时沿用命令 ID，结果未知后重试不会建出两份。
  const commandId = useRef(newCommandId());

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (!name.trim()) { setError('名称不能为空。'); return; }
    setBusy(true);
    setError('');
    try {
      const receipt = await createAgent({ commandId: commandId.current, name, description, instructions, ...model });
      onCreated(receipt.agent);
    } catch (cause) {
      setError(errorText(cause, '创建失败，请重试。'));
      commandId.current = newCommandId();
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="session-detail project-detail agent-detail" aria-labelledby={titleId}>
      <form className="agent-new-form" onSubmit={(event) => void submit(event)}
        onKeyDown={(event) => { if (event.key === 'Escape' && !busy) { event.preventDefault(); event.stopPropagation(); onCancel(); } }}>
        <div className="project-detail-head">
          <div className="project-title"><span className="agent-heading-icon"><Plus aria-hidden="true" /></span><h2 id={titleId}>新建智能体</h2></div>
          <p className="project-title-note">智能体是一套执行配置，不改变权限边界；创建后可在任务确认卡上选择。</p>
        </div>
        <div className="agent-identity-fields">
          <label className="agent-field"><span>名称</span>
            <input value={name} maxLength={AGENT_NAME_MAX_LENGTH} autoFocus placeholder="例如：代码审查" aria-invalid={error && !name.trim() ? true : undefined}
              onChange={(event) => { setName(event.target.value); setError(''); }} />
          </label>
          <label className="agent-field"><span>用途</span>
            <input value={description} maxLength={AGENT_DESCRIPTION_MAX_LENGTH} placeholder="一句话说明适合什么工作"
              onChange={(event) => setDescription(event.target.value)} />
          </label>
        </div>
        <div className="agent-model-section">
          <AgentModelField snapshot={snapshot} disabled={busy} value={model} onChange={setModel} />
          {modelSettingsError && <p className="form-error" role="alert">{modelSettingsError}</p>}
          <p className="section-hint">只能选择当前可用的模型。<button type="button" className="inline-link" data-shell-navigation onClick={onManageModels}>管理模型配置</button></p>
        </div>
        <label className="agent-field"><span>指令</span>
          <textarea className="agent-instructions" value={instructions} maxLength={AGENT_INSTRUCTIONS_MAX_LENGTH} rows={6}
            placeholder="这类工作的约定，例如“结论和证据分开写”。项目默认约束与工作目录的 AGENTS.md 会另外带入。"
            onChange={(event) => setInstructions(event.target.value)} />
        </label>
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="project-constraints-actions">
          <button type="button" className="secondary-button" disabled={busy} onClick={onCancel}>取消</button>
          <button type="submit" className="primary-button" disabled={busy}>{busy ? '正在创建…' : '创建'}</button>
        </div>
      </form>
    </section>
  );
}
