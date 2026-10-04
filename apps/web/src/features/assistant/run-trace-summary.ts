/** 轨迹摘要所需的运行时段；结果状态不在这里表达，由输入区状态条负责。 */
export interface RunTraceTiming {
  running: boolean;
  /** 运行中且有工具调用在等待用户授权：此时不是在思考或执行。 */
  awaitingAuthorization?: boolean;
  startedAt?: string | null | undefined;
  endedAt?: string | null | undefined;
}

/**
 * 运行用时文案：不足 60 秒显示“N 秒”，否则显示“M 分 S 秒”。
 * 至少按 1 秒计；时间缺失或无法解析时返回 null，由调用方回退为中性文案。
 */
export function formatRunDuration(startedAt: string, endedAt: string): string | null {
  const elapsedMs = Date.parse(endedAt) - Date.parse(startedAt);
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return null;

  const totalSeconds = Math.max(1, Math.round(elapsedMs / 1000));
  if (totalSeconds < 60) return `${totalSeconds} 秒`;

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes} 分 ${seconds} 秒`;
}

/**
 * 轨迹摘要：运行中按本轮开始时间显示实时用时，等待授权时显示“等待授权”，结束后固定用时。
 * 成功、失败、取消一视同仁；缺少结束时间（如异常中断的历史轨迹）显示“已结束”。
 */
export function runTraceSummary({ running, awaitingAuthorization = false, startedAt, endedAt }: RunTraceTiming, now = Date.now()): string {
  if (running) {
    if (awaitingAuthorization) return '等待授权';
    const duration = startedAt && Number.isFinite(now) ? formatRunDuration(startedAt, new Date(now).toISOString()) : null;
    return duration ? `思考中 · ${duration}` : '思考中';
  }
  if (!startedAt || !endedAt) return '已结束';
  const duration = formatRunDuration(startedAt, endedAt);
  return duration ? `用时 ${duration}` : '已结束';
}

/** 运行中始终可展开以显示等待占位；结束后没有任何思考或工具条目时只保留摘要行。 */
export function runTraceExpandable({ running, entryCount }: { running: boolean; entryCount: number }): boolean {
  return running || entryCount > 0;
}
