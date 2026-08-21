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

### `liveSync.subscribe(file, res, { lane } = {})`

Register an SSE response object to receive updates for a file.

- `file` - Full identity key. On the platform, `{username}:{path/name.ext}`;
  in hyperclay-local, `{path/name.ext}`. Always includes the extension.
- `res` - Express response object (SSE connection)
- `lane` - `'live'` (default), `'saved'`, or `'all'`

### `liveSync.unsubscribe(file, res)`

Remove an SSE response from a file's subscribers.

### `liveSync.broadcast(file, { html, sender, identityMap }, { lane } = {})`

Send an update to all clients subscribed to a file.

- `file` - Full identity key, same form as `subscribe`
- `html` - Full document HTML, not body innerHTML
- `sender` - Client ID, or a server-side origin like `'file-watcher'`
- `identityMap` - Optional opaque element-identity map, forwarded as-is.
  Omitted entirely when undefined, so the wire stays byte-identical for
  senders that don't set it.
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
