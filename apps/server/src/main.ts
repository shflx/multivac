import { createServer } from 'node:http';
import { APP_NAME } from '@multivac/contracts';

const host = '127.0.0.1';
const port = Number.parseInt(process.env.MULTIVAC_PORT ?? '4317', 10);

const server = createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
  response.end(`Hello World from ${APP_NAME} server.`);
});

server.listen(port, host, () => {
  console.log(`${APP_NAME} server: http://${host}:${port}`);
});
