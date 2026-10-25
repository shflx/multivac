import {
  terminalIsActive, type Project, type ProjectTerminal, type TerminalClientMessage, type TerminalStatus,
} from '@multivac/contracts';

export interface TerminalRepository {
  get(terminalId: string): ProjectTerminal | undefined;
  list(projectId: string, includeClosed?: boolean): ProjectTerminal[];
  insert(record: ProjectTerminal): void;
  /** 按当前实例做比较更新；旧运行回调不得改写重新打开后的实例。 */
  replace(record: ProjectTerminal, expectedInstanceId: string): boolean;
  /** 服务启动只改元数据；不读取旧 PID，不恢复画面，不发送信号。 */
  endInterrupted(at: string): number;
}

export function selectTerminalDirectory(project: Project | undefined, directory?: string): string {
  if (!project) throw new Error('项目不存在或已移除。');
  const selected = directory ?? project.directories[0]?.path;
  if (!selected || !project.directories.some(entry => entry.path === selected)) {
    throw new Error('终端目录必须是该项目当前登记的目录。');
  }
  // 这里只核对登记归属；启动及重开还须检查目录真实存在，cwd 不提供文件访问隔离。
  return selected;
}

const TRANSITIONS: Record<TerminalStatus, readonly TerminalStatus[]> = {
  starting: ['running', 'stopping', 'stop-unconfirmed', 'failed', 'exited'],
  running: ['stopping', 'stop-unconfirmed', 'exited'],
  stopping: ['stop-unconfirmed', 'exited'],
  'stop-unconfirmed': ['stopping', 'exited'],
  exited: [], failed: [],
};
export function assertTerminalTransition(from: TerminalStatus, to: TerminalStatus): void {
  if (from !== to && !TRANSITIONS[from].includes(to)) throw new Error(`终端状态不能从 ${from} 变为 ${to}。`);
}

export function assertTerminalOperation(record: ProjectTerminal, instanceId: string, operation: 'end' | 'close' | 'reopen' | 'read', confirmRunning = false): void {
  if (record.instanceId !== instanceId) throw new Error('终端实例已变更，请重新读取。');
  if (operation === 'reopen') {
    if (terminalIsActive(record.status)) throw new Error('旧终端尚未证实结束，不能重新打开。');
    return;
  }
  if (record.closedAt !== null) throw new Error('终端已关闭，请重新打开。');
  if (operation === 'close' && terminalIsActive(record.status) && !confirmRunning) throw new Error('关闭运行中的终端需要用户确认。');
  if (operation === 'end' && !terminalIsActive(record.status)) throw new Error('终端已经结束。');
}

/** 运行期窗口状态不持久化。发送快照完成后从其绝对水位开始确认。 */
export interface TerminalConnectionState {
  instanceId: string;
  connectionId: string;
  acknowledged: number;
  sent: number;
  attached: boolean;
}
export function assertTerminalConnection(state: TerminalConnectionState, message: TerminalClientMessage): void {
  if (!state.attached || state.instanceId !== message.instanceId || state.connectionId !== message.connectionId) {
    throw new Error('终端连接或实例已失效。');
  }
  if (message.type === 'ack' && (!Number.isSafeInteger(message.watermark) || message.watermark < state.acknowledged || message.watermark > state.sent)) {
    throw new Error('终端确认水位倒退或超过已发送范围。');
  }
}
export function assertTerminalOwner(state: TerminalConnectionState, message: TerminalClientMessage, ownerConnectionId: string | null): void {
  assertTerminalConnection(state, message);
  if ((message.type === 'input' || message.type === 'resize') && state.connectionId !== ownerConnectionId) {
    throw new Error('该窗口只读，请先接管终端。');
  }
}
