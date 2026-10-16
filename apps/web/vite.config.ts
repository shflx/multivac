import { defineConfig, type ServerOptions } from 'vite';
import react from '@vitejs/plugin-react';
import { resolveRuntimeConfig, resolvePort } from '../server/src/runtime-config.ts';

function developmentServer(): ServerOptions {
  const e2ePort = process.env.MULTIVAC_E2E_API_PORT?.trim();
  if (e2ePort && process.env.MULTIVAC_PORT?.trim() && resolvePort(e2ePort) !== resolvePort(process.env.MULTIVAC_PORT)) {
    throw new Error('MULTIVAC_E2E_API_PORT 与 MULTIVAC_PORT 冲突。');
  }
  const runtime = resolveRuntimeConfig({ ...process.env,
    ...(e2ePort ? { MULTIVAC_PORT: e2ePort } : {}),
  }, 'development');
  return {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${runtime.port}`,
        // 保留浏览器访问的 Host，避免局域网 GET 经回环代理后被误判为本机免登录请求。
        changeOrigin: false,
        ws: true,
        configure(proxy) {
          // 服务端中途断开事件流时，将断开传给浏览器，让客户端能及时重连。
          proxy.on('proxyRes', (proxyRes, _request, response) => {
            proxyRes.once('close', () => {
              if (!proxyRes.complete) response.destroy();
            });
          });
        },
      },
    },
  };
}

// 构建静态页面不解析运行实例配置；生产构建环境无需改成开发模式。
export default defineConfig(({ command }) => ({
  plugins: [react()],
  ...(command === 'serve' ? { server: developmentServer() } : {}),
}));
