import type { AssistantContextRef } from '@multivac/contracts';

/**
 * Multivac 侧栏正在看的对象，用来理解“这个”：输入框上方提示“正在看{label}，可以直接说‘这个’”，
 * 发送时作为上下文引用交给服务端。引用只带 id，标题与内容由服务端核对后自行读取。
 */
export interface MultivacFocus {
  ref: AssistantContextRef;
  /** 提示里对这个对象的称呼，如「核对接口」。 */
  label: string;
}

/** 工作区的当前焦点会话：工作区里只有会话，提示里只写会话名。 */
export function workspaceSessionFocus(focus: { sessionId: string; title: string } | null): MultivacFocus | null {
  return focus && { ref: { kind: 'workspace-session', sessionId: focus.sessionId }, label: `「${focus.title}」` };
}
