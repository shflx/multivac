import { Archive } from 'lucide-react';
import type { ConfirmOptions } from '../../components/confirm-card.js';

/**
 * 归档会话的确认卡内容，各处归档共用同一套文案。
 * 归档可以恢复，按普通操作确认（焦点在“归档”上，Enter 直接确认）。
 */
export function archiveConfirmOptions(title: string): Pick<ConfirmOptions, 'title' | 'description' | 'details' | 'icon' | 'confirmLabel'> {
  return {
    title: `归档「${title}」`,
    description: '归档后不再出现在工作区中。',
    details: ['对话历史与工作目录都会保留。', '可以在会话列表底部的“已归档”中恢复。'],
    icon: Archive,
    confirmLabel: '归档',
  };
}
