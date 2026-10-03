import type { HumanRequest, HumanRequestList, HumanRequestQuery } from '@multivac/contracts';
export interface HumanRequestRepository {
  get(id: string): HumanRequest | null;
  list(taskId?: string): HumanRequest[];
  page(query: HumanRequestQuery): HumanRequestList;
  save(request: HumanRequest): void;
}
