import { useEffect, useId, useRef, useState, useSyncExternalStore, type DragEvent, type ReactNode } from 'react';
import {
  ChevronDown,
  ChevronUp,
  CircleAlert,
  Download,
  FileArchive,
  FileText,
  Folder,
  FolderOpen,
  FolderSearch,
  Info,
  Layers,
  LoaderCircle,
  MoreHorizontal,
  MousePointerClick,
  Plus,
  Power,
  RefreshCw,
  Sparkles,
  Trash2,
  Wrench,
  X,
} from 'lucide-react';
import {
  SKILL_DRAFT_SOURCE_PREFIX,
  SKILL_UPLOAD_SOURCE_PREFIX,
  isPackagedSkillSource,
  type SkillImport,
  type SkillManifest,
  type SkillPreview,
  type SkillRecord,
  type SkillUpload,
  type SkillUseView,
  type Workspace,
} from '@multivac/contracts';
import { ManagementPageActions } from '../../app/management-layout.js';
import { ConfirmCard, useConfirm } from '../../components/confirm-card.js';
import { listWorkspaces } from '../../data/workspace-api.js';
import { useWorkbenchEvents } from '../workbench/workbench-sync-provider.js';
import { skillApi, skillsStore } from './skills-store.js';
import { readSkillDirectoryPick, readSkillDroppedDirectory, readSkillZipPick, type SkillUploadPick } from './skill-upload.js';
import './skills.css';

interface Props {
  active: boolean;
  onDirtyChange: (dirty: boolean) => void;
  onBusyChange: (busy: boolean) => void;
  discardSignal: number;
  /** 从使用记录打开对应会话；未提供时只展示会话名称。 */
  onOpenSession?: (sessionId: string) => void;
}

interface SkillDetailData {
  record: SkillRecord;
  manifest: SkillManifest;
  body: string;
  uses?: SkillUseView[];
}

/** 某个项目中的可见性偏好；revision 用于并发核对。 */
interface ProjectVisibility {
  revision: number;
  hidden: boolean;
}

interface SkillCandidate {
  source: string;
  name: string;
  description: string;
  error: string | null;
  diagnostics: string[];
}

const isDraft = (record: SkillRecord) => record.source.startsWith(SKILL_DRAFT_SOURCE_PREFIX);

/** 来源的展示文字：对话草案与上传包没有本机路径，只显示来历。 */
function sourceLabel(source: string): string {
  if (source.startsWith(SKILL_DRAFT_SOURCE_PREFIX)) return '用户确认的对话草案';
  if (source.startsWith(SKILL_UPLOAD_SOURCE_PREFIX)) return `本地上传 · ${source.slice(SKILL_UPLOAD_SOURCE_PREFIX.length)}`;
  return source;
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false });
}

/** 详情中默认展示的使用记录条数，更多的按需展开。 */
const USES_PREVIEW = 5;

/** 使用记录的时间：一周内用相对时间，更早的显示日期。 */
function formatUseTime(value: string, now = Date.now()): string {
  const at = Date.parse(value);
  if (Number.isNaN(at)) return value;
  const minutes = Math.floor(Math.max(0, now - at) / 60000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)} 小时前`;
  if (minutes < 7 * 24 * 60) return `${Math.floor(minutes / 60 / 24)} 天前`;
  return new Date(at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
}

/** 一次使用的来由：用户在对话中手动选择，或模型按需读取正文、资源。 */
function useAction(use: SkillUseView): { icon: typeof Layers; label: string } {
  if (use.toolCallId.startsWith('explicit:')) return { icon: MousePointerClick, label: '在对话中选择' };
  return use.kind === 'resource' ? { icon: FileText, label: '模型读取资源' } : { icon: Sparkles, label: '模型按需加载' };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function declaredTools(manifest: SkillManifest): string {
  if (manifest.dependencies.source === 'unknown') return '未声明（不代表不需要工具）';
  return manifest.dependencies.tools.join('、') || '声明无工具依赖';
}

/**
 * 管理 · 设置 · 能力：列表 + 详情，“导入 Skill”在页头。
 * 右侧在导入面板与 Skill 详情之间切换；没有 Skill 时直接显示导入面板。
 */
export function SkillsPage({ active, onDirtyChange, onBusyChange, discardSignal, onOpenSession }: Props) {
  const state = useSyncExternalStore(skillsStore.subscribe, skillsStore.snapshot),
    confirm = useConfirm();
  const [selected, setSelected] = useState<string | null>(null),
    [detail, setDetail] = useState<SkillDetailData | null>(null),
    [importing, setImporting] = useState(false);
  const [source, setSource] = useState(''),
    [displayName, setDisplayName] = useState(''),
    [projectId, setProjectId] = useState(''),
    [projects, setProjects] = useState<Workspace[]>([]),
    [editing, setEditing] = useState<SkillRecord | null>(null),
    [upload, setUpload] = useState<SkillUploadPick | null>(null);
  const [preview, setPreview] = useState<SkillPreview | null>(null),
    [commandId, setCommandId] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [visibility, setVisibility] = useState<Record<string, ProjectVisibility>>({});
  const [dependencyDraft, setDependencyDraft] = useState('');
  const [candidateSource, setCandidateSource] = useState(''),
    [candidates, setCandidates] = useState<SkillCandidate[]>([]);
  const projectOptions = projects.filter((w) => w.project);
  const empty = state.loaded && state.records.length === 0;
  const showImport = importing || empty;

  const reset = () => {
    setDependencyDraft('');
    setCandidateSource('');
    setCandidates([]);
    setSource('');
    setUpload(null);
    setDisplayName('');
    setProjectId('');
    setEditing(null);
    setPreview(null);
    setError('');
  };
  useEffect(() => {
    reset();
    setImporting(false);
  }, [discardSignal]);
  useEffect(() => {
    onDirtyChange(!!source || !!upload || !!preview || !!dependencyDraft || !!displayName || !!candidateSource);
  }, [source, upload, preview, dependencyDraft, displayName, candidateSource, onDirtyChange]);
  useEffect(() => {
    onBusyChange(busy);
  }, [busy, onBusyChange]);
  useEffect(() => {
    if (active) {
      void skillsStore.refresh();
      void listWorkspaces()
        .then(setProjects)
        .catch((e) => setError(e.message));
    }
  }, [active]);
  useWorkbenchEvents((e) => {
    if (e.type === 'skill.changed' || e.type === 'workbench.connected') void skillsStore.refresh();
  });

  // 未选中或所选已被移除时，默认展示第一个 Skill，右侧不留空白。
  useEffect(() => {
    if (!state.loaded) return;
    if (!selected || !state.records.some((r) => r.skillId === selected)) setSelected(state.records[0]?.skillId ?? null);
  }, [state.loaded, state.records, selected]);
  useEffect(() => {
    let current = true;
    setDetail(null);
    if (selected)
      void skillApi<SkillDetailData>('/' + encodeURIComponent(selected))
        .then((d) => {
          if (current) setDetail(d);
        })
        .catch((e) => {
          if (current) setError(e.message);
        });
    return () => {
      current = false;
    };
  }, [selected, state.records]);
  // 逐个读取各项目中的可见性；项目专属的 Skill 只在所属项目中有意义。
  const record = state.records.find((r) => r.skillId === selected);
  const visibilityProjects = projectOptions.filter((w) => !record?.projectId || w.project!.projectId === record.projectId);
  const visibilityKey = visibilityProjects.map((w) => w.project!.projectId).join(',');
  // 切换 Skill 时清空；同一 Skill 刷新时保留旧值，开关不闪回“读取中”。
  useEffect(() => {
    setVisibility({});
  }, [selected]);
  useEffect(() => {
    let current = true;
    if (selected)
      void Promise.all(
        visibilityProjects.map(async (w) => {
          const projectId = w.project!.projectId;
          const value = await skillApi<ProjectVisibility>(
            `/preference?skillId=${encodeURIComponent(selected)}&projectId=${encodeURIComponent(projectId)}`,
          );
          return [projectId, value] as const;
        }),
      )
        .then((entries) => {
          if (current) setVisibility(Object.fromEntries(entries));
        })
        .catch((e) => {
          if (current) setError(e.message);
        });
    return () => {
      current = false;
    };
  }, [selected, visibilityKey, state.records]);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  /** 离开当前详情前，确认是否放弃未保存的依赖补充。 */
  async function leaveDetail(): Promise<boolean> {
    if (!dependencyDraft) return true;
    if (!(await confirm({ title: '放弃未保存的依赖补充？', confirmLabel: '放弃', tone: 'danger' }))) return false;
    setDependencyDraft('');
    return true;
  }

  async function select(skillId: string) {
    if (!importing && selected === skillId) return;
    if (importing && (source || upload || displayName || candidateSource)) {
      if (!(await confirm({ title: '放弃正在进行的导入？', confirmLabel: '放弃', tone: 'danger' }))) return;
      reset();
    } else if (!(await leaveDetail())) return;
    setImporting(false);
    setSelected(skillId);
  }

  async function startImport(record?: SkillRecord) {
    if (!importing && !(await leaveDetail())) return;
    reset();
    if (record) {
      setEditing(record);
      if (!isPackagedSkillSource(record.source)) setSource(record.source);
      setDisplayName(record.displayName);
      setProjectId(record.projectId ?? '');
    }
    setImporting(true);
    requestAnimationFrame(() => document.getElementById('skill-source')?.focus());
  }

  function cancelImport() {
    reset();
    setImporting(false);
  }

  /** 已选择上传包时提交包内容，否则按服务端本机目录预览。 */
  async function previewImport() {
    const common = {
      displayName,
      projectId: projectId || null,
      ...(editing ? { skillId: editing.skillId, revision: editing.revision } : {}),
    };
    await run(async () => {
      const result = upload
        ? await skillApi<SkillPreview>('/preview-upload', { ...common, label: upload.label, content: upload.content } satisfies SkillUpload)
        : await skillApi<SkillPreview>('/preview', { ...common, source } satisfies SkillImport);
      setPreview(result);
      setCommandId(crypto.randomUUID());
    });
  }

  /** 读取浏览器选择的目录或 zip 包；读取期间禁用表单，失败原因显示在页面顶部。 */
  function pickUpload(read: () => Promise<SkillUploadPick>) {
    void run(async () => {
      const pick = await read();
      setSource('');
      setUpload(pick);
    });
  }

  async function changeState(record: SkillRecord, action: 'enable' | 'disable' | 'remove') {
    const commandId = crypto.randomUUID();
    await confirm({
      title: `${action === 'remove' ? '移除' : action === 'disable' ? '停用' : '启用'}「${record.displayName}」？`,
      description: '只影响后续发现和加载，已进入历史的内容仍保留。源文件不会删除。',
      tone: action === 'remove' ? 'danger' : 'default',
      confirmLabel: '确认',
      action: async () => {
        await skillApi('/state', { commandId, skillId: record.skillId, revision: record.revision, action });
        await skillsStore.refresh();
        if (action === 'remove') setSelected(null);
      },
    });
  }

  function saveDependencies(record: SkillRecord) {
    const commandId = crypto.randomUUID();
    void confirm({
      title: '保存用户补充的依赖？',
      description: dependencyDraft.trim() || '确认无工具依赖',
      confirmLabel: '保存',
      action: async () => {
        await skillApi('/dependencies', {
          commandId,
          skillId: record.skillId,
          revision: record.revision,
          tools: dependencyDraft.trim().split(/\s+/u).filter(Boolean),
        });
        setDependencyDraft('');
        await skillsStore.refresh();
      },
    });
  }

  function changeHidden(record: SkillRecord, projectId: string, value: boolean) {
    const current = visibility[projectId];
    if (!current) return;
    void run(async () => {
      await skillApi('/preference', {
        commandId: crypto.randomUUID(),
        skillId: record.skillId,
        projectId,
        sessionId: null,
        revision: current.revision,
        hidden: value,
      });
      await skillsStore.refresh();
    });
  }

  if (!state.loaded) {
    return (
      <div className="management-page-state" data-management-page="skills" aria-live="polite">
        <LoaderCircle className="spin" aria-hidden="true" />
        <p role="status">正在读取 Skill</p>
      </div>
    );
  }

  return (
    <section className="projects-page skills-page" data-management-page="skills" aria-label="Skill 管理">
      <ManagementPageActions>
        <button type="button" className="secondary-button" disabled={busy || showImport} onClick={() => void startImport()}>
          <Plus aria-hidden="true" />
          导入 Skill
        </button>
      </ManagementPageActions>
      {(error || state.error) && !preview && (
        <p className="skills-alert" role="alert">
          <CircleAlert aria-hidden="true" />
          {error || state.error}
        </p>
      )}
      <div className="sessions-layout projects-layout skills-layout">
        <div className="project-list-pane">
          {empty ? (
            <div className="skills-list-empty">
              <Layers aria-hidden="true" />
              <p>还没有 Skill。选择包含 SKILL.md 的目录，预览后确认导入。</p>
            </div>
          ) : (
            <div className="session-list project-list" role="list" aria-label="已登记 Skill">
              {state.records.map((r) => {
                const current = !showImport && r.skillId === selected;
                return (
                  <div key={r.skillId} role="listitem">
                    <button
                      type="button"
                      className={`${current ? 'selected' : ''} ${r.enabled ? '' : 'disabled-skill'}`}
                      aria-current={current ? 'true' : undefined}
                      onClick={() => void select(r.skillId)}
                    >
                      <span className="skill-list-icon">
                        <Layers aria-hidden="true" />
                      </span>
                      <span className="session-list-copy">
                        <strong>{r.displayName}</strong>
                        <small title={r.description}>{r.description}</small>
                        {/* 列表只标记例外：项目专属与已停用；全局为默认，不重复标注。 */}
                        {(r.projectId || !r.enabled) && (
                          <span className="skill-tags">
                            {r.projectId && <span className="skill-tag">项目专属</span>}
                            {!r.enabled && <span className="skill-tag muted">已停用</span>}
                          </span>
                        )}
                      </span>
                    </button>
                  </div>
                );
              })}
            </div>
          )}
          <p className="settings-list-hint">Skill 是可复用的方法。对话中输入 / 选择后，按需加载正文和资料。</p>
        </div>

        {showImport ? (
          <SkillImportPanel
            editing={editing}
            busy={busy}
            cancellable={!empty}
            source={source}
            upload={upload}
            displayName={displayName}
            projectId={projectId}
            projects={projectOptions}
            candidateSource={candidateSource}
            candidates={candidates}
            onSource={(value) => {
              setSource(value);
              if (value) setUpload(null);
            }}
            onPickDirectory={(files) => pickUpload(() => readSkillDirectoryPick(files))}
            onPickZip={(file) => pickUpload(() => readSkillZipPick(file))}
            onDropDirectory={(entry) => pickUpload(() => readSkillDroppedDirectory(entry))}
            onClearUpload={() => setUpload(null)}
            onDisplayName={setDisplayName}
            onProjectId={setProjectId}
            onCandidateSource={setCandidateSource}
            onListCandidates={() =>
              void run(async () => setCandidates(await skillApi('/candidates', { source: candidateSource })))
            }
            onPickCandidate={(candidate) => {
              setEditing(null);
              setUpload(null);
              setSource(candidate.source);
              setDisplayName('');
              requestAnimationFrame(() => document.getElementById('skill-source')?.focus());
            }}
            onPreview={() => void previewImport()}
            onCancel={cancelImport}
          />
        ) : !detail ? (
          <div className="management-page-state skills-detail-state" aria-live="polite">
            <LoaderCircle className="spin" aria-hidden="true" />
            <p role="status">正在读取详情…</p>
          </div>
        ) : (
          <SkillDetail
            key={detail.record.skillId}
            detail={detail}
            busy={busy}
            projects={visibilityProjects}
            visibility={visibility}
            dependencyDraft={dependencyDraft}
            onHidden={(projectId, value) => changeHidden(detail.record, projectId, value)}
            onDependencyDraft={setDependencyDraft}
            onSaveDependencies={() => saveDependencies(detail.record)}
            onUpdate={() => void startImport(detail.record)}
            onState={(action) => void changeState(detail.record, action)}
            {...(onOpenSession ? { onOpenSession } : {})}
          />
        )}
      </div>

      {preview && (
        <ConfirmCard
          title={editing ? '确认更新 Skill' : '确认导入 Skill'}
          description={`${preview.manifest.name} · ${preview.input.projectId ? '项目专属' : '全局可发现'}`}
          confirmLabel="确认登记"
          busy={busy}
          error={error}
          onCancel={() => setPreview(null)}
          onConfirm={() =>
            void run(async () => {
              const record = await skillApi<SkillRecord>('/confirm', {
                commandId,
                previewId: preview.previewId,
              });
              reset();
              setImporting(false);
              setSelected(record.skillId);
              await skillsStore.refresh();
            })
          }
        >
          <dl className="skills-preview-facts">
            <dt>来源</dt>
            <dd>{sourceLabel(preview.input.source)}</dd>
            <dt>描述</dt>
            <dd>{preview.manifest.description}</dd>
            <dt>变更文件</dt>
            <dd>{preview.changes.join('、') || '无内容变化'}</dd>
            <dt>工具依赖</dt>
            <dd>{declaredTools(preview.manifest)}；不授予工具权限。</dd>
          </dl>
          <details>
            <summary>检查正文与诊断</summary>
            <pre className="skills-preview">{preview.body}</pre>
            {preview.manifest.diagnostics.map((d) => (
              <p key={d} className="skills-diagnostic">
                {d}
              </p>
            ))}
          </details>
        </ConfirmCard>
      )}
    </section>
  );
}

/** 导入面板：优先从浏览器选择目录或 zip 包；也可填写服务端本机目录，或从 Claude Code / Codex 目录批量查找。 */
function SkillImportPanel(props: {
  editing: SkillRecord | null;
  busy: boolean;
  cancellable: boolean;
  source: string;
  upload: SkillUploadPick | null;
  displayName: string;
  projectId: string;
  projects: Workspace[];
  candidateSource: string;
  candidates: SkillCandidate[];
  onSource: (value: string) => void;
  onPickDirectory: (files: FileList) => void;
  onPickZip: (file: File) => void;
  onDropDirectory: (entry: FileSystemDirectoryEntry) => void;
  onClearUpload: () => void;
  onDisplayName: (value: string) => void;
  onProjectId: (value: string) => void;
  onCandidateSource: (value: string) => void;
  onListCandidates: () => void;
  onPickCandidate: (candidate: SkillCandidate) => void;
  onPreview: () => void;
  onCancel: () => void;
}) {
  const titleId = useId();
  const { editing, busy, upload } = props;
  const directoryInput = useRef<HTMLInputElement>(null),
    zipInput = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  /** 拖入文件夹或 zip 包；拖入文件夹不会触发浏览器自带的上传确认。 */
  function drop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    if (busy) return;
    const entry = event.dataTransfer.items[0]?.webkitGetAsEntry();
    if (entry?.isDirectory) props.onDropDirectory(entry as FileSystemDirectoryEntry);
    else if (event.dataTransfer.files[0]) props.onPickZip(event.dataTransfer.files[0]);
  }

  return (
    <section className="session-detail project-detail skills-detail-pane" aria-labelledby={titleId}>
      <div className="project-detail-head">
        <div className="project-title">
          <span className="skill-heading-icon">
            {editing ? <RefreshCw aria-hidden="true" /> : <Plus aria-hidden="true" />}
          </span>
          <h2 id={titleId}>{editing ? `更新「${editing.displayName}」` : '导入 Skill'}</h2>
        </div>
        <p className="project-title-note">
          选择包含 SKILL.md 的目录或 zip 包，预览正文与依赖后确认登记。登记不会授予任何工具权限。
        </p>
      </div>

      <form
        className="skills-card skills-import"
        onSubmit={(e) => {
          e.preventDefault();
          props.onPreview();
        }}
      >
        <div
          className={`skills-dropzone ${dragging ? 'dragging' : ''}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={drop}
        >
          {upload ? (
            <div className="skills-upload-chip">
              {upload.content.kind === 'zip' ? <FileArchive aria-hidden="true" /> : <FolderOpen aria-hidden="true" />}
              <span>
                <strong>{upload.label}</strong>
                <small>
                  {upload.content.kind === 'zip' ? 'zip 包' : `${upload.fileCount} 个文件`} · {formatBytes(upload.bytes)}
                  {upload.ignored > 0 && ` · 已忽略 ${upload.ignored} 项隐藏内容`}
                </small>
              </span>
              <button type="button" className="icon-button" aria-label="移除所选包" title="移除所选包" disabled={busy} onClick={props.onClearUpload}>
                <X aria-hidden="true" />
              </button>
            </div>
          ) : (
            <>
              <p>把 Skill 文件夹或 zip 包拖到这里</p>
              <small>也可以点击下方按钮选择；按钮选择文件夹时，浏览器会先询问是否上传</small>
            </>
          )}
          <div className="skills-pick-actions">
            <button type="button" className="secondary-button" disabled={busy} onClick={() => directoryInput.current?.click()}>
              <FolderOpen aria-hidden="true" />
              选择文件夹
            </button>
            <button type="button" className="secondary-button" disabled={busy} onClick={() => zipInput.current?.click()}>
              <FileArchive aria-hidden="true" />
              选择 zip 包
            </button>
          </div>
          {/* webkitdirectory 不在 React 的类型里，通过 ref 回调设置。 */}
          <input
            ref={(el) => {
              directoryInput.current = el;
              el?.setAttribute('webkitdirectory', '');
            }}
            type="file"
            hidden
            onChange={(e) => {
              if (e.target.files?.length) props.onPickDirectory(e.target.files);
              e.target.value = '';
            }}
          />
          <input
            ref={zipInput}
            type="file"
            accept=".zip,application/zip"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) props.onPickZip(file);
              e.target.value = '';
            }}
          />
        </div>
        <label className="skills-field">
          <span>或填写本地包目录</span>
          <input
            id="skill-source"
            aria-label="本地包目录"
            value={props.source}
            onChange={(e) => props.onSource(e.target.value)}
            placeholder="服务端本机的绝对目录路径，如 /Users/me/skills/review-notes"
            disabled={busy}
          />
        </label>
        <div className="skills-fields">
          <label className="skills-field">
            <span>显示名称（可选）</span>
            <input
              value={props.displayName}
              onChange={(e) => props.onDisplayName(e.target.value)}
              maxLength={128}
              placeholder="默认使用 SKILL.md 中的名称"
              disabled={busy}
            />
          </label>
          <label className="skills-field">
            <span>发现范围</span>
            <select value={props.projectId} disabled={busy || !!editing} onChange={(e) => props.onProjectId(e.target.value)}>
              <option value="">全局</option>
              {props.projects.map((w) => (
                <option key={w.workspaceId} value={w.project!.projectId}>
                  {w.project!.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="project-constraints-actions">
          {props.cancellable && (
            <button type="button" className="secondary-button" disabled={busy} onClick={props.onCancel}>
              取消
            </button>
          )}
          <button type="submit" className="primary-button" disabled={(!props.source.trim() && !upload) || busy}>
            预览{editing ? '更新' : '导入'}
          </button>
        </div>
      </form>

      {!editing && (
        <details className="skills-card skills-candidates">
          <summary>从 Claude Code / Codex 来源导入</summary>
          <p className="section-hint">
            输入明确选择的 skills 父目录。只检查直接子目录中的标准包；宿主扩展仅保留，不保证跨宿主执行语义。
          </p>
          <div className="skills-inline-field">
            <label className="skills-field">
              <span>来源目录</span>
              <input
                value={props.candidateSource}
                onChange={(e) => props.onCandidateSource(e.target.value)}
                placeholder="如 ~/.claude/skills"
              />
            </label>
            <button
              type="button"
              className="secondary-button"
              disabled={busy || !props.candidateSource.trim()}
              onClick={props.onListCandidates}
            >
              <FolderSearch aria-hidden="true" />
              列出候选
            </button>
          </div>
          {props.candidates.length > 0 && (
            <ul className="skills-candidate-list">
              {props.candidates.map((c) => (
                <li key={c.source} className={c.error ? 'invalid' : ''}>
                  <span>
                    <strong>{c.name}</strong>
                    <small>{c.error ?? c.description}</small>
                  </span>
                  <button
                    type="button"
                    className="secondary-button compact"
                    disabled={!!c.error || busy}
                    onClick={() => props.onPickCandidate(c)}
                  >
                    选择并预览
                  </button>
                </li>
              ))}
            </ul>
          )}
        </details>
      )}
    </section>
  );
}

/** 本机目录来源只显示目录名，完整路径放在提示中；上传与草案显示来历。 */
function shortSourceLabel(source: string): { text: string; title?: string } {
  if (isPackagedSkillSource(source)) return { text: sourceLabel(source) };
  return { text: `本机目录 · ${source.split('/').filter(Boolean).at(-1) ?? source}`, title: source };
}

/**
 * Skill 详情：标题区集中名称、来历、使用情况与常用操作；下方只保留设置（项目可见性、可用性）与内容。
 * 低频且有风险的停用、移除收进“更多”菜单。
 */
function SkillDetail(props: {
  detail: SkillDetailData;
  busy: boolean;
  projects: Workspace[];
  visibility: Record<string, ProjectVisibility>;
  dependencyDraft: string;
  onHidden: (projectId: string, hidden: boolean) => void;
  onDependencyDraft: (value: string) => void;
  onSaveDependencies: () => void;
  onUpdate: () => void;
  onState: (action: 'enable' | 'disable' | 'remove') => void;
  onOpenSession?: (sessionId: string) => void;
}) {
  const titleId = useId();
  const { detail, busy } = props;
  const { record, manifest } = detail;
  const uses = detail.uses ?? [];
  const [usesOpen, setUsesOpen] = useState(false);
  const [allUses, setAllUses] = useState(false);
  const shownUses = allUses ? uses : uses.slice(0, USES_PREVIEW);
  const [depsOpen, setDepsOpen] = useState(false);
  const source = shortSourceLabel(record.source);
  const dependencyUnknown = manifest.dependencies.source === 'unknown' && record.userTools === undefined;
  const dependencySummary = record.userTools !== undefined
    ? record.userTools.join('、') || '确认无依赖'
    : dependencyUnknown ? '未声明，书伴等无工具场景中不可用' : manifest.dependencies.tools.join('、') || '无依赖';

  return (
    <section className="session-detail project-detail skills-detail-pane skills-detail" aria-labelledby={titleId}>
      <div className="project-detail-head skills-head">
        <div className="project-title">
          <span className="skill-heading-icon">
            <Layers aria-hidden="true" />
          </span>
          <h2 id={titleId}>{record.displayName}</h2>
          {/* 只标记例外：项目专属与已停用；全局为默认。 */}
          {record.projectId && <span className="skill-tag">项目专属</span>}
          {!record.enabled && <span className="skill-tag muted">已停用</span>}
          <div className="skills-head-actions">
            {!isDraft(record) && (
              <button type="button" className="secondary-button compact" disabled={busy} onClick={props.onUpdate}>
                <RefreshCw aria-hidden="true" />
                预览新版本
              </button>
            )}
            <a
              className="secondary-button compact"
              href={`/api/skills/${encodeURIComponent(record.skillId)}/export?version=${record.version}`}
              download
            >
              <Download aria-hidden="true" />
              导出标准包
            </a>
            <SkillMoreMenu enabled={record.enabled} busy={busy} onState={props.onState} />
          </div>
        </div>
        {record.description && <p className="project-title-note">{record.description}</p>}
        <p className="skills-meta">
          {record.name !== record.displayName && <code title="SKILL.md 中的规范名称">{record.name}</code>}
          <span {...(source.title ? { title: source.title } : {})}>{source.text}</span>
          <span title={`版本 ${record.version.slice(0, 12)} · ${formatTime(record.updatedAt)}`}>
            更新于 {formatUseTime(record.updatedAt)}
          </span>
          {/* 链接外包一层，分隔点落在链接之外，不带下划线。 */}
          {uses.length ? (
            <span>
              <button type="button" className="inline-link skills-uses-link" aria-expanded={usesOpen} onClick={() => setUsesOpen((open) => !open)}>
                使用 {uses.length} 次
                {usesOpen ? <ChevronUp aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}
              </button>
            </span>
          ) : (
            <span>暂未使用</span>
          )}
        </p>
        {/* 使用记录是标题区元信息的展开细节，不单独成节。 */}
        {usesOpen && uses.length > 0 && (
          <div className="skills-uses-panel">
            <ul className="skills-uses">
              {shownUses.map((use) => {
                const action = useAction(use);
                const Icon = action.icon;
                return (
                  <li key={use.useId}>
                    <span className="skill-use-icon">
                      <Icon aria-hidden="true" />
                    </span>
                    <span className="skill-use-copy">
                      <strong>
                        {action.label}
                        {use.kind === 'resource' && <code>{use.path}</code>}
                        {use.version !== record.version && <em title={`版本 ${use.version.slice(0, 12)}`}>旧版本</em>}
                      </strong>
                      <small>
                        {use.sessionAvailable && props.onOpenSession ? (
                          <span>
                            <button type="button" className="inline-link" onClick={() => props.onOpenSession!(use.sessionId)}>
                              {use.sessionTitle ?? '工作会话'}
                            </button>
                          </span>
                        ) : (
                          <span>{use.sessionTitle ?? '会话已不可用'}</span>
                        )}
                        <time dateTime={use.createdAt} title={formatTime(use.createdAt)}>
                          {formatUseTime(use.createdAt)}
                        </time>
                      </small>
                    </span>
                  </li>
                );
              })}
            </ul>
            {uses.length > USES_PREVIEW && (
              <button type="button" className="inline-link skills-uses-more" onClick={() => setAllUses((all) => !all)}>
                {allUses ? '只看最近 5 次' : `查看全部 ${uses.length} 次`}
              </button>
            )}
            <p>只记录正文与资源被读取，不代表脚本执行成功；工具结果请在对应会话中查看。</p>
          </div>
        )}
      </div>

      <SkillSection title="项目可见性" hint="关闭后，该项目中的会话不再发现此 Skill；不改变工具权限。">
        {props.projects.length ? (
          <ul className="skills-rows">
            {props.projects.map((w) => {
              const projectId = w.project!.projectId;
              const value = props.visibility[projectId];
              const labelId = `${titleId}-project-${projectId}`;
              return (
                <li key={w.workspaceId} className="skills-row">
                  <Folder aria-hidden="true" />
                  <span id={labelId}>{w.project!.name}</span>
                  {/* 开关已表达可发现，只在读取中或已隐藏时补充文字。 */}
                  {(!value || value.hidden) && <small>{value ? '已隐藏' : '读取中…'}</small>}
                  <button
                    type="button"
                    role="switch"
                    className="preference-switch"
                    aria-labelledby={labelId}
                    aria-checked={value ? !value.hidden : false}
                    disabled={busy || !value}
                    onClick={() => value && props.onHidden(projectId, !value.hidden)}
                  >
                    <span aria-hidden="true" />
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="section-hint">还没有项目。</p>
        )}
      </SkillSection>

      {/* 工具依赖只决定候选是否可用（如书伴无工具），用设置行展示，按需展开调整。 */}
      <SkillSection title="可用性" hint="会话缺少所需工具时，此 Skill 在候选中显示为不可用。依赖声明不授予任何工具权限。">
        <div className="skills-rows">
          <div className="skills-row">
            <Wrench aria-hidden="true" />
            <span>工具依赖</span>
            <small className={dependencyUnknown ? 'warn' : undefined}>{dependencySummary}</small>
            <button
              type="button"
              className="secondary-button compact"
              aria-expanded={depsOpen}
              onClick={() => setDepsOpen((open) => !open)}
            >
              {depsOpen ? '收起' : dependencyUnknown ? '确认' : '调整'}
            </button>
          </div>
          {depsOpen && (
            <div className="skills-row-panel">
              <dl className="skills-facts">
                <div>
                  <dt>包内声明</dt>
                  <dd>{declaredTools(manifest)}</dd>
                </div>
                <div>
                  <dt>用户补充</dt>
                  <dd>
                    {record.userTools === undefined ? '未补充' : record.userTools.join('、') || '用户确认无工具依赖'}
                  </dd>
                </div>
              </dl>
              <form
                className="skills-inline-field"
                onSubmit={(e) => {
                  e.preventDefault();
                  props.onSaveDependencies();
                }}
              >
                <input
                  aria-label="补充工具依赖"
                  value={props.dependencyDraft}
                  onChange={(e) => props.onDependencyDraft(e.target.value)}
                  placeholder="填写实际需要的工具名，以空格分隔；留空表示确认无工具依赖"
                />
                <button type="submit" className="secondary-button" disabled={busy}>
                  确认补充
                </button>
              </form>
            </div>
          )}
        </div>
      </SkillSection>

      <SkillSection title="内容">
        <details className="skills-fold">
          <summary>
            <FileText aria-hidden="true" />
            正文预览 · SKILL.md
          </summary>
          <pre>{detail.body}</pre>
        </details>
        <details className="skills-fold">
          <summary>
            <Layers aria-hidden="true" />
            包文件 · {manifest.files.length}
          </summary>
          <ul className="skills-files">
            {manifest.files.map((f) => (
              <li key={f.path}>
                <code>{f.path}</code>
                <small>{formatBytes(f.bytes)}</small>
              </li>
            ))}
          </ul>
        </details>
        {/* 包说明是登记时的中性提示（如宿主扩展仅保留），不是错误。 */}
        {manifest.diagnostics.length > 0 && (
          <ul className="skills-package-notes" aria-label="包说明">
            {manifest.diagnostics.map((d) => (
              <li key={d}>
                <Info aria-hidden="true" />
                {d}
              </li>
            ))}
          </ul>
        )}
      </SkillSection>
    </section>
  );
}

/** 停用、启用与移除：低频且有确认步骤，收在“更多”菜单中。 */
function SkillMoreMenu({ enabled, busy, onState }: {
  enabled: boolean;
  busy: boolean;
  onState: (action: 'enable' | 'disable' | 'remove') => void;
}) {
  const [open, setOpen] = useState(false);
  const menu = useRef<HTMLDivElement>(null),
    trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    const close = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [open]);
  const choose = (action: 'enable' | 'disable' | 'remove') => {
    setOpen(false);
    trigger.current?.focus();
    onState(action);
  };

  return (
    <div className="skills-more">
      <button
        ref={trigger}
        type="button"
        className="secondary-button compact skills-more-trigger"
        aria-label="更多 Skill 操作"
        title="更多操作"
        aria-expanded={open}
        disabled={busy}
        onClick={() => setOpen((value) => !value)}
      >
        <MoreHorizontal aria-hidden="true" />
      </button>
      {open && (
        <div
          ref={menu}
          className="skills-more-menu"
          role="group"
          aria-label="更多 Skill 操作"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              setOpen(false);
              trigger.current?.focus();
            }
          }}
        >
          <button type="button" onClick={() => choose(enabled ? 'disable' : 'enable')}>
            <Power aria-hidden="true" />
            {enabled ? '停用' : '启用'}
          </button>
          <button type="button" className="danger" onClick={() => choose('remove')}>
            <Trash2 aria-hidden="true" />
            移除
          </button>
        </div>
      )}
    </div>
  );
}

function SkillSection({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  const id = useId();
  return (
    <section className="detail-section skills-section" aria-labelledby={id}>
      <div className="section-title">
        <h3 id={id}>{title}</h3>
      </div>
      {hint && <p className="section-hint">{hint}</p>}
      {children}
    </section>
  );
}
