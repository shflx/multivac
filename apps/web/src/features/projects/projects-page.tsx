import {
  AlertCircle,
  ChevronRight,
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
import { ManagementPageActions } from '../../app/management-layout.js';
import { useConfirm } from '../../components/confirm-card.js';
import { SavedMark, useSavedFlash } from '../../components/saved-mark.js';
import { updateProject } from '../../data/workspace-api.js';
import { GrantList } from '../authorizations/grant-list.js';
import { useWorkspaces, useWorkspaceSessions } from '../workspace/workspace-sessions-provider.js';
import { workspaceSummary } from '../workspace/workspaces.js';
import { NewProjectCard } from './new-project-card.js';
import {
  DIRECTORY_CHANGE_NOTE,
  directoryPaths,
  mountPathError,
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
  /** 页面是否正在显示；变为可见时重新读取记住的授权。 */
  active: boolean;
  request?: ProjectSettingsRequest | null;
  /** 选中的项目变化时报告给外壳：管理中的 Multivac 侧栏把它作为“正在看”的对象。 */
  onSelectionChange?: (project: Project | null) => void;
}

/**
 * 管理 · 设置 · 项目：项目列表 + 详情（名称、目录、默认约束），“新建项目…”在页头的主要操作位。
 *
 * 项目来自应用内共享的工作区列表（项目工作区带着项目），修改后以接口返回的工作区写回，
 * 工作区切换菜单、新建会话对话框与会话页随即看到新的名称与目录。
 * 修改目录只影响之后新建的会话，已有会话的工作目录以会话记录为准。
 */
export function ProjectsPage({ active, request = null, onSelectionChange }: ProjectsPageProps) {
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
  // 列表未读完时没有选中；改名后以最新的项目报告（提示随之更新）。
  useEffect(() => {
    onSelectionChange?.(selected);
  }, [selected, onSelectionChange]);

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
      {/* 列表读完后才放“新建项目…”：新建成功要写回共享的工作区列表并选中新项目。 */}
      <ManagementPageActions>
        <button type="button" ref={newButtonRef} className="secondary-button" onClick={() => setCreating(true)}>
          <Plus aria-hidden="true" />
          新建项目…
        </button>
      </ManagementPageActions>

      {!selected ? (
        <div className="empty-state sessions-empty">
          <Folder aria-hidden="true" />
          <h2>还没有项目</h2>
          <p>项目给会话一个固定的目录，自动带一个同名工作区；不填目录时由 Multivac 托管。</p>
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
                        <small>{sessionCount(project.projectId)} 个会话</small>
                      </span>
                      <ChevronRight aria-hidden="true" />
                    </button>
                  </div>
                );
              })}
            </div>
            {/* 原型这里提示“也可以对 Multivac 说……”；对话创建项目尚未实现，只写已有的规则。 */}
            <p className="settings-list-hint">每个项目自动带一个同名工作区。</p>
          </div>

          {/* 按项目挂载详情：切换项目时改名、输入、忙碌、错误与“已保存”状态随之重置。 */}
          <ProjectDetail key={selected.projectId} project={selected} active={active} />
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

/** 详情中修改成功后显示“已保存”的几处：名称（标题旁）、目录（小节标题旁）、默认约束（保存按钮旁）。 */
type SavedPart = 'name' | 'directories' | 'constraints';

/**
 * 选中项目的详情：标题（原地改名）与工作目录，目录（挂载、卸载、主目录）与默认约束。
 * 各处的错误显示在出错的输入框或小节里，修改成功后在对应位置短暂显示“已保存”。
 */
function ProjectDetail({ project, active }: { project: Project; active: boolean }) {
  const confirm = useConfirm();
  const { upsert } = useWorkspaces();
  const titleId = useId();
  const renameErrorId = useId();
  const directoryErrorId = useId();
  const constraintsNoteId = useId();
  const saved = useSavedFlash<SavedPart>();
  // 改名在标题处原地编辑：null 表示没在改名，否则是输入框里的草稿。
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameError, setRenameError] = useState('');
  const [mountPath, setMountPath] = useState('');
  const [directoryError, setDirectoryError] = useState('');
  const [constraints, setConstraints] = useState(project.defaultConstraints);
  const [constraintsError, setConstraintsError] = useState('');
  const [busy, setBusy] = useState(false);
  const renameButtonRef = useRef<HTMLButtonElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const mountInputRef = useRef<HTMLInputElement>(null);
  const directoriesRef = useRef<HTMLUListElement>(null);
  const constraintsRef = useRef<HTMLTextAreaElement>(null);
  const permissionsRef = useRef<HTMLElement>(null);
  const onlyOne = project.directories.length === 1;
  // 项目至少有一个目录，第一个是主目录：新建的会话在这里工作。
  const primaryDirectory = project.directories[0]!;

  /** 提交一次更新并写回共享的工作区列表；抛出的错误由调用方决定显示在哪里。 */
  async function save(input: UpdateProject): Promise<void> {
    const updated = await updateProject(project.projectId, input);
    upsert(updated.workspace);
  }

  /** 在详情里执行一次更新：进行中禁用操作，失败时把原因交给出错的那一处显示。 */
  async function run(input: UpdateProject, fallback: string, showError: (message: string) => void): Promise<boolean> {
    showError('');
    setBusy(true);
    try {
      await save(input);
      return true;
    } catch (cause) {
      showError(errorText(cause, fallback));
      return false;
    } finally {
      setBusy(false);
    }
  }

  function startRename(): void {
    setRenameError('');
    setRenaming(project.name);
  }

  /** 结束改名（保存或取消），焦点回到“改名”。 */
  function closeRename(): void {
    setRenaming(null);
    setRenameError('');
    requestAnimationFrame(() => renameButtonRef.current?.focus({ preventScroll: true }));
  }

  /** 改名只动项目名，同名工作区跟着改；重名等原因写在输入框下方，输入保留以便修改。 */
  async function submitRename(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (renaming === null || busy) return;
    const name = normalizeProjectName(renaming);
    if (!name) {
      setRenameError('项目名称不能为空。');
      renameInputRef.current?.focus();
      return;
    }
    if (name === project.name) {
      closeRename();
      return;
    }
    if (await run({ name }, '改名失败，请重试。', setRenameError)) {
      closeRename();
      saved.flash('name');
    } else {
      renameInputRef.current?.focus();
    }
  }

  /**
   * 挂载扩大了自动执行的范围：空路径与已在项目中的目录在输入框下直接说明，
   * 其余经确认卡确认，服务端校验不通过时原因留在卡上。
   */
  async function mount(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (busy) return;
    const problem = mountPathError(project, mountPath);
    if (problem) {
      setDirectoryError(problem);
      mountInputRef.current?.focus();
      return;
    }
    setDirectoryError('');
    const path = mountPath.trim();
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
      fallbackFocus: () => mountInputRef.current,
    });
    if (mounted) {
      setMountPath('');
      saved.flash('directories');
    }
  }

  /** 卸载只解除项目与目录的关系，目录本身不删除；至少保留一个目录。 */
  async function unmount(path: string, primary: boolean): Promise<void> {
    setDirectoryError('');
    const unmounted = await confirm({
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
    if (unmounted) saved.flash('directories');
  }

  async function makePrimary(path: string): Promise<void> {
    if (await run({ directories: directoryPaths(project, { primary: path }) }, '设为主目录失败，请重试。', setDirectoryError)) {
      saved.flash('directories');
      // “设为主目录”随之消失，焦点交给这一行的卸载按钮。
      requestAnimationFrame(() => directoriesRef.current
        ?.querySelector<HTMLElement>(`[data-directory-path="${CSS.escape(path)}"] .icon-button`)
        ?.focus({ preventScroll: true }));
    }
  }

  // 与上次保存的值（去掉首尾空白后）不同才算改动；“还原”与“保存”只在有改动时可用。
  const constraintsChanged = constraints.trim() !== project.defaultConstraints;
  // 默认约束被别处（其他窗口、Multivac）改动时：输入框没有改过就跟着更新，正在编辑的内容原样保留。
  const syncedConstraintsRef = useRef(project.defaultConstraints);
  useEffect(() => {
    const previous = syncedConstraintsRef.current;
    syncedConstraintsRef.current = project.defaultConstraints;
    setConstraints((current) => current.trim() === previous ? project.defaultConstraints : current);
  }, [project.defaultConstraints]);

  async function saveConstraints(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!constraintsChanged || busy) return;
    if (await run({ defaultConstraints: constraints }, '默认约束保存失败，请重试。', setConstraintsError)) {
      setConstraints(constraints.trim());
      saved.flash('constraints');
    }
  }

  /** 还原到上次保存的值；按钮随之不可用，焦点回到输入框。 */
  function revertConstraints(): void {
    setConstraints(project.defaultConstraints);
    setConstraintsError('');
    constraintsRef.current?.focus();
  }

  return (
    <section className="session-detail project-detail" aria-labelledby={titleId}>
      <div className="project-detail-head">
        {renaming === null ? (
          <div className="project-title">
            <h2 id={titleId}>{project.name}</h2>
            <button type="button" ref={renameButtonRef} className="inline-link" disabled={busy} onClick={startRename}>
              <Pencil aria-hidden="true" />
              改名
            </button>
            <SavedMark saved={saved} target="name" />
          </div>
        ) : (
          <form className="project-rename" onSubmit={(event) => void submitRename(event)}>
            <input
              ref={renameInputRef}
              id={titleId}
              aria-label="项目名称"
              aria-invalid={renameError ? true : undefined}
              aria-describedby={renameError ? renameErrorId : undefined}
              value={renaming}
              maxLength={PROJECT_NAME_MAX_LENGTH}
              autoFocus
              onFocus={(event) => event.currentTarget.select()}
              onChange={(event) => {
                setRenaming(event.target.value);
                setRenameError('');
              }}
              onKeyDown={(event) => {
                if (event.key !== 'Escape') return;
                event.preventDefault();
                event.stopPropagation();
                closeRename();
              }}
            />
            <button type="submit" className="primary-button compact" disabled={busy}>保存</button>
            <button type="button" className="secondary-button compact" onClick={closeRename}>取消</button>
          </form>
        )}
        {renameError && <p id={renameErrorId} className="form-error" role="alert">{renameError}</p>}
        {/* 原页头说明中“项目中的会话在项目目录里工作”放在这里，与工作目录一起交代。 */}
        <p className="project-title-note">同名工作区随项目改名，项目中的会话在项目目录里工作。</p>
        <p className="project-working-directory">
          工作目录：{PROJECT_DIRECTORY_KINDS[primaryDirectory.kind].label} <code>{primaryDirectory.path}</code>
        </p>
      </div>

      <section className="detail-section" aria-labelledby={`${titleId}-directories`}>
        <div className="section-title">
          <h3 id={`${titleId}-directories`}>目录</h3>
          <SavedMark saved={saved} target="directories" />
        </div>
        <p className="section-hint">第一个是主目录，项目中新建的会话在主目录中工作。{DIRECTORY_CHANGE_NOTE}</p>
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
                      className="secondary-button compact"
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
        {onlyOne && <p className="section-hint">项目至少保留一个目录；要换目录，先挂载新目录再卸载这个。</p>}
        <form className="mount-directory-form" onSubmit={(event) => void mount(event)}>
          <input
            ref={mountInputRef}
            aria-label="要挂载的目录"
            aria-invalid={directoryError ? true : undefined}
            aria-describedby={directoryError ? directoryErrorId : undefined}
            value={mountPath}
            placeholder="输入已有目录的路径，如 ~/code/docs"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            onChange={(event) => {
              setMountPath(event.target.value);
              setDirectoryError('');
            }}
          />
          {/* 空路径时也可以点：原因写在输入框下方，而不是只把按钮置灰。 */}
          <button type="submit" className="secondary-button" disabled={busy}>
            <Plus aria-hidden="true" />
            挂载
          </button>
        </form>
        {directoryError && <p id={directoryErrorId} className="form-error" role="alert">{directoryError}</p>}
      </section>

      <section className="detail-section" aria-labelledby={`${titleId}-constraints`}>
        <div className="section-title">
          <h3 id={`${titleId}-constraints`}>默认约束</h3>
        </div>
        <form className="project-constraints-form" onSubmit={(event) => void saveConstraints(event)}>
          <div className="project-constraints-field">
            <textarea
              ref={constraintsRef}
              aria-label="默认约束"
              aria-describedby={constraintsNoteId}
              value={constraints}
              maxLength={PROJECT_DEFAULT_CONSTRAINTS_MAX_LENGTH}
              rows={2}
              placeholder="例如：只修改 docs/ 下的文件；提交前先运行测试。"
              onChange={(event) => {
                setConstraints(event.target.value);
                setConstraintsError('');
              }}
            />
            {/* 如实说明：默认约束目前只保存，还不会自动带入会话（原型写的是“确认卡上会带上”）。 */}
            <small id={constraintsNoteId}>项目内会话长期遵守的约定。目前只保存在项目中，还不会自动带入会话。</small>
            {constraintsError && <p className="form-error" role="alert">{constraintsError}</p>}
          </div>
          <div className="project-constraints-actions">
            <SavedMark saved={saved} target="constraints" />
            <button type="button" className="secondary-button" disabled={busy || !constraintsChanged} onClick={revertConstraints}>
              还原
            </button>
            <button type="submit" className="primary-button" disabled={busy || !constraintsChanged}>
              保存
            </button>
          </div>
        </form>
      </section>

      {/* 按原型顺序，“权限”接在默认约束之后；原型权限区块的其他项（效果上限、服务、Skill）尚未实现，只放已记住的授权。 */}
      <section
        className="detail-section"
        aria-labelledby={`${titleId}-permissions`}
        ref={permissionsRef}
        tabIndex={-1}
      >
        <div className="section-title">
          <h3 id={`${titleId}-permissions`}>权限</h3>
        </div>
        <h4>已记住的授权</h4>
        <GrantList
          owner={{ projectId: project.projectId }}
          visible={active}
          label="已记住的授权"
          empty="本项目还没有记住的授权。在授权卡上选“本项目内始终允许”后会出现在这里，可以随时撤销。"
          fallbackFocus={() => permissionsRef.current}
        />
      </section>
    </section>
  );
}
