// -----------------------------------------------------------------------------
// A small client of the Rocket.Chat REST API v1 (/api/v1), the handful of
// endpoints a bot needs: who am I, a user by username, rooms, joining a public
// channel, direct rooms, messages, the messages of a room since a date, and
// image upload. Built on fetch, injected by the tests.
//
// Authentication: the X-User-Id and X-Auth-Token headers of a personal access
// token. Every failure is a RocketChatError with a `kind` (below), so the
// callers and the texts never parse a server message. The token never appears
// in an error message nor in a log line.
// -----------------------------------------------------------------------------

export const ERROR_KINDS = {
  NOT_CONFIGURED: 'not_configured',
  INVALID_URL: 'invalid_url',
  NO_TOKEN: 'no_token',
  UNREACHABLE: 'unreachable',
  TIMEOUT: 'timeout',
  NOT_ROCKETCHAT: 'not_rocketchat',
  TOKEN: 'token',
  FORBIDDEN: 'forbidden',
  NOT_FOUND: 'not_found',
  TOO_LONG: 'too_long',
  REJECTED: 'rejected',
  RATE_LIMITED: 'rate_limited',
  SERVER: 'server',
};

// Failures that say nothing about the configuration: the network or the server
// will come back, the connection loop retries.
export const TRANSIENT_KINDS = new Set([
  ERROR_KINDS.UNREACHABLE,
  ERROR_KINDS.TIMEOUT,
  ERROR_KINDS.RATE_LIMITED,
  ERROR_KINDS.SERVER,
]);

export class RocketChatError extends Error {
  /**
   * @param {string} kind one of ERROR_KINDS
   * @param {string} message English, without secret
   * @param {object} [details]
   * @param {number} [details.status] HTTP status
   * @param {string} [details.code] Rocket.Chat error code (error-room-not-found...)
   * @param {number} [details.retryAfterMs] wait asked by a 429
   */
  constructor(kind, message, { status, code, retryAfterMs, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'RocketChatError';
    this.kind = kind;
    this.status = status;
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

const API_PATH = '/api/v1';
export const REQUEST_TIMEOUT_MS = 15_000;
// The longest wait a 429 is honored with inside one call; beyond, the caller decides.
const MAX_INLINE_RETRY_MS = 10_000;
// The default Message_MaxAllowedSize of a Rocket.Chat server (characters).
export const MAX_POST_LENGTH = 5000;

// Rocket.Chat answers most refusals with HTTP 400 and a code in `errorType`
// or `error`: these are the ones a bot meets (recorded on a real 8.9 server).
const CODE_KINDS = {
  'error-room-not-found': ERROR_KINDS.NOT_FOUND,
  'invalid-channel': ERROR_KINDS.NOT_FOUND,
  'error-invalid-room': ERROR_KINDS.NOT_FOUND,
  'error-invalid-user': ERROR_KINDS.NOT_FOUND,
  'User not found.': ERROR_KINDS.NOT_FOUND,
  'not-allowed': ERROR_KINDS.FORBIDDEN,
  'Not Allowed': ERROR_KINDS.FORBIDDEN,
  'error-not-allowed': ERROR_KINDS.FORBIDDEN,
  'error-action-not-allowed': ERROR_KINDS.FORBIDDEN,
  unauthorized: ERROR_KINDS.FORBIDDEN,
  'error-message-size-exceeded': ERROR_KINDS.TOO_LONG,
  'error-too-many-requests': ERROR_KINDS.RATE_LIMITED,
};

function kindOf(status, data) {
  switch (status) {
    case 401:
      return ERROR_KINDS.TOKEN;
    case 403:
      return ERROR_KINDS.FORBIDDEN;
    case 404:
      return ERROR_KINDS.NOT_FOUND;
    case 429:
      return ERROR_KINDS.RATE_LIMITED;
    default:
      if (status >= 500) {
        return ERROR_KINDS.SERVER;
      }
      for (const code of [data?.errorType, data?.error]) {
        if (typeof code === 'string' && CODE_KINDS[code]) {
          return CODE_KINDS[code];
        }
        // "... [error-not-allowed]": the code at the end of a sentence.
        const bracketed = typeof code === 'string' && code.match(/\[([\w-]+)\]$/)?.[1];
        if (bracketed && CODE_KINDS[bracketed]) {
          return CODE_KINDS[bracketed];
        }
      }
      return ERROR_KINDS.REJECTED;
  }
}

const sleep = (ms, signal) =>
  new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });

/**
 * The wait a 429 asks for: Retry-After (seconds), else X-RateLimit-Reset,
 * which Rocket.Chat gives as a date in milliseconds.
 */
function retryAfter(headers, now = Date.now()) {
  const seconds = Number(headers?.get?.('retry-after'));
  if (Number.isFinite(seconds) && seconds > 0) {
    return seconds * 1000;
  }
  const reset = Number(headers?.get?.('x-ratelimit-reset'));
  if (Number.isFinite(reset) && reset > 0) {
    return reset > 1e11 ? Math.max(reset - now, 0) : reset * 1000;
  }
  return undefined;
}

/** A date of Rocket.Chat in milliseconds: ISO text (REST) or { $date } (DDP). */
export function toMillis(value) {
  if (value && typeof value === 'object' && '$date' in value) {
    return Number(value.$date);
  }
  return typeof value === 'string' ? Date.parse(value) : Number(value);
}

export class RocketChatClient {
  /**
   * @param {object} options
   * @param {URL} options.server base address of the server
   * @param {string} options.userId id of the bot account
   * @param {string} options.token personal access token of the bot account
   * @param {typeof fetch} [options.fetch]
   */
  constructor({ server, userId, token, fetch: fetchImpl = globalThis.fetch }) {
    this.base = server;
    this.userId = userId;
    this.token = token;
    this.fetch = fetchImpl;
  }

  url(path, query) {
    const url = new URL(this.base.href.replace(/\/$/, '') + API_PATH + path);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== null) {
        url.searchParams.set(key, String(value));
      }
    }
    return url;
  }

  /** The WebSocket (DDP) address of the server: ws:// or wss://, same host and path. */
  websocketUrl() {
    const url = new URL(`${this.base.href.replace(/\/$/, '')}/websocket`);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    return url.href;
  }

  /**
   * One request. Resolves with the JSON body of a 2xx answer.
   * @param {string} method
   * @param {string} path below /api/v1
   * @param {object} [options]
   */
  async request(method, path, { body, query, timeoutMs = REQUEST_TIMEOUT_MS, signal, form } = {}) {
    if (!this.token || !this.userId) {
      throw new RocketChatError(ERROR_KINDS.NO_TOKEN, 'No access token');
    }
    const headers = { 'x-user-id': this.userId, 'x-auth-token': this.token };
    let payload = form;
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    for (let attempt = 0; ; attempt += 1) {
      let response;
      try {
        response = await this.fetch(this.url(path, query), {
          method,
          headers,
          body: payload,
          // A fresh timeout per attempt: the wait of a 429 does not eat the next one.
          signal: signal
            ? AbortSignal.any([AbortSignal.timeout(timeoutMs), signal])
            : AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        if (signal?.aborted) {
          throw err; // stopped by the caller: not a failure of the server
        }
        if (err?.name === 'TimeoutError') {
          throw new RocketChatError(ERROR_KINDS.TIMEOUT, `No answer within ${timeoutMs} ms`);
        }
        throw new RocketChatError(
          ERROR_KINDS.UNREACHABLE,
          `Server unreachable: ${err?.cause?.code ?? err?.message}`,
        );
      }
      let data;
      const text = await response.text().catch(() => '');
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        data = null;
      }
      if (response.ok) {
        if (data === null || typeof data !== 'object') {
          throw new RocketChatError(
            ERROR_KINDS.NOT_ROCKETCHAT,
            `Not a Rocket.Chat answer (HTTP ${response.status})`,
          );
        }
        return data;
      }
      if (data === null && [404, 405].includes(response.status)) {
        // A web server that is not Rocket.Chat: the address is wrong.
        throw new RocketChatError(
          ERROR_KINDS.NOT_ROCKETCHAT,
          `No Rocket.Chat API at this address (HTTP ${response.status})`,
          { status: response.status },
        );
      }
      const kind = kindOf(response.status, data);
      const retryAfterMs = retryAfter(response.headers);
      if (kind === ERROR_KINDS.RATE_LIMITED && attempt === 0) {
        const wait = retryAfterMs ?? 1000;
        if (wait <= MAX_INLINE_RETRY_MS) {
          await sleep(wait, signal);
          if (signal?.aborted) {
            throw signal.reason;
          }
          continue;
        }
      }
      // The server message never carries the token.
      const code = [data?.errorType, data?.error].find((value) => typeof value === 'string');
      throw new RocketChatError(
        kind,
        `${method} ${path}: HTTP ${response.status} ${(code ?? '').slice(0, 200)}`.trim(),
        { status: response.status, code, retryAfterMs },
      );
    }
  }

  /** The account behind the token: `{ _id, username, roles... }`. */
  me(options) {
    return this.request('GET', '/me', options);
  }

  /** A user by username (case-sensitive on the server). */
  async userByUsername(username, { signal } = {}) {
    const data = await this.request('GET', '/users.info', { query: { username }, signal });
    return data.user;
  }

  /** A room by id or by name: `{ _id, name, t }`, t being c (public), p (private) or d (direct). */
  async room({ id, name }, { signal } = {}) {
    const query = id ? { roomId: id } : { roomName: name };
    const data = await this.request('GET', '/rooms.info', { query, signal });
    return data.room;
  }

  /** True when the bot has a subscription to the room (it is a member). */
  async isMember(roomId, { signal } = {}) {
    const data = await this.request('GET', '/subscriptions.getOne', {
      query: { roomId },
      signal,
    });
    return Boolean(data.subscription);
  }

  /** The bot joins a public channel. */
  joinChannel(roomId, { signal } = {}) {
    return this.request('POST', '/channels.join', { body: { roomId }, signal });
  }

  /**
   * The direct room with a person, created the first time. Resolves with its id.
   * Beware: with an unknown username, the server opens a room of the bot with
   * itself. Check the person first (userByUsername).
   */
  async directRoom(username, { signal } = {}) {
    const data = await this.request('POST', '/im.create', { body: { username }, signal });
    return data.room?._id ?? data.room?.rid;
  }

  /** Writes a message (Markdown). Resolves with the created message. */
  async postMessage({ roomId, text }, { signal } = {}) {
    const data = await this.request('POST', '/chat.postMessage', {
      body: { roomId, text },
      signal,
    });
    return data.message ?? {};
  }

  /** The messages of a room created or changed since `since` (milliseconds), oldest first. */
  async messagesSince(roomId, since, { signal } = {}) {
    const data = await this.request('GET', '/chat.syncMessages', {
      query: { roomId, lastUpdate: new Date(since).toISOString() },
      signal,
    });
    const messages = Array.isArray(data?.result?.updated) ? data.result.updated : [];
    return messages.sort((a, b) => toMillis(a.ts) - toMillis(b.ts));
  }

  /** Uploads an image to a room, then posts it (rooms.media, then rooms.mediaConfirm). */
  async uploadImage(roomId, buffer, contentType, fileName) {
    const form = new FormData();
    form.append('file', new Blob([buffer], { type: contentType }), fileName);
    const room = encodeURIComponent(roomId);
    const data = await this.request('POST', `/rooms.media/${room}`, { form, timeoutMs: 30_000 });
    const fileId = data?.file?._id;
    if (typeof fileId !== 'string') {
      throw new RocketChatError(ERROR_KINDS.NOT_ROCKETCHAT, 'Upload answer without a file id');
    }
    return this.request('POST', `/rooms.mediaConfirm/${room}/${encodeURIComponent(fileId)}`, {
      body: { msg: '' },
    });
  }
}
