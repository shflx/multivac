import { parseSkillFrontmatter } from '../../src/runtime/executors/pi-skill-parser.js';
import { realpathSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteAssistantStore } from '../../src/storage/sqlite-assistant-store.js';
import { SkillService } from '../../src/application/skill-service.js';
import { SkillPackages } from '../../src/modules/skills/skill-package.js';
import { WorkbenchEvents } from '../../src/application/workbench-events.js';
export function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'skill-service-'))),
    source = join(root, 'sample');
  mkdirSync(source);
  const write = (body: string) =>
    writeFileSync(join(source, 'SKILL.md'), `---\nname: sample\ndescription: 示例\n---\n${body}`);
  write('first');
  const store = new SqliteAssistantStore(join(root, 'db')),
    events = new WorkbenchEvents(),
    changes: unknown[] = [];
  events.subscribe((e) => changes.push(e));
  const service = new SkillService(
    store.skills,
    new SkillPackages(join(root, 'packages'), parseSkillFrontmatter),
    events,
    (id) => {
      if (id !== 'project') throw Error('missing project');
    },
  );
  return {
    root,
    source,
    store,
    service,
    changes,
    write,
    close: () => {
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
