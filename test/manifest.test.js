// -----------------------------------------------------------------------------
// Consistency checks between `gladys-assistant-integration.json` and the code.
// The manifest is validated by the store indexer, but nothing there can know
// which handlers the code actually registers — these tests keep both in sync.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DEFAULT_CONFIG, LANGUAGES } from '../src/config.js';
import { ACTION_KEY, SCENE_ACTION_KEY, TRIGGERS } from '../src/app.js';
import { WIDGET_KEY } from '../src/widgets.js';
import { createWorld } from './helpers/world.js';

const manifest = JSON.parse(
  await readFile(new URL('../gladys-assistant-integration.json', import.meta.url), 'utf8'),
);
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

// Every list of form fields the manifest can declare (same field grammar).
const allFields = [
  ...(manifest.config_schema ?? []),
  ...(manifest.contact_schema ?? []),
  ...[
    ...(manifest.actions ?? []),
    ...(manifest.scene_triggers ?? []),
    ...(manifest.scene_actions ?? []),
  ].flatMap((item) => item.fields ?? []),
  ...(manifest.widgets ?? []).flatMap((widget) => widget.settings ?? []),
];

// Manifest fields older Gladys releases reject as unknown, with the first
// release accepting them. The store validator refuses a manifest whose
// `gladys_version` minimum is lower: these tests catch it before a release.
const CAPABILITY_FIELDS = ['scene_triggers', 'scene_actions', 'widgets'];
const CAPABILITY_MIN_GLADYS_VERSION = [5, 1, 0];
const CATEGORIES_MIN_GLADYS_VERSION = [4, 86, 0];

const keysOf = (list) => (list ?? []).map((entry) => entry.key);

// Minimum version of the manifest `gladys_version` range, e.g. [5, 1, 0].
function minGladysVersion() {
  const match = manifest.gladys_version.match(/>=\s*(\d+)\.(\d+)\.(\d+)/);
  assert.ok(match, 'gladys_version must declare a minimum version');
  return match.slice(1).map(Number);
}

function isAtLeast(version, required) {
  for (let i = 0; i < required.length; i += 1) {
    if (version[i] !== required[i]) {
      return version[i] > required[i];
    }
  }
  return true;
}

test('identity: a two-way Rocket.Chat chat channel, local and cloud, notifications category', () => {
  assert.equal(manifest.name, 'Rocket.Chat');
  assert.equal(manifest.type, 'communication');
  assert.deepEqual(manifest.messaging, { receive: true });
  assert.equal(manifest.contact_schema, undefined, 'a receiving channel links by code');
  assert.match(manifest.docker_image, /^ghcr\.io\/guim31\/gladys-rocketchat:/);
  assert.equal(
    manifest.cover_image,
    'https://raw.githubusercontent.com/guim31/gladys-rocketchat/main/cover.png',
  );
  assert.deepEqual(manifest.transports, ['local', 'cloud']);
  assert.deepEqual(manifest.categories, ['notifications']);
  assert.equal(manifest.gladys_version, '>=5.1.0');
});

test('the token is a secret field, and nothing is required but the server and the account', () => {
  const byKey = Object.fromEntries(manifest.config_schema.map((field) => [field.key, field]));
  assert.equal(byKey.access_token.type, 'secret');
  const required = manifest.config_schema.filter((field) => field.required).map((f) => f.key);
  assert.deepEqual(required, ['server_url', 'user_id']);
});

test('the language select offers the four languages of the code', () => {
  const field = manifest.config_schema.find((entry) => entry.key === 'language');
  assert.deepEqual(
    field.options.map((option) => option.value),
    LANGUAGES,
  );
});

test('every manifest action, scene action and widget has a handler', async (t) => {
  assert.deepEqual(keysOf(manifest.actions), [ACTION_KEY]);
  assert.deepEqual(keysOf(manifest.scene_actions), [SCENE_ACTION_KEY]);
  assert.deepEqual(keysOf(manifest.widgets), [WIDGET_KEY]);
  const world = await createWorld();
  t.after(() => world.app.stop());
  assert.equal((await world.fake.action(ACTION_KEY, {})).success, true);
  const ack = await world.fake.sceneAction(SCENE_ACTION_KEY, {
    channel: '#garage',
    message: 'x',
  });
  assert.equal(ack.success, true);
  const [action] = manifest.scene_actions;
  assert.deepEqual(Object.keys(ack.data.outputs).sort(), keysOf(action.outputs).sort());
  const required = action.fields.filter((field) => field.required).map((field) => field.key);
  assert.deepEqual(required, ['channel', 'message']);
  const widget = await world.fake.widgetGet(WIDGET_KEY, { settings: {}, language: 'en' });
  assert.equal(widget.success, true);
});

test('the triggers fired by the code are the declared ones, with their variables', async (t) => {
  assert.deepEqual(keysOf(manifest.scene_triggers).sort(), Object.values(TRIGGERS).sort());
  const byKey = Object.fromEntries(
    manifest.scene_triggers.map((trigger) => [trigger.key, trigger]),
  );
  assert.deepEqual(keysOf(byKey[TRIGGERS.MESSAGE].fields), ['channel', 'sender']);
  assert.deepEqual(keysOf(byKey[TRIGGERS.COMMAND].fields), ['command', 'channel', 'sender']);
  // No field is required: an empty filter is "any".
  assert.ok(
    manifest.scene_triggers.every((trigger) => (trigger.fields ?? []).every((f) => !f.required)),
  );
  // The data of every fired event holds exactly the declared fields and variables.
  const { ALICE_ID, GARAGE, settle } = await import('./helpers/world.js');
  const world = await createWorld();
  t.after(() => world.app.stop());
  world.server.publish(ALICE_ID, GARAGE, '!lights off');
  await settle();
  assert.equal(world.fake.sceneEvents.length, 2);
  for (const event of world.fake.sceneEvents) {
    const trigger = byKey[event.key];
    const declared = new Set([...keysOf(trigger.fields), ...keysOf(trigger.variables)]);
    assert.deepEqual(Object.keys(event.data).sort(), [...declared].sort(), event.key);
  }
});

test('declaring catalog categories requires Gladys >= 4.86.0', () => {
  // The store vocabulary itself is checked by the store validator (unknown
  // keys are dropped with a warning there) — what this test pins is the
  // coupling rule: older cores reject any unknown manifest field, so a
  // manifest declaring `categories` must not claim compatibility below the
  // first release that accepts it.
  assert.ok(manifest.categories.length >= 1 && manifest.categories.length <= 3);
  assert.ok(
    isAtLeast(minGladysVersion(), CATEGORIES_MIN_GLADYS_VERSION),
    `categories requires gladys_version >= 4.86.0, got "${manifest.gladys_version}"`,
  );
});

test('declaring scene triggers, scene actions or widgets requires Gladys >= 5.1.0', () => {
  const declared = CAPABILITY_FIELDS.filter((field) => manifest[field] !== undefined);
  assert.ok(declared.length > 0);
  assert.ok(
    isAtLeast(minGladysVersion(), CAPABILITY_MIN_GLADYS_VERSION),
    `${declared.join(', ')} requires gladys_version >= 5.1.0, got "${manifest.gladys_version}"`,
  );
});

test('config_schema defaults stay consistent with DEFAULT_CONFIG', () => {
  for (const field of manifest.config_schema) {
    if (field.type !== 'section') {
      assert.ok(field.key in DEFAULT_CONFIG, `DEFAULT_CONFIG.${field.key} is missing`);
    }
    if (field.default !== undefined) {
      assert.equal(
        DEFAULT_CONFIG[field.key],
        field.default,
        `DEFAULT_CONFIG.${field.key} must match the manifest default`,
      );
    }
  }
});

test('section fields are purely presentational', () => {
  const sections = manifest.config_schema.filter((f) => f.type === 'section');
  assert.ok(sections.length > 0);
  for (const section of sections) {
    // A section stores NO value: declaring `required`, `default` or
    // `placeholder` on it rejects the manifest, and its key must never leak
    // into the config the code manipulates.
    assert.equal(section.required, undefined, `section "${section.key}" must not be required`);
    assert.equal(section.default, undefined, `section "${section.key}" must not have a default`);
    assert.equal(
      section.placeholder,
      undefined,
      `section "${section.key}" must not have a placeholder`,
    );
    assert.ok(section.label?.en, `section "${section.key}" needs an English label`);
    assert.ok(
      !(section.key in DEFAULT_CONFIG),
      `section "${section.key}" stores no value and must not appear in DEFAULT_CONFIG`,
    );
    for (const link of section.links ?? []) {
      assert.match(link.url, /^https:\/\//, 'section links must be https');
    }
  }
});

test('the manifest version is the package version, and the image is tagged with it', () => {
  // The Release workflow writes all three: a mismatch means one was edited by
  // hand, and Gladys would offer a version whose image is another one.
  assert.equal(manifest.version, pkg.version, 'manifest version must match package.json');
  assert.ok(
    manifest.docker_image.endsWith(`:${manifest.version}`),
    `docker_image must be tagged :${manifest.version}, got "${manifest.docker_image}"`,
  );
});

test('the catalog description holds 10 to 100 characters per language', () => {
  // A store rule (the catalog card is short): a longer text rejects the
  // manifest.
  assert.ok(manifest.description.en, 'the description needs an English text');
  for (const [lang, text] of Object.entries(manifest.description)) {
    assert.ok(
      text.length >= 10 && text.length <= 100,
      `description.${lang} has ${text.length} characters (10 to 100 allowed)`,
    );
  }
});

test('field placeholders are multi-language objects', () => {
  // Like `label` and `description`: a plain string rejects the manifest.
  const withPlaceholder = allFields.filter((f) => f.placeholder !== undefined);
  assert.ok(withPlaceholder.length > 0);
  for (const field of withPlaceholder) {
    assert.equal(typeof field.placeholder, 'object', `field "${field.key}": placeholder`);
    assert.ok(field.placeholder.en, `field "${field.key}": placeholder needs an English text`);
  }
});
