/** 轨迹摘要所需的运行时段；结果状态不在这里表达，由输入区状态条负责。 */
export interface RunTraceTiming {
  running: boolean;
  startedAt?: string | null | undefined;
  endedAt?: string | null | undefined;
}

/**
 * 运行用时文案：不足 60 秒显示“用时 N 秒”，否则显示“用时 M 分 S 秒”。
 * 至少按 1 秒计；时间缺失或无法解析时返回 null，由调用方回退为中性文案。
 */
export function formatRunDuration(startedAt: string, endedAt: string): string | null {
  const elapsedMs = Date.parse(endedAt) - Date.parse(startedAt);
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return null;

  const totalSeconds = Math.max(1, Math.round(elapsedMs / 1000));
  if (totalSeconds < 60) return `用时 ${totalSeconds} 秒`;

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `用时 ${minutes} 分 ${seconds} 秒`;
}

/**
 * 轨迹摘要：运行中显示“思考中”，结束后显示用时。
 * 成功、失败、取消一视同仁；缺少结束时间（如异常中断的历史轨迹）显示“已结束”。
 */
export function runTraceSummary({ running, startedAt, endedAt }: RunTraceTiming): string {
  if (running) return '思考中';
  if (!startedAt || !endedAt) return '已结束';
  return formatRunDuration(startedAt, endedAt) ?? '已结束';
}

/** 运行中始终可展开以显示等待占位；结束后没有任何思考或工具条目时只保留摘要行。 */
export function runTraceExpandable({ running, entryCount }: { running: boolean; entryCount: number }): boolean {
  return running || entryCount > 0;
}
