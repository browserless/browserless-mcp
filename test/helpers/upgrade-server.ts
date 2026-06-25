import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';

export interface UpgradeServerHandle {
  url: string;
  close: () => Promise<void>;
}

export interface RejectingServerHandle extends UpgradeServerHandle {
  hits: () => number;
}

// Write a non-101 HTTP response on a raw socket, mirroring the wire shape a
// production server emits when a WS upgrade is refused. Header order/values
// match what `writeResponse` in the backend produces: no Content-Length, a
// keep-alive header followed by an immediate .end(), so the body length is
// delimited by socket close.
const writeRejection = (
  socket: { write: (s: string) => unknown; end: () => unknown },
  status: number,
  body: string,
): void => {
  const statusLine = `HTTP/1.1 ${status} ${http.STATUS_CODES[status] ?? ''}`;
  const response = [
    statusLine,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Encoding: UTF-8',
    'Accept-Ranges: bytes',
    'Connection: keep-alive',
    '\r\n',
    body,
  ].join('\r\n');
  socket.write(response);
  socket.end();
};

/**
 * Spin up an HTTP server that rejects every /chromium/agent WS upgrade with
 * the given status and body. Returns the live URL plus an upgrade-hit counter
 * — tests use it to verify the retry-guard's "don't retry on 4xx" behavior.
 */
export const makeRejectingServer = async (
  status: number,
  body: string,
): Promise<RejectingServerHandle> => {
  let hits = 0;
  const server = http.createServer();
  server.on('upgrade', (_req, socket) => {
    hits += 1;
    // Suppress EPIPE when the client truncates the response (legitimate when
    // the body-size cap kicks in mid-write).
    socket.on('error', () => {});
    writeRejection(socket, status, body);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    hits: () => hits,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections?.();
        server.close(() => r());
      }),
  };
};

/**
 * Spin up an HTTP server that sends non-101 headers (with a Content-Length
 * that will never be reached) and then stalls — never writes the body, never
 * closes the socket. Used to verify the upgrade body-read timeout in
 * readUpgradeError.
 */
export const makeStallingServer = async (
  status: number,
): Promise<UpgradeServerHandle> => {
  const server = http.createServer();
  const openSockets: { destroy: () => void }[] = [];
  server.on('upgrade', (_req, socket) => {
    socket.on('error', () => {});
    openSockets.push(socket);
    const statusLine = `HTTP/1.1 ${status} ${http.STATUS_CODES[status] ?? ''}`;
    // Promise a body of 999 bytes we will never deliver.
    const headers = [
      statusLine,
      'Content-Type: text/plain; charset=utf-8',
      'Content-Length: 999',
      'Connection: keep-alive',
      '\r\n',
    ].join('\r\n');
    socket.write(headers);
    // Deliberately no body, no .end().
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((r) => {
        openSockets.forEach((s) => s.destroy());
        server.closeAllConnections?.();
        server.close(() => r());
      }),
  };
};

// for tests only
export const makeRespondingServer = async (
  responder: (method: string, params: unknown) => unknown,
): Promise<UpgradeServerHandle> => {
  const wss = new WebSocketServer({ noServer: true });
  const server = http.createServer();
  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => {});
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on('message', (data: Buffer) => {
        const msg = JSON.parse(data.toString('utf8')) as {
          id: string;
          method: string;
          params: unknown;
        };
        ws.send(
          JSON.stringify({
            id: msg.id,
            result: responder(msg.method, msg.params),
          }),
        );
      });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((r) => {
        wss.clients.forEach((c) => c.terminate());
        server.closeAllConnections?.();
        server.close(() => r());
      }),
  };
};

/**
 * Spin up an HTTP server that completes the WS upgrade successfully. Used by
 * tests that need a live session — the server holds connections open until
 * `close()` terminates them.
 */
export const makeAcceptingServer = async (): Promise<UpgradeServerHandle> => {
  const wss = new WebSocketServer({ noServer: true });
  const server = http.createServer();
  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => {});
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on('close', () => {});
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((r) => {
        wss.clients.forEach((c) => c.terminate());
        server.closeAllConnections?.();
        server.close(() => r());
      }),
  };
};
