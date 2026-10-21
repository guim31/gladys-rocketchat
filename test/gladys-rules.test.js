// -----------------------------------------------------------------------------
// The conformity rules of the Gladys devices (category/type pairs, polling,
// min/max, units...) apply to the devices an integration publishes. A
// communication integration has no Devices screen: this one publishes none,
// and this test keeps it that way — a device added one day must come with the
// full checks of guim31/gladys-wled (test/fixtures/gladys-feature-table.json).
// -----------------------------------------------------------------------------

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ALICE_ID, GARAGE, createWorld, settle } from './helpers/world.js';

const manifest = JSON.parse(
  await readFile(new URL('../gladys-assistant-integration.json', import.meta.url), 'utf8'),
);

test('a communication integration: no device published, no state, no polling handler', async (t) => {
  assert.equal(manifest.type, 'communication');
  const world = await createWorld();
  t.after(() => world.app.stop());
  world.server.publish(ALICE_ID, GARAGE, '!lights off');
  await settle();
  assert.deepEqual(world.fake.discoveredDevices, []);
  assert.deepEqual(world.fake.states, []);
  const ack = await world.fake.poll({ external_id: 'rocketchat:anything', features: [] });
  assert.equal(ack.success, false);
});
