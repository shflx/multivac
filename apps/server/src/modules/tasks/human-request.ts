import type { HumanRequest } from '@multivac/contracts';
export interface HumanRequestRepository {
  get(id: string): HumanRequest | null;
  list(taskId?: string): HumanRequest[];
  save(request: HumanRequest): void;
}
