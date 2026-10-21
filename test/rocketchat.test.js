// -----------------------------------------------------------------------------
// The pieces: configuration parsing, the REST client (typed errors, no token
// in a message), the DDP handshake and the widget budget.
// -----------------------------------------------------------------------------

import test from 'node:test';
import assert from 'node:assert/strict';
import { validateWidgetContent } from '@gladysassistant/integration-sdk';
import { normalizeConfig, parseChannel, parseServer } from '../src/config.js';
import { ERROR_KINDS, RocketChatClient, toMillis } from '../src/rocketchat/client.js';
import { openDdp } from '../src/rocketchat/ddp.js';
import { parseImage } from '../src/app.js';
import { CONNECTION, buildWidgetContent } from '../src/widgets.js';
import { BOT_ID, FAMILY, GARAGE, TOKEN, createFakeServer, fixture } from './helpers/world.js';

test('normalizeConfig: defaults, lists, usernames without @ and case kept', () => {
  assert.deepEqual(normalizeConfig({}), {
    server_url: '',
    user_id: '',
    access_token: '',
    allowed_users: [],
    channels: [],
    command_prefix: '!',
    language: 'fr',
  });
  const config = normalizeConfig({
    user_id: ' b0tb0tb0tb0tb0tb0 ',
    allowed_users: '@Alice, bob;; Alice\nnot#valid',
    channels: ' #garage , #garage ',
    command_prefix: 'toolong',
    language: 'it',
  });
  assert.equal(config.user_id, 'b0tb0tb0tb0tb0tb0');
  // Rocket.Chat matches usernames exactly: "Alice" is not "alice".
  assert.deepEqual(config.allowed_users, ['Alice', 'bob']);
  assert.deepEqual(config.channels, ['#garage']);
  assert.equal(config.command_prefix, '!');
  assert.equal(config.language, 'fr');
});

test('parseChannel: #name, name, the browser address, an id', () => {
  assert.deepEqual(parseChannel('#garage'), { name: 'garage' });
  assert.deepEqual(parseChannel('garage'), { name: 'garage' });
  assert.deepEqual(parseChannel('https://chat.example.org/channel/garage?msg=x'), {
    name: 'garage',
  });
  assert.deepEqual(parseChannel('https://chat.example.org/group/family'), { name: 'family' });
  assert.deepEqual(parseChannel('garagegaragegarag'), {
    id: 'garagegaragegarag',
    name: 'garagegaragegarag',
  });
  assert.deepEqual(parseChannel('6ad9140f65a279b0295578a8'), {
    id: '6ad9140f65a279b0295578a8',
    name: '6ad9140f65a279b0295578a8',
  });
  assert.equal(parseChannel('https://chat.example.org/direct/alice'), null);
  assert.equal(parseChannel('@alice'), null);
  assert.equal(parseChannel(''), null);
});

test('parseServer: https implied, a sub-path kept, no credentials in the address', () => {
  assert.equal(parseServer('chat.example.org').href, 'https://chat.example.org/');
  assert.equal(parseServer('http://192.0.2.10:3000/').href, 'http://192.0.2.10:3000/');
  assert.equal(parseServer('https://example.org/chat/api/v1').href, 'https://example.org/chat');
  assert.equal(
    parseServer('https://chat.example.org/channel/general').href,
    'https://chat.example.org/',
  );
  assert.equal(parseServer('https://user:pass@chat.example.org'), null);
  assert.equal(parseServer('ftp://chat.example.org'), null);
  assert.equal(parseServer(''), null);
});

test('client: the WebSocket address follows the server', () => {
  const client = (address) =>
    new RocketChatClient({ server: parseServer(address), userId: 'u', token: 't' });
  assert.equal(
    client('https://example.org/chat').websocketUrl(),
    'wss://example.org/chat/websocket',
  );
  assert.equal(client('http://192.0.2.10:3000').websocketUrl(), 'ws://192.0.2.10:3000/websocket');
});

test('client: errors are typed and never carry the token', async () => {
  const server = createFakeServer();
  const client = (token, fetch = server.fetch) =>
    new RocketChatClient({
      server: parseServer('https://chat.test'),
      userId: BOT_ID,
      token,
      fetch,
    });
  await assert.rejects(client('wrong-token').me(), (err) => {
    assert.equal(err.kind, ERROR_KINDS.TOKEN);
    assert.equal(err.message.includes('wrong-token'), false);
    return true;
  });
  await assert.rejects(client(TOKEN).room({ name: 'nope' }), {
    kind: ERROR_KINDS.NOT_FOUND,
    code: 'error-room-not-found',
  });
  await assert.rejects(client(TOKEN).userByUsername('ghost'), { kind: ERROR_KINDS.NOT_FOUND });
  await assert.rejects(client(TOKEN).room({ name: 'secret' }), { kind: ERROR_KINDS.FORBIDDEN });
  await assert.rejects(client(TOKEN).postMessage({ roomId: 'nope', text: 'x' }), {
    kind: ERROR_KINDS.NOT_FOUND,
  });
  server.rejectPosts = true;
  await assert.rejects(client(TOKEN).postMessage({ roomId: GARAGE, text: 'x' }), {
    kind: ERROR_KINDS.TOO_LONG,
  });
  await assert.rejects(client(TOKEN).request('GET', '/../not-api'), {
    kind: ERROR_KINDS.NOT_ROCKETCHAT,
  });
  server.down = 'ECONNREFUSED';
  await assert.rejects(client(TOKEN).me(), {
    kind: ERROR_KINDS.UNREACHABLE,
    message: 'Server unreachable: ECONNREFUSED',
  });
  const html = async () => new Response('<html></html>', { status: 200 });
  await assert.rejects(client(TOKEN, html).me(), { kind: ERROR_KINDS.NOT_ROCKETCHAT });
  await assert.rejects(
    new RocketChatClient({ server: parseServer('https://chat.test'), userId: '', token: 't' }).me(),
    { kind: ERROR_KINDS.NO_TOKEN },
  );
});

test('client: a short 429 is waited for once (reset given as a date), then it goes through', async () => {
  let calls = 0;
  const fetch = async () => {
    calls += 1;
    return calls === 1
      ? new Response('{"success":false,"error":"error-too-many-requests"}', {
          status: 429,
          headers: { 'x-ratelimit-reset': String(Date.now() + 10) },
        })
      : new Response(JSON.stringify(fixture('me')), { status: 200 });
  };
  const client = new RocketChatClient({
    server: parseServer('https://chat.test'),
    userId: 'u',
    token: 't',
    fetch,
  });
  assert.equal((await client.me()).username, 'gladys');
  assert.equal(calls, 2);
});

test('toMillis: the dates of REST (ISO) and of DDP ({ $date })', () => {
  const message = fixture('ddp-message-channel').fields.args[0];
  assert.equal(toMillis(message.ts), 1792611453837);
  assert.equal(toMillis('2026-10-21T19:37:01.339Z'), Date.parse('2026-10-21T19:37:01.339Z'));
});

test('ddp: logs in with the token, subscribes, delivers messages; refuses a wrong token', async () => {
  const server = createFakeServer();
  const received = [];
  const socket = await openDdp({
    url: 'wss://chat.test/websocket',
    token: TOKEN,
    WebSocket: server.WebSocket,
    onMessage: (message, meta) => received.push([message.msg, meta.roomType]),
  });
  server.publish(BOT_ID, FAMILY, 'hello');
  assert.deepEqual(received, [['hello', 'p']]);
  // The server pings too: the client answers.
  server.sockets[0].push({ msg: 'ping' });
  assert.deepEqual(server.sockets[0].sent.at(-1), { msg: 'pong' });
  socket.close();
  assert.equal(await socket.closed, 'closed by the integration');

  await assert.rejects(
    openDdp({
      url: 'wss://chat.test/websocket',
      token: 'wrong',
      WebSocket: server.WebSocket,
      onMessage: () => {},
    }),
    { kind: ERROR_KINDS.TOKEN },
  );
});

test('parseImage: the "image/jpg;base64,..." of Gladys', () => {
  const image = parseImage('image/jpg;base64,/9j/4AAQ');
  assert.equal(image.contentType, 'image/jpeg');
  assert.equal(image.extension, 'jpg');
  assert.equal(image.buffer.length, 6);
  assert.equal(parseImage('not an image'), null);
  assert.equal(parseImage(null), null);
});

test('the widget fits the budget of the core in every state', () => {
  const recent = Array.from({ length: 8 }, (_, i) => ({
    channel: 'https://chat.example.org/channel/a-very-long-channel-name',
    sender: 'someone-with-a-long-name',
    text: 'x'.repeat(600),
    at: new Date(Date.UTC(2026, 9, 20, 10, i)).toISOString(),
  }));
  for (const connection of Object.values(CONNECTION)) {
    for (const language of ['en', 'fr', 'de', 'es']) {
      for (const list of [[], recent]) {
        const content = buildWidgetContent(
          {
            connection,
            username: connection === CONNECTION.CONNECTED ? 'gladys' : null,
            channels: { joined: 1, total: 2 },
            recent: list,
          },
          language,
        );
        assert.deepEqual(validateWidgetContent(content), [], `${connection} ${language}`);
        assert.ok(content.components.length <= 8);
      }
    }
  }
  const [card] = buildWidgetContent(
    {
      connection: 'connected',
      username: 'gladys',
      channels: { joined: 1, total: 1 },
      recent: [{ ...recent[0], channel: '#garage' }],
    },
    'en',
  ).components[1].items;
  assert.equal(card.badge.text, 'garage');
});
