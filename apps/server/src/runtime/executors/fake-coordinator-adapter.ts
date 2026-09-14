import {
  COORDINATOR_EVENT_FIXTURES,
  type CoordinatorActionAccepted,
  type CoordinatorAdapterEvent,
  type CoordinatorEventListener,
  type CoordinatorModelConfig,
  type CoordinatorModelState,
  type CoordinatorModelUpdate,
  type CoordinatorResult,
  type CoordinatorRunResult,
  type CoordinatorRuntimeConfig,
  type CoordinatorSessionBinding,
  type CoordinatorSessionReady,
  type CoordinatorThinkingLevel,
} from '@multivac/contracts';
import type {
  ContinueCoordinatorSessionInput,
  CoordinatorAdapter,
  CreateCoordinatorSessionInput,
} from './coordinator-adapter.js';
import { COORDINATOR_TOOL_ALLOWLIST } from './coordinator-tools.js';

type FakePromptScenario = keyof typeof COORDINATOR_EVENT_FIXTURES;

interface FakeSessionState {
  binding: CoordinatorSessionBinding;
  config: CoordinatorRuntimeConfig;
  model: CoordinatorModelConfig;
  sequence: number;
  listeners: Set<CoordinatorEventListener>;
}

export type FakeCoordinatorCall =
  | { method: 'createSession'; input: CreateCoordinatorSessionInput }
  | { method: 'continueSession'; input: ContinueCoordinatorSessionInput }
  | { method: 'prompt' | 'steer' | 'followUp'; assistantSessionId: string; text: string }
  | { method: 'abort' | 'disposeSession' | 'subscribe'; assistantSessionId: string }
  | { method: 'setModel'; assistantSessionId: string; model: CoordinatorModelConfig }
  | { method: 'setThinkingLevel'; assistantSessionId: string; level: CoordinatorThinkingLevel }
  | { method: 'dispose' };

export interface FakeCoordinatorAdapterOptions {
  promptScenario?: FakePromptScenario;
  now?: () => string;
  sessionPathRoot?: string;
}

function ok<T>(value: T): CoordinatorResult<T> {
  return { ok: true, value };
}

/** Fake 仅模拟公共端口，既不读取模型密钥，也不访问文件系统或网络。 */
export class FakeCoordinatorAdapter implements CoordinatorAdapter {
  readonly calls: FakeCoordinatorCall[] = [];

  private readonly sessions = new Map<string, FakeSessionState>();
  private readonly promptScenario: FakePromptScenario;
  private readonly now: () => string;
  private readonly sessionPathRoot: string;

  constructor(options: FakeCoordinatorAdapterOptions = {}) {
    this.promptScenario = options.promptScenario ?? 'success';
    this.now = options.now ?? (() => '2026-09-14T08:00:00.000Z');
    this.sessionPathRoot = options.sessionPathRoot ?? '/fake/pi-sessions';
  }

  async createSession(
    input: CreateCoordinatorSessionInput,
  ): Promise<CoordinatorResult<CoordinatorSessionReady>> {
    this.calls.push({ method: 'createSession', input });
    const piSessionId = `pi-fake-${input.assistantSessionId}`;
    const binding: CoordinatorSessionBinding = {
      assistantSessionId: input.assistantSessionId,
      piSessionId,
      piSessionPath: `${this.sessionPathRoot}/${encodeURIComponent(piSessionId)}.jsonl`,
      updatedAt: this.now(),
    };

    return this.storeSession(binding, input.config, input.initialEventSequence ?? 0);
  }

  async continueSession(
    input: ContinueCoordinatorSessionInput,
  ): Promise<CoordinatorResult<CoordinatorSessionReady>> {
    this.calls.push({ method: 'continueSession', input });
    return this.storeSession(input.binding, input.config, input.initialEventSequence ?? 0);
  }

  async prompt(
    assistantSessionId: string,
    text: string,
  ): Promise<CoordinatorResult<CoordinatorRunResult>> {
    this.calls.push({ method: 'prompt', assistantSessionId, text });
    const session = this.sessions.get(assistantSessionId);
    if (!session) {
      return this.sessionNotActive();
    }

    if (this.promptScenario === 'retryAndCompaction') {
      this.emitEvents(session, COORDINATOR_EVENT_FIXTURES.success.slice(0, 1));
      this.emitFixture(session, 'retryAndCompaction');
      this.emitEvents(session, COORDINATOR_EVENT_FIXTURES.success.slice(1));
    } else {
      this.emitFixture(session, this.promptScenario);
    }

    const finalEvent =
      this.promptScenario === 'retryAndCompaction'
        ? COORDINATOR_EVENT_FIXTURES.success.at(-1)
        : COORDINATOR_EVENT_FIXTURES[this.promptScenario].at(-1);
    const usage = finalEvent && 'usage' in finalEvent ? finalEvent.usage : undefined;
    const status =
      this.promptScenario === 'failure'
        ? 'failed'
        : this.promptScenario === 'cancelled'
          ? 'cancelled'
          : 'completed';

    return ok({ status, ...(usage === undefined ? {} : { usage }) });
  }

  async steer(
    assistantSessionId: string,
    text: string,
  ): Promise<CoordinatorResult<CoordinatorActionAccepted>> {
    this.calls.push({ method: 'steer', assistantSessionId, text });
    return this.acceptIfActive(assistantSessionId);
  }

  async followUp(
    assistantSessionId: string,
    text: string,
  ): Promise<CoordinatorResult<CoordinatorActionAccepted>> {
    this.calls.push({ method: 'followUp', assistantSessionId, text });
    return this.acceptIfActive(assistantSessionId);
  }

  async abort(assistantSessionId: string): Promise<CoordinatorResult<CoordinatorActionAccepted>> {
    this.calls.push({ method: 'abort', assistantSessionId });
    const session = this.sessions.get(assistantSessionId);
    if (!session) {
      return this.sessionNotActive();
    }

    this.emitFixture(session, 'cancelled');
    return ok({ accepted: true });
  }

  async setModel(
    assistantSessionId: string,
    model: CoordinatorModelConfig,
  ): Promise<CoordinatorResult<CoordinatorModelUpdate>> {
    this.calls.push({ method: 'setModel', assistantSessionId, model });
    const session = this.sessions.get(assistantSessionId);
    if (!session) {
      return this.sessionNotActive();
    }

    session.model = { ...model };
    return ok({ model: this.modelState(session), diagnostics: [] });
  }

  async setThinkingLevel(
    assistantSessionId: string,
    level: CoordinatorThinkingLevel,
  ): Promise<CoordinatorResult<CoordinatorModelUpdate>> {
    this.calls.push({ method: 'setThinkingLevel', assistantSessionId, level });
    const session = this.sessions.get(assistantSessionId);
    if (!session) {
      return this.sessionNotActive();
    }

    session.model = { ...session.model, thinkingLevel: level };
    return ok({ model: this.modelState(session), diagnostics: [] });
  }

  subscribe(
    assistantSessionId: string,
    listener: CoordinatorEventListener,
  ): CoordinatorResult<() => void> {
    this.calls.push({ method: 'subscribe', assistantSessionId });
    const session = this.sessions.get(assistantSessionId);
    if (!session) {
      return this.sessionNotActive();
    }

    session.listeners.add(listener);
    return ok(() => session.listeners.delete(listener));
  }

  disposeSession(assistantSessionId: string): void {
    this.calls.push({ method: 'disposeSession', assistantSessionId });
    this.sessions.delete(assistantSessionId);
  }

  dispose(): void {
    this.calls.push({ method: 'dispose' });
    this.sessions.clear();
  }

  private storeSession(
    binding: CoordinatorSessionBinding,
    config: CoordinatorRuntimeConfig,
    sequence: number,
  ): CoordinatorResult<CoordinatorSessionReady> {
    const session: FakeSessionState = {
      binding,
      config,
      model: { ...config.model },
      sequence,
      listeners: new Set(),
    };
    this.sessions.set(binding.assistantSessionId, session);

    return ok({
      binding,
      activeToolNames: [...COORDINATOR_TOOL_ALLOWLIST],
      model: this.modelState(session),
      diagnostics: [],
    });
  }

  private emitFixture(session: FakeSessionState, scenario: FakePromptScenario): void {
    this.emitEvents(session, COORDINATOR_EVENT_FIXTURES[scenario]);
  }

  private emitEvents(
    session: FakeSessionState,
    fixtures: readonly CoordinatorAdapterEvent[],
  ): void {
    for (const fixture of fixtures) {
      session.sequence += 1;
      const cursor = `${session.binding.piSessionId}:${session.sequence}`;
      const event = {
        ...fixture,
        eventId: cursor,
        cursor,
        sequence: session.sequence,
        assistantSessionId: session.binding.assistantSessionId,
        piSessionId: session.binding.piSessionId,
        occurredAt: this.now(),
      } as CoordinatorAdapterEvent;

      for (const listener of [...session.listeners]) {
        listener(event);
      }
    }
  }

  private acceptIfActive(
    assistantSessionId: string,
  ): CoordinatorResult<CoordinatorActionAccepted> {
    return this.sessions.has(assistantSessionId)
      ? ok({ accepted: true })
      : this.sessionNotActive();
  }

  private modelState(session: FakeSessionState): CoordinatorModelState {
    return {
      provider: session.model.provider,
      modelId: session.model.modelId,
      thinkingLevel: session.model.thinkingLevel,
    };
  }

  private sessionNotActive<T>(): CoordinatorResult<T> {
    return {
      ok: false,
      error: { code: 'SESSION_NOT_ACTIVE', message: '协调助手会话未激活。' },
    };
  }
}
