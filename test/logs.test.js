// -----------------------------------------------------------------------------
// What reaches `docker logs`: the lifecycle at info level, everything per
// message at debug level, repeated failures once, never the token.
// -----------------------------------------------------------------------------

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ALICE_ID,
  BASE_CONFIG,
  BOT_ID,
  GARAGE,
  TOKEN,
  createWorld,
  settle,
} from './helpers/world.js';

/**
 * Captures the lines of the SDK logger (console.log for debug/info,
 * console.error for warn/error), at every level.
 */
function captureLogs(t) {
  const previous = process.env.LOG_LEVEL;
  process.env.LOG_LEVEL = 'debug';
  const lines = [];
  // The SDK logger writes `[time] [LEVEL] [name]` then the arguments.
  const capture = (prefix, ...args) => {
    const [, level, name] = /\[(DEBUG|INFO|WARN|ERROR)\](?: \[([^\]]+)\])?/.exec(prefix) ?? [];
    const text = args.map((arg) => (arg instanceof Error ? arg.message : String(arg))).join(' ');
    lines.push({ level: level?.toLowerCase(), name, text });
  };
  t.mock.method(console, 'log', capture);
  t.mock.method(console, 'error', capture);
  t.after(() => {
    if (previous === undefined) {
      delete process.env.LOG_LEVEL;
    } else {
      process.env.LOG_LEVEL = previous;
    }
  });
  return {
    lines,
    at: (...levels) => lines.filter((line) => levels.includes(line.level)).map((l) => l.text),
    clear: () => lines.splice(0),
  };
}

test('a normal cycle writes nothing at info level', async (t) => {
  const logs = captureLogs(t);
  const world = await createWorld({
    linkedUser: { selector: 'alice', first_name: 'Alice', language: 'en' },
  });
  t.after(() => world.app.stop());
  assert.ok(logs.at('info').some((line) => line.startsWith('Connected to Rocket.Chat as')));
  logs.clear();
  world.server.publish(ALICE_ID, GARAGE, '!lights off');
  world.server.publish(ALICE_ID, GARAGE, 'hello');
  await settle();
  const dm = world.server.directRoom(ALICE_ID, BOT_ID);
  world.server.publish(ALICE_ID, dm, 'What is the temperature?');
  await settle();
  await world.fake.sendMessage({ id: ALICE_ID }, { text: '21 °C', file: null });
  await world.fake.widgetGet('rocketchat', { language: 'en', settings: {} });
  assert.equal(world.fake.sceneEvents.length, 3);
  assert.equal(world.fake.messages.length, 1);
  assert.deepEqual(logs.at('info', 'warn', 'error'), []);
  assert.ok(logs.at('debug').length > 0, 'the details are at debug level');
});

test('a server down: one line when it starts, none per retry', async (t) => {
  const logs = captureLogs(t);
  const world = await createWorld();
  t.after(() => world.app.stop());
  logs.clear();
  world.server.down = 'ECONNREFUSED';
  world.server.dropSockets();
  await settle();
  for (let i = 0; i < 8; i += 1) {
    await world.wake();
  }
  const failures = logs
    .at('warn', 'error')
    .filter((line) => line.startsWith('Rocket.Chat connection failed'));
  assert.equal(failures.length, 1);
  assert.equal(
    logs.at('warn').filter((line) => line.startsWith('Rocket.Chat connection lost')).length,
    1,
  );
  world.server.down = null;
  await world.wake();
  assert.ok(logs.at('info').includes('Rocket.Chat connection works again'));
});

test('no log line ever holds the token', async (t) => {
  const logs = captureLogs(t);
  const world = await createWorld({ config: { ...BASE_CONFIG, access_token: 'secret-token-x' } });
  t.after(() => world.app.stop());
  const ok = await createWorld();
  t.after(() => ok.app.stop());
  await ok.fake.sceneAction('send_message', { channel: '#nope', message: 'x' });
  const all = logs.lines.map((line) => line.text).join('\n');
  assert.ok(all.length > 0);
  for (const secret of ['secret-token-x', TOKEN]) {
    assert.equal(all.includes(secret), false, secret);
  }
});
