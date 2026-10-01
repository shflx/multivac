// 固定演示材料，与原型对话中的引用一一对应，不读取真实文件。
export const discussionContents = [
  { id: 'readme', name: 'README.md', type: 'Markdown', path: 'examples/multivac/README.md', text: `# Multivac

轻量 AI 工作台，把讨论、执行和成果连接起来。

## 查看原文

原文只在聚焦会话内展示。空间足够时左右并排；空间不足时在原文与讨论之间切换。

关闭原文仍留在聚焦会话；返回并排恢复之前的会话栏位与列宽。

查看文件不自动加入知识库，不创建新会话，也不把全文发送给模型。

## 引用与讨论

引用包含内容名称、来源路径、行号或章节以及选中文字。引用先进入输入区，由用户检查后发送。

深入一层承接父会话背景，返回时保留父会话草稿和原文位置。

## 阅读现场

每个会话复用一个浏览区。打开其他引用时保存上一处位置；返回上一处不会改变其他栏位。

阅读文件、位置、前进后退历史与目录展开状态，按工作区内的会话分别保存。

交给 Multivac 只携带选中的片段及来源。确认整理为文档后，原讨论与阅读位置保持不变。` },
  { id: 'source', name: 'discussion-view.ts', type: 'TypeScript', path: 'examples/multivac/workspace/discussion/auxiliary-content/discussion-view.ts', text: `type Reading = { path: string; line: number; scrollTop: number };
type Discussion = {
  draft: string;
  reading: Reading | null;
  history: Reading[];
};

// 替换阅读位置前，保存上一处；讨论草稿不受影响。
export function openReference(state: Discussion, next: Reading): Discussion {
  return {
    ...state,
    reading: next,
    history: state.reading ? [...state.history, state.reading] : state.history,
  };
}

// 引用只包含选中的片段，等待用户确认发送。
export function quoteSelection(path: string, line: number, text: string) {
  return { path, line, text, pending: true };
}

export function closeReading(state: Discussion): Discussion {
  return { ...state, reading: null };
}` },
  { id: 'design', name: 'discussion.html', type: 'HTML', path: 'examples/multivac/design/discussion.html', text: `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<style>
body{margin:0;padding:24px;font:14px/1.7 system-ui;color:#1b2023;background:#f6f8f9}
h1{font-size:22px}main{display:grid;grid-template-columns:1fr 1fr;gap:16px}
section{background:#fff;border:1px solid #d2d8dd;padding:16px;border-radius:6px}
h2{font-size:16px}footer{margin-top:20px;border-top:1px solid #d2d8dd;padding-top:16px}
@media(max-width:500px){main{grid-template-columns:1fr}}
</style></head><body>
<h1>Multivac · 讨论与原文</h1>
<main><section><h2>讨论</h2><p>打开原文会影响我的草稿吗？</p><p>不会。阅读视图只切换 reading，草稿由独立字段保存。</p></section>
<section><h2>原文</h2><p>替换阅读位置前，保存上一处；讨论草稿不受影响。</p><p>引用只包含选中的片段，等待用户确认发送。</p></section></main>
<footer>结论：原文辅助讨论，任务交给 Multivac，原现场保持不变。</footer>
</body></html>` },
  { id: 'notes', name: 'reading-notes.txt', type: '纯文本', path: 'examples/multivac/notes/reading-notes.txt', text: `Multivac 阅读现场记录

1. 查看文件或点击引用时，先聚焦发起会话。
2. 原文与会话属于同一聚焦现场，不占其他栏位。
3. 目录树只展示会话工作目录中的演示材料。
4. 关闭原文仍留在会话；返回并排恢复原来的栏位和列宽。
5. 引用只有选中的片段，发送前由用户检查。
6. 阅读历史和目录状态按工作区、会话分别保存。` },
];

export const discussionContent = (id) => discussionContents.find((item) => item.id === id);
export const onboardingConversation = { title: '了解项目', category: '探索会话', messages: [
  { who: '你', text: '带我了解 Multivac：怎样从讨论查看原文，再选中继续问？' },
  { who: '工作会话', text: 'README 的“查看原文”说明了边界：原文是临时辅助视图，不创建新会话。源码第 9–14 行展示切换阅读位置时如何保留草稿并保存历史。', contentRefs: [{ id: 'readme', section: '查看原文' }, { id: 'source', line: 9 }] },
  { who: '工作会话', text: 'quoteSelection 在第 18–20 行只携带选中文字，pending 表示等待你发送。设计片段把讨论与原文并排，底部的结论可以交给 Multivac 整理成文档。', contentRefs: [{ id: 'source', line: 18 }, { id: 'design' }, { id: 'readme', section: '阅读现场' }] },
  { who: '工作会话', text: '也可以从标题栏“查看文件”主动找资料。原文只在聚焦会话内展示：关闭原文留在当前讨论，返回平行视图则恢复原来的栏位与列宽。阅读记录中列出了两种操作的区别。', contentRefs: [{ id: 'notes' }] },
] };

/** 兼容上一版按会话保存的目录偏好；完整现场始终按工作区、会话隔离。 */
export function restoreReadingScenes(stored, legacy, workspaceOf) {
  const scenes = {};
  for (const [sessionId, preference] of Object.entries(legacy || {})) {
    if (!preference || typeof preference !== 'object') continue;
    const workspaceId = workspaceOf(sessionId);
    scenes[workspaceId] = { ...scenes[workspaceId], [sessionId]: { ...preference, hidden: true } };
  }
  for (const [workspaceId, sessions] of Object.entries(stored || {})) {
    if (!sessions || typeof sessions !== 'object' || Array.isArray(sessions)) continue;
    scenes[workspaceId] = { ...scenes[workspaceId] };
    for (const [sessionId, reading] of Object.entries(sessions)) {
      if (!reading || typeof reading !== 'object' || Array.isArray(reading)) continue;
      scenes[workspaceId][sessionId] = { ...reading,
        id: discussionContent(reading.id)?.id || null,
        recent: (Array.isArray(reading.recent) ? reading.recent : []).filter(discussionContent),
        history: (Array.isArray(reading.history) ? reading.history : []).filter((position) => discussionContent(position?.id)),
        future: (Array.isArray(reading.future) ? reading.future : []).filter((position) => discussionContent(position?.id)),
        expandedDirs: Array.isArray(reading.expandedDirs) ? reading.expandedDirs.filter((path) => typeof path === 'string') : [],
      };
    }
  }
  return scenes;
}

export function saveReading(scenes, workspaceId, sessionId, reading) {
  return { ...scenes, [workspaceId]: { ...scenes[workspaceId], [sessionId]: reading } };
}

export function nextReading(current, ref) {
  const history = current?.history || [];
  const recent = [ref.id, ...(current?.recent || []).filter((id) => id !== ref.id)];
  return { ...current, ...ref, line: ref.line || null, section: ref.section || null, scrollTop: 0, scrollLeft: 0, query: '', positioned: false, hidden: false, chooser: false,
    recent, history: current?.id ? [...history, readingPosition(current)] : history, future: [] };
}

// 导航栈只保存阅读位置，目录偏好和最近文件不会随前进后退回滚。
function readingPosition(reading) {
  const { id, line, section, scrollTop, scrollLeft, query } = reading;
  return { id, line, section, scrollTop, scrollLeft, query, positioned: true };
}

export function previousReading(current) {
  const history = current?.history || [];
  return history.length ? { ...current, ...history.at(-1), history: history.slice(0, -1), future: [readingPosition(current), ...(current.future || [])], chooser: false } : current;
}

export function forwardReading(current) {
  const future = current?.future || [];
  return future.length ? { ...current, ...future[0], history: [...(current.history || []), readingPosition(current)], future: future.slice(1), chooser: false } : current;
}

export function fileTree(files) {
  const root = { children: [] };
  for (const file of files) {
    let parent = root;
    const segments = file.path.split('/');
    segments.forEach((name, index) => {
      const path = segments.slice(0, index + 1).join('/');
      let node = parent.children.find((child) => child.path === path);
      if (!node) { node = { name, path, ...(index === segments.length - 1 ? { file } : { children: [] }) }; parent.children.push(node); }
      parent = node;
    });
  }
  return root.children;
}

export function contentReference(content, location, text) {
  return `${content.name} · ${content.path}${location ? `:${location}` : ''}\n${text}`;
}
