import { spawnProgram } from '../apps/server/src/runtime/program-launch.ts';

const mode = process.argv[2];
if (!['dev', 'start', 'pi-smoke'].includes(mode)) throw new Error('未知启动模式。');
const env = { ...process.env };
if (mode === 'pi-smoke') env.MULTIVAC_PI_SMOKE = '1';
else env.MULTIVAC_REMOTE_ENABLED = process.platform === 'win32' ? env.MULTIVAC_REMOTE_ENABLED ?? '0' : '1';
const command = mode === 'dev' ? process.execPath : 'npm';
const args = mode === 'dev' ? ['scripts/dev.mjs'] : mode === 'start' ? ['run', 'start', '-w', '@multivac/server']
  : ['exec', '-w', '@multivac/server', '--', 'tsx', '--test', 'tests/pi-coordinator-smoke.test.ts'];
const child = spawnProgram(command, args, { stdio: 'inherit', env });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.once('error', error => { console.error(error.message); process.exitCode = 1; });
child.once('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
