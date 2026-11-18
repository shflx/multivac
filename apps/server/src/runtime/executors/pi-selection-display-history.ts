import { closeSync, constants, fstatSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import type { CoordinatorModelState } from '@multivac/contracts';

const ANCHOR_BYTES = 1024;
const MAX_APPEND_BYTES = 256 * 1024;
interface Selection { value: CoordinatorModelState | null; leafId: string | null }
interface CachedSelection extends Selection {
  identity: string;
  version: string;
  displayVersion: string;
  size: number;
  head: Buffer;
  tail: Buffer;
}

function fingerprint(path: string, stat: BigIntStats) {
  return `${path}\0${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
}

/** 只供展示：普通消息沿上次已核对的 leaf 追加时，保留原模型版本。 */
export class PiSelectionDisplayHistory {
  private cached: CachedSelection | undefined;

  read(path: string, load: () => Selection | undefined): { value: CoordinatorModelState | null; version: string } | undefined {
    const previous = this.cached;
    this.cached = undefined;
    const real = realpathSync(path);
    const fd = openSync(real, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const stat = fstatSync(fd, { bigint: true });
      const size = Number(stat.size);
      if (!stat.isFile()) return undefined;
      const version = fingerprint(real, stat);
      if (previous?.version === version) {
        this.cached = previous;
        return { value: previous.value, version: previous.displayVersion };
      }
      const identity = `${real}\0${stat.dev}:${stat.ino}`;
      const read = (start: number, bytes: number) => {
        const buffer = Buffer.alloc(bytes);
        if (readSync(fd, buffer, 0, bytes, start) !== bytes) throw new Error('Pi session 在读取期间变化。');
        return buffer;
      };
      let selection: Selection | undefined;
      const growth = size - (previous?.size ?? 0);
      if (previous && identity === previous.identity && growth > 0 && growth <= MAX_APPEND_BYTES &&
        previous.tail.at(-1) === 10 && read(0, previous.head.length).equals(previous.head) &&
        read(previous.size - previous.tail.length, previous.tail.length).equals(previous.tail)) {
        let leafId = previous.leafId;
        const appended = read(previous.size, growth).toString('utf8');
        if (appended.endsWith('\n')) {
          try {
            for (const line of appended.slice(0, -1).split('\n')) {
              const item = JSON.parse(line);
              if (item?.type !== 'message' || typeof item.id !== 'string' || !item.id || item.id === leafId ||
                item.parentId !== leafId || typeof item.message?.role !== 'string') throw new Error('非普通消息追加。');
              leafId = item.id;
            }
            selection = { value: previous.value, leafId };
          } catch { /* 结构或分支变化时交回 Pi 完整核对。 */ }
        }
      }
      const displayVersion = selection ? previous!.displayVersion : version;
      selection ??= load();
      if (!selection) return undefined;
      const bytes = Math.min(size, ANCHOR_BYTES);
      const head = read(0, bytes), tail = read(size - bytes, bytes);
      if (version !== fingerprint(real, statSync(path, { bigint: true })) || realpathSync(path) !== real) return undefined;
      this.cached = { ...selection, version, displayVersion, size, identity, head, tail };
      return { value: selection.value, version: displayVersion };
    } finally { closeSync(fd); }
  }
}
