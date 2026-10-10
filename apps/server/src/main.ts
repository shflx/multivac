import { APP_NAME } from '@multivac/contracts';
import { createMultivacApplication } from './bootstrap/application.js';
import { resolveServerPort } from './environment.js';

const port = resolveServerPort(process.env.MULTIVAC_PORT);

const application = createMultivacApplication();
const { server } = application;
const remote = application.remoteAccess.settings();
const host = remote.enabled ? remote.host : '127.0.0.1';

await application.ready;

let closing = false;
function close(): void {
  if (closing) return;
  closing = true;
  server.close(() => {
    void Promise.resolve().then(() => application.close()).catch(error => {
      console.error('应用退出清理失败：', error); process.exitCode = 1;
    });
  });
  server.closeAllConnections();
}

process.once('SIGINT', close);
process.once('SIGTERM', close);

server.listen(port, host, () => {
  console.log(`${APP_NAME} server: http://${host}:${port}`);
  if (remote.enabled) console.log('远程对话入口已启用，需要访问 token 登录。');
  if (process.connected) process.send?.({ type: 'multivac.ready' });
});
