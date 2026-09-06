# livesync-hyperclay

Stateless utility module for managing SSE client connections. Used by Hyperclay™ and Hyperclay Local for real-time collaborative editing.

## Features

- **SSE connection management** - Track subscribers per file
- **Broadcast updates** - Push changes to all connected browsers
- **Zero dependencies** - Pure JavaScript, no native modules

## Installation

```bash
npm install livesync-hyperclay
```

## Usage

### Basic Example

```javascript
const { liveSync } = require('livesync-hyperclay');

// SSE stream endpoint
app.get('/_/live-sync/stream', (req, res) => {
  const file = req.query.file;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.flushHeaders();

  liveSync.subscribe(file, res);

  req.on('close', () => {
    liveSync.unsubscribe(file, res);
  });

  res.write(': connected\n\n');
});

// Save endpoint
app.post('/_/live-sync/save', (req, res) => {
  const { file, html, sender } = req.body;

  liveSync.broadcast(file, { html, sender });

  res.json({ success: true });
});
```

## API

### `liveSync.subscribe(file, res, { lane, meta } = {})`

Register an SSE response object to receive updates for a file.

- `file` - Full identity key. On the platform, `{username}:{path/name.ext}`;
  in hyperclay-local, `{path/name.ext}`. Always includes the extension.
- `res` - Express response object (SSE connection)
- `lane` - `'live'` (default), `'saved'`, or `'all'`
- `meta` - Optional, opaque. Stored against this connection and handed back
  unread by `subscribers()` and the `onRemove` hook. The library never looks
  inside it, so a host can put whatever it needs there — who the connection
  belongs to, what it may see — without this package growing a concept of
  people. Passing none is not an error.

### `liveSync.unsubscribe(file, res)`

Remove an SSE response from a file's subscribers.

### `liveSync.subscribers(file)`

Iterate the connections currently on a file channel, yielding
`{ res, lane, meta }` per connection. An unknown channel yields nothing.
Iteration walks a snapshot, so a consumer may remove connections as it goes.

### `liveSync.onRemove(handler)`

Register `handler(file, { lane, meta })`, called once for every connection that
leaves a file channel. Returns a function that unregisters it.

There are three ways to leave and this hook sees all of them: `unsubscribe()`,
`closeChannel()`, and a write that threw, which drops the connection without
the request's `close` handler ever firing. Exactly once per connection, so the
`unsubscribe()` a server runs after `closeChannel()` ends the response fires
nothing further. A handler that throws is logged and skipped rather than
allowed to wedge the teardown.

User-level channels (`subscribeUser`) are not file channels and do not fire it.

### `liveSync.closeWhere(file, predicate)`

End exactly the connections on a file channel whose metadata matches, leaving
the rest receiving. Returns the number of responses closed. Connection
lifecycle only: the caller owns the access decision and writes it as a
predicate over the `meta` it stored at subscribe time.

```javascript
liveSync.closeWhere(key, m => m.personId === id);                     // that person, every tab
liveSync.closeWhere(key, m => m.personId === id && m.lane === 'live'); // their editing tabs only
liveSync.closeWhere(key, m => m.shareLinkId === id);                   // a revoked link's guests
```

**A connection with no metadata never matches, and the predicate is not called
for it.** It carries nothing to identify it by, so it keeps receiving.
`meta` is optional and hyperclay-local passes none at all, so this is what
keeps the natural predicate form `m => m.personId === id` from throwing on one
and `m => !m.canView` from silently closing every one of them. To end every
stream on a file regardless, use `closeChannel`.

Matching runs over the whole channel before anything closes, so a predicate
that throws leaves the channel exactly as it found it. Every close goes
through the same removal path as `unsubscribe`, so `onRemove` fires once per
departure.

### `liveSync.writeEvent(file, name, build)`

Write a **named** SSE event to a file channel, built per recipient. `build` is
called once per connection as `build({ lane, meta })` and returns that
connection's payload, or `null` to send it nothing at all. Returns the number
of connections written to.

```javascript
liveSync.writeEvent(key, 'presence', ({ meta }) => (
  meta?.canView ? { people, anonymous: 0 } : { people: [], anonymous: total }
));
```

`broadcast` and `notify` serialize one message for everyone, so neither can
answer "what may this particular connection be told". That is the whole reason
this exists.

Every frame it writes carries its `event:` field. That matters more than it
looks: every connection on a channel receives this whether or not it listens
for the name, and a frame written without its name lands on a client's default
`onmessage` handler, which reads a frame as a document. The name is therefore
refused rather than defaulted — it must be a non-empty string with no newline.

Nothing is added to the payload; what `build` returns is what goes on the wire.
A connection whose write throws is dropped the same way every other write drops
one, firing `onRemove`.

### `liveSync.broadcast(file, { html, sender, identityMap, etag, by }, { lane } = {})`

Send an update to all clients subscribed to a file.

- `file` - Full identity key, same form as `subscribe`
- `html` - Full document HTML, not body innerHTML
- `sender` - Client ID, or a server-side origin like `'file-watcher'`
- `identityMap` - Optional opaque element-identity map, forwarded as-is.
  Omitted entirely when undefined, so the wire stays byte-identical for
  senders that don't set it.
- `etag` - Optional version stamp of what the host stored for these bytes.
  Forwarded as-is, **on the `'live'` lane only**.
- `by` - Optional opaque author stamp for this frame, forwarded as-is,
  **on the `'live'` lane only**. The saved lane carries whole documents to
  whoever may view the page, which on a public document is anyone; an author
  there names the writer to a stranger. Enforced here rather than left to each
  caller.
- `lane` - `'live'` (default), `'saved'`, or `'all'`. Pre-strip snapshots
  must stay on `'live'`; only post-strip on-disk HTML may go to `'saved'`
  or `'all'`.

`html` must be a string. Anything else is refused with a logged error and
no broadcast, so a wrong key name fails silently at the network layer.

Each delivered payload also carries a monotonic `seq` the library assigns.

### `liveSync.getStats()`

Returns connection statistics:

```javascript
{
  rooms: 3,            // Number of files with active connections
  connections: 7,      // Total file-level connected clients
  userConnections: 2   // Total user-level connected clients
}
```

### Other methods

The user-level and node-level broadcast surface is not documented here yet:
`subscribeUser`, `unsubscribeUser`, `broadcastToUser`, `broadcastNodeSaved`,
`broadcastNodeRenamed`, `broadcastNodeMoved`, `broadcastNodeDeleted`,
`notify`, `broadcastCollectionRecord`, `closeChannel`, `markBrowserSave`,
and `wasBrowserSave`. See the JSDoc in `index.js` for their signatures.

`closeChannel(file)` ends every stream on a channel and drops it; it is the
blunt instrument `closeWhere` refines.

## Integration

### hyperclay (hosted)

Routes are handled by the routing table in `hey.js`. The handlers call `liveSync.subscribe()`, `liveSync.unsubscribe()`, and `liveSync.broadcast()`.

### hyperclay-local

Routes and file watching are set up in `server.js`. When files change on disk, Chokidar detects the change and calls `liveSync.broadcast()`.

## Client Setup

Include the LiveSync client via CDN:

```html
<script type="module" src="https://cdn.jsdelivr.net/npm/hyperclayjs@latest/hyperclay.js?features=live-sync"></script>
```

## Testing

### Test 1: Multi-Browser Sync

1. Open `http://localhost:4321/test.html` in Browser A
2. Open same URL in Browser B
3. Make an edit in Browser A
4. Browser B should update instantly

### Test 2: File Edit Detection (hyperclay-local)

1. Open a page in the browser
2. Edit the HTML file in a text editor
3. Save the file
4. Browser should update instantly without refresh

### Test 3: Path Traversal Rejection

```bash
# Should return 400 error
curl -X POST http://localhost:4321/_/live-sync/save \
  -H "Content-Type: application/json" \
  -d '{"file":"../etc/passwd","body":"test","sender":"test"}'
```

## Troubleshooting

### "Idiomorph not available" warning

Ensure hyperclayjs loads the idiomorph dependency:
- Use `?features=live-sync` (idiomorph auto-loads as dependency)
- Or manually: `?features=idiomorph,live-sync`

### SSE connection keeps dropping

Check for proxy buffering. The server sets `X-Accel-Buffering: no` but you may also need:

```nginx
proxy_buffering off;
```
