import { useEffect, useState } from 'react';
import { Check, ChevronRight, File as FileIcon, Folder, FolderSearch, LoaderCircle, RefreshCw, Search } from 'lucide-react';
import type { Project, ProjectDirectoryEntry, ProjectDirectoryListing, ProjectResource } from '@multivac/contracts';
import { ConfirmCard } from '../../components/confirm-card.js';
import { browseProjectDirectory, createProjectResource } from '../../data/project-resources-api.js';

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/** 项目目录中条目的绝对路径，与服务端登记的引用路径一致，用于识别已添加的文件。 */
function absolutePath(root: string, path: string): string {
  return `${root.replace(/\/+$/u, '')}/${path}`;
}

function directoryName(path: string): string {
  return path.replace(/\/+$/u, '').split('/').at(-1) || path;
}

/**
 * 从项目目录选择：逐级浏览或按文件名搜索项目目录，勾选一个或多个文件登记为资料引用，不复制。
 * 已在资料中的文件标为“已添加”，不能重复选择。
 */
export function ProjectDirectoryPicker({ project, resources, onAdded, onCancel }: {
  project: Project;
  resources: readonly ProjectResource[];
  onAdded: (created: ProjectResource[]) => Promise<void>;
  onCancel: () => void;
}) {
  const [root, setRoot] = useState(project.directories[0]!.path);
  const [path, setPath] = useState('');
  const [query, setQuery] = useState('');
  const [listing, setListing] = useState<ProjectDirectoryListing | null>(null);
  const [loadError, setLoadError] = useState('');
  const [retry, setRetry] = useState(0);
  // 选中的文件以绝对路径记录，切换目录或搜索时保留。
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const added = new Set(resources.filter((resource) => resource.source === 'directory').map((resource) => resource.path));
  const searching = Boolean(query.trim());
  // 搜索覆盖整个所选目录，与当前浏览位置无关。
  const browsePath = searching ? '' : path;

  useEffect(() => {
    const controller = new AbortController();
    setListing(null);
    setLoadError('');
    // 搜索时稍等输入停顿再请求，逐级浏览立即读取。
    const timer = setTimeout(() => {
      browseProjectDirectory(project.projectId, root, browsePath, query.trim(), controller.signal)
        .then((value) => { if (!controller.signal.aborted) setListing(value); })
        .catch((cause: unknown) => { if (!controller.signal.aborted) setLoadError(errorText(cause, '目录读取失败。')); });
    }, searching ? 200 : 0);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [project.projectId, root, browsePath, query, searching, retry]);

  function toggle(entry: ProjectDirectoryEntry) {
    const target = absolutePath(root, entry.path);
    setSelected((current) => current.includes(target) ? current.filter((item) => item !== target) : [...current, target]);
  }

  async function submit() {
    setBusy(true);
    setError('');
    const created: ProjectResource[] = [];
    try {
      for (const target of selected) created.push(await createProjectResource(project.projectId, { kind: 'directory', path: target }));
      await onAdded(created);
    } catch (cause) {
      // 部分添加成功时，已添加的从选择中移除，重试只处理剩下的。
      const done = new Set(created.map((resource) => resource.path));
      setSelected((current) => current.filter((item) => !done.has(item)));
      setError(errorText(cause, '添加没有完成，请重试。'));
      setBusy(false);
    }
  }

  const segments = path ? path.split('/') : [];

  return (
    <ConfirmCard
      title="从项目目录选择"
      description="引用项目目录中的已有文件，不复制；文件在目录中修改后，这里看到的就是最新内容。"
      icon={FolderSearch}
      confirmLabel={selected.length > 1 ? `添加 ${selected.length} 个文件` : '添加'}
      confirmDisabled={!selected.length}
      busy={busy}
      error={error}
      onConfirm={() => void submit()}
      onCancel={onCancel}
    >
      <div className="directory-picker">
        <div className="directory-picker-bar">
          {project.directories.length > 1 && (
            <select aria-label="项目目录" value={root} title={root} onChange={(event) => { setRoot(event.target.value); setPath(''); }}>
              {project.directories.map((directory) => <option key={directory.path} value={directory.path}>{directoryName(directory.path)}</option>)}
            </select>
          )}
          <label className="directory-picker-search">
            <Search aria-hidden="true" />
            <input
              autoFocus
              aria-label="搜索文件名"
              placeholder="搜索文件名"
              value={query}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              onChange={(event) => setQuery(event.target.value.slice(0, 200))}
              onKeyDown={(event) => { if (event.key === 'Escape' && query) { event.preventDefault(); event.stopPropagation(); setQuery(''); } }}
            />
          </label>
        </div>

        {!searching && (
          <nav className="directory-picker-crumbs" aria-label="当前位置">
            <button type="button" title={root} aria-current={segments.length ? undefined : 'location'} onClick={() => setPath('')}>{directoryName(root)}</button>
            {segments.map((segment, index) => (
              <span key={index}>
                <ChevronRight aria-hidden="true" />
                <button type="button" aria-current={index === segments.length - 1 ? 'location' : undefined} onClick={() => setPath(segments.slice(0, index + 1).join('/'))}>{segment}</button>
              </span>
            ))}
          </nav>
        )}

        <div className="directory-picker-list">
          {loadError ? (
            <p className="directory-picker-empty" role="alert">
              {loadError}
              <button type="button" className="icon-button" aria-label="重新读取目录" title="重试" onClick={() => setRetry((value) => value + 1)}><RefreshCw /></button>
            </p>
          ) : !listing ? (
            <p className="directory-picker-empty" role="status"><LoaderCircle className="spin" aria-hidden="true" />{searching ? '正在搜索…' : '正在读取目录…'}</p>
          ) : (
            <>
              <ul aria-label={searching ? '搜索结果' : '目录内容'}>
                {listing.entries.map((entry) => {
                  if (entry.kind === 'directory') {
                    return (
                      <li key={entry.path}>
                        <button type="button" onClick={() => setPath(entry.path)}>
                          <Folder aria-hidden="true" /><span>{entry.name}</span><ChevronRight className="directory-picker-enter" aria-hidden="true" />
                        </button>
                      </li>
                    );
                  }
                  const target = absolutePath(root, entry.path);
                  const exists = added.has(target);
                  const checked = selected.includes(target);
                  return (
                    <li key={entry.path}>
                      <button type="button" aria-pressed={checked} disabled={exists} title={target} onClick={() => toggle(entry)}>
                        {checked ? <Check className="directory-picker-check" aria-hidden="true" /> : <FileIcon aria-hidden="true" />}
                        <span>{entry.name}{searching && <small>{entry.path}</small>}</span>
                        {exists && <em>已添加</em>}
                      </button>
                    </li>
                  );
                })}
              </ul>
              {!listing.entries.length && <p className="directory-picker-empty">{searching ? '没有匹配的文件' : '这个目录是空的'}</p>}
              {listing.limited && <p className="directory-picker-empty">{searching ? '结果较多，只显示了一部分，请输入更具体的文件名。' : '条目较多，只显示了一部分，可以用搜索查找。'}</p>}
            </>
          )}
        </div>

        {selected.length > 0 && (
          <p className="directory-picker-selected" role="status">
            已选 {selected.length} 个文件
            <button type="button" onClick={() => setSelected([])}>清空</button>
          </p>
        )}
      </div>
    </ConfirmCard>
  );
}
