import { lstatSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { ProjectRepository } from '../modules/projects/project.js';
import type { SessionRegistryRepository } from '../modules/sessions/session-registry.js';
import { isPathWithin } from '../modules/sessions/working-directory.js';
import type { MultivacWorkPaths } from '../storage/work-paths.js';

/**
 * 能否移除一个会话临时目录（删除空目录或移到废纸篓）：
 * - allowed：可以移除；
 * - missing：目录已不存在，无需处理；
 * - later：此刻不能动（所属会话有运行时），之后再核对；
 * - refused：不能自动移除（位置不对、受保护或仍被其他会话使用），reason 说明原因。
 */
export type TempDirectoryRemoval =
  | { verdict: 'allowed' }
  | { verdict: 'missing' }
  | { verdict: 'later'; reason: string }
  | { verdict: 'refused'; reason: string };

export interface TempDirectoryRemovalOptions {
  registry: Pick<SessionRegistryRepository, 'listAll'>;
  /** 项目目录（托管与挂载）永不清理：与之重叠的临时目录一律不动。 */
  projects: Pick<ProjectRepository, 'list'>;
  paths: MultivacWorkPaths;
  /** 内部数据目录同样受保护。 */
  dataDir: string;
  /** 会话此刻是否有运行时：有时它可能正在被恢复或访问，不动它的目录。 */
  hasRuntime: (sessionId: string) => boolean;
}

/**
 * 移除会话临时目录前的统一判定：归档时删除空目录、归入项目后删除空的原目录、新建失败时回收，
 * 以及到期移到废纸篓，都经过这里，规则只有一份。
 *
 * 1. 位置：必须是（按字面路径与真实路径）直接位于 `<工作根>/sessions/` 下的真实目录，不是符号链接；
 * 2. 受保护的目录：与 Multivac 工作目录、托管项目根目录、任何项目目录（托管或挂载）、内部数据目录互不包含；
 * 3. 其他会话：除所属会话外，没有任何会话记录（含已归档的，它们恢复后还要用）的工作目录与它互相包含
 *    ——项目卸载目录后，已有的项目会话仍以原路径为工作目录，第 2 条就看不到它了；
 * 4. 运行时：所属会话此刻没有运行时（其他会话的运行时以记录中的工作目录为 cwd，已由第 3 条覆盖）。
 *
 * 路径按字面与真实路径各比一次，并且不区分大小写（与会话记录的查重一致）：宁可多保留，不误移。
 */
export class TempDirectoryRemovalPolicy {
  constructor(private readonly options: TempDirectoryRemovalOptions) {}

  /** owner 是目录所属的会话（归档的那个），它自己的记录不算“其他会话在用”；没有所属会话时传 null。 */
  check(path: string, owner: string | null): TempDirectoryRemoval {
    const { paths } = this.options;
    const target = resolve(path);
    if (dirname(target) !== resolve(paths.sessionsDir)) return refused('不在临时目录根下');
    let stat;
    try {
      stat = lstatSync(target);
    } catch {
      return { verdict: 'missing' };
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) return refused('不是目录');
    const realTarget = realpathSync.native(target);
    if (dirname(realTarget) !== realpathSync.native(paths.sessionsDir)) return refused('真实路径不在临时目录根下');

    const targetForms = [target, realTarget];
    const protectedPaths = [
      paths.multivacDir,
      paths.projectsDir,
      this.options.dataDir,
      ...this.options.projects.list().flatMap((project) => project.directories.map((directory) => directory.path)),
    ];
    if (protectedPaths.some((protectedPath) => overlaps(targetForms, protectedPath))) return refused('与受保护的目录重叠');

    // 同一项目的会话共用目录：按路径去重后再比较。
    const usedPaths = new Set(this.options.registry.listAll()
      .filter((record) => record.sessionId !== owner && record.workingDirectory)
      .map((record) => record.workingDirectory!.path));
    const used = [...usedPaths].find((usedPath) => overlaps(targetForms, usedPath));
    if (used) return refused(`仍被其他会话使用：${used}`);

    if (owner && this.options.hasRuntime(owner)) return { verdict: 'later', reason: '所属会话有运行时' };
    return { verdict: 'allowed' };
  }
}

function refused(reason: string): TempDirectoryRemoval {
  return { verdict: 'refused', reason };
}

/** 目标的各路径形式与另一路径（字面与真实路径）是否互相包含，不区分大小写。 */
function overlaps(targetForms: readonly string[], other: string): boolean {
  const literal = resolve(other);
  const otherForms = [literal];
  try {
    otherForms.push(realpathSync.native(literal));
  } catch {
    // 不存在的路径只按字面比较。
  }
  return targetForms.some((target) => otherForms.some((form) => {
    const [left, right] = [target.toLowerCase(), form.toLowerCase()];
    return isPathWithin(left, right) || isPathWithin(right, left);
  }));
}
