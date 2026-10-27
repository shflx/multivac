import { TerminalResponseSchema, TerminalListResponseSchema, type CreateTerminal } from '@multivac/contracts';
import { fetchJson } from './assistant-api.js';
const post = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
export async function terminalAvailable(): Promise<boolean> {
  const response = await fetch('/api/terminals/capabilities', post({})); return response.ok;
}
export async function listTerminals(projectId: string) { return (await fetchJson('/api/terminals/list', post({ projectId, includeClosed: false }), TerminalListResponseSchema)).terminals; }
export async function createTerminal(input: CreateTerminal) { return (await fetchJson('/api/terminals', post(input), TerminalResponseSchema)).terminal; }
export async function terminalAction(id: string, action: 'get' | 'end' | 'close' | 'reopen' | 'read' | 'rename', body: unknown) {
  return (await fetchJson(`/api/terminals/${encodeURIComponent(id)}${action === 'rename' ? '' : `/${action}`}`, { ...post(body), method: action === 'rename' ? 'PATCH' : 'POST' }, TerminalResponseSchema)).terminal;
}
