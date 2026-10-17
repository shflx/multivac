import type { ArtifactRepository } from './artifact.js';
import type { ExternalOperationRepository } from './external-operation.js';
import type { HumanRequestRepository } from './human-request.js';
import type { TaskRepository, TaskRunRepository, TaskRuntimeRepository } from './task.js';

/**
 * 任务业务的持久事实：任务、运行、人工请求、成果、外发操作与调度权。
 * 同一用例需要一起提交的写入，只能通过 transaction 回调收到的这组仓储完成。
 */
export interface TaskFacts {
  readonly tasks: TaskRepository;
  readonly runs: TaskRunRepository;
  readonly requests: HumanRequestRepository;
  readonly artifacts: ArtifactRepository;
  readonly runtime: TaskRuntimeRepository;
  readonly externalOperations: ExternalOperationRepository;
}

/**
 * 任务事实的事务入口。回调内的写入（含命令回执与任务事件）整体提交或回滚；
 * 回调必须同步且简短，不调用模型、文件、Git 或网络，外部操作在提交后按持久意图与结果对账处理。
 */
export interface TaskFactsStore extends TaskFacts {
  transaction<T>(operation: (facts: TaskFacts) => T): T;
}
