import {
  AlertCircle,
  BrainCircuit,
  Check,
  CircleOff,
  Cpu,
  Image,
  LoaderCircle,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Star,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ModelAvailability,
  ModelProfile,
  ModelProfileInput,
  ModelProtocol,
  ModelSettingsSnapshot,
  SaveModelSettings,
  SetDefaultModel,
} from '@multivac/contracts';
import {
  ModelSettingsApiError,
  getModelSettings,
  saveModelSettings,
  setDefaultModel,
} from '../../data/model-settings-api.js';

const PROTOCOLS: Array<{ value: ModelProtocol; label: string }> = [
  { value: 'openai-responses', label: 'OpenAI Responses' },
  { value: 'openai-completions', label: 'OpenAI Chat Completions' },
  { value: 'anthropic-messages', label: 'Anthropic Messages' },
  { value: 'google-generative-ai', label: 'Google Generative AI' },
];

const EMPTY_DRAFT: ModelProfileInput = {
  profileId: '',
  displayName: '',
  provider: '',
  modelId: '',
  protocol: 'openai-responses',
  endpoint: null,
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '模型设置操作失败。';
}

function resultUnknown(error: unknown): boolean {
  return error instanceof ModelSettingsApiError &&
    (error.status === 0 || error.code === 'RESULT_UNKNOWN');
}

function formatTokens(tokens: number): string {
  return new Intl.NumberFormat('zh-CN').format(tokens);
}

function availabilityFor(
  snapshot: ModelSettingsSnapshot,
  profileId: string,
): ModelAvailability | undefined {
  return snapshot.availability.find((item) => item.profileId === profileId);
}

function statusLabel(availability: ModelAvailability | undefined): string {
  if (!availability) return '状态未知';
  if (availability.reason === 'CONFIGURATION_INVALID') return '配置需修复';
  if (availability.available) return '已认证且可用';
  if (!availability.authenticated) return '未认证';
  return '当前不可用';
}

export interface ModelSettingsPageProps {
  onDirtyChange: (dirty: boolean) => void;
  onBusyChange: (busy: boolean) => void;
  discardSignal: number;
}

type PendingModelCommand =
  | {
      kind: 'save';
      command: SaveModelSettings;
      submittedDraft: ModelProfileInput;
      editVersion: number;
    }
  | {
      kind: 'default';
      command: SetDefaultModel;
    };

interface OperationIssue {
  message: string;
  action: 'retry' | 'reload-preserve' | null;
}

export function ModelSettingsPage({
  onDirtyChange,
  onBusyChange,
  discardSignal,
}: ModelSettingsPageProps) {
  const [snapshot, setSnapshot] = useState<ModelSettingsSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [operationIssue, setOperationIssue] = useState<OperationIssue | null>(null);
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null);
  const [draft, setDraft] = useState<ModelProfileInput | null>(null);
  const [creating, setCreating] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [pendingCommand, setPendingCommand] = useState<PendingModelCommand | null>(null);
  const editVersionRef = useRef(0);
  const loadRequestRef = useRef(0);
  const handledDiscardSignalRef = useRef(discardSignal);
  const commandLocked = saving || pendingCommand !== null;

  const load = useCallback(async () => {
    const requestId = ++loadRequestRef.current;
    setLoading(true);
    setLoadError(null);
    try {
      const next = await getModelSettings();
      if (requestId !== loadRequestRef.current) return;
      setSnapshot(next);
      setSelectedProfileId((current) =>
        current && next.profiles.some((profile) => profile.profileId === current)
          ? current
          : next.defaultProfileId ?? next.profiles[0]?.profileId ?? null,
      );
    } catch (error) {
      if (requestId !== loadRequestRef.current) return;
      setLoadError(errorMessage(error));
    } finally {
      if (requestId === loadRequestRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (discardSignal === handledDiscardSignalRef.current) return;
    handledDiscardSignalRef.current = discardSignal;
    editVersionRef.current += 1;
    setDraft(null);
    setCreating(false);
    setDirty(false);
    setOperationIssue(null);
    void load();
  }, [discardSignal, load]);

  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);

  useEffect(() => {
    onBusyChange(saving);
  }, [onBusyChange, saving]);

  useEffect(() => {
    if (!dirty && pendingCommand === null) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty, pendingCommand]);

  const selected = useMemo(
    () => snapshot?.profiles.find((profile) => profile.profileId === selectedProfileId) ?? null,
    [selectedProfileId, snapshot],
  );
  const selectedAvailability = snapshot && selected
    ? availabilityFor(snapshot, selected.profileId)
    : undefined;
  const availableCount = snapshot?.availability.filter((item) => item.available).length ?? 0;

  function confirmDiscard(): boolean {
    if (commandLocked) return false;
    return !dirty || window.confirm('当前模型配置有未保存的更改，确定放弃吗？');
  }

  function chooseProfile(profileId: string): void {
    if (profileId === selectedProfileId && !creating) return;
    if (!confirmDiscard()) return;
    setSelectedProfileId(profileId);
    setDraft(null);
    setCreating(false);
    setDirty(false);
    editVersionRef.current += 1;
    setOperationIssue(null);
  }

  function startEdit(): void {
    if (!selected) return;
    setDraft({
      profileId: selected.profileId,
      displayName: selected.displayName,
      provider: selected.provider,
      modelId: selected.modelId,
      protocol: selected.protocol,
      endpoint: selected.endpoint,
    });
    setCreating(false);
    setDirty(false);
    editVersionRef.current += 1;
    setOperationIssue(null);
  }

  function startCreate(): void {
    if (!confirmDiscard()) return;
    setDraft({ ...EMPTY_DRAFT });
    setCreating(true);
    setDirty(false);
    editVersionRef.current += 1;
    setOperationIssue(null);
  }

  function updateDraft<K extends keyof ModelProfileInput>(key: K, value: ModelProfileInput[K]): void {
    setDraft((current) => current ? { ...current, [key]: value } : current);
    editVersionRef.current += 1;
    setDirty(true);
    setOperationIssue(null);
  }

  function discard(): void {
    setDraft(null);
    setCreating(false);
    setDirty(false);
    editVersionRef.current += 1;
    setOperationIssue(null);
  }

  async function submitSave(retry?: Extract<PendingModelCommand, { kind: 'save' }>): Promise<void> {
    if (!snapshot || (!draft && !retry) || saving) return;
    const pending = retry ?? {
      kind: 'save' as const,
      command: {
        commandId: crypto.randomUUID(),
        revision: snapshot.revision,
        profile: structuredClone(draft!),
      },
      submittedDraft: structuredClone(draft!),
      editVersion: editVersionRef.current,
    };
    if (!retry) setDirty(false);
    setPendingCommand(pending);
    setSaving(true);
    setOperationIssue(null);
    try {
      const next = await saveModelSettings(pending.command);
      setSnapshot(next);
      setSelectedProfileId(pending.submittedDraft.profileId.trim());
      setPendingCommand(null);
      if (editVersionRef.current === pending.editVersion) {
        setDraft(null);
        setCreating(false);
        setDirty(false);
      }
    } catch (error) {
      if (resultUnknown(error)) {
        setOperationIssue({ message: errorMessage(error), action: 'retry' });
      } else if (
        error instanceof ModelSettingsApiError &&
        error.code === 'MODEL_SETTINGS_CONFLICT'
      ) {
        setPendingCommand(null);
        setDirty(true);
        setOperationIssue({
          message: '服务端配置已更新。重新加载会保留当前草稿，之后可再次保存。',
          action: 'reload-preserve',
        });
      } else {
        setPendingCommand(null);
        setDirty(true);
        setOperationIssue({ message: errorMessage(error), action: null });
      }
    } finally {
      setSaving(false);
    }
  }

  async function submitDefault(
    retry?: Extract<PendingModelCommand, { kind: 'default' }>,
  ): Promise<void> {
    if (!snapshot || !selected || saving) return;
    const pending = retry ?? {
      kind: 'default' as const,
      command: {
        commandId: crypto.randomUUID(),
        revision: snapshot.revision,
        profileId: selected.profileId,
      },
    };
    setPendingCommand(pending);
    setSaving(true);
    setOperationIssue(null);
    try {
      setSnapshot(await setDefaultModel(pending.command));
      setPendingCommand(null);
    } catch (error) {
      if (resultUnknown(error)) {
        setOperationIssue({ message: errorMessage(error), action: 'retry' });
      } else if (
        error instanceof ModelSettingsApiError &&
        error.code === 'MODEL_SETTINGS_CONFLICT'
      ) {
        setPendingCommand(null);
        setOperationIssue({
          message: '服务端配置已更新，请重新加载后再次设置默认模型。',
          action: 'reload-preserve',
        });
      } else {
        setPendingCommand(null);
        setOperationIssue({ message: errorMessage(error), action: null });
      }
    } finally {
      setSaving(false);
    }
  }

  async function retryPendingCommand(): Promise<void> {
    if (!pendingCommand || saving) return;
    if (pendingCommand.kind === 'save') await submitSave(pendingCommand);
    else await submitDefault(pendingCommand);
  }

  async function reconcilePendingCommand(): Promise<void> {
    if (!pendingCommand || saving) return;
    setSaving(true);
    try {
      const next = await getModelSettings();
      setSnapshot(next);
      const committed = pendingCommand.kind === 'save'
        ? next.revision > pendingCommand.command.revision && next.profiles.some((profile) =>
            profile.profileId === pendingCommand.submittedDraft.profileId.trim() &&
            profile.displayName === pendingCommand.submittedDraft.displayName.trim() &&
            profile.provider === pendingCommand.submittedDraft.provider.trim() &&
            profile.modelId === pendingCommand.submittedDraft.modelId.trim() &&
            profile.protocol === pendingCommand.submittedDraft.protocol &&
            (profile.endpoint ?? '') === (pendingCommand.submittedDraft.endpoint?.trim().replace(/\/$/u, '') ?? ''))
        : next.revision > pendingCommand.command.revision &&
          next.defaultProfileId === pendingCommand.command.profileId;
      if (committed) {
        if (pendingCommand.kind === 'save') {
          setSelectedProfileId(pendingCommand.submittedDraft.profileId.trim());
          setDraft(null);
          setCreating(false);
          setDirty(false);
        }
        setPendingCommand(null);
        setOperationIssue(null);
        return;
      }
      if (next.revision > pendingCommand.command.revision) {
        if (pendingCommand.kind === 'save') setDirty(true);
        setPendingCommand(null);
        setOperationIssue({
          message: '服务端已有其它更新，当前命令未能确认；草稿已保留。',
          action: pendingCommand.kind === 'save' ? 'reload-preserve' : null,
        });
        return;
      }
      setOperationIssue({
        message: '服务端尚未出现该命令结果，请重试原命令继续对账。',
        action: 'retry',
      });
    } catch (error) {
      setOperationIssue({ message: errorMessage(error), action: 'retry' });
    } finally {
      setSaving(false);
    }
  }

  async function reloadPreservingDraft(): Promise<void> {
    if (saving) return;
    const requestId = ++loadRequestRef.current;
    setSaving(true);
    try {
      const next = await getModelSettings();
      if (requestId !== loadRequestRef.current) return;
      setSnapshot(next);
      setSelectedProfileId((current) =>
        current && next.profiles.some((profile) => profile.profileId === current)
          ? current
          : next.defaultProfileId ?? next.profiles[0]?.profileId ?? null,
      );
      setOperationIssue(null);
    } catch (error) {
      if (requestId === loadRequestRef.current) {
        setOperationIssue({ message: errorMessage(error), action: 'reload-preserve' });
      }
    } finally {
      if (requestId === loadRequestRef.current) setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="model-page-state" data-management-page="models">
        <LoaderCircle className="spin" aria-hidden="true" />
        <h2>正在加载模型设置</h2>
        <p>正在从本地服务读取 Pi 模型目录和认证状态。</p>
      </div>
    );
  }

  if (loadError || !snapshot) {
    return (
      <div className="model-page-state model-error-state" data-management-page="models">
        <AlertCircle aria-hidden="true" />
        <h2>模型设置加载失败</h2>
        <p>{loadError ?? '模型设置当前不可用。'}</p>
        <button type="button" onClick={() => void load()}>
          <RefreshCw aria-hidden="true" />
          重新加载
        </button>
      </div>
    );
  }

  return (
    <div className="model-settings" data-management-page="models">
      <section className="model-list-pane" aria-label="模型配置列表">
        <div className="model-list-summary">
          <div>
            <strong>{snapshot.profiles.length}</strong>
            <span>配置</span>
          </div>
          <div>
            <strong>{availableCount}</strong>
            <span>可用</span>
          </div>
          <button
            type="button"
            onClick={startCreate}
            aria-label="添加模型配置"
            title="添加模型配置"
            disabled={commandLocked}
          >
            <Plus aria-hidden="true" />
          </button>
        </div>

        {snapshot.profiles.length === 0 ? (
          <div className="model-empty-list">
            <CircleOff aria-hidden="true" />
            <strong>暂无模型配置</strong>
            <span>添加一个官方模型或兼容端点。</span>
            <button type="button" onClick={startCreate} disabled={commandLocked}>
              <Plus aria-hidden="true" />
              添加模型
            </button>
          </div>
        ) : (
          <div className="model-list-items">
            {snapshot.profiles.map((profile) => {
              const availability = availabilityFor(snapshot, profile.profileId);
              const isDefault = snapshot.defaultProfileId === profile.profileId;
              return (
                <button
                  type="button"
                  key={profile.profileId}
                  className={profile.profileId === selectedProfileId && !creating ? 'selected' : ''}
                  onClick={() => chooseProfile(profile.profileId)}
                  disabled={commandLocked}
                >
                  <span className={`model-status-dot ${availability?.available ? 'available' : ''}`} />
                  <span className="model-list-copy">
                    <strong>{profile.displayName}</strong>
                    <small>{profile.provider} / {profile.modelId}</small>
                  </span>
                  {isDefault && <Star className="default-star" aria-label="全局默认" />}
                </button>
              );
            })}
          </div>
        )}
      </section>

      <section className="model-detail-pane" aria-live="polite">
        {operationIssue && (
          <div className="model-operation-error" role="alert">
            <AlertCircle aria-hidden="true" />
            <span>{operationIssue.message}</span>
            {operationIssue.action === 'retry' && (
              <>
                <button type="button" onClick={() => void retryPendingCommand()} disabled={saving}>
                  <RefreshCw aria-hidden="true" />
                  重试原命令
                </button>
                <button type="button" onClick={() => void reconcilePendingCommand()} disabled={saving}>
                  <RefreshCw aria-hidden="true" />
                  重新加载确认结果
                </button>
              </>
            )}
            {operationIssue.action === 'reload-preserve' && (
              <button type="button" onClick={() => void reloadPreservingDraft()} disabled={saving}>
                <RefreshCw aria-hidden="true" />
                重新加载并保留草稿
              </button>
            )}
          </div>
        )}

        {draft ? (
          <ModelProfileForm
            draft={draft}
            creating={creating}
            locked={commandLocked}
            onChange={updateDraft}
            onSave={() => void submitSave()}
            onDiscard={discard}
          />
        ) : selected ? (
          <ModelProfileDetail
            profile={selected}
            availability={selectedAvailability}
            isDefault={snapshot.defaultProfileId === selected.profileId}
            locked={commandLocked}
            onEdit={startEdit}
            onSetDefault={() => void submitDefault()}
          />
        ) : (
          <div className="model-detail-empty">
            <Cpu aria-hidden="true" />
            <h2>选择模型配置</h2>
            <p>从左侧选择现有配置，或添加新的模型配置。</p>
          </div>
        )}
      </section>
    </div>
  );
}

interface ModelProfileFormProps {
  draft: ModelProfileInput;
  creating: boolean;
  locked: boolean;
  onChange: <K extends keyof ModelProfileInput>(key: K, value: ModelProfileInput[K]) => void;
  onSave: () => void;
  onDiscard: () => void;
}

function ModelProfileForm({
  draft,
  creating,
  locked,
  onChange,
  onSave,
  onDiscard,
}: ModelProfileFormProps) {
  const saveDisabled = locked || !draft.profileId.trim() || !draft.displayName.trim() ||
    !draft.provider.trim() || !draft.modelId.trim();
  return (
    <form className="model-profile-form" onSubmit={(event) => { event.preventDefault(); onSave(); }}>
      <div className="model-detail-heading">
        <div>
          <span>{creating ? '新配置' : '编辑配置'}</span>
          <h2>{creating ? '添加模型' : draft.displayName}</h2>
        </div>
        <div className="model-detail-actions">
          <button type="button" className="secondary" onClick={onDiscard} disabled={locked}>
            <X aria-hidden="true" />
            放弃
          </button>
          <button type="submit" className="primary" disabled={saveDisabled}>
            {locked ? <LoaderCircle className="spin" aria-hidden="true" /> : <Save aria-hidden="true" />}
            保存
          </button>
        </div>
      </div>

      <div className="model-form-grid">
        <label>
          <span>配置 ID</span>
          <input
            aria-label="配置 ID"
            value={draft.profileId}
            readOnly={!creating}
            disabled={locked}
            onChange={(event) => onChange('profileId', event.target.value)}
            placeholder="例如 openai-main"
          />
          <small>保存后保持稳定，用于默认模型引用。</small>
        </label>
        <label>
          <span>显示名称</span>
          <input
            aria-label="显示名称"
            value={draft.displayName}
            disabled={locked}
            onChange={(event) => onChange('displayName', event.target.value)}
            placeholder="例如 GPT 主模型"
          />
        </label>
        <label>
          <span>Provider</span>
          <input
            aria-label="Provider"
            value={draft.provider}
            disabled={locked}
            onChange={(event) => onChange('provider', event.target.value)}
            placeholder="例如 openai"
          />
        </label>
        <label>
          <span>模型 ID</span>
          <input
            aria-label="模型 ID"
            value={draft.modelId}
            disabled={locked}
            onChange={(event) => onChange('modelId', event.target.value)}
            placeholder="例如 gpt-5"
          />
        </label>
        <label>
          <span>协议</span>
          <select
            aria-label="协议"
            value={draft.protocol}
            disabled={locked}
            onChange={(event) => onChange('protocol', event.target.value as ModelProtocol)}
          >
            {PROTOCOLS.map((protocol) => (
              <option key={protocol.value} value={protocol.value}>{protocol.label}</option>
            ))}
          </select>
        </label>
        <label>
          <span>端点</span>
          <input
            aria-label="端点"
            value={draft.endpoint ?? ''}
            disabled={locked}
            onChange={(event) => onChange('endpoint', event.target.value || null)}
            placeholder="官方 Provider 可留空"
          />
          <small>兼容 Provider 必须填写 HTTP(S) 地址，且不得包含用户名或密码。</small>
        </label>
      </div>

      <div className="model-readonly-note">
        <BrainCircuit aria-hidden="true" />
        <span>认证、可用性、上下文窗口、最大输出和推理能力由 Pi 判定，不能在此覆盖。</span>
      </div>
    </form>
  );
}

interface ModelProfileDetailProps {
  profile: ModelProfile;
  availability: ModelAvailability | undefined;
  isDefault: boolean;
  locked: boolean;
  onEdit: () => void;
  onSetDefault: () => void;
}

function ModelProfileDetail({
  profile,
  availability,
  isDefault,
  locked,
  onEdit,
  onSetDefault,
}: ModelProfileDetailProps) {
  return (
    <div className="model-profile-detail">
      <div className="model-detail-heading">
        <div>
          <span>{profile.provider}</span>
          <h2>{profile.displayName}</h2>
          <p>{profile.modelId}</p>
        </div>
        <div className="model-detail-actions">
          <button type="button" className="secondary" onClick={onEdit} disabled={locked}>
            <Pencil aria-hidden="true" />
            编辑
          </button>
          <button
            type="button"
            className="primary"
            onClick={onSetDefault}
            disabled={locked || isDefault || !availability?.available}
          >
            {locked ? <LoaderCircle className="spin" aria-hidden="true" /> : <Star aria-hidden="true" />}
            {isDefault ? '当前默认' : '设为默认'}
          </button>
        </div>
      </div>

      <div className={`model-availability ${availability?.available ? 'available' : 'unavailable'}`}>
        {availability?.available ? <Check aria-hidden="true" /> : <AlertCircle aria-hidden="true" />}
        <div>
          <strong>{statusLabel(availability)}</strong>
          <span>{availability?.message ?? 'Pi 当前已确认该模型具备有效认证并可用。'}</span>
        </div>
      </div>

      {isDefault && !availability?.available && (
        <div className="default-invalid-warning">
          <AlertCircle aria-hidden="true" />
          <span>默认引用已保留，但当前不可用；Multivac 不会自动切换到其他模型。</span>
        </div>
      )}

      <dl className="model-metadata">
        <div><dt>配置 ID</dt><dd>{profile.profileId}</dd></div>
        <div><dt>协议</dt><dd>{profile.protocol}</dd></div>
        <div><dt>端点</dt><dd>{profile.endpoint ?? 'Pi 官方默认端点'}</dd></div>
        <div><dt>认证类型</dt><dd>{availability?.authenticationType ?? '未认证'}</dd></div>
      </dl>

      <div className="model-capabilities">
        <h3>Pi 报告的能力</h3>
        {profile.capabilities ? (
          <>
            <p className={`capability-source ${profile.capabilities.source}`}>
              {profile.capabilities.source === 'pi-catalog'
                ? '来源：Pi 模型目录实际声明'
                : '来源：Pi 对未知兼容模型使用的缺省能力，不代表上游真实能力'}
            </p>
            <div className="capability-grid">
              <div><Cpu aria-hidden="true" /><span>上下文窗口</span><strong>{formatTokens(profile.capabilities.contextWindow)}</strong></div>
              <div><Save aria-hidden="true" /><span>最大输出 Token</span><strong>{formatTokens(profile.capabilities.maxOutputTokens)}</strong></div>
              <div><BrainCircuit aria-hidden="true" /><span>推理能力</span><strong>{profile.capabilities.reasoning ? '支持' : '不支持'}</strong></div>
              <div><Image aria-hidden="true" /><span>输入类型</span><strong>{profile.capabilities.input.join('、')}</strong></div>
            </div>
          </>
        ) : (
          <p className="capability-missing">Pi 当前目录中没有可展示的模型能力。</p>
        )}
      </div>
    </div>
  );
}
