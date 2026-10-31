import { listenerHttpUrl } from './adapters/http/loopback-peer.js';
import { APP_NAME } from '@multivac/contracts';
import { createMultivacApplication } from './bootstrap/application.js';
import { resolveMode, resolveRuntimeConfig, runtimeEnvironment } from './runtime-config.js';
import { remoteTokenPath } from './storage/remote-access-token.js';

const modeArgument = process.argv.find(argument => argument.startsWith('--mode='));
const config = resolveRuntimeConfig(process.env, modeArgument ? resolveMode(modeArgument.slice('--mode='.length)) : undefined);
const port = config.port;

const application = createMultivacApplication(runtimeEnvironment(config));
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
  const address = server.address();
  const url = address && typeof address !== 'string' ? listenerHttpUrl(address.address, address.port) : listenerHttpUrl(host, port);
  console.log(`${APP_NAME} ${config.mode} [${config.instanceId}] server: ${url}`);
  console.log(`数据目录：${config.dataDir}；工作根：${config.workRoot}`);
  if (remote.enabled) {
    console.log('远程对话入口已启用，需要访问 token 登录。');
    if (!process.env.MULTIVAC_REMOTE_TOKEN) {
      // 自动凭据按用户要求仅在启动终端展示，不进入 API、公共事件或诊断日志。
      console.log(`远程访问 token：${remote.token}`);
      console.log(`token 已保存至 ${remoteTokenPath(application.paths.dataDir)}，下次启动将复用。`);
    } else {
      console.log('访问 token 使用 MULTIVAC_REMOTE_TOKEN 中的手动配置值。');
    }
  } else {
    console.log('远程对话入口未启用；设置 MULTIVAC_REMOTE_ENABLED=1 后启动，自动 token 才会生成并显示。');
  }
  if (process.connected) process.send?.({ type: 'multivac.ready' });
});
