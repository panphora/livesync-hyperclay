# Changelog

## [0.15.0] - 2026-08-30

### Added
- `broadcast` forwards an optional `etag` on the payload, the way it already forwards
  `identityMap`: attached only when defined, so the wire stays byte-identical for a sender
  that does not send one.

  This is the version stamp of what a host stored (Malleable HTML File spec §6). It rides ON
  a content frame and can never travel alone, because `broadcast` refuses a payload whose
  `html` is not a string. That is deliberate and it is the point: a receiver may only adopt a
  stamp as part of applying the content that stamp describes. A stamp arriving by itself would
  tell a tab it is in step with disk without giving it the bytes to be in step with, and its
  next save would then overwrite a save it had never received.

## [0.14.3] - 2026-08-21

### Changed
- Updated livesync-hyperclay



## [Unreleased]

### Changed
- License: relicensed to MIT-0 (MIT No Attribution). Same rights, attribution no longer required.

### Fixed
- Added the LICENSE file (MIT, as package.json has always declared); published tarballs now carry the license text.



## [0.14.2] - 2026-08-11

### Added
- Declare kind, status, and url in the hyper key

### Fixed
- Corrected the saved-lane comments



## [0.14.0] - 2026-07-13

### Added
- Lane-based broadcasting to live-sync
- Optional structured data payload to notify()



## [0.13.0] - 2026-07-02

### Added
- Per-subscriber lanes on the per-file channel: `subscribe(file, res, { lane: 'live' | 'saved' })`. `broadcast()` and `notify()` take `{ lane: 'live' | 'saved' | 'all' }` and only write to matching subscribers. Defaults everywhere are `'live'`, so existing callsites and old clients behave exactly as before. The `saved` lane carries only post-strip on-disk HTML for view-mode tabs; pre-strip snapshots, notifications, and collection-record events stay on `live`.

## [0.12.0] - 2026-06-03

### Added
- `closeChannel(file)` force-disconnects every open SSE stream on a channel and drops it, so a share revoke can fail-closed an already-open viewer (the reconnect re-authenticates and 403s). Unit tests cover the empty-channel, single, and multi-subscriber cases plus error isolation.

## [0.11.0] - 2026-06-01

### Added
- `broadcastCollectionRecord()` so collection record create/update/delete events fan out over live-sync to open dashboards

## [0.10.1] - 2026-05-06

### Added
- Forward optional `identityMap` on broadcast (browser-channel only)

## [0.10.0] - 2026-04-20

### Added
- livesync handling in index.js with unit test coverage

### Changed
- writeToAll refactor, full-path key docs, unit tests



## [0.9.1] - 2026-04-15

### Changed
- Extracted `writeToAll()` helper to centralize dead-connection cleanup across all broadcast methods
- Updated channel key documentation throughout: keys are now full paths with extension (`blog/post.html`); platform callers prefix with `{username}:`, hyperclay-local callers pass the path directly
- Updated `markBrowserSave` / `wasBrowserSave` docs to reflect full-path-with-extension key format

### Added
- Jest unit tests (27 tests) covering key isolation, multi-subscriber delivery, dead-connection cleanup, node lifecycle broadcasts, and stats

## [0.9.0] - 2026-04-08

### Changed
- Extended broadcastNodeMoved with oldName/newName parameters to support atomic move+rename operations

### Fixed
- Removed stale broadcastFileSaved JSDoc comment left above broadcastNodeSaved

### Breaking Changes
- Replaced broadcastFile* methods with broadcastNode* methods



## [0.8.0] - 2026-02-26

### Added
- Broadcast methods for file rename, move, and delete events



## [0.7.1] - 2026-01-31

### Added
- Browser save tracking to prevent duplicate notifications



## [0.7.0] - 2026-01-22

### Changed
- Add sync engine subscriptions and notification support



## [0.6.0] - 2026-01-10

### Added
- Full document sync API with html and sender parameters

### Changed
- Removed release.sh script


