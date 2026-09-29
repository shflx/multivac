/**
 * 本窗口（浏览器标签页的这一次加载）的 id：写请求经 `x-multivac-window-id` 头携带，工作台事件流连接时登记。
 * 服务端据此在变更事件中注明发起窗口，本窗口据此识别自己直接发起的改动；Multivac 的导航只投给发出消息的窗口。
 *
 * 只保存在内存中：刷新即是新的窗口。没有放进 sessionStorage，因为“复制标签页”会连同 sessionStorage 一起复制，
 * 两个标签页会共用同一个 id，互相把对方的改动当成自己的而不应用。
 */
const WINDOW_ID = crypto.randomUUID();

export function windowId(): string {
  return WINDOW_ID;
}
