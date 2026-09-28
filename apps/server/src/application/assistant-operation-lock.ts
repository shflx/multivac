/**
 * 会话的操作互斥区：send handoff 与选模共享；锁不覆盖整个 prompt，由运行占用持续阻止选模。
 *
 * 改变会话执行环境的操作（归入项目换工作目录）以 runFinal 进入互斥区：成功后互斥区关闭，
 * 之后的操作（包括已经在排队的）一律拒绝，不会落到即将释放的旧运行时上。
 */
export class AssistantOperationLock {
  private tail: Promise<void> = Promise.resolve();
  private closedError: (() => Error) | null = null;

  run<T>(operation: () => Promise<T>): Promise<T> {
    const guarded = (): Promise<T> => this.closedError ? Promise.reject(this.closedError()) : operation();
    const result = this.tail.then(guarded, guarded);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  /** 在互斥区内执行最后一个操作：成功后关闭互斥区，之后的操作以 closedError 拒绝；失败时互斥区照常可用。 */
  runFinal<T>(operation: () => Promise<T>, closedError: () => Error): Promise<T> {
    return this.run(async () => {
      const result = await operation();
      this.closedError = closedError;
      return result;
    });
  }
}
