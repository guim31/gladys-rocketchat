# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- Talk to Gladys from Rocket.Chat: each Gladys user links their Rocket.Chat
  account with a code, then writes to the bot in a direct message; the answers
  of Gladys, the _Send Message_ scene action and the system messages arrive
  there, camera images included.
- A list of allowed people (usernames): the bot ignores everyone else. Empty by
  default.
- Watched channels and the _Rocket.Chat message received_ and _Rocket.Chat
  command received_ triggers (`!lights off`: command `lights`, arguments
  `off`).
- The _Send a Rocket.Chat message_ scene action, to a channel (`#name`, its
  address or its id) or to a person (`@alice`), with the outputs sent, message
  id and error.
- The _Rocket.Chat connection lost_ and _Rocket.Chat connection restored_
  triggers, and the connection status of the Configuration screen.
- The _Rocket.Chat_ dashboard widget and the _Test the connection_ action.
- Real-time messages over the DDP API of Rocket.Chat, automatic reconnection,
  and the messages of the last 5 minutes read back after a cut.
- English, French, German and Spanish.
