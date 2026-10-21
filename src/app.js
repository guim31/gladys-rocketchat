// -----------------------------------------------------------------------------
// The integration: a Rocket.Chat bot account wired to Gladys.
//
// - A connection loop: the REST API (who am I, the allowed people, the watched
//   channels), then the real-time API (DDP over the WebSocket), which pushes
//   every new message of the rooms the bot is in. After a cut, the messages of
//   the last minutes are read back by REST. Only the people of the "allowed"
//   list are ever answered or obeyed.
// - Watched channels (configuration): every message fires `message_received`,
//   a message starting with the command prefix also fires `command_received`.
// - A direct message from an allowed person is a conversation with Gladys
//   (manifest `type: "communication"`): a link code links the Rocket.Chat
//   account to a Gladys user, then the messages go to the brain
//   (publishMessage) and the answers come back through onSendMessage.
// - Any other room (a channel not watched, a direct message with several
//   people) is ignored: Gladys never answers where others can read.
// - Scene action `send_message`: a message in a channel, or to a person.
// - Triggers `connection_lost` / `connection_restored`, the connection status
//   of the Configuration screen, the widget and the `test_connection` action.
// -----------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { createLogger } from '@gladysassistant/integration-sdk';
import { normalizeConfig, parseChannel, parseServer, parseUsername } from './config.js';
import {
  ERROR_KINDS,
  MAX_POST_LENGTH,
  RocketChatClient,
  RocketChatError,
  TRANSIENT_KINDS,
  toMillis,
} from './rocketchat/client.js';
import { openDdp } from './rocketchat/ddp.js';
import { createFailureLog } from './log.js';
import { Store } from './store.js';
import {
  BOT_TEXT,
  PARTIAL_STATUS,
  REPORT_TEXT,
  each,
  errorText,
  errorTexts,
  pick,
} from './texts.js';
import { CONNECTION, TEST_ACTION, WIDGET_KEY, buildWidgetContent } from './widgets.js';

const logger = createLogger({ name: 'rocketchat' });

export const ACTION_KEY = 'test_connection';
export const SCENE_ACTION_KEY = 'send_message';
export const TRIGGERS = {
  MESSAGE: 'message_received',
  COMMAND: 'command_received',
  LOST: 'connection_lost',
  RESTORED: 'connection_restored',
};

// Messages older than this when the bot reads them (missed while Gladys or
// the container was down) are skipped: a "!open garage" from two hours ago
// must not run now.
export const MAX_MESSAGE_AGE_MS = 5 * 60 * 1000;
// The connection is declared lost after failures lasting this long, never on one blip.
export const LOST_AFTER_MS = 60 * 1000;
export const RETRY_DELAYS_MS = [2000, 5000, 10_000, 30_000, 60_000];
// A refused token: retry slowly, in case the server was the cause.
export const CREDENTIALS_RETRY_MS = 5 * 60 * 1000;
export const RECENT_KEPT = 5;
// Message ids already handled: the real-time API and the catch-up may both bring
// one, and an edit or a reaction pushes the same message again.
const SEEN_KEPT = 200;
const SEEN_SAVED = 200;
// Gladys waits 5 s for the ack of a message: answer before, even if the server is slow.
export const MESSAGE_TIMEOUT_MS = 4500;
// How long a message of Gladys waits for the first connection, within that deadline.
export const CONNECT_WAIT_MS = 2000;
// The "last seen alive" time is written to /data at most this often.
const ALIVE_SAVE_MS = 60 * 1000;
// Gladys link codes: 8 characters of an alphabet without 0/O/1/I/L.
const LINK_CODE = /^[A-HJ-KM-NP-Z2-9]{8}$/i;
const MAX_TEXT_LENGTH = 4096; // the limit of publishMessage
// Room types of Rocket.Chat: public channel, private group, direct message.
const WATCHABLE_TYPES = new Set(['c', 'p']);

const fingerprint = (...parts) =>
  createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 16);

/** Parses a command: "!lights off" → { command: "lights", args: "off" }. */
export function parseCommand(text, prefix) {
  if (!text.startsWith(prefix)) {
    return null;
  }
  const rest = text.slice(prefix.length);
  const match = rest.match(/^(\S+)(?:\s+([\s\S]*))?$/);
  if (!match) {
    return null;
  }
  return { command: match[1].toLowerCase(), args: (match[2] ?? '').trim() };
}

/** Parses an image of Gladys (a camera): "image/jpg;base64,..." (data: optional). */
export function parseImage(file) {
  if (typeof file !== 'string') {
    return null;
  }
  const match = file.match(/^(?:data:)?(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i);
  if (!match) {
    return null;
  }
  const buffer = Buffer.from(match[2], 'base64');
  if (buffer.length === 0) {
    return null;
  }
  // Gladys writes image/jpg: the registered type is image/jpeg.
  const contentType =
    match[1].toLowerCase() === 'image/jpg' ? 'image/jpeg' : match[1].toLowerCase();
  const extension = contentType.split('/')[1].replace('jpeg', 'jpg').replace(/\+.*$/, '');
  return { buffer, contentType, extension };
}

const clipPost = (text) =>
  text.length > MAX_POST_LENGTH ? `${text.slice(0, MAX_POST_LENGTH - 1)}…` : text;

/**
 * @param {import('@gladysassistant/integration-sdk').GladysIntegration} gladys
 * @param {object} [options] replaced by the tests
 * @param {typeof fetch} [options.fetch]
 * @param {typeof WebSocket} [options.WebSocket]
 * @param {{ load(): Promise<object>, save(data: object): Promise<void>, flush(): Promise<void> }} [options.store]
 * @param {() => number} [options.now] milliseconds
 * @param {(ms: number, signal: AbortSignal) => Promise<void>} [options.sleep]
 * @param {number} [options.pingIntervalMs]
 */
export function registerHandlers(gladys, options = {}) {
  const {
    fetch: fetchImpl = globalThis.fetch,
    WebSocket: WebSocketImpl = globalThis.WebSocket,
    store = new Store(),
    now = () => Date.now(),
    pingIntervalMs,
    sleep = (ms, signal) =>
      new Promise((resolve) => {
        const onAbort = () => {
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(() => {
          signal.removeEventListener('abort', onAbort);
          resolve();
        }, ms);
        signal.addEventListener('abort', onAbort, { once: true });
      }),
  } = options;

  let data = {}; // persisted: see save()
  const loaded = store.load().then((stored) => {
    data = stored ?? {};
    seen = new Set(Array.isArray(data.seen) ? data.seen : []);
  });

  let config = normalizeConfig({});
  let client = null;
  let me = null; // the bot account: { id, username }
  let configError = new RocketChatError(ERROR_KINDS.NOT_CONFIGURED, 'Not configured yet');
  let connection = CONNECTION.NOT_CONFIGURED;
  let lastError = null;
  let watched = new Map(); // room id → the entry typed in the configuration
  let allowed = new Map(); // user id → username, for the allowed people found
  let failures = []; // channels and people of the configuration not found or not joined
  let reportedFailures = ''; // the failures already logged: a reconnection does not repeat them
  let controller = null; // aborts the running loop
  let running = null; // the running loop
  let stopped = false;
  let lastStatus = null;
  let connectionKey = null; // server and token of the applied configuration
  let lostFired = false; // connection_lost was fired: connection_restored may follow
  let applying = Promise.resolve(); // configurations are applied one at a time
  let readyWaiters = []; // onSendMessage calls waiting for the first connection
  let lastAliveSave = 0;
  let seen = new Set(); // ids of the messages already handled, persisted (data.seen)
  const statusLog = createFailureLog(logger, { recovered: 'Connection status published again' });
  const socketLog = createFailureLog(logger, { recovered: 'Rocket.Chat connection works again' });
  const brainLog = createFailureLog(logger, { recovered: 'Messages reach Gladys again' });

  function save() {
    return store.save(data);
  }

  // --- Gladys side effects, never fatal --------------------------------------

  async function publishStatus(connected, message) {
    const key = JSON.stringify([connected, message ?? null]);
    if (key === lastStatus || !gladys.connected) {
      return;
    }
    try {
      await gladys.setConnectionStatus(connected, message);
      lastStatus = key;
      statusLog.ok();
    } catch (err) {
      statusLog.fail(`Cannot publish the connection status: ${err.message}`);
    }
  }

  async function fire(key, payload) {
    try {
      await gladys.publishSceneEvent(key, payload);
    } catch (err) {
      logger.warn(`Cannot fire the "${key}" trigger: ${err.message}`);
    }
  }

  function refreshWidget() {
    try {
      gladys.requestWidgetRefresh(WIDGET_KEY);
    } catch (err) {
      logger.debug(`Widget refresh not requested: ${err.message}`);
    }
  }

  function setConnection(next) {
    if (connection !== next) {
      connection = next;
      refreshWidget();
    }
  }

  // --- Connection ----------------------------------------------------------------

  /**
   * Resolves a channel of the configuration or of a scene to its room. A bare
   * value shaped like an id is tried as an id, then as a name.
   */
  async function resolveRoom(entry, signal) {
    const parsed = parseChannel(entry);
    if (!parsed) {
      throw new RocketChatError(ERROR_KINDS.NOT_FOUND, `Not a channel: ${entry}`);
    }
    let room;
    if (parsed.id) {
      try {
        room = await client.room({ id: parsed.id }, { signal });
      } catch (err) {
        if (err.kind !== ERROR_KINDS.NOT_FOUND && err.kind !== ERROR_KINDS.FORBIDDEN) {
          throw err;
        }
      }
    }
    room ??= await client.room({ name: parsed.name }, { signal });
    if (!room || !WATCHABLE_TYPES.has(room.t)) {
      throw new RocketChatError(ERROR_KINDS.NOT_FOUND, `Not a channel: ${entry}`);
    }
    return room;
  }

  /** Checks the token, then finds the allowed people and the watched channels. */
  async function connect(signal) {
    const account = fingerprint(client.base.href, config.user_id, config.access_token);
    if (data.account !== account) {
      // Another server or another account: nothing stored applies any more.
      data = { account, recent: data.recent ?? [] };
      seen = new Set();
      await save();
    }
    const user = await client.me({ signal });
    me = { id: user._id, username: user.username };
    const missing = [];
    const notes = [];

    const people = new Map();
    for (const name of config.allowed_users) {
      try {
        const found = await client.userByUsername(name, { signal });
        if (!found?._id || found._id === me.id || found.active === false) {
          throw new RocketChatError(ERROR_KINDS.NOT_FOUND, 'Inactive user');
        }
        people.set(found._id, found.username);
      } catch (err) {
        if (signal.aborted || TRANSIENT_KINDS.has(err.kind) || err.kind === ERROR_KINDS.TOKEN) {
          throw err;
        }
        missing.push(`@${name}`);
        notes.push(`Allowed person @${name} not found on the server`);
      }
    }
    allowed = people;

    const channels = new Map();
    for (const entry of config.channels) {
      try {
        const room = await resolveRoom(entry, signal);
        if (!(await client.isMember(room._id, { signal }))) {
          if (room.t !== 'c') {
            // A private channel shown to an administrator account: never heard.
            throw new RocketChatError(ERROR_KINDS.FORBIDDEN, 'The bot is not a member');
          }
          // The bot hears only the rooms it is in: it joins a public channel.
          await client.joinChannel(room._id, { signal });
          logger.info(`Joined the watched channel ${entry}`);
        }
        channels.set(room._id, entry);
      } catch (err) {
        if (signal.aborted || TRANSIENT_KINDS.has(err.kind) || err.kind === ERROR_KINDS.TOKEN) {
          throw err;
        }
        missing.push(entry);
        notes.push(`Cannot watch the channel ${entry}: ${err.message}`);
      }
    }
    watched = channels;
    failures = missing;
    // Said once: the same failures on every reconnection go to debug.
    const key = missing.join('|');
    notes.forEach((note) => (key === reportedFailures ? logger.debug(note) : logger.warn(note)));
    reportedFailures = key;
  }

  const partialStatus = () =>
    failures.length > 0 ? each(PARTIAL_STATUS, (text) => text(failures.join(', '))) : undefined;

  async function markConnected() {
    lastError = null;
    setConnection(CONNECTION.CONNECTED);
    readyWaiters.splice(0).forEach((wake) => wake());
    await publishStatus(true, partialStatus());
    if (lostFired) {
      lostFired = false;
      logger.info('Rocket.Chat connection restored');
      await fire(TRIGGERS.RESTORED, { user: me?.username ?? '' });
    }
  }

  /** Resolves once the bot is connected, or after `ms` at most. */
  function whenConnected(ms) {
    if (me && connection === CONNECTION.CONNECTED) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        readyWaiters = readyWaiters.filter((waiter) => waiter !== wake);
        resolve();
      }, ms);
      readyWaiters.push(wake);
    });
  }

  function alive() {
    const time = now();
    data.lastSeen = time;
    if (time - lastAliveSave >= ALIVE_SAVE_MS) {
      lastAliveSave = time;
      save();
    }
  }

  // --- The connection loop -------------------------------------------------------

  async function loop(signal) {
    let failingSince = null;
    let attempt = 0;
    if (connection !== CONNECTION.DISCONNECTED) {
      // A reconnection after a cut keeps "connected" until the loss is declared.
      setConnection(CONNECTION.CONNECTING);
    }
    while (!signal.aborted) {
      try {
        await connect(signal);
        const since = data.lastSeen;
        const socket = await openDdp({
          url: client.websocketUrl(),
          token: config.access_token,
          WebSocket: WebSocketImpl,
          signal,
          onMessage: (message, meta) => {
            handleMessage(message, meta.roomType).catch((err) =>
              logger.warn(`Message not handled: ${err.message}`),
            );
          },
          onAlive: alive,
          ...(pingIntervalMs ? { pingIntervalMs } : {}),
        });
        const openedAt = now();
        const before = { failingSince, attempt };
        failingSince = null;
        attempt = 0;
        socketLog.ok();
        if (connection !== CONNECTION.CONNECTED) {
          logger.info(`Connected to Rocket.Chat as @${me.username}`);
        } else {
          logger.debug(`Reconnected to Rocket.Chat as @${me.username}`);
        }
        await markConnected();
        // Read back what was posted while the socket was down (a cut, a restart).
        if (since) {
          await catchUp(since, signal);
        }
        const reason = await socket.closed;
        if (signal.aborted) {
          return;
        }
        if (now() - openedAt < LOST_AFTER_MS && before.failingSince !== null) {
          // A socket closed right after it opened: the failure goes on, never a busy loop.
          ({ failingSince, attempt } = before);
        }
        throw new RocketChatError(ERROR_KINDS.UNREACHABLE, `WebSocket closed (${reason})`);
      } catch (err) {
        if (signal.aborted) {
          return;
        }
        const error =
          err instanceof RocketChatError
            ? err
            : new RocketChatError(ERROR_KINDS.SERVER, err.message);
        const transient = TRANSIENT_KINDS.has(error.kind);
        lastError = error;
        let delay = RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)];
        attempt += 1;
        if (!transient) {
          // The configuration is wrong: say it, and retry slowly in case the server is the cause.
          delay = CREDENTIALS_RETRY_MS;
        } else if (error.kind === ERROR_KINDS.RATE_LIMITED && error.retryAfterMs > delay) {
          delay = error.retryAfterMs;
        }
        failingSince ??= now();
        socketLog.fail(`Rocket.Chat connection failed: ${error.message}`);
        if (!transient || now() - failingSince >= LOST_AFTER_MS) {
          if (connection !== CONNECTION.DISCONNECTED) {
            const wasConnected = connection === CONNECTION.CONNECTED;
            setConnection(CONNECTION.DISCONNECTED);
            logger.warn(`Rocket.Chat connection lost: ${error.message}`);
            if (wasConnected) {
              lostFired = true;
              await fire(TRIGGERS.LOST, { error: errorText(error, config.language) });
            }
          }
          await publishStatus(false, errorTexts(error));
        }
        await sleep(delay, signal);
      }
    }
  }

  /** Handles the messages of the watched channels and the direct rooms since `since`. */
  async function catchUp(since, signal) {
    // 30 s of overlap for a server clock behind ours; the ids already handled are skipped.
    const from = Math.max(
      Math.min(since, data.lastPostAt ?? since) - 30_000,
      now() - MAX_MESSAGE_AGE_MS,
    );
    const rooms = new Map([...watched.keys()].map((id) => [id, 'c']));
    for (const roomId of Object.values(data.contactChannels ?? {})) {
      rooms.set(roomId, 'd');
    }
    for (const [roomId, type] of rooms) {
      try {
        const messages = await client.messagesSince(roomId, from, { signal });
        for (const message of messages) {
          // syncMessages also returns the messages edited since: keep the new ones.
          if (toMillis(message.ts) >= from) {
            await handleMessage(message, type);
          }
        }
      } catch (err) {
        if (signal.aborted) {
          return;
        }
        logger.debug(`Missed messages of ${roomId} not read: ${err.message}`);
      }
    }
  }

  /**
   * One message, from the real-time API or the catch-up.
   * @param {object} message a Rocket.Chat message
   * @param {string} roomType c (public), p (private), d (direct)
   */
  async function handleMessage(message, roomType) {
    if (!message || typeof message._id !== 'string' || seen.has(message._id)) {
      return;
    }
    if (message.editedAt) {
      return; // an edit: the original was handled, or is too late to act on
    }
    if (!watched.has(message.rid) && roomType !== 'd') {
      return; // a room the bot hears but does not listen to: kept out of `seen`
    }
    seen.add(message._id);
    if (seen.size > SEEN_KEPT) {
      seen.delete(seen.values().next().value);
    }
    data.seen = [...seen].slice(-SEEN_SAVED);
    const createdAt = toMillis(message.ts);
    if (Number.isFinite(createdAt) && createdAt > (data.lastPostAt ?? 0)) {
      data.lastPostAt = createdAt; // the clock of the server
    }
    save();
    const userId = message.u?._id;
    if (!me || userId === me.id) {
      return; // its own messages: no loop between a scene and its triggers
    }
    if (!allowed.has(userId)) {
      logger.debug(`Message ${message._id} ignored: not from an allowed person`);
      return;
    }
    if (message.t) {
      return; // a system message (joined the room, topic changed...)
    }
    if (message.bot) {
      // An incoming webhook or an app writing in the name of the person: not the person.
      logger.debug(`Message ${message._id} ignored: from a webhook or an app`);
      return;
    }
    if (!Number.isFinite(createdAt) || createdAt < now() - MAX_MESSAGE_AGE_MS) {
      logger.debug(`Message ${message._id} skipped: too old`);
      return;
    }
    const text = typeof message.msg === 'string' ? message.msg.trim() : '';
    if (text === '') {
      return;
    }
    const sender = allowed.get(userId);
    try {
      if (watched.has(message.rid)) {
        await handleChannelMessage(message, sender, text, createdAt);
      } else if (roomType === 'd' && message.rid === (await directRoomOf(userId))) {
        // The direct room of the bot and this allowed person, nobody else.
        await handleConversation(message, sender, text, createdAt);
      } else {
        logger.debug(`Message ${message._id} ignored: neither a watched channel nor a direct one`);
      }
    } catch (err) {
      logger.warn(`Message ${message._id} not handled: ${err.message}`);
    }
  }

  async function handleChannelMessage(message, sender, text, createdAt) {
    const channel = watched.get(message.rid);
    const at = new Date(createdAt).toISOString();
    data.recent = [{ channel, sender, text: text.slice(0, 500), at }, ...(data.recent ?? [])].slice(
      0,
      RECENT_KEPT,
    );
    save();
    refreshWidget();
    logger.debug(`Message from @${sender} in ${channel}`);
    const common = {
      channel,
      channel_id: message.rid,
      sender,
      text: text.slice(0, 1000),
    };
    await fire(TRIGGERS.MESSAGE, common);
    const command = parseCommand(text, config.command_prefix);
    if (command) {
      await fire(TRIGGERS.COMMAND, {
        ...common,
        command: command.command.slice(0, 1000),
        arguments: command.args.slice(0, 1000),
      });
    }
  }

  async function reply(roomId, text) {
    try {
      await client.postMessage({ roomId, text });
    } catch (err) {
      logger.warn(`Cannot answer in Rocket.Chat: ${err.message}`);
    }
  }

  async function handleConversation(message, sender, text, createdAt) {
    const userId = message.u._id;
    const roomId = message.rid;
    if (LINK_CODE.test(text)) {
      try {
        const user = await gladys.linkContact(text.toUpperCase(), userId, sender);
        logger.info(`Rocket.Chat account @${sender} linked to a Gladys user`);
        const language = BOT_TEXT[user?.language] ? user.language : config.language;
        await reply(roomId, pick(BOT_TEXT, language).linked(user?.first_name || sender));
        return;
      } catch (err) {
        if (err?.status !== 404) {
          logger.warn(`Cannot link @${sender}: ${err.message}`);
          await reply(roomId, pick(BOT_TEXT, config.language).unavailable);
          return;
        }
        // Not a valid code: maybe a word that looks like one, for the brain.
      }
    }
    try {
      await gladys.publishMessage(userId, text.slice(0, MAX_TEXT_LENGTH), {
        createdAt: new Date(createdAt),
      });
      brainLog.ok();
      logger.debug(`Message from @${sender} passed to Gladys`);
    } catch (err) {
      if (err?.status === 404) {
        logger.info(`Message from @${sender}, whose account is not linked: instructions sent`);
        await reply(roomId, pick(BOT_TEXT, config.language).notLinked);
        return;
      }
      brainLog.fail(`Cannot pass a message to Gladys: ${err.message}`);
      await reply(roomId, pick(BOT_TEXT, config.language).unavailable);
    }
  }

  // --- Configuration -------------------------------------------------------------

  async function stopLoop() {
    controller?.abort();
    await running;
    controller = null;
    running = null;
  }

  function applyConfig(raw) {
    // Serialized: two saves in a row must never leave two loops running.
    applying = applying.then(() => doApplyConfig(raw));
    return applying;
  }

  async function doApplyConfig(raw) {
    await loaded;
    await stopLoop();
    config = normalizeConfig(raw);
    client = null;
    me = null;
    lastError = null;
    watched = new Map();
    allowed = new Map();
    failures = [];
    const previousKey = connectionKey;
    connectionKey = fingerprint(config.server_url, config.user_id, config.access_token);
    if (connectionKey !== previousKey) {
      lostFired = false; // another server or account: a loss of the old one is not restored here
    }
    const server = parseServer(config.server_url);
    if (!config.server_url) {
      configError = new RocketChatError(ERROR_KINDS.NOT_CONFIGURED, 'No server address');
    } else if (!server) {
      configError = new RocketChatError(ERROR_KINDS.INVALID_URL, 'Server address not understood');
    } else if (!config.user_id || !config.access_token) {
      configError = new RocketChatError(ERROR_KINDS.NO_TOKEN, 'No user id or access token');
    } else {
      configError = null;
    }
    if (configError) {
      setConnection(CONNECTION.NOT_CONFIGURED);
      await publishStatus(false, errorTexts(configError));
      return;
    }
    client = new RocketChatClient({
      server,
      userId: config.user_id,
      token: config.access_token,
      fetch: fetchImpl,
    });
    if (stopped) {
      return;
    }
    controller = new AbortController();
    running = loop(controller.signal).catch((err) => logger.error('Rocket.Chat loop stopped', err));
  }

  function requireConnected() {
    if (!client) {
      throw configError;
    }
    if (!me) {
      throw (
        lastError ??
        new RocketChatError(ERROR_KINDS.UNREACHABLE, 'Not connected to Rocket.Chat yet')
      );
    }
    return client;
  }

  // --- Sending -------------------------------------------------------------------

  /**
   * The direct room with an allowed person (or one checked by userByUsername),
   * known or opened now: im.create would open a room of the bot with itself
   * for an unknown username.
   */
  async function directRoomOf(userId, signal, username = allowed.get(userId)) {
    const known = data.contactChannels?.[userId];
    if (known) {
      return known;
    }
    if (!username) {
      throw new RocketChatError(ERROR_KINDS.NOT_FOUND, 'Unknown person');
    }
    const roomId = await requireConnected().directRoom(username, { signal });
    data.contactChannels = { ...data.contactChannels, [userId]: roomId };
    save();
    return roomId;
  }

  /** Sends to "@username" (a direct message), a room id, "#channel" or the address of a channel. */
  async function sendTo(target, text) {
    const rocketchat = requireConnected();
    let roomId;
    if (target.startsWith('@')) {
      const name = parseUsername(target);
      const user = name ? await rocketchat.userByUsername(name) : null;
      if (!user?._id) {
        throw new RocketChatError(ERROR_KINDS.NOT_FOUND, `Unknown user ${target}`);
      }
      roomId = await directRoomOf(user._id, undefined, user.username);
    } else {
      roomId = (await resolveRoom(target))._id;
    }
    return rocketchat.postMessage({ roomId, text });
  }

  async function sendImage(roomId, file) {
    const image = parseImage(file);
    if (!image || !client) {
      return;
    }
    try {
      await client.uploadImage(
        roomId,
        image.buffer,
        image.contentType,
        `gladys.${image.extension}`,
      );
    } catch (err) {
      logger.warn(`Image not sent to Rocket.Chat: ${err.message}`);
    }
  }

  async function testConnection() {
    if (!client) {
      return each(REPORT_TEXT, (text, lang) => text.failed(errorText(configError, lang)));
    }
    try {
      const user = await client.me();
      const lines = (text) => [
        text.connected(user.username),
        config.channels.length > 0
          ? text.channels(watched.size, config.channels.length)
          : text.noChannels,
        config.allowed_users.length > 0
          ? text.users(allowed.size, config.allowed_users.length)
          : text.noUsers,
      ];
      return each(REPORT_TEXT, (text) => lines(text).join(' '));
    } catch (err) {
      return each(REPORT_TEXT, (text, lang) => text.failed(errorText(err, lang)));
    }
  }

  // --- Handlers ------------------------------------------------------------------

  gladys.onSendMessage(async (contact, message) => {
    // Gladys gives up after 5 s: everything below holds in one deadline.
    const deadline = AbortSignal.timeout(MESSAGE_TIMEOUT_MS);
    const contactId = typeof contact?.id === 'string' ? contact.id : '';
    // Right after a start (the "Gladys updated" message), the bot may still be connecting.
    await whenConnected(CONNECT_WAIT_MS);
    if (!me) {
      requireConnected(); // throws: Gladys learns the message was not delivered
    }
    if (!allowed.has(contactId)) {
      // Linked once, then removed from the allowed people: nothing goes out to them.
      logger.debug(
        `Message to ${contactId || 'an unknown contact'} not sent: not an allowed person`,
      );
      return;
    }
    const text = typeof message?.text === 'string' ? message.text : '';
    try {
      const rocketchat = requireConnected();
      const roomId = await directRoomOf(contactId, deadline);
      if (text.trim() !== '') {
        await rocketchat.postMessage({ roomId, text: clipPost(text) }, { signal: deadline });
      }
      if (message?.file) {
        sendImage(roomId, message.file); // after the ack: an upload takes longer than 5 s
      }
    } catch (err) {
      const failure = deadline.aborted
        ? new RocketChatError(ERROR_KINDS.TIMEOUT, `No answer within ${MESSAGE_TIMEOUT_MS} ms`)
        : err;
      logger.warn(`Message not delivered to @${allowed.get(contactId)}: ${failure.message}`);
      throw new Error(`Rocket.Chat: ${errorText(failure, 'en')}`, { cause: err });
    }
  });

  gladys.onSceneAction(SCENE_ACTION_KEY, async (fields) => {
    const target = typeof fields?.channel === 'string' ? fields.channel.trim() : '';
    const text = typeof fields?.message === 'string' ? fields.message : '';
    if (target === '' || text.trim() === '') {
      throw new Error('Rocket.Chat: the channel and the message are required');
    }
    try {
      const posted = await sendTo(target, clipPost(text));
      logger.info(`Scene message sent to ${target}`);
      return { sent: true, post_id: posted._id ?? '', error: '' };
    } catch (err) {
      logger.warn(`Scene message not sent to ${target}: ${err.message}`);
      return { sent: false, post_id: '', error: errorText(err, config.language) };
    }
  });

  gladys.onAction(ACTION_KEY, () => testConnection());

  gladys.onWidgetGet(WIDGET_KEY, async ({ language }) => {
    await loaded;
    return buildWidgetContent(
      {
        connection,
        username: me?.username ?? null,
        channels: { joined: watched.size, total: config.channels.length },
        recent: data.recent ?? [],
      },
      language,
    );
  });

  gladys.onWidgetAction(WIDGET_KEY, async (actionKey) => {
    if (actionKey !== TEST_ACTION) {
      throw new Error(`Unknown widget action "${actionKey}"`);
    }
    const report = await testConnection();
    return each(report, (text) => (text.length > 200 ? `${text.slice(0, 199)}…` : text));
  });

  gladys.onConfigUpdated((raw) => applyConfig(raw));

  gladys.on('connected', () => {
    lastStatus = null; // a new connection: publish the status again
    return applyConfig(gladys.config).catch((err) =>
      logger.error('Cannot apply the configuration', err),
    );
  });

  return {
    get config() {
      return config;
    },
    get connection() {
      return connection;
    },
    get data() {
      return data;
    },
    async stop() {
      stopped = true;
      await stopLoop();
      save();
      await store.flush();
    },
  };
}
