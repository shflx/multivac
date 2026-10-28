import { useEffect, useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import './message-copy.css';

/** 复制成功的提示停留时长。 */
const COPIED_MS = 1500;

/** 消息时间：今天只显示时刻，昨天加“昨天”，同年显示月日，跨年补年份。 */
function messageTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const now = new Date();
  const time = date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (date.toDateString() === now.toDateString()) return time;
  if (date.toDateString() === yesterday.toDateString()) return `昨天 ${time}`;
  const day = `${date.getMonth() + 1}月${date.getDate()}日`;
  return date.getFullYear() === now.getFullYear() ? `${day} ${time}` : `${date.getFullYear()}年${day} ${time}`;
}

/**
 * 消息下方的操作行：复制原文（助手回复为 Markdown 源文）与发送时间。
 * 时间位于复制按钮的外侧：左侧消息在右边，右侧消息在左边。
 */
export function MessageActions({ text, createdAt }: { text: string; createdAt: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const copy = async () => {
    window.clearTimeout(timer.current);
    try {
      await navigator.clipboard.writeText(text);
      setState('copied');
    } catch {
      setState('failed');
    }
    timer.current = window.setTimeout(() => setState('idle'), COPIED_MS);
  };

  const label = state === 'copied' ? '已复制' : state === 'failed' ? '复制失败' : '复制消息';
  return <div className="message-actions">
    <button type="button" aria-label="复制消息" title={label} data-state={state} onClick={() => void copy()}>
      {state === 'copied' ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
    </button>
    <time className="message-time" dateTime={createdAt} title={new Date(createdAt).toLocaleString('zh-CN')}>{messageTime(createdAt)}</time>
    <span className="message-actions-feedback" role="status" aria-live="polite">{state === 'idle' ? '' : label}</span>
  </div>;
}
