import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const apiPort = process.env.MULTIVAC_E2E_API_PORT ?? '4317';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      // ws：工作台变更事件经 WebSocket（`/api/workbench/events`）推送，升级请求同样转给本地服务。
      '/api': { target: `http://127.0.0.1:${apiPort}`, changeOrigin: true, ws: true },
    },
  },
});
