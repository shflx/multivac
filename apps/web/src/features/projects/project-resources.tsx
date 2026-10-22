import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  File as FileIcon,
  FileCode,
  FileImage,
  FileText,
  FolderOpen,
  FolderSearch,
  LoaderCircle,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Trash2,
  Upload,
} from 'lucide-react';
import { createPortal } from 'react-dom';
import {
  PROJECT_RESOURCE_LIMITS,
  projectResourceExtension,
  projectResourceTitle,
  type Project,
  type ProjectResource,
  type ProjectResourceListResponse,
} from '@multivac/contracts';
import { ConfirmCard, useConfirm } from '../../components/confirm-card.js';
import {
  createProjectResource,
  fileToBase64,
  listProjectResources,
  openProjectResource,
  removeProjectResource,
  updateProjectResource,
} from '../../data/project-resources-api.js';
import '../workspace/file-actions.css';
import './project-resources.css';

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'heic', 'bmp', 'tiff']);

function ResourceIcon({ resource }: { resource: ProjectResource }) {
  const extension = projectResourceExtension(resource.fileName);
  const Icon = IMAGE_EXTENSIONS.has(extension) ? FileImage
    : ['md', 'markdown', 'mdx', 'txt', 'text', 'rst', 'adoc', 'org'].includes(extension) ? FileText
      : resource.text ? FileCode : FileIcon;
  return <span className="resource-icon" aria-hidden="true"><Icon /></span>;
}

/** 更新时间：一周内用相对时间，更早的显示日期。 */
function formatModified(value: string | null, now = Date.now()): string {
  if (!value) return '';
  const at = Date.parse(value);
  if (Number.isNaN(at)) return '';
  const minutes = Math.floor(Math.max(0, now - at) / 60000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)} 小时前`;
  if (minutes < 7 * 24 * 60) return `${Math.floor(minutes / 60 / 24)} 天前`;
  return new Date(at).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
}

type Dialog = { kind: 'new' } | { kind: 'directory' } | { kind: 'edit'; resource: ProjectResource };

/**
 * 项目资料：围绕项目整理的一组文件，与目录中的工作成果分开呈现。
 * 资料由系统默认程序打开；常驻的文本资料每次会话都会带上全文，其余作为索引供智能体按需读取。
 */
export function ProjectResources({ project, active, onCount }: { project: Project; active: boolean; onCount?: (count: number | null) => void }) {
  const confirm = useConfirm();
  const [list, setList] = useState<ProjectResourceListResponse | null>(null);
  const [loadError, setLoadError] = useState('');
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const [adding, setAdding] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const addRef = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const projectId = project.projectId;

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      setList(await listProjectResources(projectId, signal));
      setLoadError('');
    } catch (error) {
      if (!signal?.aborted) setLoadError(errorText(error, '项目资料读取失败。'));
    }
  }, [projectId]);

  // 切换项目或回到页面时重新读取：文件可能在外部被修改、移动或删除。
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    setList((current) => current?.resources[0]?.projectId === projectId || current?.resources.length === 0 ? current : null);
    void load(controller.signal);
    return () => controller.abort();
  }, [active, load, projectId]);

  useEffect(() => {
    if (!adding) return;
    const close = (event: PointerEvent) => { if (!addRef.current?.contains(event.target as Node)) setAdding(false); };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [adding]);

  const report = (text: string, error = false) => setNotice({ text, error });

  async function upload(files: readonly File[]) {
    if (!files.length) return;
    const tooLarge = files.find((file) => file.size > PROJECT_RESOURCE_LIMITS.uploadBytes);
    if (tooLarge) { report(`「${tooLarge.name}」超过 ${PROJECT_RESOURCE_LIMITS.uploadBytes / 1024 / 1024} MB，无法添加。`, true); return; }
    setUploading(true);
    try {
      for (const file of files) await createProjectResource(projectId, { kind: 'upload', fileName: file.name, contentBase64: await fileToBase64(file) });
      report(files.length === 1 ? `已添加「${files[0]!.name}」。` : `已添加 ${files.length} 个文件。`);
    } catch (error) {
      report(errorText(error, '添加文件失败，请重试。'), true);
    } finally {
      setUploading(false);
      await load();
    }
  }

  async function open(resource: ProjectResource, action: 'open' | 'reveal') {
    try { report(await openProjectResource(projectId, resource.resourceId, action)); }
    catch (error) { report(errorText(error, action === 'open' ? '打开失败，请重试。' : '定位失败，请重试。'), true); }
  }

  async function togglePinned(resource: ProjectResource) {
    try {
      await updateProjectResource(projectId, resource.resourceId, { pinned: !resource.pinned });
      report(resource.pinned ? `「${projectResourceTitle(resource)}」不再常驻。` : `「${projectResourceTitle(resource)}」已设为常驻，之后的会话会带上全文。`);
      await load();
    } catch (error) { report(errorText(error, '修改失败，请重试。'), true); }
  }

  async function remove(resource: ProjectResource) {
    const managed = resource.source === 'managed';
    const removed = await confirm({
      title: `移除「${projectResourceTitle(resource)}」`,
      description: managed ? '这份资料保存在项目资料目录中，移除后文件会移到废纸篓。' : '只从项目资料中移除，项目目录中的文件保持不动。',
      ...(managed ? { tone: 'danger' as const } : {}),
      confirmLabel: '移除',
      action: async () => { await removeProjectResource(projectId, resource.resourceId); },
    });
    if (removed) { report(`已移除「${projectResourceTitle(resource)}」。`); await load(); }
  }

  const resources = list?.resources ?? [];
  useEffect(() => { onCount?.(list ? list.resources.length : null); }, [list, onCount]);
  const pinnedCount = resources.filter((resource) => resource.pinned).length;

  return (
    <section className="project-resources" aria-label="项目资料">
      <div className="resources-head">
        <p className="section-hint">
          围绕这个项目整理的资料，用系统默认程序打开。常驻的文本资料每次会话都会带上全文，其余由智能体在需要时查阅。
        </p>
        <div className="resources-add" ref={addRef}>
          <button type="button" className="secondary-button compact" aria-haspopup="menu" aria-expanded={adding} disabled={uploading} onClick={() => setAdding((value) => !value)}>
            {uploading ? <LoaderCircle className="spin" aria-hidden="true" /> : <Plus aria-hidden="true" />}
            {uploading ? '正在添加…' : '添加'}
          </button>
          {adding && (
            <div className="resources-add-menu" role="menu" aria-label="添加资料" onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); setAdding(false); } }}>
              <button type="button" role="menuitem" autoFocus onClick={() => { setAdding(false); setDialog({ kind: 'new' }); }}>
                <FileText aria-hidden="true" /><span><strong>新建文档</strong><small>在资料目录中创建 Markdown 文件</small></span>
              </button>
              <button type="button" role="menuitem" onClick={() => { setAdding(false); setDialog({ kind: 'directory' }); }}>
                <FolderSearch aria-hidden="true" /><span><strong>从项目目录选择</strong><small>引用目录中的已有文件，不复制</small></span>
              </button>
              <button type="button" role="menuitem" onClick={() => { setAdding(false); fileInput.current?.click(); }}>
                <Upload aria-hidden="true" /><span><strong>从本机添加文件</strong><small>复制一份到资料目录，如 PDF、HTML</small></span>
              </button>
            </div>
          )}
          <input ref={fileInput} type="file" multiple hidden aria-label="选择要添加的文件" onChange={(event) => { const files = Array.from(event.currentTarget.files ?? []); event.currentTarget.value = ''; void upload(files); }} />
        </div>
      </div>

      {notice && <p className={notice.error ? 'resources-notice error' : 'resources-notice'} role={notice.error ? 'alert' : 'status'}>{notice.text}</p>}
      {loadError && <p className="form-error" role="alert">{loadError}</p>}

      {list === null && !loadError && <p className="resources-empty" role="status"><LoaderCircle className="spin" aria-hidden="true" />正在读取资料…</p>}
      {list !== null && resources.length === 0 && (
        <div className="resources-empty">
          <strong>还没有资料</strong>
          <span>把需求说明、设计稿、参考文档放在这里，智能体做事时会知道它们的存在。</span>
        </div>
      )}
      {resources.length > 0 && (
        <>
          {pinnedCount > 0 && list && (
            <p className="resources-budget">
              常驻 {pinnedCount} 份，共 {list.pinnedChars.toLocaleString('en-US')} / {list.pinnedLimit.toLocaleString('en-US')} 字
            </p>
          )}
          <ul className="resources-list">
            {resources.map((resource) => (
              <ResourceRow
                key={resource.resourceId}
                resource={resource}
                onOpen={() => void open(resource, 'open')}
                onReveal={() => void open(resource, 'reveal')}
                onEdit={() => setDialog({ kind: 'edit', resource })}
                onTogglePinned={() => void togglePinned(resource)}
                onRemove={() => void remove(resource)}
              />
            ))}
          </ul>
        </>
      )}

      {dialog?.kind === 'new' && (
        <InputDialog
          title="新建文档"
          description="在项目资料目录中创建 Markdown 文件，创建后用系统默认程序打开编辑。"
          label="文件名"
          placeholder="例如：需求说明"
          confirmLabel="新建并打开"
          onCancel={() => setDialog(null)}
          onSubmit={async (fileName) => {
            const created = await createProjectResource(projectId, { kind: 'new', fileName });
            setDialog(null);
            await load();
            await open(created, 'open');
          }}
        />
      )}
      {dialog?.kind === 'directory' && (
        <InputDialog
          title="从项目目录选择"
          description="引用项目目录中的已有文件，不复制；文件在目录中修改后这里看到的就是最新内容。"
          label="文件路径"
          placeholder="如 docs/design.md，或绝对路径"
          hint={<>相对路径从主目录算起：<code>{project.directories[0]!.path}</code></>}
          confirmLabel="添加"
          onCancel={() => setDialog(null)}
          onSubmit={async (path) => {
            const created = await createProjectResource(projectId, { kind: 'directory', path });
            setDialog(null);
            report(`已添加「${projectResourceTitle(created)}」。`);
            await load();
          }}
        />
      )}
      {dialog?.kind === 'edit' && (
        <EditDialog
          resource={dialog.resource}
          onCancel={() => setDialog(null)}
          onSaved={async () => { setDialog(null); report('已保存。'); await load(); }}
        />
      )}
    </section>
  );
}

function ResourceRow({ resource, onOpen, onReveal, onEdit, onTogglePinned, onRemove }: {
  resource: ProjectResource;
  onOpen: () => void;
  onReveal: () => void;
  onEdit: () => void;
  onTogglePinned: () => void;
  onRemove: () => void;
}) {
  const [menu, setMenu] = useState<{ left: number; top: number } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const missing = resource.file.status === 'missing';
  const title = projectResourceTitle(resource);
  const source = resource.source === 'managed' ? '资料目录' : '项目目录';
  // 自定义了标题时第二行给出文件名，便于找到实际文件。
  const detail = resource.summary || (resource.title ? resource.fileName : resource.source === 'directory' ? resource.path : '');

  useEffect(() => {
    if (!menu) return;
    menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus({ preventScroll: true });
    const close = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setMenu(null);
    };
    const hide = () => setMenu(null);
    document.addEventListener('pointerdown', close);
    window.addEventListener('resize', hide);
    return () => { document.removeEventListener('pointerdown', close); window.removeEventListener('resize', hide); };
  }, [menu]);

  const run = (action: () => void) => () => { setMenu(null); action(); };
  const openMenu = () => {
    const rect = trigger.current!.getBoundingClientRect();
    setMenu(menu ? null : { left: Math.max(8, rect.right - 200), top: rect.bottom + 4 });
  };

  return (
    <li className={missing ? 'resource-row missing' : 'resource-row'}>
      <button type="button" className="resource-main" title={missing ? '文件不存在，可能已被移动或删除' : `用系统默认程序打开 ${resource.path}`} disabled={missing} onClick={onOpen}>
        <ResourceIcon resource={resource} />
        <span className="resource-copy">
          <strong>{title}</strong>
          <small>{source}{detail ? ` · ${detail}` : ''}</small>
        </span>
      </button>
      {resource.pinned && <span className="resource-tag pinned"><Pin aria-hidden="true" />常驻</span>}
      {missing && <span className="resource-tag missing">文件缺失</span>}
      <span className="resource-time">{formatModified(resource.file.modifiedAt)}</span>
      <button ref={trigger} type="button" className="icon-button resource-more" aria-label={`「${title}」的操作`} aria-haspopup="menu" aria-expanded={Boolean(menu)} onClick={openMenu}>
        <MoreHorizontal aria-hidden="true" />
      </button>
      {menu && createPortal(
        <div ref={menuRef} className="file-action-menu" role="menu" aria-label={`「${title}」的操作`} style={{ left: menu.left, top: menu.top }} onKeyDown={(event) => {
          if (event.key === 'Escape' || event.key === 'Tab') { event.preventDefault(); setMenu(null); trigger.current?.focus(); }
          if (['ArrowDown', 'ArrowUp'].includes(event.key)) {
            event.preventDefault();
            const items = [...menuRef.current!.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')];
            const index = items.indexOf(document.activeElement as HTMLButtonElement);
            items[(index + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length]?.focus();
          }
        }}>
          <button type="button" role="menuitem" disabled={missing} onClick={run(onOpen)}><FileText aria-hidden="true" />打开</button>
          <button type="button" role="menuitem" disabled={missing} onClick={run(onReveal)}><FolderOpen aria-hidden="true" />在文件管理器中显示</button>
          <div className="file-action-separator" role="separator" />
          <button type="button" role="menuitem" onClick={run(onEdit)}><Pencil aria-hidden="true" />编辑标题和简介</button>
          <button type="button" role="menuitem" disabled={!resource.pinned && (!resource.text || missing)} title={!resource.text ? '只有文本类资料可以常驻' : undefined} onClick={run(onTogglePinned)}>
            {resource.pinned ? <PinOff aria-hidden="true" /> : <Pin aria-hidden="true" />}{resource.pinned ? '取消常驻' : '设为常驻'}
          </button>
          <div className="file-action-separator" role="separator" />
          <button type="button" role="menuitem" className="danger" onClick={run(onRemove)}><Trash2 aria-hidden="true" />移除</button>
        </div>,
        document.body,
      )}
    </li>
  );
}

function InputDialog({ title, description, label, placeholder, hint, confirmLabel, onSubmit, onCancel }: {
  title: string;
  description: string;
  label: string;
  placeholder: string;
  hint?: ReactNode;
  confirmLabel: string;
  onSubmit: (value: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit() {
    setBusy(true);
    setError('');
    try { await onSubmit(value.trim()); }
    catch (cause) { setError(errorText(cause, '操作没有完成，请重试。')); setBusy(false); }
  }
  return (
    <ConfirmCard title={title} description={description} icon={FileText} confirmLabel={confirmLabel} confirmDisabled={!value.trim()} busy={busy} error={error} onConfirm={() => void submit()} onCancel={onCancel}>
      <dl className="confirm-card-fields">
        <div>
          <dt>{label}</dt>
          <dd>
            <input autoFocus aria-label={label} value={value} placeholder={placeholder} spellCheck={false} autoCapitalize="off" autoCorrect="off" onChange={(event) => setValue(event.target.value)} />
            {hint && <small className="resources-dialog-hint">{hint}</small>}
          </dd>
        </div>
      </dl>
    </ConfirmCard>
  );
}

function EditDialog({ resource, onSaved, onCancel }: { resource: ProjectResource; onSaved: () => Promise<void>; onCancel: () => void }) {
  const [title, setTitle] = useState(resource.title ?? '');
  const [summary, setSummary] = useState(resource.summary);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit() {
    setBusy(true);
    setError('');
    try {
      await updateProjectResource(resource.projectId, resource.resourceId, { title: title.trim() || null, summary });
      await onSaved();
    } catch (cause) { setError(errorText(cause, '保存没有完成，请重试。')); setBusy(false); }
  }
  return (
    <ConfirmCard title="编辑资料" description="标题留空时显示文件名；简介会写进给智能体的资料索引，写清它是什么、什么时候用。" icon={Pencil} confirmLabel="保存" busy={busy} error={error} onConfirm={() => void submit()} onCancel={onCancel}>
      <dl className="confirm-card-fields">
        <div>
          <dt>标题</dt>
          <dd><input autoFocus aria-label="标题" value={title} maxLength={PROJECT_RESOURCE_LIMITS.titleLength} placeholder={resource.fileName} onChange={(event) => setTitle(event.target.value)} /></dd>
        </div>
        <div>
          <dt>简介</dt>
          <dd><textarea aria-label="简介" rows={3} value={summary} maxLength={PROJECT_RESOURCE_LIMITS.summaryLength} placeholder="例如：v0.5 的目标与范围，评估需求边界时先看它" onChange={(event) => setSummary(event.target.value)} /></dd>
        </div>
        <div>
          <dt>文件</dt>
          <dd><code className="resources-path">{resource.path}</code></dd>
        </div>
      </dl>
    </ConfirmCard>
  );
}
