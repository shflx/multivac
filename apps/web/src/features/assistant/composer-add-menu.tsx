import { useEffect, useRef, useState } from 'react';
import { ImageIcon, Plug, Plus } from 'lucide-react';
import type { AssistantMcpQuote } from '@multivac/contracts';
import { McpResourcePicker } from '../mcp/mcp-resource-picker.js';
import { ImageInput } from './image-input.js';
import type { useImageDraft } from './image-draft.js';
import './composer-add-menu.css';
import '../mcp/mcp-session-tools.css';

type ImageDraft = ReturnType<typeof useImageDraft>;

interface McpResources { sessionId: string; disabled: boolean; onQuote: (quote: AssistantMcpQuote) => void }

/**
 * 输入区“+”：添加给模型看的材料。只有图片时保持一次点击直接选图；
 * 会话可以引用 MCP 资源时展开为菜单，资源选中后作为引用草稿加入。
 */
export function ComposerAddMenu({ draft, mcpResources }: { draft: ImageDraft; mcpResources?: McpResources }) {
  const [open, setOpen] = useState(false), [picking, setPicking] = useState(false);
  const input = useRef<HTMLInputElement>(null), root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [open]);
  if (!mcpResources) return <ImageInput draft={draft} />;

  return <div className="composer-add" ref={root}>
    <input ref={input} type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden aria-label="选择图片文件" onChange={event => { draft.add(Array.from(event.currentTarget.files ?? [])); event.currentTarget.value = ''; }} />
    <button type="button" className="icon-button composer-image-add" title="添加图片或引用资源" aria-label="添加图片或引用资源" aria-expanded={open} onClick={() => setOpen(value => !value)}><Plus aria-hidden="true" /></button>
    {open && <div className="composer-add-menu" role="menu" aria-label="添加材料" onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setOpen(false); } }}>
      <button type="button" role="menuitem" onClick={() => { setOpen(false); input.current?.click(); }}><ImageIcon aria-hidden="true" /><span><strong>添加图片</strong><small>PNG、JPEG、WebP、GIF</small></span></button>
      <button type="button" role="menuitem" disabled={mcpResources.disabled} onClick={() => { setOpen(false); setPicking(true); }}><Plug aria-hidden="true" /><span><strong>引用 MCP 资源</strong><small>从已连接的服务中选取一段内容</small></span></button>
    </div>}
    <McpResourcePicker sessionId={mcpResources.sessionId} open={picking} onClose={() => setPicking(false)} onQuote={mcpResources.onQuote} />
  </div>;
}
