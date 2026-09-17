/** send handoff 与选模共享；锁不覆盖整个 prompt，由运行占用持续阻止选模。 */
export class AssistantOperationLock {
  private tail: Promise<void> = Promise.resolve();
  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation, operation);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
}
