import { ArrowLeft, Columns2, Layers3, Maximize2 } from 'lucide-react';
import type { SyntheticEvent } from 'react';
import type { AssistantQuote } from '@multivac/contracts';
import { AssistantView } from '../assistant/assistant-view.js';

interface ConversationPanelProps {
  sessionId: string;
  title: string;
  /** 工作区是否可见。 */
  visible: boolean;
  /** 是否为当前会话（焦点高亮，接住焦点）。 */
  current: boolean;
  /** 是否处于聚焦模式。 */
  focused: boolean;
  /** 并排时所在栏位（如“第 2 栏”），与会话列表中的栏位对应；聚焦时为空。 */
  slotLabel?: string;
  /** 并排时非当前会话的输入区收成一行入口。 */
  collapseComposer: boolean;
  onActivate: () => void;
  onFocusMode: () => void;
  onReturnToParallel: () => void;
  onManageModels: () => void;
  /** 把选中内容连同本会话交给 Multivac 侧栏。 */
  onHandToMultivac?: (quote: AssistantQuote) => void;
  /** 基于选中内容深入一层，新建子会话。 */
  onDrillDown?: (quote: AssistantQuote) => void;
  /** 栈式路径：从顶层会话到本会话的名称；顶层会话只有自身。 */
  stackPath?: readonly string[];
  /** 深入时在父会话中选中的内容；顶层会话没有。 */
  originText?: string | null;
  /** 返回父会话；顶层会话没有。 */
  onBackToParent?: () => void;
}

/**
 * 折叠输入区里的运行状态条（含停止按钮）操作的是该会话本身，不应顺带把会话切为当前：
 * 否则输入区会在按下时展开，停止按钮随之卸载，点击落空。
 */
function activates(event: SyntheticEvent): boolean {
  return !(event.target instanceof Element && event.target.closest('.assistant-composer.collapsed .run-status'));
}

/**
 * 工作区中的一个会话面板：标题栏加上该会话的完整对话呈现。
 * 消息、Markdown、运行轨迹、工具记录与输入区都复用 Multivac 首页的组件。
 */
export function ConversationPanel({
  sessionId, title, visible, current, focused, slotLabel = '', collapseComposer,
  onActivate, onFocusMode, onReturnToParallel, onManageModels, onHandToMultivac, onDrillDown,
  stackPath = [], originText = null, onBackToParent,
}: ConversationPanelProps) {
  return (
    <section
      className={['conversation-panel', current ? 'active' : '', focused ? 'focused' : ''].filter(Boolean).join(' ')}
      aria-label={title}
      data-session-id={sessionId}
      onPointerDownCapture={(event) => { if (activates(event)) onActivate(); }}
      onFocusCapture={(event) => { if (activates(event)) onActivate(); }}
    >
      <header className="conversation-header">
        <div className="conversation-title">
          {onBackToParent && (
            <button
              type="button"
              className="icon-button"
              aria-label="返回父会话"
              title="返回父会话"
              onClick={onBackToParent}
            >
              <ArrowLeft aria-hidden="true" />
            </button>
          )}
          <div>
            {stackPath.length > 1 && (
              <div className="conversation-path" title={stackPath.join(' / ')}>
                栈式路径 · {stackPath.join(' / ')}
              </div>
            )}
            <div className="conversation-name">
              {slotLabel && <span className="slot-tag">{slotLabel}</span>}
              <h2 title={title}>{title}</h2>
            </div>
          </div>
        </div>
        <div className="conversation-tools">
          {focused ? (
            <button type="button" className="return-parallel" onClick={onReturnToParallel}>
              <Columns2 aria-hidden="true" />
              返回并排
            </button>
          ) : (
            <button
              type="button"
              className="icon-button"
              aria-label={`放大「${title}」`}
              title="放大会话"
              onClick={onFocusMode}
            >
              <Maximize2 aria-hidden="true" />
            </button>
          )}
        </div>
      </header>
      {originText && (
        <div className="stack-source">
          <Layers3 aria-hidden="true" />
          <div>
            <span>来自父会话的选中内容</span>
            <p>{originText}</p>
          </div>
        </div>
      )}
      <AssistantView
        sessionId={sessionId}
        variant="panel"
        active={visible}
        focusOnActivate={visible && current}
        collapseComposer={collapseComposer}
        composerLabel={title}
        onManageModels={onManageModels}
        {...(onHandToMultivac ? { onHandToMultivac } : {})}
        {...(onDrillDown ? { onDrillDown } : {})}
      />
    </section>
  );
}
