import type { NoteDiscussionLifecycle, NoteDiscussionSources } from '../../src/modules/notes/note.js';

/** 测试用的讨论生命周期：默认没有运行中的讨论；用例可替换方法模拟会话层状态。 */
export function noteDiscussions(): NoteDiscussionLifecycle {
  return { check() {}, release() {} };
}

/** 测试用的讨论历史与模型来源：默认不可读，用例按需替换为固定结果。 */
export function noteSources(): NoteDiscussionSources {
  return {
    history: async () => { throw new Error('测试未提供讨论历史。'); },
    model: async () => { throw new Error('测试未提供讨论模型。'); },
  };
}
