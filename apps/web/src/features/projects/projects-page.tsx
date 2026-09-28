import {
  AlertCircle,
  Check,
  Folder,
  FolderMinus,
  FolderPlus,
  LoaderCircle,
  Pencil,
  Plus,
  RefreshCw,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import {
  normalizeProjectName,
  PROJECT_DEFAULT_CONSTRAINTS_MAX_LENGTH,
  PROJECT_NAME_MAX_LENGTH,
  type Project,
  type UpdateProject,
} from '@multivac/contracts';
import { useConfirm } from '../../components/confirm-card.js';
import { updateProject } from '../../data/workspace-api.js';
import { useWorkspaces, useWorkspaceSessions } from '../workspace/workspace-sessions-provider.js';
import { workspaceSummary } from '../workspace/workspaces.js';
import { NewProjectCard } from './new-project-card.js';
import {
  DIRECTORY_CHANGE_NOTE,
  directoryPaths,
  PROJECT_DIRECTORY_KINDS,
  projectsOf,
} from './project-directories.js';

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/** 从别处（工作区切换菜单的“项目设置”）打开本页：projectId 为要选中的项目；id 递增表示一次新的打开。 */
export interface ProjectSettingsRequest {
  id: number;
  projectId: string | null;
}

interface ProjectsPageProps {
  request?: ProjectSettingsRequest | null;
}

/**
 * 管理 · 设置 · 项目：项目列表 + 详情（名称、目录、默认约束），以及“新建项目…”。
 *
 * 项目来自应用内共享的工作区列表（项目工作区带着项目），修改后以接口返回的工作区写回，
 * 工作区切换菜单、新建会话对话框与会话页随即看到新的名称与目录。
 * 修改目录只影响之后新建的会话，已有会话的工作目录以会话记录为准。
 */
export function ProjectsPage({ request = null }: ProjectsPageProps) {
  const { workspaces, ensureLoaded } = useWorkspaces();
  const { sessions, ensureLoaded: ensureSessionsLoaded } = useWorkspaceSessions();
  const [loadError, setLoadError] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const newButtonRef = useRef<HTMLButtonElement>(null);

  const load = useCallback(async () => {
    setLoadError('');
    try {
      await Promise.all([ensureLoaded(), ensureSessionsLoaded()]);
    } catch (error) {
      setLoadError(errorText(error, '项目读取失败。'));
    }
  }, [ensureLoaded, ensureSessionsLoaded]);

  useEffect(() => {
    void load();
  }, [load]);

  // “项目设置”直达当前项目；从默认工作区进入时不指定项目，保留当前选择。
  useEffect(() => {
    if (request?.projectId) setSelectedId(request.projectId);
  }, [request?.id]);

  const projects = projectsOf(workspaces);
  const selected = projects.find((project) => project.projectId === selectedId) ?? projects[0] ?? null;
  const sessionCount = (projectId: string) =>
    sessions?.filter((session) => session.workspaceId === projectId && session.archivedAt === null).length ?? 0;

  const newProject = creating && (
    <NewProjectCard
      onCreated={(created) => {
        setCreating(false);
        setSelectedId(created.project.projectId);
      }}
      onCancel={() => setCreating(false)}
      fallbackFocus={() => newButtonRef.current}
    />
  );
  const newProjectButton = (
    <button type="button" ref={newButtonRef} className="secondary-button" onClick={() => setCreating(true)}>
      <Plus aria-hidden="true" />
      新建项目…
    </button>
  );

  if (workspaces === null) {
    return (
      <div className="sessions-page-state" data-management-page="projects" aria-live="polite">
        {loadError ? (
          <>
            <AlertCircle aria-hidden="true" />
            <h2>项目读取失败</h2>
            <p>{loadError}</p>
            <button type="button" className="secondary-button" onClick={() => void load()}>
              <RefreshCw aria-hidden="true" />
              重试
            </button>
          </>
        ) : (
          <>
            <LoaderCircle className="spin" aria-hidden="true" />
            <p>正在读取项目</p>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="projects-page" data-management-page="projects">
      {!selected ? (
        <div className="empty-state sessions-empty">
          <Folder aria-hidden="true" />
          <h2>还没有项目</h2>
          <p>项目给会话一个固定的目录，自动带一个同名工作区；不填目录时由 Multivac 托管。</p>
          {newProjectButton}
        </div>
      ) : (
        <div className="sessions-layout projects-layout">
          <div className="project-list-pane">
            <div className="session-list project-list" role="list" aria-label="项目列表">
              {projects.map((project) => {
                const current = project.projectId === selected.projectId;
                return (
                  <div key={project.projectId} role="listitem">
                    <button
                      type="button"
                      className={current ? 'selected' : ''}
                      aria-current={current ? 'true' : undefined}
                      data-project-id={project.projectId}
                      onClick={() => setSelectedId(project.projectId)}
                    >
                      <Folder aria-hidden="true" />
                      <span className="session-list-copy">
                        <strong>{project.name}</strong>
                        <small title={projectSummary(project)}>{projectSummary(project)}</small>
                        <small className="session-list-level">{sessionCount(project.projectId)} 个会话</small>
                      </span>
                    </button>
                  </div>
                );
              })}
            </div>
            <div className="project-list-footer">
              {newProjectButton}
              <p>每个项目自动带一个同名工作区。</p>
            </div>
          </div>

          {/* 按项目挂载详情：切换项目时改名、输入、忙碌与错误状态随之重置。 */}
          <ProjectDetail key={selected.projectId} project={selected} />
        </div>
      )}
      {newProject}
    </div>
  );
}

/** 列表行的目录摘要：主目录的类型与路径，多个目录时注明数量（与工作区切换菜单一致）。 */
function projectSummary(project: Project): string {
  return workspaceSummary({ workspaceId: project.projectId, name: project.name, project });
}

/** 选中项目的详情：名称、目录（挂载、卸载、主目录）与默认约束。 */
function ProjectDetail({ project }: { project: Project }) {
  const confirm = useConfirm();
  const { upsert } = useWorkspaces();
  const titleId = useId();
  const constraintsId = useId();
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const [mountPath, setMountPath] = useState('');
  const [constraints, setConstraints] = useState(project.defaultConstraints);
  const [constraintsSaved, setConstraintsSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const renameButtonRef = useRef<HTMLButtonElement>(null);
  const mountInputRef = useRef<HTMLInputElement>(null);
  const directoriesRef = useRef<HTMLUListElement>(null);
  const onlyOne = project.directories.length === 1;

  /** 提交一次更新并写回共享的工作区列表；抛出的错误由调用方决定显示在哪里。 */
  async function save(input: UpdateProject): Promise<void> {
    const updated = await updateProject(project.projectId, input);
    upsert(updated.workspace);
  }

  /** 在详情里执行一次更新：进行中禁用操作，失败时把原因留在详情里。 */
  async function run(input: UpdateProject, fallback: string): Promise<boolean> {
    setError('');
    setBusy(true);
    try {
      await save(input);
      return true;
    } catch (cause) {
      setError(errorText(cause, fallback));
      return false;
    } finally {
      setBusy(false);
    }
  }

  function startRename(): void {
    setError('');
    setRenameValue(project.name);
    setRenaming(true);
  }

  function cancelRename(): void {
    setRenaming(false);
    requestAnimationFrame(() => renameButtonRef.current?.focus({ preventScroll: true }));
  }

  async function submitRename(event: FormEvent): Promise<void> {
    event.preventDefault();
    const name = normalizeProjectName(renameValue);
    if (!name || busy) return;
    if (name === project.name) {
      cancelRename();
      return;
    }
    if (await run({ name }, '改名失败，请重试。')) cancelRename();
  }

  /** 挂载扩大了自动执行的范围：经确认卡确认，服务端校验不通过时原因留在卡上。 */
  async function mount(event: FormEvent): Promise<void> {
    event.preventDefault();
    const path = mountPath.trim();
    if (!path || busy) return;
    setError('');
    const mounted = await confirm({
      title: '挂载目录',
      description: `挂载到项目「${project.name}」，这个目录内的修改将自动执行。`,
      details: [
        <>{PROJECT_DIRECTORY_KINDS.mounted.label} <code>{path}</code></>,
        '挂载后排在已有目录之后，可以设为主目录；项目中新建的会话在主目录中工作。',
        DIRECTORY_CHANGE_NOTE,
      ],
      icon: FolderPlus,
      confirmLabel: '挂载',
      action: () => save({ directories: directoryPaths(project, { mount: path }) }),
    });
    if (mounted) setMountPath('');
  }

  /** 卸载只解除项目与目录的关系，目录本身不删除；至少保留一个目录。 */
  async function unmount(path: string, primary: boolean): Promise<void> {
    setError('');
    await confirm({
      title: '卸载目录',
      description: `从项目「${project.name}」中卸载，之后新建的会话不再使用这个目录。`,
      details: [
        <code key="path">{path}</code>,
        ...(primary ? ['它是主目录，卸载后由下一个目录成为主目录。'] : []),
        '目录本身和其中的文件不会被删除，之后可以重新挂载。',
        '已有会话继续使用创建时的工作目录。',
      ],
      icon: FolderMinus,
      confirmLabel: '卸载',
      action: () => save({ directories: directoryPaths(project, { unmount: path }) }),
      fallbackFocus: () => mountInputRef.current,
    });
  }

  async function makePrimary(path: string): Promise<void> {
    if (await run({ directories: directoryPaths(project, { primary: path }) }, '设为主目录失败，请重试。')) {
      // “设为主目录”随之消失，焦点交给这一行的卸载按钮。
      requestAnimationFrame(() => directoriesRef.current
        ?.querySelector<HTMLElement>(`[data-directory-path="${CSS.escape(path)}"] .icon-button`)
        ?.focus({ preventScroll: true }));
    }
  }

  async function saveConstraints(event: FormEvent): Promise<void> {
    event.preventDefault();
    setConstraintsSaved(false);
    if (await run({ defaultConstraints: constraints }, '默认约束保存失败，请重试。')) {
      setConstraints(constraints.trim());
      setConstraintsSaved(true);
    }
  }

  const constraintsChanged = constraints.trim() !== project.defaultConstraints;

  return (
    <section className="session-detail project-detail" aria-labelledby={titleId}>
      {renaming ? (
        <form className="session-rename" onSubmit={(event) => void submitRename(event)}>
          <input
            id={titleId}
            aria-label="项目名称"
            value={renameValue}
            maxLength={PROJECT_NAME_MAX_LENGTH}
            autoFocus
            onFocus={(event) => event.currentTarget.select()}
            onChange={(event) => setRenameValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Escape') return;
              event.stopPropagation();
              cancelRename();
            }}
          />
          <button
            type="submit"
            className="icon-button"
            aria-label="保存名称"
            title="保存名称"
            disabled={busy || !normalizeProjectName(renameValue)}
          >
            <Check aria-hidden="true" />
          </button>
          <button type="button" className="icon-button" aria-label="取消改名" title="取消改名" onClick={cancelRename}>
            <X aria-hidden="true" />
          </button>
        </form>
      ) : (
        <div className="project-detail-heading">
          <h2 id={titleId}>{project.name}</h2>
          <button
            type="button"
            ref={renameButtonRef}
            className="secondary-button"
            disabled={busy}
            onClick={startRename}
          >
            <Pencil aria-hidden="true" />
            改名
          </button>
        </div>
      )}
      <p className="project-detail-note">同名工作区随项目改名。</p>

      {error && <p className="session-detail-error" role="alert">{error}</p>}

      <section className="project-section" aria-labelledby={`${titleId}-directories`}>
        <h3 id={`${titleId}-directories`}>目录</h3>
        <p className="project-section-note">第一个是主目录，项目中新建的会话在主目录中工作。{DIRECTORY_CHANGE_NOTE}</p>
        <ul ref={directoriesRef} className="project-directories" aria-label="项目目录">
          {project.directories.map((directory, index) => {
            const kind = PROJECT_DIRECTORY_KINDS[directory.kind];
            const primary = index === 0;
            return (
              <li key={directory.path} data-directory-path={directory.path}>
                <Folder aria-hidden="true" />
                <span className="directory-rule">
                  <span>
                    <strong>{kind.label}</strong>
                    {primary && <em className="project-directory-primary">主目录</em>}
                  </span>
                  <code>{directory.path}</code>
                  <small>{kind.rule}</small>
                </span>
                <span className="project-directory-actions">
                  {!primary && (
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={busy}
                      onClick={() => void makePrimary(directory.path)}
                    >
                      设为主目录
                    </button>
                  )}
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`卸载 ${directory.path}`}
                    title={onlyOne ? '项目至少保留一个目录' : `卸载 ${directory.path}`}
                    disabled={busy || onlyOne}
                    onClick={() => void unmount(directory.path, primary)}
                  >
                    <X aria-hidden="true" />
                  </button>
                </span>
              </li>
            );
          })}
        </ul>
        {onlyOne && <p className="project-section-note">项目至少保留一个目录；要换目录，先挂载新目录再卸载这个。</p>}
        <form className="mount-directory-form" onSubmit={(event) => void mount(event)}>
          <input
            ref={mountInputRef}
            aria-label="要挂载的目录"
            value={mountPath}
            placeholder="输入已有目录的绝对路径，如 ~/code/docs"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            onChange={(event) => setMountPath(event.target.value)}
          />
          <button type="submit" className="secondary-button" disabled={busy || !mountPath.trim()}>
            <Plus aria-hidden="true" />
            挂载
          </button>
        </form>
      </section>

      <section className="project-section" aria-labelledby={`${titleId}-constraints`}>
        <h3 id={`${titleId}-constraints`}>默认约束</h3>
        <p className="project-section-note" id={constraintsId}>
          项目内会话长期遵守的约定。目前只保存在项目中，还不会自动带入会话。
        </p>
        <form className="project-constraints-form" onSubmit={(event) => void saveConstraints(event)}>
          <textarea
            aria-label="默认约束"
            aria-describedby={constraintsId}
            value={constraints}
            maxLength={PROJECT_DEFAULT_CONSTRAINTS_MAX_LENGTH}
            rows={4}
            placeholder="例如：只修改 docs/ 下的文件；提交前先运行测试。"
            onChange={(event) => {
              setConstraints(event.target.value);
              setConstraintsSaved(false);
            }}
          />
          <div className="project-constraints-actions">
            <span aria-live="polite">{constraintsSaved && !constraintsChanged ? '已保存' : ''}</span>
            <button type="submit" className="secondary-button" disabled={busy || !constraintsChanged}>
              保存默认约束
            </button>
          </div>
        </form>
      </section>
    </section>
  );
}
