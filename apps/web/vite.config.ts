import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolveRuntimeConfig, resolvePort } from '../server/src/runtime-config.ts';

const e2ePort = process.env.MULTIVAC_E2E_API_PORT?.trim();
if (e2ePort && process.env.MULTIVAC_PORT?.trim() && resolvePort(e2ePort) !== resolvePort(process.env.MULTIVAC_PORT)) {
  throw new Error('MULTIVAC_E2E_API_PORT 与 MULTIVAC_PORT 冲突。');
}
const runtime = resolveRuntimeConfig({ ...process.env,
  ...(e2ePort ? { MULTIVAC_PORT: e2ePort } : {}),
}, 'development');
const apiPort = runtime.port;

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${apiPort}`,
        // 保留浏览器访问的 Host，避免局域网 GET 经回环代理后被误判为本机免登录请求。
        changeOrigin: false,
        ws: true,
        configure(proxy) {
          // 服务端中途断开响应（全局事件流积压超限、测试模拟断线）时，把断开传给浏览器：代理默认保持浏览器一侧的连接，
          // 事件流会停在原地，既收不到事件也不会重连。
          proxy.on('proxyRes', (proxyRes, _request, response) => {
            proxyRes.once('close', () => {
              if (!proxyRes.complete) response.destroy();
            });
          });
        },
      },
    },
  },
});
