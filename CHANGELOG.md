# Changelog

## [0.16.0] - 2026-09-06

Everything a host needs to answer "who is on this document, and which of them
should stop receiving", without this package learning what a person is. It
stores facts the caller hands it and hands them back unread; the caller decides.

### Added
- `subscribe(file, res, { lane, meta })` stores an **opaque** `meta` against the
  connection, and `subscribers(file)` iterates `{ res, lane, meta }` over a
  snapshot, so a consumer may remove connections as it walks. Nothing here reads
  `meta`. Passing none is not an error: a caller that ignores it behaves exactly
  as before.
- `onRemove(handler)` fires `handler(file, { lane, meta })` once for every
  connection that leaves a file channel, whichever path removed it. Returns a
  function that unregisters it. A handler that throws is logged and skipped
  rather than allowed to wedge a teardown.
- `closeWhere(file, predicate)` ends exactly the connections whose metadata
  matches and leaves the rest receiving, which is what a demotion needs: closing
  someone's editing tabs must not close the tabs they are still allowed to read
  from. Matching runs over the whole channel before anything closes, so a
  predicate that throws leaves it as it found it. There is deliberately no
  reverse index from metadata to connections: a per-file channel is a few dozen
  connections and this scans it, whereas an index is the thing that goes stale.

  **A connection carrying no metadata never matches, and the predicate is not
  called for it.** `meta` is optional and hyperclay-local passes none, so
  otherwise the natural predicate form `m => m.personId === id` throws on one,
  and `m => !m.canView` silently closes every one of them. `closeChannel`
  remains the way to end every stream on a file.
- `writeEvent(file, name, build)` writes a **named** SSE event built per
  recipient: `build({ lane, meta })` returns that connection's payload, or
  `null` to send it nothing. `broadcast` serializes one message for everyone and
  so cannot answer "what may this particular connection be told".

  Every frame it writes carries its `event:` field, and the name is refused
  rather than defaulted, so there is no path that writes a bare `data:` line.
  Every connection on a channel receives these frames whether or not it listens
  for the name, and one written without its name lands on a client's default
  `onmessage` handler, which reads a frame as a document.
- `broadcast` forwards an optional opaque `by` author stamp, on the `'live'`
  lane only, beside the same rule for `etag`. The saved lane carries whole
  documents to whoever may view the page, which on a public document is anyone,
  so an author on a saved-lane frame names the writer to a stranger. Enforced
  here rather than left to each caller, because a host that forgets the rule
  leaks the name with nothing failing.

### Changed
- One internal removal path. A connection used to leave a channel three
  different ways — `unsubscribe`, `closeChannel`, and a write that threw, which
  deleted straight out of the Set without the request's own `close` handler ever
  firing. They now all go through one function, so `onRemove` sees every
  departure, **including the dropped-write one**, and sees it exactly once:
  membership in the channel is the record of "still here", so the `unsubscribe`
  a server runs after `closeChannel` ended a response fires nothing further.
- `writeToAll` takes an options object `{ lane, file }` rather than a bare lane.
  `file` is the channel key a dropped connection leaves through, and is `null`
  for user-level channels, which are not file channels and keep their direct Set
  delete.

### Fixed
- A failed write that took the last connection on a channel left the empty
  channel behind in the map forever. It now drops with its last connection, the
  same as an unsubscribe.

## [0.15.1] - 2026-08-31

### Fixed
- `broadcast` forwards `etag` on the `live` lane only. The saved lane is viewers, and a
  viewer holds a whole document rather than a pre-strip snapshot and makes no saves, so a
  stamp there is a version claim handed to a page that can never have earned it. 0.15.0
  attached it to whichever lane the caller named. Nothing else changes: the field is still
  attached only when defined, and still only ever alongside content.

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


