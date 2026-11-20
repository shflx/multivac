export interface TerminalSelection {
  terminalId: string;
  /** 终端已在并排栏中时，也可在本窗口单独查看。 */
  focused?: boolean;
}

export const TERMINAL_SELECTIONS_KEY = 'multivac.terminal-selections';

function parseSelection(value: unknown): TerminalSelection | null {
  if (!value || typeof value !== 'object' || !('terminalId' in value) || typeof value.terminalId !== 'string') return null;
  return { terminalId: value.terminalId, focused: 'focused' in value && value.focused === true };
}

export function rememberedTerminalSelections(): ReadonlyMap<string, TerminalSelection> {
  const selections = new Map<string, TerminalSelection>();
  try {
    const saved = sessionStorage.getItem(TERMINAL_SELECTIONS_KEY);
    if (saved === null) {
      const legacy: unknown = JSON.parse(sessionStorage.getItem('multivac.selected-terminal') ?? 'null');
      const selection = parseSelection(legacy);
      if (selection && legacy && typeof legacy === 'object' && 'workspaceId' in legacy && typeof legacy.workspaceId === 'string') {
        selections.set(legacy.workspaceId, selection);
      }
    } else {
      const value: unknown = JSON.parse(saved);
      if (value && typeof value === 'object') {
        for (const [workspaceId, raw] of Object.entries(value)) {
          const selection = parseSelection(raw);
          if (selection) selections.set(workspaceId, selection);
        }
      }
    }
  } catch { /* 本机存储损坏不影响打开工作区。 */ }
  return selections;
}
