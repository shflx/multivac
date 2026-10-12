import { AlertCircle, ChevronRight, LoaderCircle, Pencil, Plus, RefreshCw, Trash2, UserCog } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
  AGENT_DESCRIPTION_MAX_LENGTH,
  AGENT_INSTRUCTIONS_MAX_LENGTH,
  AGENT_NAME_MAX_LENGTH,
  DEFAULT_AGENT_ID,
  type Agent,
  type AgentModelState,
  type ModelSettingsSnapshot,
  type Task,
  type UpdateAgent,
} from '@multivac/contracts';
import { ManagementPageActions } from '../../app/management-layout.js';
import { useConfirm } from '../../components/confirm-card.js';
import { SavedMark, useSavedFlash } from '../../components/saved-mark.js';
import { AssistantApiError } from '../../data/assistant-api.js';
import { createAgent, deleteAgent, listAgentTasks, updateAgent } from '../../data/agent-api.js';
import { newCommandId } from '../../data/command-id.js';
import { getModelSettings } from '../../data/model-settings-api.js';
import { taskColumn, taskLabel } from '../tasks/task-panel-state.js';
import { useTaskRequests } from '../tasks/task-requests-provider.js';
import { useOptionalWorkbenchEvents } from '../workbench/workbench-sync-provider.js';
import { AgentModelPicker } from './agent-model-picker.js';
import { agentListSummary, agentModelReview, type AgentModelFields } from './agent-view.js';
import { agentsLoadError, reloadAgents, useAgents } from './use-agents.js';

/** 详情的“最近任务”最多列几条。 */
const RECENT_TASK_LIMIT = 5;

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/** 网络中断或服务端内部错误时结果未知：只能用原命令重试核对（服务端按命令 ID 幂等）。 */
function resultUnknown(error: unknown): boolean {
  return !(error instanceof AssistantApiError) || error.status === 0 || error.status >= 500;
}

export interface AgentSettingsPageProps {
  /** 页面是否正在显示；变为可见时重新读取智能体与模型配置。 */
  active: boolean;
  onManageModels: () => void;
  onOpenTask: (taskId: string) => void;
}

/**
 * 管理 · 设置 · 智能体：列表 + 详情，“新建智能体”在页头的主要操作位，新建表单在详情位置打开。
 *
 * 智能体是一套执行配置（模型、推理等级、指令），不改变权限。选择类的改动（模型与推理等级）即时保存；
 * 名称、用途与指令是文字，改完点“保存”才生效。协调者是固定配置，只读，没有编辑和删除入口。
 * 列表来自窗口内共享的智能体快照，修改后重新读取，任务看板、详情里的名称随之更新。
 */
export function AgentSettingsPage({ active, onManageModels, onOpenTask }: AgentSettingsPageProps) {
  const agents = useAgents();
  const confirm = useConfirm();
  const [models, setModels] = useState<ModelSettingsSnapshot | null>(null);
  const [selectedId, setSelectedId] = useState<string>(DEFAULT_AGENT_ID);
  const [creating, setCreating] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const newButtonRef = useRef<HTMLButtonElement>(null);

  const loadModels = useCallback(async () => {
    try { setModels(await getModelSettings()); } catch { /* 读不到时保留上次的快照，选择器里说明正在读取。 */ }
  }, []);

  useEffect(() => {
    if (!active) return;
    void loadModels();
    void reloadAgents();
  }, [active, loadModels]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  /** 切换智能体或新建前：有未保存的文字修改时先经确认卡确认。 */
  async function confirmDiscard(): Promise<boolean> {
    if (!dirty) return true;
    return confirm({
      title: '放弃未保存的修改？',
      description: '当前智能体有未保存的修改，继续后这些修改会丢失。',
      tone: 'danger',
      confirmLabel: '放弃修改',
      cancelLabel: '继续编辑',
    });
  }

  async function choose(agentId: string): Promise<void> {
    if (agentId === selectedId && !creating) return;
    if (!await confirmDiscard()) return;
    setDirty(false);
    setCreating(false);
    setSelectedId(agentId);
  }

  async function startCreate(): Promise<void> {
    if (creating) return;
    if (!await confirmDiscard()) return;
    setDirty(false);
    setCreating(true);
  }

  if (!agents) {
    const error = agentsLoadError();
    return (
      <div className="management-page-state" data-management-page="agents" aria-live="polite">
        {error ? (
          <>
            <AlertCircle aria-hidden="true" />
            <h2>智能体读取失败</h2>
            <p>{error}</p>
            <button type="button" className="secondary-button" disabled={retrying}
              onClick={() => { setRetrying(true); void reloadAgents().finally(() => setRetrying(false)); }}>
              <RefreshCw aria-hidden="true" />
              重试
            </button>
          </>
        ) : (
          <>
            <LoaderCircle className="spin" aria-hidden="true" />
            <p>正在读取智能体</p>
          </>
        )}
      </div>
    );
  }

  // 选中的智能体被删除（本窗口或别处）后回到默认的通用执行。
  const selected = agents.agents.find((agent) => agent.agentId === selectedId)
    ?? agents.agents.find((agent) => agent.agentId === DEFAULT_AGENT_ID)
    ?? agents.agents[0]!;

  return (
    <div className="agent-settings-page" data-management-page="agents">
      <ManagementPageActions>
        <button type="button" ref={newButtonRef} className="secondary-button" onClick={() => void startCreate()} disabled={creating}>
          <Plus aria-hidden="true" />
          新建智能体
        </button>
      </ManagementPageActions>

      <div className="sessions-layout agents-layout">
        <div className="agent-list-pane">
          <div className="session-list agent-list" role="list" aria-label="智能体列表">
            {agents.agents.map((agent) => {
              const current = !creating && agent.agentId === selected.agentId;
              const review = agents.modelStates[agent.agentId]?.status === 'review';
              return (
                <div key={agent.agentId} role="listitem">
                  <button type="button" className={current ? 'selected' : ''} aria-current={current ? 'true' : undefined}
                    data-agent-id={agent.agentId} onClick={() => void choose(agent.agentId)}>
                    <UserCog aria-hidden="true" />
                    <span className="session-list-copy">
                      <strong>{agent.name}</strong>
                      <small title={agentListSummary(agent)}>{agentListSummary(agent)}</small>
                    </span>
                    {review && <em className="agent-review-tag">模型待核对</em>}
                    <ChevronRight aria-hidden="true" />
                  </button>
                </div>
              );
            })}
          </div>
          <p className="settings-list-hint">智能体是一套执行配置：模型、推理等级与指令。它不改变权限，读写目录和使用工具仍按授权确认。</p>
        </div>

        {creating ? (
          <NewAgentForm
            models={models}
            onRefreshModels={() => void loadModels()}
            onManageModels={onManageModels}
            onDirtyChange={setDirty}
            onCancel={() => { setDirty(false); setCreating(false); newButtonRef.current?.focus({ preventScroll: true }); }}
            onCreated={(agentId) => { setDirty(false); setCreating(false); setSelectedId(agentId); }}
          />
        ) : selected.fixed ? (
          <CoordinatorDetail agent={selected} />
        ) : (
          // 按智能体挂载详情：切换时编辑中的文字、忙碌、错误与“已保存”状态随之重置。
          <AgentDetail
            key={selected.agentId}
            agent={selected}
            modelState={agents.modelStates[selected.agentId]}
            models={models}
            active={active}
            onRefreshModels={() => void loadModels()}
            onManageModels={onManageModels}
            onOpenTask={onOpenTask}
            onDirtyChange={setDirty}
            onDeleted={() => { setDirty(false); setSelectedId(DEFAULT_AGENT_ID); }}
          />
        )}
      </div>
    </div>
  );
}

/** 协调者：固定配置，只读。完整的固定说明（所用模型、内部工具）另行补齐，这里保证没有编辑与删除入口。 */
function CoordinatorDetail({ agent }: { agent: Agent }) {
  const titleId = useId();
  return (
    <section className="session-detail agent-detail" aria-labelledby={titleId} data-agent-detail={agent.agentId}>
      <div className="agent-detail-head">
        <div className="agent-detail-title">
          <h2 id={titleId}>{agent.name}</h2>
          <p>固定配置</p>
        </div>
      </div>
      <section className="detail-section">
        <div className="section-title"><h3>固定配置</h3></div>
        <p className="agent-section-text">{agent.description}这套配置固定，不能修改或删除，也不能用来执行任务。</p>
      </section>
    </section>
  );
}

/** 详情中修改成功后显示“已保存”的几处：名称与用途（标题旁）、模型与推理（小节标题旁）、指令（保存按钮旁）。 */
type SavedPart = 'profile' | 'model' | 'instructions';

interface DetailIssue {
  part: SavedPart;
  message: string;
  /** 结果未知时用原命令重试。 */
  retry?: () => void;
}

interface AgentDetailProps {
  agent: Agent;
  modelState: AgentModelState | undefined;
  models: ModelSettingsSnapshot | null;
  active: boolean;
  onRefreshModels: () => void;
  onManageModels: () => void;
  onOpenTask: (taskId: string) => void;
  onDirtyChange: (dirty: boolean) => void;
  onDeleted: () => void;
}

/**
 * 可编辑智能体的详情（按原型 v1 区块）：名称与用途、最近任务、模型与推理、指令。
 * 各处的错误显示在出错的小节里；修改成功后在对应位置短暂显示“已保存”。
 */
function AgentDetail({ agent, modelState, models, active, onRefreshModels, onManageModels, onOpenTask, onDirtyChange, onDeleted }: AgentDetailProps) {
  const confirm = useConfirm();
  const titleId = useId();
  const instructionsNoteId = useId();
  const saved = useSavedFlash<SavedPart>();
  const [busy, setBusy] = useState(false);
  const [issue, setIssue] = useState<DetailIssue | null>(null);
  // 名称与用途的原地编辑：null 表示没在编辑。
  const [profile, setProfile] = useState<{ name: string; description: string } | null>(null);
  const [instructions, setInstructions] = useState(agent.instructions);
  const editButtonRef = useRef<HTMLButtonElement>(null);
  const instructionsRef = useRef<HTMLTextAreaElement>(null);
  const isDefault = agent.agentId === DEFAULT_AGENT_ID;

  // 与上次保存的值（去掉首尾空白后）不同才算改动；“还原”与“保存”只在有改动时可用。
  const instructionsChanged = instructions.trim() !== agent.instructions;
  const profileChanged = profile !== null && (profile.name.trim() !== agent.name || profile.description.trim() !== agent.description);
  useEffect(() => { onDirtyChange(instructionsChanged || profileChanged); }, [instructionsChanged, profileChanged, onDirtyChange]);

  // 指令被别处（其他窗口）改动时：输入框没有改过就跟着更新，正在编辑的内容原样保留。
  const syncedInstructionsRef = useRef(agent.instructions);
  useEffect(() => {
    const previous = syncedInstructionsRef.current;
    syncedInstructionsRef.current = agent.instructions;
    setInstructions((current) => current.trim() === previous ? agent.instructions : current);
  }, [agent.instructions]);

  /** 提交一次修改并重新读取智能体列表；结果未知时保留原命令，可重试核对。 */
  async function submit(part: SavedPart, command: UpdateAgent): Promise<boolean> {
    setBusy(true);
    setIssue(null);
    try {
      await updateAgent(agent.agentId, command);
      await reloadAgents();
      saved.flash(part);
      return true;
    } catch (error) {
      if (error instanceof AssistantApiError && error.code === 'COMMAND_STATE_MISMATCH') {
        await reloadAgents();
        setIssue({ part, message: '智能体已在别处修改，已读取最新版本；请核对后再保存。' });
      } else if (resultUnknown(error)) {
        setIssue({ part, message: `保存结果未知：${errorText(error, '服务没有响应。')}可以重试原命令核对，不会重复修改。`, retry: () => void submit(part, command) });
      } else {
        setIssue({ part, message: errorText(error, '保存失败，请重试。') });
      }
      return false;
    } finally {
      setBusy(false);
    }
  }

  const update = (part: SavedPart, patch: UpdateAgent['patch']) =>
    submit(part, { commandId: newCommandId(), revision: agent.revision, patch });

  function startProfileEdit(): void {
    setIssue(null);
    setProfile({ name: agent.name, description: agent.description });
  }

  function closeProfileEdit(): void {
    setProfile(null);
    if (issue?.part === 'profile') setIssue(null);
    window.requestAnimationFrame(() => editButtonRef.current?.focus({ preventScroll: true }));
  }

  async function saveProfile(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!profile || busy) return;
    const name = profile.name.trim();
    const description = profile.description.trim();
    if (!name) {
      setIssue({ part: 'profile', message: '智能体名称不能为空。' });
      return;
    }
    const patch: UpdateAgent['patch'] = {};
    if (name !== agent.name) patch.name = name;
    if (description !== agent.description) patch.description = description;
    if (Object.keys(patch).length === 0) { closeProfileEdit(); return; }
    if (await update('profile', patch)) closeProfileEdit();
  }

  async function saveInstructions(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!instructionsChanged || busy) return;
    const next = instructions.trim();
    if (await update('instructions', { instructions: next })) setInstructions(next);
  }

  /** 还原到上次保存的值；按钮随之不可用，焦点回到输入框。 */
  function revertInstructions(): void {
    setInstructions(agent.instructions);
    if (issue?.part === 'instructions') setIssue(null);
    instructionsRef.current?.focus();
  }

  async function changeModel(next: AgentModelFields): Promise<void> {
    if (busy) return;
    await update('model', next);
  }

  async function remove(): Promise<void> {
    // 命令在打开确认卡时生成：卡上的重试沿用同一个命令，不会重复删除。
    const command = { commandId: newCommandId(), revision: agent.revision };
    const deleted = await confirm({
      title: `删除智能体「${agent.name}」`,
      description: '删除后不能再选用它执行任务。',
      details: ['仍有未结束的任务在用它时不能删除，可以先让任务结束或更换执行智能体。', '已结束任务的记录保留，执行智能体显示为“已删除的智能体”。'],
      icon: Trash2,
      tone: 'danger',
      confirmLabel: '删除',
      action: async () => {
        await deleteAgent(agent.agentId, command);
        await reloadAgents();
      },
      fallbackFocus: () => document.querySelector<HTMLElement>(`[data-agent-id="${DEFAULT_AGENT_ID}"]`),
    });
    if (deleted) onDeleted();
  }

  const issueFor = (part: SavedPart): ReactNode => issue?.part === part && (
    <div className="agent-issue" role="alert">
      <AlertCircle aria-hidden="true" />
      <span>{issue.message}</span>
      {issue.retry && (
        <button type="button" className="secondary-button compact" disabled={busy} onClick={issue.retry}>
          <RefreshCw aria-hidden="true" />
          重试原命令
        </button>
      )}
    </div>
  );
  const review = agentModelReview(modelState);

  return (
    <section className="session-detail agent-detail" aria-labelledby={titleId} data-agent-detail={agent.agentId}>
      <div className="agent-detail-head">
        {profile === null ? (
          <>
            <div className="agent-detail-title">
              <div className="agent-detail-name">
                <h2 id={titleId}>{agent.name}</h2>
                <SavedMark saved={saved} target="profile" />
              </div>
              <p>{agent.description || '未填写用途'}</p>
            </div>
            <div className="agent-detail-actions">
              <button type="button" ref={editButtonRef} className="secondary-button" disabled={busy} onClick={startProfileEdit}>
                <Pencil aria-hidden="true" />
                编辑
              </button>
              <button type="button" className="secondary-button danger" disabled={busy || isDefault}
                title={isDefault ? '默认的执行智能体不能删除，可以修改它的配置' : undefined} onClick={() => void remove()}>
                <Trash2 aria-hidden="true" />
                删除
              </button>
            </div>
          </>
        ) : (
          <form className="agent-profile-form" onSubmit={(event) => void saveProfile(event)} onKeyDown={(event) => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            event.stopPropagation();
            closeProfileEdit();
          }}>
            <div className="model-form-grid">
              <label className="wide">
                <span>名称</span>
                <input id={titleId} aria-label="智能体名称" value={profile.name} maxLength={AGENT_NAME_MAX_LENGTH} autoFocus
                  onChange={(event) => setProfile({ ...profile, name: event.target.value })} />
              </label>
              <label className="wide">
                <span>用途</span>
                <textarea className="agent-textarea" aria-label="智能体用途" value={profile.description} rows={2}
                  maxLength={AGENT_DESCRIPTION_MAX_LENGTH} placeholder="这类工作是什么，例如“审查代码改动，先列风险”。"
                  onChange={(event) => setProfile({ ...profile, description: event.target.value })} />
              </label>
            </div>
            {issueFor('profile')}
            <div className="model-form-actions">
              <button type="button" className="secondary-button" onClick={closeProfileEdit}>取消</button>
              <button type="submit" className="primary-button" disabled={busy || !profileChanged}>保存</button>
            </div>
          </form>
        )}
      </div>

      <section className="detail-section" aria-labelledby={`${titleId}-recent`}>
        <div className="section-title"><h3 id={`${titleId}-recent`}>最近任务</h3></div>
        <RecentTasks agentId={agent.agentId} isDefault={isDefault} active={active} onOpenTask={onOpenTask} />
      </section>

      <section className="detail-section" aria-labelledby={`${titleId}-model`}>
        <div className="section-title">
          <h3 id={`${titleId}-model`}>模型与推理</h3>
          <SavedMark saved={saved} target="model" />
        </div>
        <AgentModelPicker
          label={`${agent.name} 的模型与推理等级`}
          snapshot={models}
          value={{ modelProfileId: agent.modelProfileId, thinkingLevel: agent.thinkingLevel }}
          unavailable={modelState?.status === 'review'}
          disabled={busy}
          onOpen={onRefreshModels}
          onManage={onManageModels}
          onChange={(next) => void changeModel(next)}
        />
        {review && <p className="agent-model-review" role="status"><AlertCircle aria-hidden="true" /><span>{review}</span></p>}
        {issueFor('model')}
      </section>

      <section className="detail-section" aria-labelledby={`${titleId}-instructions`}>
        <div className="section-title"><h3 id={`${titleId}-instructions`}>指令</h3></div>
        <form className="project-constraints-form" onSubmit={(event) => void saveInstructions(event)}>
          <div className="project-constraints-field">
            <textarea
              ref={instructionsRef}
              className="agent-textarea agent-instructions"
              aria-label={`${agent.name} 的指令`}
              aria-describedby={instructionsNoteId}
              value={instructions}
              maxLength={AGENT_INSTRUCTIONS_MAX_LENGTH}
              rows={4}
              placeholder="这类工作的约定，例如“结论和证据分开写”。"
              onChange={(event) => {
                setInstructions(event.target.value);
                if (issue?.part === 'instructions') setIssue(null);
              }}
            />
            <small id={instructionsNoteId}>执行任务时与项目默认约束、工作目录里的 AGENTS.md 一起带入，三者并列适用。新建执行会话时读取，改动对已在执行的会话不生效。</small>
            {issueFor('instructions')}
          </div>
          <div className="project-constraints-actions">
            <SavedMark saved={saved} target="instructions" />
            <button type="button" className="secondary-button" disabled={busy || !instructionsChanged} onClick={revertInstructions}>还原</button>
            <button type="submit" className="primary-button" disabled={busy || !instructionsChanged}>保存</button>
          </div>
        </form>
      </section>
    </section>
  );
}

/** 用这个智能体执行的最近任务：随任务变更与事件流重连刷新，点击打开任务详情。 */
function RecentTasks({ agentId, isDefault, active, onOpenTask }: { agentId: string; isDefault: boolean; active: boolean; onOpenTask: (taskId: string) => void }) {
  const { requests } = useTaskRequests();
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef(0);
  const activeRef = useRef(active);
  activeRef.current = active;

  const load = useCallback(async () => {
    const request = ++requestRef.current;
    try {
      const result = await listAgentTasks(agentId, RECENT_TASK_LIMIT);
      if (request !== requestRef.current) return;
      setTasks(result.tasks);
      setError(null);
    } catch (cause) {
      if (request === requestRef.current) setError(errorText(cause, '最近任务读取失败。'));
    }
  }, [agentId]);

  useEffect(() => { if (active) void load(); }, [active, load]);
  useOptionalWorkbenchEvents((event) => {
    if (activeRef.current && (event.type === 'task.changed' || event.type === 'workbench.connected')) void load();
  });

  if (error && !tasks) {
    return (
      <p className="agent-recent-error" role="alert">
        {error}
        <button type="button" className="inline-link" onClick={() => void load()}>重试</button>
      </p>
    );
  }
  if (!tasks) return <p className="section-hint">正在读取最近任务…</p>;
  if (tasks.length === 0) {
    return <p className="section-hint">还没有用它执行的任务。{isDefault && '没有指定执行智能体的任务都用通用执行。'}</p>;
  }
  return (
    <ul className="agent-recent" aria-label="最近任务">
      {tasks.map((task) => (
        <li key={task.taskId}>
          <button type="button" className="agent-recent-task" title={task.title} onClick={() => onOpenTask(task.taskId)}>
            <span className={`task-status ${taskColumn(task, requests)}`}>{taskLabel(task, requests)}</span>
            <span className="agent-recent-title">{task.title}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

interface AgentDraftForm extends AgentModelFields {
  name: string;
  description: string;
  instructions: string;
}

const EMPTY_DRAFT: AgentDraftForm = { name: '', description: '', modelProfileId: null, thinkingLevel: null, instructions: '' };

/**
 * 页内新建表单（名称、用途、模型、推理等级、指令）：创建前不保存任何内容。
 * 同一份草稿的重复提交沿用同一个命令 ID，结果未知时再次创建不会重复登记；草稿改动后换新命令。
 */
function NewAgentForm({ models, onRefreshModels, onManageModels, onDirtyChange, onCancel, onCreated }: {
  models: ModelSettingsSnapshot | null;
  onRefreshModels: () => void;
  onManageModels: () => void;
  onDirtyChange: (dirty: boolean) => void;
  onCancel: () => void;
  onCreated: (agentId: string) => void;
}) {
  const titleId = useId();
  const [draft, setDraft] = useState<AgentDraftForm>(EMPTY_DRAFT);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const commandRef = useRef(newCommandId());
  const dirty = draft.name.trim() !== '' || draft.description.trim() !== '' || draft.instructions.trim() !== '' || draft.modelProfileId !== null;
  useEffect(() => { onDirtyChange(dirty); }, [dirty, onDirtyChange]);

  function change(patch: Partial<AgentDraftForm>): void {
    setDraft((current) => ({ ...current, ...patch }));
    setError('');
    commandRef.current = newCommandId();
  }

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (busy) return;
    if (!draft.name.trim()) { setError('智能体名称不能为空。'); return; }
    setBusy(true);
    setError('');
    try {
      const receipt = await createAgent({
        commandId: commandRef.current,
        name: draft.name.trim(),
        description: draft.description.trim(),
        modelProfileId: draft.modelProfileId,
        thinkingLevel: draft.thinkingLevel,
        instructions: draft.instructions.trim(),
      });
      await reloadAgents();
      onCreated(receipt.agent.agentId);
    } catch (cause) {
      setError(resultUnknown(cause)
        ? `创建结果未知：${errorText(cause, '服务没有响应。')}可以再次点“创建”核对，不会重复创建。`
        : errorText(cause, '创建失败，请重试。'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="session-detail agent-detail" aria-labelledby={titleId}>
      <div className="agent-detail-head">
        <div className="agent-detail-title">
          <h2 id={titleId}>新建智能体</h2>
          <p>一套执行配置：用哪个模型、推理多深、按什么约定干活。它不改变权限。</p>
        </div>
      </div>
      <form className="agent-new-form" aria-labelledby={titleId} onSubmit={(event) => void submit(event)}>
        <div className="model-form-grid">
          <label className="wide">
            <span>名称</span>
            <input aria-label="名称" value={draft.name} maxLength={AGENT_NAME_MAX_LENGTH} autoFocus placeholder="例如：代码审查"
              onChange={(event) => change({ name: event.target.value })} />
          </label>
          <label className="wide">
            <span>用途</span>
            <textarea className="agent-textarea" aria-label="用途" value={draft.description} rows={2} maxLength={AGENT_DESCRIPTION_MAX_LENGTH}
              placeholder="这类工作是什么，例如“审查代码改动，先列风险”。" onChange={(event) => change({ description: event.target.value })} />
          </label>
        </div>
        <div className="agent-new-field">
          <span>模型与推理等级</span>
          <AgentModelPicker
            label="新智能体的模型与推理等级"
            snapshot={models}
            value={{ modelProfileId: draft.modelProfileId, thinkingLevel: draft.thinkingLevel }}
            disabled={busy}
            onOpen={onRefreshModels}
            onManage={onManageModels}
            onChange={(next) => change(next)}
          />
        </div>
        <label className="agent-new-field">
          <span>指令</span>
          <textarea className="agent-textarea agent-instructions" aria-label="指令" value={draft.instructions} rows={4}
            maxLength={AGENT_INSTRUCTIONS_MAX_LENGTH} placeholder="这类工作的约定，例如“结论和证据分开写”。"
            onChange={(event) => change({ instructions: event.target.value })} />
          <small>执行任务时与项目默认约束、工作目录里的 AGENTS.md 一起带入，三者并列适用。</small>
        </label>
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="model-form-actions">
          <button type="button" className="secondary-button" disabled={busy} onClick={onCancel}>取消</button>
          <button type="submit" className="primary-button" disabled={busy || !draft.name.trim()}>
            {busy && <LoaderCircle className="spin" aria-hidden="true" />}
            创建
          </button>
        </div>
      </form>
    </section>
  );
}
