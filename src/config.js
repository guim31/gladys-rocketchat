// -----------------------------------------------------------------------------
// Integration configuration (the `config_schema` of the manifest), normalized
// so the rest of the code never deals with `undefined`, stray spaces or a
// half-typed address.
// -----------------------------------------------------------------------------

export const LANGUAGES = ['en', 'fr', 'de', 'es'];

// Defaults: they MUST stay consistent with the `default` values declared in the
// `config_schema` of the manifest (test/manifest.test.js).
export const DEFAULT_CONFIG = {
  server_url: '',
  user_id: '',
  access_token: '',
  allowed_users: '',
  channels: '',
  command_prefix: '!',
  language: 'fr',
};

const trimmed = (value) => (typeof value === 'string' ? value.trim() : '');

// Rocket.Chat ids: Meteor random ids (17 letters and digits) or, for the rooms
// and users of recent servers, 24 hexadecimal characters (recorded on 8.9).
const ID = /^(?:[A-Za-z0-9]{17}|[a-f0-9]{24})$/;
// Usernames: letters, digits, ".", "-" and "_" by default (UTF8_User_Names_Validation).
const USERNAME = /^[\p{L}\p{N}._-]{1,64}$/u;
// A room name: anything but spaces and the characters of an address or a mention.
const ROOM_NAME = /^[^\s#@/?]{1,100}$/u;
// The address of a room in the browser: <server>/channel/<name> or /group/<name>.
const ROOM_PATH = /\/(?:channel|group)\/([^/?#]+)/;

export const isId = (value) => ID.test(value);

/** Splits a list typed in a text field: commas, semicolons, spaces or new lines. */
export function parseList(value) {
  const items = trimmed(value)
    .split(/[\s,;]+/)
    .map((item) => item.trim())
    .filter((item) => item !== '');
  return [...new Set(items)];
}

/** "@alice" → "alice"; null when it cannot be a username. Case is kept: the server matches it exactly. */
export function parseUsername(value) {
  const name = trimmed(value).replace(/^@/, '');
  return USERNAME.test(name) ? name : null;
}

/**
 * A room as the person typed it: "#name", "name", a room id, or the address
 * of the room in the browser (https://chat.example.org/channel/garage).
 * A bare value shaped like an id is tried as an id first, then as a name.
 * @returns {{ name: string, id?: string } | null}
 */
export function parseChannel(value) {
  let text = trimmed(value);
  const path = text.match(ROOM_PATH);
  if (path) {
    text = decodeURIComponent(path[1]);
  } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    return null; // an address, but not the one of a room (a direct message...)
  }
  const hashed = text.startsWith('#');
  const name = text.replace(/^#/, '');
  if (!ROOM_NAME.test(name)) {
    return null;
  }
  return !hashed && !path && isId(name) ? { id: name, name } : { name };
}

/**
 * The server address as a URL, or null when it is empty or not understood.
 * A bare host name gets https://. A sub-path (https://example.org/chat) is kept.
 * @param {string} value
 * @returns {URL|null}
 */
export function parseServer(value) {
  const text = trimmed(value).replace(/\/+$/, '');
  if (text === '') {
    return null;
  }
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      return null;
    }
    url.search = '';
    url.hash = '';
    // Pasted from the browser: keep the server, not the page.
    url.pathname = url.pathname
      .replace(/\/(?:api\/v1|home|channel|group|direct|admin|account)(?:\/.*)?$/, '')
      .replace(/\/+$/, '');
    return url;
  } catch {
    return null;
  }
}

/**
 * Merge the user config with the defaults.
 * @param {Record<string, unknown>} [raw] config returned by the SDK
 */
export function normalizeConfig(raw = {}) {
  const config = raw ?? {};
  const prefix = trimmed(config.command_prefix);
  const usernames = parseList(config.allowed_users).map(parseUsername).filter(Boolean);
  return {
    server_url: trimmed(config.server_url),
    user_id: trimmed(config.user_id),
    access_token: trimmed(config.access_token),
    allowed_users: [...new Set(usernames)],
    channels: parseList(config.channels),
    // One to three characters, no space: "!" by default ("/" is taken by Rocket.Chat).
    command_prefix: prefix === '' || prefix.length > 3 ? DEFAULT_CONFIG.command_prefix : prefix,
    language: LANGUAGES.includes(config.language) ? config.language : DEFAULT_CONFIG.language,
  };
}
