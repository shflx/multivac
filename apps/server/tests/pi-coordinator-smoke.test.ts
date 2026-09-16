import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { CoordinatorThinkingLevel } from '@multivac/contracts';
import { COORDINATOR_THINKING_LEVELS } from '@multivac/contracts';
import { optionalEnvironmentValue } from '../src/environment.js';
import { PiCoordinatorAdapter } from '../src/runtime/executors/pi-coordinator-adapter.js';

const smokeEnabled = process.env.MULTIVAC_PI_SMOKE === '1';

test('Multivac 真实 Pi 运行时最小 smoke', { skip: !smokeEnabled }, async () => {
  const provider = optionalEnvironmentValue(process.env.MULTIVAC_PROVIDER);
  const modelId = optionalEnvironmentValue(process.env.MULTIVAC_MODEL);
  const configuredThinking = optionalEnvironmentValue(process.env.MULTIVAC_THINKING) ?? 'off';
  const modelsPath = optionalEnvironmentValue(process.env.MULTIVAC_MODELS_FILE);
  assert.ok(provider, 'MULTIVAC_PI_SMOKE=1 时必须设置 MULTIVAC_PROVIDER');
  assert.ok(modelId, 'MULTIVAC_PI_SMOKE=1 时必须设置 MULTIVAC_MODEL');
  assert.equal(
    COORDINATOR_THINKING_LEVELS.includes(configuredThinking as CoordinatorThinkingLevel),
    true,
    `不支持的 MULTIVAC_THINKING: ${configuredThinking}`,
  );

  const root = await mkdtemp(join(tmpdir(), 'multivac-pi-smoke-'));
  const adapter = new PiCoordinatorAdapter({
    cwd: root,
    agentDir: join(root, 'agent'),
    sessionDir: join(root, 'sessions'),
    ...(modelsPath ? { modelsPath } : {}),
  });

  try {
    const created = await adapter.createSession({
      assistantSessionId: 'smoke',
      config: {
        systemPrompt: 'You are a smoke-test assistant. Reply briefly.',
        authorizedContext: [],
        model: {
          provider,
          modelId,
          thinkingLevel: configuredThinking as CoordinatorThinkingLevel,
        },
        retry: { enabled: false, maxRetries: 0, baseDelayMs: 0 },
        compaction: { enabled: false, reserveTokens: 1_000, keepRecentTokens: 1_000 },
      },
    });
    assert.equal(created.ok, true, created.ok ? undefined : created.error.message);

    const events: string[] = [];
    const subscription = adapter.subscribe('smoke', (event) => events.push(event.type));
    assert.equal(subscription.ok, true);

    const run = await adapter.prompt('smoke', 'Reply with OK only.');
    assert.equal(run.ok, true, run.ok ? undefined : run.error.message);
    if (!run.ok) return;
    assert.equal(run.value.status, 'completed');
    assert.equal(events.includes('coordinator.run.started'), true);
    assert.equal(events.includes('coordinator.run.completed'), true);
  } finally {
    adapter.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
