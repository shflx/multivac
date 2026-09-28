import { Archive } from 'lucide-react';
import type { SessionArchivePreview } from '@multivac/contracts';
import type { ConfirmOptions } from '../../components/confirm-card.js';
import { previewSessionArchive } from '../../data/workspace-api.js';
import { archiveDirectoryDetails } from './temp-retention.js';

/**
 * 归档会话的确认卡内容，各处归档共用同一套文案。
 * 归档可以恢复，按普通操作确认（焦点在“归档”上，Enter 直接确认）。
 *
 * 工作目录的去留按归档前的核对写明（提示一次）：临时目录里有文件时列出文件与保留时长，
 * 为空时归档一并删除；preview 为 null（没能核对）时写出通用规则。
 */
export function archiveConfirmOptions(
  title: string,
  preview: SessionArchivePreview | null,
): Pick<ConfirmOptions, 'title' | 'description' | 'details' | 'icon' | 'confirmLabel'> {
  return {
    title: `归档「${title}」`,
    description: '归档后不再出现在工作区中。',
    details: [...archiveDirectoryDetails(preview), '可以在会话列表底部的“已归档”或管理的“会话”页恢复。'],
    icon: Archive,
    confirmLabel: '归档',
  };
}

/**
 * 先核对会话的工作目录（临时目录里是否有文件、当前保留时长），再打开归档确认卡。
 * 核对失败不妨碍归档：卡上改写通用规则。
 */
export async function confirmArchive(
  confirm: (options: ConfirmOptions) => Promise<boolean>,
  input: { sessionId: string; title: string } & Pick<ConfirmOptions, 'action' | 'fallbackFocus'>,
): Promise<boolean> {
  const preview = await previewSessionArchive(input.sessionId).catch(() => null);
  return confirm({
    ...archiveConfirmOptions(input.title, preview),
    ...(input.action ? { action: input.action } : {}),
    ...(input.fallbackFocus ? { fallbackFocus: input.fallbackFocus } : {}),
  });
}
