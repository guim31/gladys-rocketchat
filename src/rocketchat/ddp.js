// -----------------------------------------------------------------------------
// The real-time API of Rocket.Chat: Meteor's DDP over the WebSocket of the
// server (/websocket). Connect, log in with the personal access token
// (`login` with `resume`), then subscribe to `stream-room-messages` with
// `__my_messages__`: every message of every room the bot is in, pushed as a
// `changed` event. The server pings, we answer; we ping too, every 30 s: a
// connection that stops answering (a NAT that forgot it, a server gone) is
// closed and the caller reconnects.
//
// Node 22+ has a global WebSocket (undici): no dependency. Injected by the tests.
// -----------------------------------------------------------------------------

import { ERROR_KINDS, RocketChatError } from './client.js';

export const PING_INTERVAL_MS = 30_000;
export const OPEN_TIMEOUT_MS = 15_000;
const LOGIN_ID = 'login';
const SUBSCRIPTION_ID = 'messages';

/**
 * Opens the WebSocket, logs in and subscribes to the messages.
 * @param {object} options
 * @param {string} options.url ws:// or wss:// address
 * @param {string} options.token personal access token
 * @param {typeof WebSocket} [options.WebSocket]
 * @param {AbortSignal} [options.signal] closes the socket
 * @param {(message: object, meta: object) => void} options.onMessage a message, with
 *   `{ roomType, roomName }` (roomType: c public, p private, d direct)
 * @param {() => void} [options.onAlive] the server answered (a pong, an event)
 * @param {number} [options.pingIntervalMs]
 * @returns {Promise<{ closed: Promise<string>, close(): void }>} `closed` resolves
 *   with the reason once the connection is gone, whoever closed it
 */
export function openDdp({
  url,
  token,
  WebSocket: Impl = globalThis.WebSocket,
  signal,
  onMessage,
  onAlive = () => {},
  pingIntervalMs = PING_INTERVAL_MS,
  openTimeoutMs = OPEN_TIMEOUT_MS,
}) {
  return new Promise((resolve, reject) => {
    let socket;
    try {
      socket = new Impl(url);
    } catch (err) {
      reject(new RocketChatError(ERROR_KINDS.INVALID_URL, `Bad WebSocket address: ${err.message}`));
      return;
    }
    let opened = false;
    let pings = 0;
    let pending = null; // id of the ping waiting for its pong
    let timer = null;
    let openTimer = null;
    let finish;
    const closed = new Promise((done) => {
      finish = done;
    });

    const send = (frame) => socket.send(JSON.stringify(frame));

    let ended = false;
    function end(reason) {
      if (ended) {
        return;
      }
      ended = true;
      clearTimeout(openTimer);
      clearInterval(timer);
      signal?.removeEventListener('abort', onAbort);
      if (!opened) {
        reject(
          reason instanceof RocketChatError
            ? reason
            : new RocketChatError(ERROR_KINDS.UNREACHABLE, `WebSocket closed: ${reason}`),
        );
      }
      finish(String(reason?.message ?? reason));
    }

    const close = (reason) => {
      end(reason); // first: the reason of the integration wins over the close event
      try {
        socket.close();
      } catch {
        // already closing
      }
    };

    const onAbort = () => close('stopped');
    signal?.addEventListener('abort', onAbort);
    if (signal?.aborted) {
      onAbort();
      return;
    }

    openTimer = setTimeout(
      () =>
        close(new RocketChatError(ERROR_KINDS.TIMEOUT, `No DDP login within ${openTimeoutMs} ms`)),
      openTimeoutMs,
    );

    socket.addEventListener('open', () => {
      send({ msg: 'connect', version: '1', support: ['1'] });
    });

    socket.addEventListener('message', (message) => {
      let data;
      try {
        data = JSON.parse(typeof message.data === 'string' ? message.data : String(message.data));
      } catch {
        return;
      }
      switch (data?.msg) {
        case 'ping':
          send({ msg: 'pong', ...(data.id ? { id: data.id } : {}) });
          onAlive();
          return;
        case 'pong':
          if (data.id === pending) {
            pending = null;
          }
          onAlive();
          return;
        case 'connected':
          send({ msg: 'method', method: 'login', id: LOGIN_ID, params: [{ resume: token }] });
          return;
        case 'failed':
          close(new RocketChatError(ERROR_KINDS.SERVER, 'DDP version refused by the server'));
          return;
        case 'result':
          if (data.id !== LOGIN_ID || opened) {
            return;
          }
          if (data.error) {
            // A real Rocket.Chat answers 401 "User not found" to a refused token.
            const refused = [401, 403].includes(Number(data.error.error));
            close(
              new RocketChatError(
                refused ? ERROR_KINDS.TOKEN : ERROR_KINDS.SERVER,
                `DDP login refused (${data.error.error ?? 'error'})`,
              ),
            );
            return;
          }
          send({
            msg: 'sub',
            id: SUBSCRIPTION_ID,
            name: 'stream-room-messages',
            params: ['__my_messages__', false],
          });
          return;
        case 'nosub':
          if (data.id === SUBSCRIPTION_ID) {
            close(new RocketChatError(ERROR_KINDS.FORBIDDEN, 'Message subscription refused'));
          }
          return;
        case 'ready':
          if (!opened && data.subs?.includes(SUBSCRIPTION_ID)) {
            opened = true;
            clearTimeout(openTimer);
            timer = setInterval(() => {
              if (pending !== null) {
                close('no answer to the last ping');
                return;
              }
              pings += 1;
              pending = `ping-${pings}`;
              send({ msg: 'ping', id: pending });
            }, pingIntervalMs);
            timer.unref?.();
            onAlive();
            resolve({ closed, close: () => close('closed by the integration') });
          }
          return;
        case 'changed':
          if (data.collection === 'stream-room-messages' && Array.isArray(data.fields?.args)) {
            onAlive();
            const [msg, meta] = data.fields.args;
            try {
              onMessage(msg, meta ?? {});
            } catch {
              // the handler logs its own failures: one event never closes the socket
            }
          }
          return;
        default:
      }
    });

    socket.addEventListener('error', () => {
      // An `error` is always followed by a `close`: the reason is given there.
    });

    socket.addEventListener('close', (event) => {
      end(`code ${event?.code ?? 'unknown'}`);
    });
  });
}
