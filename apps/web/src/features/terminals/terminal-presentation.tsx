import { Command, SquareTerminal } from 'lucide-react';
import { terminalIsActive, type ProjectTerminal, type TerminalExit, type TerminalPreset } from '@multivac/contracts';
import { joinCommandLine } from './command-line.js';

export const PRESET_LABELS: Record<TerminalPreset['kind'], string> = {
  blank: '空白终端', claude: 'Claude Code', codex: 'Codex', custom: '自定义命令',
};

const EXIT_REASONS: Record<TerminalExit['reason'], string> = {
  'process-exit': '程序退出', 'user-ended': '用户结束', 'project-removed': '项目已移除', 'directory-removed': '目录已移除',
  'service-shutdown': '服务已退出', 'multivac-restarted': 'Multivac 重启', 'spawn-failed': '启动失败',
};

/** 终端标识：图标取自启动预设，不随前台程序变化。 */
export function TerminalBadge({ preset }: { preset: TerminalPreset }) {
  return (
    <span className={`terminal-badge ${preset.kind}`} aria-hidden="true">
      {preset.kind === 'claude' ? 'CC' : preset.kind === 'codex' ? 'Cx' : preset.kind === 'custom' ? <Command /> : <SquareTerminal />}
    </span>
  );
}

/** coding agent 终端（Claude Code、Codex）名称后的小标识；其他终端不显示。 */
export function AgentMark({ preset }: { preset: TerminalPreset }) {
  if (preset.kind !== 'claude' && preset.kind !== 'codex') return null;
  return <span className={`agent-mark ${preset.kind}`} title={PRESET_LABELS[preset.kind]} aria-label={PRESET_LABELS[preset.kind]}>{preset.kind === 'claude' ? 'CC' : 'Cx'}</span>;
}

/** 启动命令的可读形式。 */
export function presetCommand(preset: TerminalPreset): string {
  if (preset.kind === 'blank') return '登录 shell';
  if (preset.kind === 'custom') return joinCommandLine([preset.executable, ...preset.argv]);
  return joinCommandLine([preset.kind, ...preset.argv]);
}

/** 结束原因与退出状态：信号结束不显示为成功。 */
export function exitText(exit: TerminalExit): string {
  const status = exit.signal !== null ? `信号 ${exit.signal}` : exit.code !== null ? `退出码 ${exit.code}` : '';
  return [EXIT_REASONS[exit.reason], status].filter(Boolean).join(' · ');
}

/** 侧栏行尾的简短状态；运行中且无提醒时不显示文字。 */
export function railStatus(terminal: ProjectTerminal): string {
  if (terminal.status === 'stop-unconfirmed') return '未确认';
  if (terminal.status === 'stopping') return '结束中';
  if (terminalIsActive(terminal.status)) return '';
  const exit = terminal.lastExit;
  if (!exit) return '已结束';
  if (exit.signal !== null) return `信号 ${exit.signal}`;
  return exit.reason === 'process-exit' && exit.code !== null ? `已退出 ${exit.code}` : '已结束';
}

/** 标题下的状态说明。 */
export function statusText(terminal: ProjectTerminal): string {
  if (terminal.closedAt) return '已关闭';
  if (terminal.status === 'stop-unconfirmed') return '结束未确认';
  if (terminal.status === 'stopping') return '正在结束';
  if (terminal.status === 'starting') return '正在启动';
  if (terminalIsActive(terminal.status)) return '运行中';
  return terminal.lastExit ? exitText(terminal.lastExit) : '已结束';
}

/** 目录的末级名称，完整路径放在提示里。 */
export function directoryName(path: string): string {
  return path.replace(/\/+$/u, '').split('/').at(-1) || path;
}
