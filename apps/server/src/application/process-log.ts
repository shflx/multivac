import { open } from 'node:fs/promises';
import type { ProcessLog } from '@multivac/contracts';

/** 敏感行整体遮蔽，避免终端控制字符、凭据和私钥进入公开日志。 */
export function redactProcessLog(text: string): string {
  return text.replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/-----BEGIN[^\n]*PRIVATE KEY-----[\s\S]*?(?:-----END[^\n]*PRIVATE KEY-----|$)/g, '[私钥已隐藏]')
    .split('\n').map((line) => /(?:api[_-]?key|access[_-]?token|secret|password|authorization|bearer\s|sk-[A-Za-z0-9]|https?:\/\/[^\s/]+:[^\s/]+@)/i.test(line) || /^[A-Za-z0-9+/]{48,}={0,2}$/.test(line.trim()) ? '[敏感输出已隐藏]' : line).join('\n');
}

/** 只返回完整行，避免分块追加把凭据切成可见的半行；每次最多读 64 KiB。 */
export async function readProcessLog(path: string, after = 0): Promise<ProcessLog> {
  let file;
  try {
    file = await open(path, 'r');
    const stat = await file.stat();
    const start = Math.max(0, stat.size - 65536);
    const buffer = Buffer.alloc(Math.min(stat.size, 65536));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
    const data = buffer.subarray(0, bytesRead);
    const last = data.lastIndexOf(10);
    const first = start ? data.indexOf(10) + 1 : 0;
    const cursor = last < 0 ? start : start + last + 1;
    const text = last < first ? '' : redactProcessLog(data.subarray(first, last + 1).toString('utf8'));
    return { text: after === cursor ? '' : text, cursor, truncated: start > 0, unchanged: after === cursor, available: true };
  } catch { return { text: '', cursor: after, truncated: false, unchanged: false, available: false }; }
  finally { await file?.close(); }
}
