import { rememberedTerminalSelection } from './terminal-selection.js';
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { Project, ProjectTerminal, TerminalPreset } from '@multivac/contracts';
import { ConfirmCard } from '../../components/confirm-card.js';
import { createTerminal, listTerminals, terminalAvailable } from '../../data/terminal-api.js';
import { updatePreferences } from '../../data/preferences-api.js';
import { usePreferences } from '../preferences/use-preferences.js';
import { useRemoteConversation } from '../assistant/remote-context.js';
import { useWorkbenchEvents } from '../workbench/workbench-sync-provider.js';
import { useWorkspaces } from '../workspace/workspace-sessions-provider.js';
interface TerminalContextValue {
  available: boolean; terminals: ProjectTerminal[]; error: string;
  selected: { workspaceId: string; terminalId: string } | null;
  select(value: { workspaceId: string; terminalId: string } | null): void;
  create(project: Project, kind?: TerminalPreset['kind']): void;
  refresh(): Promise<void>;
}
const Context = createContext<TerminalContextValue | null>(null);
export function useTerminals() { const value = useContext(Context); if (!value) throw new Error('终端需要 TerminalsProvider。'); return value; }
export function TerminalsProvider({ children }: { children: ReactNode }) {
  const remote = useRemoteConversation();
  const { workspaces } = useWorkspaces();
  const [available, setAvailable] = useState(false);
  const [terminals, setTerminals] = useState<ProjectTerminal[]>([]);
  const [error, setError] = useState('');
  const [selected, select] = useState<TerminalContextValue['selected']>(rememberedTerminalSelection);
  const [creating, setCreating] = useState<{ project: Project; kind: TerminalPreset['kind'] } | null>(null);
  useEffect(() => {
    if (remote || /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)) return;
    let live = true;
    void terminalAvailable().then(value => { if (live) setAvailable(value); }).catch(() => {});
    return () => { live = false; };
  }, [remote]);
  useEffect(() => { try { sessionStorage.setItem('multivac.selected-terminal', JSON.stringify(selected)); } catch { /* 不影响当前窗口。 */ } }, [selected]);
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
  return <Context.Provider value={{ available, terminals, error, selected, select, create: (project, kind = 'blank') => setCreating({ project, kind }), refresh }}>
    {children}
    {creating && <TerminalCreation project={creating.project} initialKind={creating.kind} onCancel={() => setCreating(null)} onCreated={record => {
      setTerminals(current => [...current.filter(item => item.terminalId !== record.terminalId), record]);
      select({ workspaceId: record.projectId, terminalId: record.terminalId }); setCreating(null);
    }} />}
  </Context.Provider>;
}
function TerminalCreation({ project, initialKind, onCancel, onCreated }: { project: Project; initialKind: TerminalPreset['kind']; onCancel(): void; onCreated(record: ProjectTerminal): void }) {
  const { preferences } = usePreferences();
  const [kind, setKind] = useState<TerminalPreset['kind']>(initialKind);
  const [directory, setDirectory] = useState(project.directories[0]!.path);
  const [executable, setExecutable] = useState('');
  const [argv, setArgv] = useState('[]');
  const [savePreset, setSavePreset] = useState(false);
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  async function submit() {
    setBusy(true); setError('');
    try {
      const parsed: unknown = JSON.parse(argv);
      if (!Array.isArray(parsed) || parsed.some(item => typeof item !== 'string')) throw new Error('参数必须是 JSON 字符串数组。');
      const preset: TerminalPreset = kind === 'blank' ? { kind } : kind === 'custom' ? { kind, executable, argv: parsed } : { kind, argv: parsed };
      if (savePreset && preset.kind === 'custom') await updatePreferences({ terminalCommandPresets: [...(preferences?.terminalCommandPresets ?? []), { presetId: crypto.randomUUID(), title: executable.slice(0, 80), command: preset }] });
      const record = await createTerminal({ projectId: project.projectId, directory, preset, size: { cols: 80, rows: 24 } });
      onCreated(record);
    } catch (error) { setError(error instanceof Error ? error.message : '终端启动失败。'); }
    finally { setBusy(false); }
  }
  return <ConfirmCard title={`在「${project.name}」新建终端`} confirmLabel="启动终端" busy={busy} error={error} onConfirm={() => void submit()} onCancel={onCancel}>
    <label>终端预设<select aria-label="终端预设" value={kind} onChange={event => { setKind(event.target.value as TerminalPreset['kind']); setArgv('[]'); }}>
      <option value="blank">空白 shell</option><option value="claude">Claude Code</option><option value="codex">Codex</option><option value="custom">自定义命令</option>
    </select></label>
    <label>项目目录<select aria-label="终端目录" value={directory} onChange={event => setDirectory(event.target.value)}>{project.directories.map((dir, index) => <option key={dir.path} value={dir.path}>{index === 0 ? '主目录 · ' : ''}{dir.path}</option>)}</select></label>
    {kind === 'custom' && <>
      {!!preferences?.terminalCommandPresets?.length && <label>已保存命令<select aria-label="已保存命令" defaultValue="" onChange={event => {
        const preset = preferences?.terminalCommandPresets?.find(item => item.presetId === event.target.value); if (preset) { setExecutable(preset.command.executable); setArgv(JSON.stringify(preset.command.argv)); }
      }}><option value="">选择命令…</option>{preferences.terminalCommandPresets!.map(preset => <option key={preset.presetId} value={preset.presetId}>{preset.title}</option>)}</select></label>}
      <label>程序<input aria-label="终端程序" value={executable} onChange={event => setExecutable(event.target.value)} placeholder="例如 npm" /></label>
      <label><input type="checkbox" checked={savePreset} onChange={event => setSavePreset(event.target.checked)} />保存为命令预设</label>
    </>}
    {kind !== 'blank' && <label>参数（JSON 字符串数组）<input aria-label="终端参数" value={argv} onChange={event => setArgv(event.target.value)} placeholder={'["run", "dev"]'} /></label>}
    <p>外部程序，Multivac 不管控。项目目录仅决定启动位置，不提供文件访问隔离；同目录并发修改可能冲突。</p>
  </ConfirmCard>;
}
