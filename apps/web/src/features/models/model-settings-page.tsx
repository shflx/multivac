import {
  AlertCircle,
  ChevronRight,
  CircleOff,
  Cpu,
  LoaderCircle,
  Pencil,
  Plus,
  RefreshCw,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type {
  ModelAvailability,
  ModelProfile,
  ModelProfileInput,
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
import { ManagementPageActions } from '../../app/management-layout.js';
import { useConfirm } from '../../components/confirm-card.js';
import { useSavedFlash } from '../../components/saved-mark.js';
import { ModelAccessPanel } from './model-access-panel.js';
import { ModelProfileForm } from './model-profile-form.js';
import { ModelSection, type ModelSavedPart } from './model-section.js';
import {
  authenticationTypeLabel,
  availabilityFor,
  availabilityView,
  defaultModelWarning,
  protocolLabel,
  reasoningLabel,
  type AvailabilityView,
} from './model-profile-view.js';
import { getModelAccess, MODEL_ACCESS_MESSAGES, ModelAccessApiError } from '../../data/model-access-api.js';
import { admitAccessSnapshot, mergeModelSettings } from './model-settings-view-state.js';

const EMPTY_DRAFT: ModelProfileInput = {
  profileId: '',
  displayName: '',
  provider: '',
  modelId: '',
  protocol: 'openai-responses',
  endpoint: null,
  reasoning: 'auto',
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '模型设置操作失败。';
}

function resultUnknown(error: unknown): boolean {
  return error instanceof ModelSettingsApiError &&
    (error.status === 0 || error.code === 'RESULT_UNKNOWN');
}

export interface ModelSettingsPageProps {
  onDirtyChange: (dirty: boolean) => void;
  onBusyChange: (busy: boolean) => void;
  discardSignal: number;
  active: boolean;
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
  active,
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
  const [accessBusy, setAccessBusy] = useState(false);
  const confirm = useConfirm();
  const saved = useSavedFlash<ModelSavedPart>();
  const pageRef = useRef<HTMLDivElement | null>(null);
  const editButtonRef = useRef<HTMLButtonElement | null>(null);
  const [pendingCommand, setPendingCommand] = useState<PendingModelCommand | null>(null);
  const editVersionRef = useRef(0);
  const loadRequestRef = useRef(0);
  const authenticationRequestRef = useRef(0);
  const [accessSnapshot, setAccessSnapshot] = useState<import('@multivac/contracts').ModelAccessSnapshot | null>(null);
  const [accessIssue, setAccessIssue] = useState<string | null>(null);
  const accessRef = useRef<import('@multivac/contracts').ModelAccessSnapshot | null>(null);
  const modelsRef = useRef<ModelSettingsSnapshot | null>(null);
  const accessRequestRef = useRef<Promise<void> | null>(null);
  const acceptModelSnapshot = useCallback((next: ModelSettingsSnapshot) => {
    const merged = mergeModelSettings(modelsRef.current, next, accessRef.current);
    modelsRef.current = merged;
    setSnapshot(merged);
  }, []);
  const acceptAccessSnapshot = useCallback((next: import('@multivac/contracts').ModelAccessSnapshot) => {
    const accepted = admitAccessSnapshot(accessRef.current, next);
    if (accepted === accessRef.current) return;
    accessRef.current = accepted;
    setAccessSnapshot(accepted);
    if (modelsRef.current) acceptModelSnapshot(modelsRef.current);
  }, [acceptModelSnapshot]);
  useEffect(() => {
    const deadlines = accessSnapshot?.checks.filter((check) => check.status !== 'expired' && check.status !== 'invalidated')
      .map((check) => check.expiresAt === null ? NaN : Date.parse(check.expiresAt)).filter(Number.isFinite) ?? [];
    if (deadlines.length === 0) return;
    const timer = setTimeout(() => { if (accessRef.current) acceptAccessSnapshot(accessRef.current); },
      Math.max(0, Math.min(...deadlines) - Date.now()) + 1);
    return () => clearTimeout(timer);
  }, [accessSnapshot, acceptAccessSnapshot]);
  const loadAccess = useCallback(() => {
    if (accessRequestRef.current) return accessRequestRef.current;
    const request = getModelAccess().then((next) => { acceptAccessSnapshot(next); setAccessIssue(null); }).catch((error: unknown) => {
      setAccessIssue(error instanceof ModelAccessApiError ? error.message : MODEL_ACCESS_MESSAGES.ACCESS_UNAVAILABLE);
    }).finally(() => { if (accessRequestRef.current === request) accessRequestRef.current = null; });
    accessRequestRef.current = request;
    return request;
  }, [acceptAccessSnapshot]);
  const refreshAccess = useCallback(async () => {
    if (accessRequestRef.current) await accessRequestRef.current;
    await loadAccess();
  }, [loadAccess]);
  useEffect(() => {
    if (!active) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => { await loadAccess(); if (!stopped) timer = setTimeout(() => void poll(), 1000); };
    void poll();
    return () => { stopped = true; if (timer) clearTimeout(timer); };
  }, [active, loadAccess]);
  const handledDiscardSignalRef = useRef(discardSignal);
  const commandLocked = saving || accessBusy || pendingCommand !== null;
  const refreshAuthentication = useCallback(async () => {
    const request = ++authenticationRequestRef.current;
    const next = await getModelSettings();
    if (request !== authenticationRequestRef.current) return;
    acceptModelSnapshot(next);
  }, [acceptModelSnapshot]);

  const load = useCallback(async () => {
    const requestId = ++loadRequestRef.current;
    setLoading(true);
    setLoadError(null);
    try {
      const next = await getModelSettings();
      if (requestId !== loadRequestRef.current) return;
      acceptModelSnapshot(next);
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
  }, [acceptModelSnapshot]);

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
    onBusyChange(saving || accessBusy);
  }, [accessBusy, onBusyChange, saving]);

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
  // 按列表里的配置计数：认证快照可能暂时带着别的版本的条目。
  const availableCount = snapshot?.profiles
    .filter((profile) => availabilityFor(snapshot, profile.profileId)?.available).length ?? 0;

  /**
   * 结束编辑（取消或保存成功）后焦点回到“编辑”（按原型）。“编辑”在退出编辑、重新渲染后才出现，
   * 所以先记下请求，等草稿清空的这次提交后再移动焦点；只在页面可见、焦点还在本页或已落到 body 时移动，
   * 不抢用户已经移到别处（如侧栏）的焦点。
   */
  const focusEditRequestRef = useRef(false);
  function returnFocusToEdit(): void {
    focusEditRequestRef.current = true;
  }
  useEffect(() => {
    if (!focusEditRequestRef.current || draft) return;
    focusEditRequestRef.current = false;
    const focused = document.activeElement;
    if (!active || (focused && focused !== document.body && !pageRef.current?.contains(focused))) return;
    editButtonRef.current?.focus({ preventScroll: true });
  }, [active, draft]);

  /** 切换配置或新建前：有未保存的更改时先经确认卡确认；保存或设默认进行中时不切换。 */
  async function confirmDiscard(): Promise<boolean> {
    if (commandLocked) return false;
    if (!dirty) return true;
    return confirm({
      title: '放弃未保存的更改？',
      description: '当前模型配置有未保存的更改，继续后这些更改会丢失。',
      tone: 'danger',
      confirmLabel: '放弃更改',
      cancelLabel: '继续编辑',
    });
  }

  async function chooseProfile(profileId: string): Promise<void> {
    if (profileId === selectedProfileId && !creating) return;
    if (!await confirmDiscard()) return;
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
      reasoning: selected.reasoning,
    });
    setCreating(false);
    setDirty(false);
    editVersionRef.current += 1;
    setOperationIssue(null);
  }

  async function startCreate(): Promise<void> {
    if (!await confirmDiscard()) return;
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
    returnFocusToEdit();
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
      acceptModelSnapshot(next);
      setSelectedProfileId(pending.submittedDraft.profileId.trim());
      setPendingCommand(null);
      saved.flash('config');
      if (editVersionRef.current === pending.editVersion) {
        setDraft(null);
        setCreating(false);
        setDirty(false);
        returnFocusToEdit();
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
      acceptModelSnapshot(await setDefaultModel(pending.command));
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
      acceptModelSnapshot(next);
      const committed = pendingCommand.kind === 'save'
        ? next.revision > pendingCommand.command.revision && next.profiles.some((profile) =>
            profile.profileId === pendingCommand.submittedDraft.profileId.trim() &&
            profile.displayName === pendingCommand.submittedDraft.displayName.trim() &&
            profile.provider === pendingCommand.submittedDraft.provider.trim() &&
            profile.modelId === pendingCommand.submittedDraft.modelId.trim() &&
            profile.protocol === pendingCommand.submittedDraft.protocol &&
            profile.reasoning === (pendingCommand.submittedDraft.reasoning ?? 'auto') &&
            (profile.endpoint ?? '') === (pendingCommand.submittedDraft.endpoint?.trim().replace(/\/$/u, '') ?? ''))
        : next.revision > pendingCommand.command.revision &&
          next.defaultProfileId === pendingCommand.command.profileId;
      if (committed) {
        if (pendingCommand.kind === 'save') {
          setSelectedProfileId(pendingCommand.submittedDraft.profileId.trim());
          setDraft(null);
          setCreating(false);
          setDirty(false);
          saved.flash('config');
          returnFocusToEdit();
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
      acceptModelSnapshot(next);
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

  const defaultWarning = defaultModelWarning(snapshot);
  // 保存结果未知、冲突等：编辑时写在表单的操作按钮上方，否则写在“配置”小节开头（设默认的问题）。
  const issue = operationIssue && (
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
  );
  const form = draft && (
    <ModelProfileForm
      draft={draft}
      saved={creating ? null : selected}
      dirty={dirty}
      locked={commandLocked}
      issue={issue}
      onChange={updateDraft}
      onSave={() => void submitSave()}
      onDiscard={discard}
    />
  );

  return (
    <div className="model-settings-page" data-management-page="models" ref={pageRef}>
      <ManagementPageActions>
        <button type="button" className="secondary-button" onClick={() => void startCreate()} disabled={commandLocked}>
          <Plus aria-hidden="true" />
          添加模型
        </button>
      </ManagementPageActions>

      {/* 默认模型失效时保留引用，只在页头下方提示一次，选中其他模型时也看得到。 */}
      {defaultWarning && (
        <p className="model-default-warning" role="status">
          <AlertCircle aria-hidden="true" />
          <span>{defaultWarning}</span>
        </p>
      )}

      <div className="model-settings">
        <section className="model-list-pane" aria-label="模型配置列表">
          <div className="model-list-heading">
            <span>模型配置 · <strong>{availableCount}/{snapshot.profiles.length} 可用</strong></span>
          </div>

          {snapshot.profiles.length === 0 ? (
            <div className="model-empty-list">
              <CircleOff aria-hidden="true" />
              <strong>暂无模型配置</strong>
              <span>添加一个官方模型或兼容端点。</span>
              <button type="button" onClick={() => void startCreate()} disabled={commandLocked}>
                <Plus aria-hidden="true" />
                添加模型
              </button>
            </div>
          ) : (
            <div className="model-list-items">
              {snapshot.profiles.map((profile) => {
                const view = availabilityView(availabilityFor(snapshot, profile.profileId));
                const isDefault = snapshot.defaultProfileId === profile.profileId;
                return (
                  <button
                    type="button"
                    key={profile.profileId}
                    className={profile.profileId === selectedProfileId && !creating ? 'selected' : ''}
                    onClick={() => void chooseProfile(profile.profileId)}
                    disabled={commandLocked}
                  >
                    <span className={`model-status-dot ${view.state}`} title={view.label} aria-hidden="true" />
                    <span className="model-list-copy">
                      <strong>{profile.displayName}</strong>
                      <small>{profile.provider} / {profile.modelId}{view.available ? '' : ` · ${view.label}`}</small>
                    </span>
                    {isDefault && <em className={`model-default-tag${view.available ? '' : ' unavailable'}`}>默认</em>}
                    <ChevronRight aria-hidden="true" />
                  </button>
                );
              })}
            </div>
          )}
        </section>

        <section className="model-detail-pane" aria-live="polite">
          {creating && form ? (
            <>
              <div className="model-detail-heading">
                <div>
                  <span className="model-availability">新配置</span>
                  <h2>添加模型</h2>
                  <p>填写连到哪个模型；保存后再配置 API Key 并检查连接。</p>
                </div>
              </div>
              <ModelSection title="配置" saved={saved} target="config">
                {form}
              </ModelSection>
            </>
          ) : selected ? (
            <>
              <ModelDetailHeading
                profile={selected}
                view={availabilityView(selectedAvailability)}
                isDefault={snapshot.defaultProfileId === selected.profileId}
                editing={draft !== null}
                locked={commandLocked}
                defaultBusy={saving && pendingCommand?.kind === 'default'}
                editButtonRef={editButtonRef}
                onEdit={startEdit}
                onSetDefault={() => void submitDefault()}
              />
              <ModelSection title="配置" saved={saved} target="config">
                {form ?? (
                  <>
                    {issue}
                    <ModelConfigReadonly profile={selected} availability={selectedAvailability} />
                  </>
                )}
              </ModelSection>
              {/* 编辑时两节仍然显示，只是暂停操作（原因写在各自的说明里）。 */}
              <ModelAccessPanel key={selected.profileId} profile={selected} snapshot={accessSnapshot}
                accessIssue={accessIssue} refresh={refreshAccess} onSnapshot={acceptAccessSnapshot}
                profileRevision={snapshot.revision} editing={draft !== null} saved={saved}
                active={active} locked={saving || pendingCommand !== null} onRefresh={refreshAuthentication} onBusy={setAccessBusy} />
            </>
          ) : (
            <div className="model-detail-empty">
              <Cpu aria-hidden="true" />
              <h2>选择模型配置</h2>
              <p>从左侧选择现有配置，或添加新的模型配置。</p>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

interface ModelDetailHeadingProps {
  profile: ModelProfile;
  view: AvailabilityView;
  isDefault: boolean;
  editing: boolean;
  locked: boolean;
  defaultBusy: boolean;
  editButtonRef: RefObject<HTMLButtonElement | null>;
  onEdit: () => void;
  onSetDefault: () => void;
}

/**
 * 详情头（按原型）：可用状态小标签 + 名称 + 一句说明（可用时是 Pi 的确认，不可用时是原因）；
 * 右侧“编辑”（编辑时隐藏）与“设为默认 / 当前默认”都是次要按钮。只有可用的模型才能设为默认。
 */
function ModelDetailHeading({
  profile,
  view,
  isDefault,
  editing,
  locked,
  defaultBusy,
  editButtonRef,
  onEdit,
  onSetDefault,
}: ModelDetailHeadingProps) {
  return (
    <div className="model-detail-heading">
      <div>
        <span className={`model-availability ${view.state}`}>{view.label}</span>
        <h2>{profile.displayName}</h2>
        <p>{view.message}</p>
      </div>
      <div className="model-detail-actions">
        {!editing && (
          <button ref={editButtonRef} type="button" className="secondary-button" onClick={onEdit} disabled={locked}>
            <Pencil aria-hidden="true" />
            编辑
          </button>
        )}
        <button
          type="button"
          className="secondary-button"
          onClick={onSetDefault}
          disabled={locked || isDefault || !view.available}
          title={!isDefault && !view.available ? '只有可用的模型才能设为默认' : undefined}
        >
          {defaultBusy && <LoaderCircle className="spin" aria-hidden="true" />}
          {isDefault ? '当前默认' : '设为默认'}
        </button>
      </div>
    </div>
  );
}

/**
 * 只读的“配置”：单列列出提供方、协议（显示名称）、模型 ID、API 端点与推理能力；
 * 配置 ID 与认证类型是技术字段，以小字放在下方。
 */
function ModelConfigReadonly({
  profile,
  availability,
}: {
  profile: ModelProfile;
  availability: ModelAvailability | undefined;
}) {
  return (
    <>
      <dl className="model-metadata">
        <div><dt>提供方</dt><dd>{profile.provider}</dd></div>
        <div><dt>协议</dt><dd>{protocolLabel(profile.protocol)}</dd></div>
        <div><dt>模型 ID</dt><dd><code>{profile.modelId}</code></dd></div>
        <div><dt>API 端点</dt><dd>{profile.endpoint ? <code>{profile.endpoint}</code> : 'Pi 官方默认端点'}</dd></div>
        <div><dt>推理能力</dt><dd>{reasoningLabel(profile)}</dd></div>
      </dl>
      <dl className="model-technical">
        <div><dt>配置 ID</dt><dd><code>{profile.profileId}</code></dd></div>
        <div><dt>认证类型</dt><dd>{authenticationTypeLabel(availability)}</dd></div>
      </dl>
    </>
  );
}
