export function rememberedTerminalSelection(): { workspaceId: string; terminalId: string } | null {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem('multivac.selected-terminal') ?? 'null');
    if (value && typeof value === 'object' && 'workspaceId' in value && 'terminalId' in value && typeof value.workspaceId === 'string' && typeof value.terminalId === 'string') return { workspaceId: value.workspaceId, terminalId: value.terminalId };
  } catch { /* 本机存储损坏不影响打开工作区。 */ }
  return null;
}
