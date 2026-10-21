// -----------------------------------------------------------------------------
// The integration wired to the fake Gladys of the SDK and to a fake Rocket.Chat
// server: a `fetch` replacement for the REST API and a WebSocket replacement
// speaking DDP, shaped like the answers of a real Rocket.Chat 8.9
// (test/fixtures/rocketchat/). No network, a virtual clock, manual sleeps.
// -----------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { registerHandlers } from '../../src/app.js';

export const fixture = (name) =>
  JSON.parse(readFileSync(new URL(`../fixtures/rocketchat/${name}.json`, import.meta.url), 'utf8'));

export const SERVER = 'https://chat.test';
export const TOKEN = 'bot-token-0123456789abcdefghij';
const me = fixture('me');
export const BOT_ID = me._id;
export const ALICE_ID = 'a1icea1icea1icea1';
export const MALLORY_ID = 'ma11orma11orma11o';
export const GARAGE = fixture('rooms-info-garage').room._id; // #garage, public
export const FAMILY = 'fami1yfami1yfami1'; // family, private, the bot is in it
export const SECRET = 'secretsecretsecre'; // secret, private, the bot is not in it
export const START = Date.parse('2026-10-20T10:00:00Z');

export const BASE_CONFIG = {
  server_url: SERVER,
  user_id: BOT_ID,
  access_token: TOKEN,
  channels: '#garage',
  allowed_users: 'alice',
  language: 'en',
};

const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const roomNotFound = () => json(400, fixture('error-room-not-found'));
const notAllowed = () =>
  json(400, { success: false, error: 'not-allowed', errorType: 'Not Allowed' });

/** A fake Rocket.Chat server: just enough of the REST API and of DDP, recorded. */
export function createFakeServer() {
  const server = {
    down: null, // an error code (ECONNREFUSED...) makes every request fail
    tokens: new Set([TOKEN]),
    users: new Map([
      [BOT_ID, { _id: BOT_ID, username: 'gladys', active: true }],
      [ALICE_ID, { _id: ALICE_ID, username: 'alice', active: true }],
      [MALLORY_ID, { _id: MALLORY_ID, username: 'mallory', active: true }],
    ]),
    rooms: new Map([
      [GARAGE, { _id: GARAGE, name: 'garage', t: 'c', members: new Set([ALICE_ID, MALLORY_ID]) }],
      [
        FAMILY,
        { _id: FAMILY, name: 'family', t: 'p', members: new Set([BOT_ID, ALICE_ID, MALLORY_ID]) },
      ],
      [SECRET, { _id: SECRET, name: 'secret', t: 'p', members: new Set([ALICE_ID]) }],
    ]),
    messages: [], // every message, { _id, rid, msg, ts, u, ... }
    uploads: [],
    requests: [], // { method, path }
    sockets: [],
    muted: false, // the sockets stop answering pings
    rejectPosts: false, // a 400, as for a message too long
    clock: () => START,
  };

  const userName = (id) => server.users.get(id)?.username;
  const iso = () => new Date(server.clock()).toISOString();

  /** The 1:1 direct room of two users, created the first time (like im.create). */
  server.directRoom = (a, b) => {
    const id = `dm${[a, b].sort().join('').slice(0, 15)}`;
    if (!server.rooms.has(id)) {
      server.rooms.set(id, { _id: id, t: 'd', members: new Set([a, b]) });
    }
    return id;
  };

  server.fetch = async (url, init = {}) => {
    const { pathname, searchParams } = new URL(url);
    const method = init.method ?? 'GET';
    const path = decodeURIComponent(pathname.replace(/^\/api\/v1/, ''));
    server.requests.push({ method, path });
    if (init.signal?.aborted) {
      throw init.signal.reason; // like fetch: an aborted request never starts
    }
    if (server.down) {
      throw new TypeError('fetch failed', { cause: { code: server.down } });
    }
    if (!pathname.startsWith('/api/v1/')) {
      return new Response('<html>Not found</html>', { status: 404 });
    }
    const headers = init.headers ?? {};
    if (!server.tokens.has(headers['x-auth-token']) || headers['x-user-id'] !== BOT_ID) {
      return json(401, fixture('error-401'));
    }
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : init.body;
    const query = Object.fromEntries(searchParams);

    if (path === '/me') {
      return json(200, { ...me, success: true });
    }
    if (path === '/users.info') {
      const user = [...server.users.values()].find((u) => u.username === query.username);
      return user
        ? json(200, { user: { ...user, type: 'user' }, success: true })
        : json(400, fixture('error-user-not-found'));
    }
    if (path === '/rooms.info') {
      const room = query.roomId
        ? server.rooms.get(query.roomId)
        : [...server.rooms.values()].find((r) => r.name === query.roomName);
      if (!room) {
        return roomNotFound();
      }
      if (room.t !== 'c' && !room.members.has(BOT_ID)) {
        return notAllowed();
      }
      const { members, ...fields } = room;
      return json(200, { room: { ...fields, usersCount: members.size }, success: true });
    }
    if (path === '/subscriptions.getOne') {
      const member = server.rooms.get(query.roomId)?.members.has(BOT_ID);
      return json(200, { subscription: member ? { rid: query.roomId } : null, success: true });
    }
    if (method === 'POST' && path === '/channels.join') {
      const room = server.rooms.get(body.roomId);
      if (!room || room.t !== 'c') {
        return roomNotFound();
      }
      room.members.add(BOT_ID);
      return json(200, { channel: { _id: room._id, name: room.name, t: 'c' }, success: true });
    }
    if (method === 'POST' && path === '/im.create') {
      const user = [...server.users.values()].find((u) => u.username === body.username);
      // A real server opens a room of the bot with itself for an unknown username.
      const id = user ? server.directRoom(BOT_ID, user._id) : `self${BOT_ID.slice(0, 13)}`;
      return json(200, { room: { t: 'd', rid: id, _id: id }, success: true });
    }
    if (method === 'POST' && path === '/chat.postMessage') {
      const room = server.rooms.get(body.roomId);
      if (!room) {
        return json(400, {
          success: false,
          error: '[invalid-channel]',
          errorType: 'invalid-channel',
        });
      }
      // A public channel takes messages from anyone; a private one from its members.
      if (room.t !== 'c' && !room.members.has(BOT_ID)) {
        return json(400, { success: false, error: 'error-not-allowed' });
      }
      if (server.rejectPosts) {
        return json(400, fixture('error-size-exceeded'));
      }
      const message = server.publish(BOT_ID, body.roomId, body.text);
      return json(200, { ts: server.clock(), channel: body.roomId, message, success: true });
    }
    if (path === '/chat.syncMessages') {
      const since = Date.parse(query.lastUpdate);
      const room = server.rooms.get(query.roomId);
      if (!room || (room.t !== 'c' && !room.members.has(BOT_ID))) {
        return json(400, { success: false, error: 'Not allowed [error-not-allowed]' });
      }
      const updated = server.messages.filter(
        (m) => m.rid === query.roomId && Date.parse(m._updatedAt) >= since,
      );
      return json(200, { result: { updated, deleted: [] }, success: true });
    }
    let match = path.match(/^\/rooms\.media\/([^/]+)$/);
    if (method === 'POST' && match) {
      const file = init.body.get('file');
      server.uploads.push({ room: match[1], size: file.size, type: file.type, name: file.name });
      return json(200, { file: { _id: `file${server.uploads.length}` }, success: true });
    }
    match = path.match(/^\/rooms\.mediaConfirm\/([^/]+)\/([^/]+)$/);
    if (method === 'POST' && match) {
      const message = server.publish(BOT_ID, match[1], body.msg ?? '', {
        file: { _id: match[2] },
      });
      return json(200, { message, success: true });
    }
    return json(404, { success: false, error: 'Not found' });
  };

  /** A new message, pushed to the DDP sockets of the bot when it is in the room. */
  server.publish = (userId, roomId, text, extra = {}) => {
    const message = {
      _id: `msg${String(server.messages.length + 1).padStart(14, '0')}`,
      rid: roomId,
      msg: text,
      ts: iso(),
      u: { _id: userId, username: userName(userId), name: userName(userId) },
      _updatedAt: iso(),
      ...extra,
    };
    server.messages.push(message);
    const room = server.rooms.get(roomId);
    const frame = fixture('ddp-message-channel');
    frame.fields.args = [
      {
        ...message,
        ts: { $date: Date.parse(message.ts) },
        _updatedAt: { $date: Date.parse(message._updatedAt) },
      },
      {
        roomParticipant: true,
        roomType: room?.t ?? 'c',
        ...(room?.name ? { roomName: room.name } : {}),
      },
    ];
    if (room?.members.has(BOT_ID)) {
      server.sockets.filter((socket) => socket.open).forEach((socket) => socket.push(frame));
    }
    return message;
  };

  /** Closes every open socket, as a server restart would (code 1006). */
  server.dropSockets = () => {
    server.sockets.filter((socket) => socket.open).forEach((socket) => socket.drop(1006));
  };

  server.WebSocket = class FakeWebSocket {
    constructor(url) {
      this.url = url;
      this.open = false;
      this.listeners = {};
      this.sent = [];
      server.sockets.push(this);
      setImmediate(() => {
        if (server.down) {
          this.emit('error', {});
          this.emit('close', { code: 1006 });
          return;
        }
        this.emit('open', {});
      });
    }

    addEventListener(type, listener) {
      (this.listeners[type] ??= []).push(listener);
    }

    emit(type, event) {
      (this.listeners[type] ?? []).forEach((listener) => listener(event));
    }

    push(data) {
      this.emit('message', { data: JSON.stringify(data) });
    }

    send(text) {
      const frame = JSON.parse(text);
      this.sent.push(frame);
      if (frame.msg === 'connect') {
        this.push({ msg: 'connected', session: 'sessionsessionses' });
      } else if (frame.msg === 'method' && frame.method === 'login') {
        this.push({ msg: 'updated', methods: [frame.id] });
        if (!server.tokens.has(frame.params?.[0]?.resume)) {
          this.push({
            msg: 'result',
            id: frame.id,
            error: { isClientSafe: true, error: 401, reason: 'User not found' },
          });
          return;
        }
        this.push({ ...fixture('ddp-login'), id: frame.id });
      } else if (frame.msg === 'sub') {
        this.open = true;
        this.push({ msg: 'ready', subs: [frame.id] });
      } else if (frame.msg === 'ping' && !server.muted) {
        this.push({ msg: 'pong', id: frame.id });
      }
    }

    drop(code) {
      if (this.closed) {
        return;
      }
      this.closed = true;
      this.open = false;
      this.emit('close', { code });
    }

    close() {
      this.drop(1000);
    }
  };

  return server;
}

export function createMemoryStore(initial = {}) {
  return {
    data: structuredClone(initial),
    writes: 0,
    async load() {
      return structuredClone(this.data);
    },
    async save(data) {
      this.data = structuredClone(data);
      this.writes += 1;
    },
    async flush() {},
  };
}

/** Lets pending promises, fetches and socket events settle. */
export async function settle(rounds = 30) {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

export async function createWorld({
  config = BASE_CONFIG,
  stored = {},
  server = createFakeServer(),
  linkedUser,
  pingIntervalMs,
} = {}) {
  const gladys = createFakeGladys({ config, linkedUser });
  const store = createMemoryStore(stored);
  const clock = { time: START };
  server.clock = () => clock.time;
  const sleeps = [];
  const app = registerHandlers(gladys, {
    fetch: server.fetch,
    WebSocket: server.WebSocket,
    store,
    now: () => clock.time,
    pingIntervalMs,
    sleep: (ms, signal) =>
      new Promise((resolve) => {
        const entry = { ms, resolve };
        sleeps.push(entry);
        signal.addEventListener('abort', resolve);
      }),
  });
  /** Ends the oldest pending sleep, moving the clock forward by its length. */
  const wake = async () => {
    await settle();
    const entry = sleeps.shift();
    if (!entry) {
      throw new Error('nothing is sleeping');
    }
    clock.time += entry.ms;
    entry.resolve();
    await settle();
    return entry.ms;
  };
  await gladys.connect();
  await settle();
  return { gladys, fake: gladys.fake, server, store, clock, sleeps, wake, app };
}
