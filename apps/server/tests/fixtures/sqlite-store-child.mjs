import { SqliteAssistantStore } from '../../src/storage/sqlite-assistant-store.ts';

const databasePath = process.argv[2];
if (!databasePath) {
  throw new Error('缺少 SQLite 测试数据库路径。');
}

process.stdout.write('ready\n');
const store = new SqliteAssistantStore(databasePath);
store.close();
process.stdout.write('done\n');
