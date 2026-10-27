import { rememberedTerminalSelection } from './terminal-selection.js';
import { SquareTerminal } from 'lucide-react';
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { Project, ProjectTerminal, TerminalPreset } from '@multivac/contracts';
import { ConfirmCard } from '../../components/confirm-card.js';
import { createTerminal, listTerminals, terminalAvailable } from '../../data/terminal-api.js';
import { updatePreferences } from '../../data/preferences-api.js';
import { usePreferences } from '../preferences/use-preferences.js';
import { useRemoteConversation } from '../assistant/remote-context.js';
import { useWorkbenchEvents } from '../workbench/workbench-sync-provider.js';
import { useWorkspaces } from '../workspace/workspace-sessions-provider.js';
import { joinCommandLine, splitCommandLine } from './command-line.js';
import { PRESET_LABELS, TerminalBadge } from './terminal-presentation.js';
import './terminals.css';

/** 并排栏位中的终端：栏号（从 0 起）到终端 id。只在本窗口生效，不写入工作区现场。 */
export type TerminalColumns = Readonly<Record<number, string>>;

interface TerminalContextValue {
  available: boolean; terminals: ProjectTerminal[]; error: string;
  /** 聚焦查看的终端；放在并排栏位中且处于并排时只表示选中。 */
  selected: { workspaceId: string; terminalId: string } | null;
  select(value: { workspaceId: string; terminalId: string } | null): void;
  create(project: Project, kind?: TerminalPreset['kind']): void;
  refresh(): Promise<void>;
  columnsOf(workspaceId: string): TerminalColumns;
  /** 把终端放进第 slot + 1 栏；它原来在别的栏时移过去。 */
  place(workspaceId: string, terminalId: string, slot: number): void;
  placeFirst(workspaceId: string, terminalId: string): void;
  /** 从栏位移除终端（按 id），或清空某一栏（按栏号）。 */
  unplace(workspaceId: string, target: string | number): void;
  /** 本窗口最近新建的终端；工作区据此把它放进并排的第一栏。 */
  created: { workspaceId: string; terminalId: string; sequence: number } | null;
}

const Context = createContext<TerminalContextValue | null>(null);
export function useTerminals() { const value = useContext(Context); if (!value) throw new Error('终端需要 TerminalsProvider。'); return value; }

const COLUMNS_KEY = 'multivac.terminal-columns';

function rememberedColumns(): Record<string, TerminalColumns> {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(COLUMNS_KEY) ?? '{}');
    if (!value || typeof value !== 'object') return {};
    return Object.fromEntries(Object.entries(value).map(([workspaceId, columns]): [string, TerminalColumns] => [workspaceId, Object.fromEntries(
      Object.entries(columns && typeof columns === 'object' ? columns as Record<string, unknown> : {})
        .filter((entry): entry is [string, string] => /^\d+$/u.test(entry[0]) && typeof entry[1] === 'string'),
    )]));
  } catch { return {}; }
}

export function TerminalsProvider({ children }: { children: ReactNode }) {
  const remote = useRemoteConversation();
  const { workspaces } = useWorkspaces();
  const [available, setAvailable] = useState(false);
  const [terminals, setTerminals] = useState<ProjectTerminal[]>([]);
  const [error, setError] = useState('');
  const [selected, select] = useState<TerminalContextValue['selected']>(rememberedTerminalSelection);
  const [columns, setColumns] = useState<Record<string, TerminalColumns>>(rememberedColumns);
  const [created, setCreated] = useState<TerminalContextValue['created']>(null);
  const [creating, setCreating] = useState<{ project: Project; kind: TerminalPreset['kind']; error?: string } | null>(null);

  useEffect(() => {
    if (remote || /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)) return;
    let live = true;
    void terminalAvailable().then(value => { if (live) setAvailable(value); }).catch(() => {});
    return () => { live = false; };
  }, [remote]);
  useEffect(() => { try { sessionStorage.setItem('multivac.selected-terminal', JSON.stringify(selected)); } catch { /* 不影响当前窗口。 */ } }, [selected]);
  useEffect(() => { try { sessionStorage.setItem(COLUMNS_KEY, JSON.stringify(columns)); } catch { /* 不影响当前窗口。 */ } }, [columns]);

  const sequence = useRef(0);
  const refresh = useCallback(async () => {
    if (!available || !workspaces) return;
    const version = ++sequence.current;
    try {
      const lists = await Promise.all(workspaces.flatMap(workspace => workspace.project ? [listTerminals(workspace.project.projectId)] : []));
      if (version === sequence.current) { setTerminals(lists.flat()); setError(''); }
    } catch (error) { if (version === sequence.current) setError(error instanceof Error ? error.message : '终端列表读取失败。'); }
  }, [available, workspaces]);
  useEffect(() => { void refresh(); }, [refresh]);
  useWorkbenchEvents(event => { if (event.type === 'terminal.changed' || event.type === 'workbench.connected') void refresh(); });

  const opened = useCallback((record: ProjectTerminal) => {
    setTerminals(current => [...current.filter(item => item.terminalId !== record.terminalId), record]);
    select({ workspaceId: record.projectId, terminalId: record.terminalId });
    setCreated(current => ({ workspaceId: record.projectId, terminalId: record.terminalId, sequence: (current?.sequence ?? 0) + 1 }));
  }, []);

  /** 预设在唯一目录中直接启动；自定义命令、多个目录或启动失败时打开创建卡。 */
  const create = useCallback((project: Project, kind: TerminalPreset['kind'] = 'blank') => {
    if (kind === 'custom' || project.directories.length > 1) { setCreating({ project, kind }); return; }
    const preset: TerminalPreset = kind === 'blank' ? { kind } : { kind, argv: [] };
    void createTerminal({ projectId: project.projectId, directory: project.directories[0]!.path, preset, size: { cols: 80, rows: 24 } })
      .then(opened)
      .catch((cause: unknown) => setCreating({ project, kind, error: cause instanceof Error ? cause.message : '终端启动失败。' }));
  }, [opened]);

  const columnsOf = useCallback((workspaceId: string) => columns[workspaceId] ?? {}, [columns]);
  const place = useCallback((workspaceId: string, terminalId: string, slot: number) => setColumns(current => {
    const kept = Object.entries(current[workspaceId] ?? {}).filter(([, id]) => id !== terminalId);
    return { ...current, [workspaceId]: { ...Object.fromEntries(kept), [slot]: terminalId } };
  }), []);
  /** 放进第一栏，已放好的终端依次后移一栏（与新会话进第一栏一致）。 */
  const placeFirst = useCallback((workspaceId: string, terminalId: string) => setColumns(current => {
    const kept = Object.entries(current[workspaceId] ?? {}).filter(([, id]) => id !== terminalId).map(([slot, id]) => [Number(slot) + 1, id] as const);
    return { ...current, [workspaceId]: { ...Object.fromEntries(kept), 0: terminalId } };
  }), []);
  const unplace = useCallback((workspaceId: string, target: string | number) => setColumns(current => {
    const entries = Object.entries(current[workspaceId] ?? {});
    const kept = entries.filter(([slot, id]) => (typeof target === 'number' ? Number(slot) !== target : id !== target));
    return kept.length === entries.length ? current : { ...current, [workspaceId]: Object.fromEntries(kept) };
  }), []);

  return <Context.Provider value={{ available, terminals, error, selected, select, create, refresh, columnsOf, place, placeFirst, unplace, created }}>
    {children}
    {creating && <TerminalCreation project={creating.project} initialKind={creating.kind} initialError={creating.error ?? ''} onCancel={() => setCreating(null)} onCreated={record => { opened(record); setCreating(null); }} />}
  </Context.Provider>;
}

const KINDS: readonly TerminalPreset['kind'][] = ['blank', 'claude', 'codex', 'custom'];

/** 创建卡：选择预设与目录；Claude Code、Codex 可追加参数，自定义命令写成一行。 */
function TerminalCreation({ project, initialKind, initialError, onCancel, onCreated }: {
  project: Project; initialKind: TerminalPreset['kind']; initialError: string; onCancel(): void; onCreated(record: ProjectTerminal): void;
}) {
  const { preferences } = usePreferences();
  const saved = preferences?.terminalCommandPresets ?? [];
  const [kind, setKind] = useState<TerminalPreset['kind']>(initialKind);
  const [directory, setDirectory] = useState(project.directories[0]!.path);
  const [command, setCommand] = useState('');
  const [savePreset, setSavePreset] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(initialError);

  async function submit() {
    setBusy(true); setError('');
    try {
      const args = splitCommandLine(command);
      let preset: TerminalPreset;
      if (kind === 'blank') preset = { kind };
      else if (kind === 'custom') {
        const [executable, ...argv] = args;
        if (!executable) throw new Error('请填写要运行的命令。');
        preset = { kind, executable, argv };
      } else preset = { kind, argv: args };
      if (savePreset && preset.kind === 'custom' && !saved.some(item => joinCommandLine([item.command.executable, ...item.command.argv]) === joinCommandLine([preset.executable, ...preset.argv]))) {
        await updatePreferences({ terminalCommandPresets: [...saved, { presetId: crypto.randomUUID(), title: joinCommandLine([preset.executable, ...preset.argv]).slice(0, 80), command: preset }] });
      }
      onCreated(await createTerminal({ projectId: project.projectId, directory, preset, size: { cols: 80, rows: 24 } }));
    } catch (cause) { setError(cause instanceof Error ? cause.message : '终端启动失败。'); setBusy(false); }
  }

  return <ConfirmCard
    title="新建终端"
    description={`在「${project.name}」的项目目录中启动。终端是外部程序，Multivac 不管控它的文件访问与命令执行。`}
    icon={SquareTerminal}
    confirmLabel="启动"
    confirmDisabled={kind === 'custom' && !command.trim()}
    busy={busy}
    error={error}
    onConfirm={() => void submit()}
    onCancel={onCancel}
  >
    <div className="terminal-creation">
      <div className="terminal-kinds" role="radiogroup" aria-label="终端预设">
        {KINDS.map(item => <button type="button" role="radio" key={item} aria-checked={kind === item} onClick={() => { setKind(item); setCommand(''); }}>
          <TerminalBadge preset={item === 'blank' ? { kind: item } : item === 'custom' ? { kind: item, executable: 'sh', argv: [] } : { kind: item, argv: [] }} />
          <span>{PRESET_LABELS[item]}</span>
        </button>)}
      </div>
      <dl className="confirm-card-fields terminal-creation-fields">
        {project.directories.length > 1 && <div><dt>目录</dt><dd>
          <select aria-label="终端目录" title={directory} value={directory} onChange={event => setDirectory(event.target.value)}>
            {project.directories.map((dir, index) => <option key={dir.path} value={dir.path}>{index === 0 ? '主目录 · ' : ''}{dir.path}</option>)}
          </select>
        </dd></div>}
        {kind === 'custom' && <div><dt>命令</dt><dd>
          <input aria-label="终端命令" autoFocus value={command} spellCheck={false} autoCapitalize="off" autoCorrect="off" placeholder="例如 npm run dev" onChange={event => setCommand(event.target.value)} />
          {saved.length > 0 && <div className="terminal-saved" aria-label="已保存的命令">
            {saved.map(item => <button type="button" key={item.presetId} title={joinCommandLine([item.command.executable, ...item.command.argv])} onClick={() => setCommand(joinCommandLine([item.command.executable, ...item.command.argv]))}>{item.title}</button>)}
          </div>}
          <label className="terminal-save"><input type="checkbox" checked={savePreset} onChange={event => setSavePreset(event.target.checked)} />保存为常用命令</label>
        </dd></div>}
        {(kind === 'claude' || kind === 'codex') && <div><dt>参数</dt><dd>
          <input aria-label="终端参数" value={command} spellCheck={false} autoCapitalize="off" autoCorrect="off" placeholder={kind === 'codex' ? '可选，例如 resume' : '可选，例如 --model sonnet'} onChange={event => setCommand(event.target.value)} />
        </dd></div>}
        {project.directories.length === 1 && <div><dt>目录</dt><dd><code className="terminal-creation-path" title={directory}>{directory}</code></dd></div>}
      </dl>
    </div>
  </ConfirmCard>;
}
