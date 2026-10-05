import { useEffect, useState, useSyncExternalStore } from 'react';
import type {
  SkillImport,
  SkillManifest,
  SkillPreview,
  SkillRecord,
  SkillUse,
  Workspace,
} from '@multivac/contracts';
import { ConfirmCard, useConfirm } from '../../components/confirm-card.js';
import { listWorkspaces } from '../../data/workspace-api.js';
import { useWorkbenchEvents } from '../workbench/workbench-sync-provider.js';
import { skillApi, skillsStore } from './skills-store.js';
import './skills.css';
interface Props {
  active: boolean;
  onDirtyChange: (dirty: boolean) => void;
  onBusyChange: (busy: boolean) => void;
  discardSignal: number;
}
export function SkillsPage({ active, onDirtyChange, onBusyChange, discardSignal }: Props) {
  const state = useSyncExternalStore(skillsStore.subscribe, skillsStore.snapshot),
    confirm = useConfirm();
  const [selected, setSelected] = useState<string | null>(null),
    [detail, setDetail] = useState<{
      record: SkillRecord;
      manifest: SkillManifest;
      body: string;
      uses?: SkillUse[];
    } | null>(null);
  const [source, setSource] = useState(''),
    [displayName, setDisplayName] = useState(''),
    [projectId, setProjectId] = useState(''),
    [projects, setProjects] = useState<Workspace[]>([]),
    [editing, setEditing] = useState<SkillRecord | null>(null);
  const [preview, setPreview] = useState<SkillPreview | null>(null),
    [commandId, setCommandId] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [scope, setScope] = useState('');
  const [dependencyDraft, setDependencyDraft] = useState('');
  const [candidateSource, setCandidateSource] = useState(''),
    [candidates, setCandidates] = useState<
      { source: string; name: string; description: string; error: string | null; diagnostics: string[] }[]
    >([]);
  const [hidden, setHidden] = useState<{ revision: number; hidden: boolean }>({ revision: 0, hidden: false });
  const reset = () => {
    setDependencyDraft('');
    setCandidateSource('');
    setCandidates([]);
    setSource('');
    setDisplayName('');
    setProjectId('');
    setEditing(null);
    setPreview(null);
    setError('');
  };
  useEffect(() => {
    reset();
  }, [discardSignal]);
  useEffect(() => {
    onDirtyChange(!!source || !!preview || !!dependencyDraft || !!displayName || !!candidateSource);
  }, [source, preview, dependencyDraft, displayName, candidateSource, onDirtyChange]);
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
  useEffect(() => {
    let current = true;
    setDetail(null);
    if (selected)
      void skillApi<typeof detail>('/' + encodeURIComponent(selected))
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
  useEffect(() => {
    let current = true;
    if (selected && scope)
      void skillApi<typeof hidden>(
        `/preference?skillId=${encodeURIComponent(selected)}&projectId=${encodeURIComponent(scope)}`,
      )
        .then((v) => {
          if (current) setHidden(v);
        })
        .catch((e) => setError(e.message));
    return () => {
      current = false;
    };
  }, [selected, scope, state.records]);
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
  async function previewImport() {
    const input: SkillImport = {
      source,
      displayName,
      projectId: projectId || null,
      ...(editing ? { skillId: editing.skillId, revision: editing.revision } : {}),
    };
    await run(async () => {
      setPreview(await skillApi<SkillPreview>('/preview', input));
      setCommandId(crypto.randomUUID());
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
  return (
    <section className="skills-page" aria-label="Skill 管理">
      <div className="skills-toolbar">
        <div>
          <h2>Skill</h2>
          <p>把可复用的方法带入工作，按需加载正文和资料。</p>
        </div>
        <button type="button" onClick={() => document.getElementById('skill-source')?.focus()}>
          导入本地 Skill
        </button>
      </div>
      {(error || state.error) && <p role="alert">{error || state.error}</p>}
      <div className="skills-layout">
        <aside className="skills-list" aria-label="已登记 Skill">
          {!state.loaded ? (
            <p role="status">正在读取…</p>
          ) : state.records.length === 0 ? (
            <p>还没有 Skill。选择包含 SKILL.md 的目录，预览后确认导入。</p>
          ) : (
            state.records.map((r) => (
              <button
                key={r.skillId}
                type="button"
                aria-pressed={selected === r.skillId}
                onClick={() => {
                  void (async () => {
                    if (
                      dependencyDraft &&
                      selected !== r.skillId &&
                      !(await confirm({
                        title: '放弃未保存的依赖补充？',
                        confirmLabel: '放弃',
                        tone: 'danger',
                      }))
                    )
                      return;
                    if (selected !== r.skillId) setDependencyDraft('');
                    setSelected(r.skillId);
                  })();
                }}
              >
                <strong>{r.displayName}</strong>
                <span>{r.description}</span>
                <small>
                  {r.projectId ? '项目专属' : '全局'} · {r.enabled ? '已启用' : '已停用'}
                </small>
              </button>
            ))
          )}
        </aside>
        <div className="skills-main">
          <details>
            <summary>从 Claude Code / Codex 来源导入</summary>
            <p>
              输入明确选择的 skills 父目录。只检查直接子目录中的标准包；宿主扩展仅保留，不保证跨宿主执行语义。
            </p>
            <label>
              来源目录
              <input value={candidateSource} onChange={(e) => setCandidateSource(e.target.value)} />
            </label>
            <button
              disabled={busy || !candidateSource.trim()}
              onClick={() =>
                void run(async () =>
                  setCandidates(await skillApi('/candidates', { source: candidateSource })),
                )
              }
            >
              列出候选
            </button>
            {candidates.map((c) => (
              <div key={c.source}>
                <strong>{c.name}</strong>
                <p>{c.error ?? c.description}</p>
                <button
                  disabled={!!c.error}
                  onClick={() => {
                    setEditing(null);
                    setSource(c.source);
                    setDisplayName('');
                  }}
                >
                  选择并预览
                </button>
              </div>
            ))}
          </details>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void previewImport();
            }}
            className="skills-import"
          >
            <h3>{editing ? '更新 Skill' : '导入 Skill'}</h3>
            <label>
              本地包目录
              <input
                id="skill-source"
                value={source}
                onChange={(e) => setSource(e.target.value)}
                placeholder="输入服务端本机的绝对目录路径"
                required
                disabled={busy}
              />
            </label>
            <div className="skills-fields">
              <label>
                显示名称（可选）
                <input
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  maxLength={128}
                  disabled={busy}
                />
              </label>
              <label>
                发现范围
                <select
                  value={projectId}
                  disabled={busy || !!editing}
                  onChange={(e) => setProjectId(e.target.value)}
                >
                  <option value="">全局</option>
                  {projects
                    .filter((w) => w.project)
                    .map((w) => (
                      <option key={w.workspaceId} value={w.project!.projectId}>
                        {w.project!.name}
                      </option>
                    ))}
                </select>
              </label>
            </div>
            <div className="skills-actions">
              <button disabled={!source.trim() || busy} type="submit">
                预览{editing ? '更新' : '导入'}
              </button>
              {source && (
                <button type="button" disabled={busy} onClick={reset}>
                  取消
                </button>
              )}
            </div>
          </form>
          {selected && !detail ? (
            <p role="status">正在读取详情…</p>
          ) : (
            detail && (
              <article className="skills-detail">
                <header>
                  <h3>{detail.record.displayName}</h3>
                  <p>{detail.record.description}</p>
                </header>
                <dl>
                  <dt>规范名称</dt>
                  <dd>{detail.record.name}</dd>
                  <dt>来源</dt>
                  <dd>
                    {detail.record.source.startsWith('draft:') ? '用户确认的对话草案' : detail.record.source}
                  </dd>
                  <dt>版本</dt>
                  <dd>
                    <code>{detail.record.version}</code>
                  </dd>
                  <dt>工具依赖</dt>
                  <dd>
                    {detail.manifest.dependencies.source === 'unknown'
                      ? '未知；未声明不代表不需要工具'
                      : detail.manifest.dependencies.tools.join('、') || '声明无工具依赖'}
                    。声明不授予权限。
                  </dd>
                  <dt>用户补充</dt>
                  <dd>
                    {detail.record.userTools === undefined
                      ? '未补充'
                      : detail.record.userTools.join('、') || '用户确认无工具依赖'}
                  </dd>
                  <dt>最近加载</dt>
                  <dd>{detail.uses?.find((u) => u.kind === 'load')?.createdAt ?? '暂无使用记录'}</dd>
                </dl>
                <div className="skills-actions">
                  <a
                    href={`/api/skills/${encodeURIComponent(detail.record.skillId)}/export?version=${detail.record.version}`}
                    download
                  >
                    导出标准包
                  </a>
                  {!detail.record.source.startsWith('draft:') && (
                    <button
                      disabled={busy}
                      onClick={() => {
                        setEditing(detail.record);
                        setSource(detail.record.source);
                        setDisplayName(detail.record.displayName);
                        setProjectId(detail.record.projectId ?? '');
                      }}
                    >
                      预览新版本
                    </button>
                  )}
                  <button
                    onClick={() =>
                      void changeState(detail.record, detail.record.enabled ? 'disable' : 'enable')
                    }
                  >
                    {detail.record.enabled ? '停用' : '启用'}
                  </button>
                  <button onClick={() => void changeState(detail.record, 'remove')}>移除</button>
                </div>
                <label>
                  项目相关性
                  <select value={scope} onChange={(e) => setScope(e.target.value)}>
                    <option value="">选择项目</option>
                    {projects
                      .filter((w) => w.project)
                      .map((w) => (
                        <option key={w.workspaceId} value={w.project!.projectId}>
                          {w.project!.name}
                        </option>
                      ))}
                  </select>
                </label>
                {scope && (
                  <label>
                    <input
                      type="checkbox"
                      checked={hidden.hidden}
                      disabled={busy}
                      onChange={(e) => {
                        const value = e.target.checked;
                        void run(async () => {
                          await skillApi('/preference', {
                            commandId: crypto.randomUUID(),
                            skillId: detail.record.skillId,
                            projectId: scope,
                            sessionId: null,
                            revision: hidden.revision,
                            hidden: value,
                          });
                          await skillsStore.refresh();
                        });
                      }}
                    />{' '}
                    在此项目隐藏（不改变工具权限）
                  </label>
                )}
                <details>
                  <summary>补充工具依赖</summary>
                  <p>
                    填写实际需要的工具名，以空格分隔。空列表表示你确认没有工具依赖；不会授予这些工具的权限。
                  </p>
                  <input
                    aria-label="补充工具依赖"
                    value={dependencyDraft}
                    onChange={(e) => setDependencyDraft(e.target.value)}
                  />
                  <button
                    onClick={() => {
                      const commandId = crypto.randomUUID();
                      void confirm({
                        title: '保存用户补充的依赖？',
                        description: dependencyDraft.trim() || '确认无工具依赖',
                        confirmLabel: '保存',
                        action: async () => {
                          await skillApi('/dependencies', {
                            commandId,
                            skillId: detail.record.skillId,
                            revision: detail.record.revision,
                            tools: dependencyDraft.trim().split(/\s+/u).filter(Boolean),
                          });
                          setDependencyDraft('');
                          await skillsStore.refresh();
                        },
                      });
                    }}
                  >
                    确认补充
                  </button>
                </details>
                {detail.uses && detail.uses.length > 0 && (
                  <details>
                    <summary>最近使用事实</summary>
                    <ul>
                      {detail.uses.map((use) => (
                        <li key={use.useId}>
                          {use.createdAt} · {use.kind === 'load' ? '正文已读取' : '资源已读取'} · {use.path} ·
                          版本 {use.version.slice(0, 12)} · 会话 {use.sessionId}
                        </li>
                      ))}
                    </ul>
                    <p>读取事实不等于脚本执行成功；工具结果在对应会话运行轨迹中查看。</p>
                  </details>
                )}
                {detail.manifest.diagnostics.map((d) => (
                  <p key={d}>{d}</p>
                ))}
                <details>
                  <summary>正文预览 · SKILL.md</summary>
                  <pre>{detail.body}</pre>
                </details>
                <details>
                  <summary>包文件 · {detail.manifest.files.length}</summary>
                  <ul>
                    {detail.manifest.files.map((f) => (
                      <li key={f.path}>
                        {f.path} · {f.bytes} 字节
                      </li>
                    ))}
                  </ul>
                </details>
              </article>
            )
          )}
        </div>
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
              setSelected(record.skillId);
              await skillsStore.refresh();
            })
          }
        >
          <p>{preview.input.source}</p>
          <p>{preview.manifest.description}</p>
          <p>变更文件：{preview.changes.join('、') || '无内容变化'}</p>
          <p>
            依赖：
            {preview.manifest.dependencies.source === 'unknown'
              ? '未知'
              : preview.manifest.dependencies.tools.join('、') || '声明无工具依赖'}
            ；不授予工具权限。
          </p>
          <details>
            <summary>检查正文与诊断</summary>
            <pre className="skills-preview">{preview.body}</pre>
            {preview.manifest.diagnostics.map((d) => (
              <p key={d}>{d}</p>
            ))}
          </details>
        </ConfirmCard>
      )}
    </section>
  );
}
