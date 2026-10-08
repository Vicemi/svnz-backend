import { createServer } from 'node:http';
import { buildApi } from './api.js';
import { config } from './config.js';
import { buildHttp } from './http.js';
import { log } from './log.js';
import { Rooms } from './rooms.js';
import { attachWebSocket } from './ws.js';

const rooms = new Rooms();
const app = buildHttp(buildApi(rooms));
const server = createServer(app);
const sockets = attachWebSocket(server, rooms);

server.listen(config.port, config.host, () => {
  log.info(`svnz-backend listening on http://${config.host}:${config.port} (ws path /ws)`);
  log.info(`allowed origins: ${config.allowedOrigins.join(', ')}`);
});

const stop = () => {
  log.info('shutting down');
  sockets.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
