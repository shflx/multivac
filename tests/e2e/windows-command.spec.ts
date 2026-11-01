import { expect, test } from '@playwright/test';
import { fakeApiRoot, resetE2eState } from './test-state.js';

test('Windows 工作会话通过真实命令工具执行 PowerShell', async ({ request }) => {
  test.skip(process.platform !== 'win32');
  await resetE2eState(request);
  const sessionId = 'windows-command-e2e';
  const commandId = 'windows-command-run';
  expect((await request.post(`${fakeApiRoot}/api/sessions`, { data: { sessionId, title: 'Windows 命令验收' } })).ok()).toBe(true);
  const turn = await request.post(`${fakeApiRoot}/api/sessions/${sessionId}/turns`, {
    data: { commandId, assistantSessionId: sessionId, text: `bash执行：${JSON.stringify({ command: "Write-Output 'windows-command-ok'" })}`, contextRefs: [] },
  });
  expect(turn.ok()).toBe(true);
  await expect.poll(async () => (await (await request.get(`${fakeApiRoot}/api/sessions/${sessionId}/commands/${commandId}`)).json()).status).toBe('terminal');
  const session = await (await request.get(`${fakeApiRoot}/api/sessions/${sessionId}/session`)).json() as { messages: { text: string }[] };
  expect(session.messages.at(-1)?.text).toContain('windows-command-ok');
});
