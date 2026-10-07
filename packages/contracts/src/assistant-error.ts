import { Type } from 'typebox';

export const ASSISTANT_ERROR_MESSAGE_MAX_LENGTH = 2048;
export const ASSISTANT_FAILURE_REASON_UNAVAILABLE = '原因未提供。';

export const AssistantExecutionErrorSchema = Type.Object({
  code: Type.String({ minLength: 1, maxLength: 128 }),
  message: Type.String({ minLength: 1, maxLength: ASSISTANT_ERROR_MESSAGE_MAX_LENGTH }),
}, { additionalProperties: false });
export type AssistantExecutionError = Type.Static<typeof AssistantExecutionErrorSchema>;

/** 只公开错误说明，不序列化异常对象、请求头、工具输出或堆栈；脱敏先于截断和落库。 */
export function assistantErrorMessage(value: unknown): string | undefined {
  const message = typeof value === 'string' ? value : value instanceof Error ? value.message : undefined;
  if (!message?.trim()) return undefined;
  const redacted = message
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/giu, '[已隐藏凭据]')
    .replace(/\b(?:authorization|proxy-authorization|cookie|set-cookie)\s*:[^\r\n]*/giu, '[已隐藏凭据]')
    .replace(/\b(?:Bearer|Basic)\s+[^\s,;"'<>]+/giu, '[已隐藏凭据]')
    .replace(/(["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|passwd|secret|client[_-]?secret)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}&]+)/giu, '$1[已隐藏凭据]')
    .replace(/\b(?:sk|rk|pk)[-_][A-Za-z0-9._-]+/giu, '[已隐藏凭据]')
    .replace(/\b(?:AIza[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|AKIA[A-Z0-9]{16})\b/gu, '[已隐藏凭据]')
    .replace(/((?:incorrect|invalid)\s+api\s*key(?:\s+provided)?\s*:\s*)[^\s,;]+/giu, '$1[已隐藏凭据]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, '[已隐藏凭据]')
    .replace(/https?:\/\/[^\s"'<>]+/giu, (address) => {
      try {
        const url = new URL(address);
        url.username = ''; url.password = ''; url.search = ''; url.hash = '';
        return url.toString();
      } catch { return '[地址已隐藏]'; }
    })
    .replace(/\r?\n\s*at\s[^\r\n]*/gu, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '')
    .trim();
  if (!redacted) return undefined;
  return redacted.length <= ASSISTANT_ERROR_MESSAGE_MAX_LENGTH
    ? redacted : `${redacted.slice(0, ASSISTANT_ERROR_MESSAGE_MAX_LENGTH - 1)}…`;
}

export function assistantExecutionError(code: string, value: unknown): AssistantExecutionError | undefined {
  const message = assistantErrorMessage(value);
  return message ? { code: /^[A-Z][A-Z0-9_]{0,127}$/u.test(code) ? code : 'RUNTIME_OPERATION_FAILED', message } : undefined;
}
