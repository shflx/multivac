/** 网页能力的服务商无关端口；调用方只接收规范化结果，不依赖供应商响应字段。 */
export interface WebSearchInput { query: string; count: number }
export interface WebSearchResult { title: string; url: string; summary: string; publishedAt: string | null }
export interface WebPage { title: string; url: string; content: string }
export interface WebRequestContext {
  signal: AbortSignal;
  maxBytes: number;
  /** 每个实际收到的数据块都计入任务预算，包括异常响应和超过上限的最后一个块。 */
  received(bytes: number): void;
}
export interface WebSearchProvider {
  search(input: WebSearchInput, context: WebRequestContext): Promise<WebSearchResult[]>;
}
export interface WebFetchProvider {
  fetch(url: string, context: WebRequestContext): Promise<WebPage>;
}
export interface WebProvider extends WebSearchProvider, WebFetchProvider { readonly id: string }

/** 只包含可公开的错误说明，不携带服务商响应、请求头或底层异常。 */
export class WebAccessError extends Error {}
