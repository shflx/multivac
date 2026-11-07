export type ExecutionLeasePhase = 'starting' | 'check' | 'progress' | 'settled';
export interface ExecutionMeter { outputBytes: number; toolCalls: number; markers: Record<string, boolean> }

/** 只共用额度记账，不共用宿主停止或恢复策略；必须在各宿主自己的短事务中调用。 */
export function meterExecution(meter: ExecutionMeter, phase: ExecutionLeasePhase, marker: string, bytes: number): void {
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('执行输出字节数无效。');
  if (phase === 'starting' && !Object.hasOwn(meter.markers, marker)) {
    meter.markers[marker] = true;
    meter.toolCalls++;
  }
  meter.outputBytes += bytes;
}
