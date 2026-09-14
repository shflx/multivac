import { APP_NAME } from '@multivac/contracts';
import { createMultivacApplication } from './bootstrap/application.js';
import { resolveServerPort } from './environment.js';

const host = '127.0.0.1';
const port = resolveServerPort(process.env.MULTIVAC_PORT);

const application = createMultivacApplication();
const { server } = application;

let closing = false;
function close(): void {
  if (closing) return;
  closing = true;
  server.close(() => application.close());
}

process.once('SIGINT', close);
process.once('SIGTERM', close);

server.listen(port, host, () => {
  console.log(`${APP_NAME} server: http://${host}:${port}`);
});
