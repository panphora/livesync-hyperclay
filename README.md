# livesync-hyperclay

Real-time HTML sync server for hyperclay. Provides SSE endpoints and file watching for instant browser updates when files change.

## Features

- **SSE broadcasting** - Push updates to connected browsers instantly
- **File watching** - Detect changes via Chokidar (local mode)
- **Bidirectional sync** - Browser edits sync back to file
- **Echo loop prevention** - Client IDs prevent infinite loops
- **Head change detection** - Triggers full reload when CSS/JS changes

## Installation

```bash
cd livesync-hyperclay
npm install
```

For hyperclay-local integration:

```bash
cd hyperclay-local
npm install
```

## Usage

### Server Setup (hyperclay-local)

The server is already integrated in `hyperclay-local/src/main/server.js`:

```javascript
const { setupLiveSync } = require('livesync-hyperclay');

// After Express app setup
app.use('/live-sync', express.json({ limit: '10mb' }));
setupLiveSync(app, { baseDir });
```

### Client Setup (HTML pages)

**For local development (hyperclay-local):** Include the LiveSync client via CDN:

```html
<script type="module" src="https://cdn.jsdelivr.net/npm/hyperclayjs@latest/hyperclay.js?features=live-sync"></script>
```

Or with the everything preset:

```html
<script type="module" src="https://cdn.jsdelivr.net/npm/hyperclayjs@latest/hyperclay.js?preset=everything"></script>
```

**For hosted mode (hyperclay):** The script is typically included in the layout templates.

## API

### Server Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/live-sync/stream?file=X` | GET | SSE stream for file updates |
| `/live-sync/save` | POST | Save browser changes to file |
| `/live-sync/debug` | GET | Debug info (rooms, connections) |
| `/live-sync/stats` | GET | Statistics (room count, etc.) |

### POST /live-sync/save

Request body:
```json
{
  "file": "index",
  "body": "<div>content</div>",
  "sender": "client-id-abc123",
  "headHash": "a1b2c3d4"
}
```

**Note:** The `file` parameter is a site identifier (e.g., `index`, `about`, `pages/contact`), not a filename. Do not include the `.html` extension.

### Client API

```javascript
// Access via window.hyperclay.liveSync
const liveSync = window.hyperclay.liveSync;

// Manual control
liveSync.stop();
liveSync.start('other-page');  // Site identifier, not filename

// Callbacks
liveSync.onConnect = () => console.log('Connected');
liveSync.onDisconnect = () => console.log('Disconnected');
liveSync.onUpdate = ({ body, sender }) => console.log('Update from', sender);
liveSync.onError = (err) => console.error('Error', err);
```

### Rate Limiting

The server enforces a rate limit of **10 saves per second per client**. Exceeding this limit returns a `429 Too Many Requests` response with a `Retry-After` header.

## Manual Testing

### Prerequisites

1. Install dependencies:
   ```bash
   npm -C livesync-hyperclay install
   npm -C hyperclay-local install
   ```

2. Regenerate hyperclayjs module graph:
   ```bash
   cd hyperclayjs && node build/generate-dependency-graph.js
   ```

### Test 1: External File Edit

1. Start hyperclay-local: `npm start` (or `npm run dev`)
2. Create a test file in your site directory:
   ```html
   <!DOCTYPE html>
   <html>
   <head>
     <title>LiveSync Test</title>
     <script type="module" src="/hyperclayjs/src/hyperclay.js?features=live-sync"></script>
   </head>
   <body>
     <h1>LiveSync Test</h1>
     <p>Edit this file externally!</p>
     <input type="text" placeholder="Type here...">
   </body>
   </html>
   ```
3. Open `http://localhost:4321/test.html` in browser
4. Edit `test.html` in a text editor, change the `<p>` text
5. Save the file

**Expected:** Browser updates instantly without refresh. Input focus preserved.

### Test 2: Multi-Browser Sync

1. Open `http://localhost:4321/test.html` in Browser A
2. Open same URL in Browser B
3. In Browser A DevTools Console, run:
   ```javascript
   document.querySelector('p').textContent = 'Changed from A';
   ```
4. Observe Browser B

**Expected:** Browser B shows the change instantly.

### Test 3: Echo Loop Prevention

1. Open browser DevTools Console
2. Watch for `[LiveSync] Sending update` and `[LiveSync] Received update from:` logs
3. Make an edit in the browser

**Expected:** You see "Sending update" but NOT "Received update from: [your-client-id]"

### Test 4: Path Traversal Rejection

```bash
# Should return 400 error
curl -X POST http://localhost:4321/live-sync/save \
  -H "Content-Type: application/json" \
  -d '{"file":"../../../etc/passwd","body":"test","sender":"test"}'

curl -X POST http://localhost:4321/live-sync/save \
  -H "Content-Type: application/json" \
  -d '{"file":"/absolute/path","body":"test","sender":"test"}'

# Including .html extension should also be rejected
curl -X POST http://localhost:4321/live-sync/save \
  -H "Content-Type: application/json" \
  -d '{"file":"test.html","body":"test","sender":"test"}'
```

**Expected:** All return `{"error":"..."}` with 400 status.

### Test 5: Missing Body Tag Rejection

1. Create a file without `<body>` tags:
   ```html
   <html><head></head>no body tags here</html>
   ```
2. Try to save via LiveSync

**Expected:** Returns 422 error "File does not contain `<body>...</body>` tags"

### Test 6: Debug Endpoint

```bash
curl http://localhost:4321/live-sync/debug
```

**Expected:** JSON with rooms, connections, mode info.

## Configuration

```javascript
setupLiveSync(app, {
  baseDir: '/path/to/site',      // null for hosted mode
  checkAccess: async (req, file) => true,  // Auth callback
  maxPayloadSize: 10 * 1024 * 1024,        // 10MB default
  prefix: '/live-sync',                     // Route prefix
  maxRooms: 100,                            // Max concurrent files
  maxConnectionsPerRoom: 50                 // Max browsers per file
});
```

## Troubleshooting

### "Idiomorph not available" warning

Ensure hyperclayjs loads the idiomorph dependency. Check that:
- You're using `?features=live-sync` (idiomorph is auto-loaded as dependency)
- Or manually include idiomorph: `?features=idiomorph,live-sync`

### SSE connection keeps dropping

Check for proxy/nginx buffering. The server sets `X-Accel-Buffering: no` but you may need:
```nginx
proxy_buffering off;
```

### Changes not syncing

1. Check browser console for `[LiveSync]` logs
2. Verify the file has `<body>` tags
3. Check `/live-sync/debug` to see active connections
