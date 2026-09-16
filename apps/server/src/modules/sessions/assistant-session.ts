import type { AssistantPageState, CoordinatorSessionBinding } from '@multivac/contracts';

export interface AssistantSessionBindingRepository {
  get(assistantSessionId: string): CoordinatorSessionBinding | undefined;
  insertIfAbsent(binding: CoordinatorSessionBinding): {
    binding: CoordinatorSessionBinding;
    inserted: boolean;
  };
}

export interface AssistantPageStateRepository {
  get(assistantSessionId: string): AssistantPageState;
  save(assistantSessionId: string, state: AssistantPageState): AssistantPageState;
}

export class AssistantPageStateRevisionConflictError extends Error {
  constructor(readonly current: AssistantPageState) {
    super('Multivac 页面状态 revision 已过期。');
    this.name = 'AssistantPageStateRevisionConflictError';
  }
}
