export interface TerminalSelection {
  workspaceId: string;
  terminalId: string;
  /** 终端已在并排栏中时，也可在本窗口单独查看。 */
  focused?: boolean;
}

export function rememberedTerminalSelection(): TerminalSelection | null {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem('multivac.selected-terminal') ?? 'null');
    if (value && typeof value === 'object' && 'workspaceId' in value && 'terminalId' in value && typeof value.workspaceId === 'string' && typeof value.terminalId === 'string') {
      return { workspaceId: value.workspaceId, terminalId: value.terminalId, focused: 'focused' in value && value.focused === true };
    }
  } catch { /* 本机存储损坏不影响打开工作区。 */ }
  return null;
}
