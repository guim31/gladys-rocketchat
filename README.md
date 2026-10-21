# Rocket.Chat for Gladys Assistant

An external integration for [Gladys Assistant](https://gladysassistant.com)
that connects a bot account of [Rocket.Chat](https://www.rocket.chat), the
open-source team chat you can host yourself, to Gladys: talk to Gladys in a
direct message, receive the messages of Gladys there, post in Rocket.Chat
channels from your scenes, and start scenes on a message or a command such as
`!lights off`. Works with a server on the local network or on the Internet.

> **Developed without the hardware: feedback welcome.** The integration was
> tested against a real Rocket.Chat server (the official 8.9 image with
> MongoDB, in Docker), in both directions, but not inside a real Gladys nor
> with every Rocket.Chat client. Please report what works and what does not in
> the [issues](https://github.com/guim31/gladys-rocketchat/issues) or on the
> [Gladys forum](https://community.gladysassistant.com).

## Features

- **A two-way chat channel**, like the Telegram bot of Gladys (manifest
  `type: "communication"`, `messaging.receive: true`): each Gladys user links
  their Rocket.Chat account with a code from the Configuration screen, then
  talks to Gladys in a direct message with the bot. The answers of Gladys, the
  _Send Message_ scene action and the system messages arrive there; camera
  images arrive as images.
- **Allowed people only**: the bot ignores the messages of everyone who is not
  in the list of usernames, which is empty by default. Gladys never answers in
  a channel or a direct message with several people, where others can read.
- **Scene triggers**: _Rocket.Chat message received_ (in a watched channel,
  filtered by channel and sender), _Rocket.Chat command received_ (prefix +
  word, e.g. `!garage close`, with the arguments as a variable), _Rocket.Chat
  connection lost_, _Rocket.Chat connection restored_.
- **Scene action** _Send a Rocket.Chat message_: Markdown and scene variables,
  to a channel (`#name`, its address or its id) or to a person (`@alice`).
  Outputs: sent, message id, error.
- **Dashboard widget** _Rocket.Chat_: connection, bot account, watched
  channels, the last messages of the watched channels, a _Test the connection_
  button.
- Real time over the DDP API of Rocket.Chat, automatic reconnection, and the
  messages of the last 5 minutes read back after a cut.
- Four languages (English, French, German, Spanish).

Compared with [Apprise for Gladys](https://github.com/guim31/gladys-apprise),
which sends notifications to Rocket.Chat among 100 other services, this
integration also receives: conversations with Gladys, commands and triggers.
It follows the design of
[Mattermost for Gladys](https://github.com/guim31/gladys-mattermost): same
triggers, action and safeguards.

## Requirements

- Gladys Assistant **5.1.0** or later.
- A Rocket.Chat server Gladys can reach (tested with 8.9), and a user for the
  bot (roles `bot` and `user`) with a personal access token.

## Installation

In Gladys: **Integrations → Install from GitHub**, then enter
`https://github.com/guim31/gladys-rocketchat`. Fill in the server address, the
user id and the personal access token of the bot, and the allowed people,
click **Test the connection**, then each user links their account. The full
documentation is in [docs/en.md](docs/en.md) (also in [French](docs/fr.md),
[German](docs/de.md) and [Spanish](docs/es.md)).

## How it works

- REST API v1 with the personal access token (`X-User-Id`, `X-Auth-Token`):
  `GET /me`, `GET /users.info` (the allowed people, by username, kept by id),
  `GET /rooms.info`, `GET /subscriptions.getOne` and `POST /channels.join`
  (the bot joins a public watched channel), `POST /im.create`,
  `POST /chat.postMessage`, `POST /rooms.media` + `/rooms.mediaConfirm`
  (camera images), `GET /chat.syncMessages` (catch-up after a cut). A 429 is
  honored.
- DDP over the WebSocket `/websocket`: `connect`, `login` with
  `{ resume: <token> }`, then `stream-room-messages` with `__my_messages__`,
  which pushes every message of every room the bot is in. Pings both ways,
  every 30 s on our side. Node's built-in WebSocket: no dependency but the
  Gladys SDK.
- Watched channels fire the triggers only; a message in the 1:1 direct room of
  the bot and an allowed person is a conversation with Gladys (`linkContact`,
  `publishMessage`, `onSendMessage`); anything else is ignored. The bot's own
  messages, system messages and messages of incoming webhooks and apps (field
  `bot`, even when they post in the name of a person) are ignored, so a scene
  answering a message cannot loop, and a webhook URL cannot talk to the brain.

## Limits

- Text only: files, images and voice messages sent to the bot are ignored.
- Threads are read as ordinary messages; the answers are not threaded.
- One bot account per Gladys. Messages missed during a cut longer than
  5 minutes are skipped.
- 5000 characters per message by default: longer answers are cut.

## Development

```bash
npm install
npm test            # node --test, against the fake Gladys of the SDK and a fake Rocket.Chat
npm run lint
npm run format:check
npx -y github:GladysAssistant/integration-store --skip-image-check .
```

## Credits

- The [Rocket.Chat developer documentation](https://developer.rocket.chat/apidocs)
  (REST v1 and the real-time API). The test fixtures are answers recorded from
  a real Rocket.Chat 8.9 server running in Docker (ids and tokens replaced).
- The [Home Assistant `rocketchat` notify platform](https://www.home-assistant.io/integrations/rocketchat/)
  (Apache-2.0), built on [rocketchat_API](https://github.com/jadolg/rocketchat_API)
  (MIT): the shape of the configuration (server, account, room). No code was
  copied.
- The logo on the cover is the Rocket.Chat logo from the
  [Rocket.Chat repository](https://github.com/RocketChat/Rocket.Chat)
  (`apps/meteor/public/images/logo/logo.svg`, MIT; a trademark of Rocket.Chat
  Technologies Corp.), recolored white on the brand red.
- The architecture, the `/data` store and the quiet logs come from
  [gladys-mattermost](https://github.com/guim31/gladys-mattermost) and
  [gladys-matrix](https://github.com/guim31/gladys-matrix); the tests follow
  [gladys-wled](https://github.com/guim31/gladys-wled).

## Disclaimer

This project is not affiliated with, endorsed or sponsored by Rocket.Chat
Technologies Corp. Rocket.Chat is a trademark of Rocket.Chat Technologies Corp.

## License

Apache-2.0
