/** 仅收到后端监听成功的结构化消息后，才启动前端。 */
export function waitForServerReady(server) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      server.off('message', onMessage);
      server.off('exit', onExit);
      server.off('error', onError);
    };
    const onMessage = (message) => {
      if (message?.type !== 'multivac.ready') return;
      cleanup();
      resolve();
    };
    const onExit = (code, signal) => {
      cleanup();
      reject(new Error(`后端在就绪前退出（${signal ?? code}），未启动前端。`));
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    server.on('message', onMessage);
    server.once('exit', onExit);
    server.once('error', onError);
  });
}
