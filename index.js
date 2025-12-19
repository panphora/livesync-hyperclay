/**
 * livesync-hyperclay/index.js
 *
 * Server-side LiveSync: SSE broadcasting + file watching
 *
 * WHAT THIS FILE DOES:
 * 1. Watches HTML files for changes (local mode)
 * 2. Provides SSE endpoint for browsers to connect
 * 3. Broadcasts changes to all connected browsers
 * 4. Accepts changes from browsers and writes to files
 */

const chokidar = require('chokidar');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Track SSE connections per file
// Structure: Map<filename, Set<response>>
const clients = new Map();

// Track who initiated the last save (for sender attribution)
// Structure: Map<filename, clientId>
const lastSender = new Map();

// In-memory state for hosted mode (no file system)
// Structure: Map<filename, { body: string, headHash: string }>
const memoryState = new Map();

/**
 * Setup live sync endpoints and optional file watcher
 *
 * @param {Express} app - Express app instance
 * @param {Object} options - Configuration options
 * @param {string|null} options.baseDir - Base directory for file watching (null = hosted mode)
 * @param {Function} options.checkAccess - Auth callback: async (req, file) => boolean
 * @param {number} options.maxPayloadSize - Max body size in bytes (default: 10MB)
 * @param {string} options.prefix - Route prefix (default: '/live-sync')
 *
 * @returns {{ watcher, clients, getRealtimeStats }}
 */
function setupLiveSync(app, options = {}) {
  const {
    baseDir = null,
    checkAccess = null,
    maxPayloadSize = 10 * 1024 * 1024,
    prefix = '/live-sync'
  } = options;

  const isLocalMode = !!baseDir;
  let watcher = null;

  // File watcher (local mode only)
  if (isLocalMode) {
    watcher = chokidar.watch('**/*.html', {
      cwd: baseDir,
      persistent: true,
      ignoreInitial: true,
      ignored: ['**/node_modules/**', '**/sites-versions/**', '**/.*'],
      awaitWriteFinish: {
        stabilityThreshold: 300
      }
    });

    watcher.on('change', async (filename) => {
      const subs = clients.get(filename);
      if (!subs || subs.size === 0) return;

      try {
        const filepath = path.join(baseDir, filename);
        const content = await fs.promises.readFile(filepath, 'utf8');
        const { body, headHash } = extractBodyAndHead(content);

        const sender = lastSender.get(filename) || 'file-system';
        lastSender.delete(filename);

        broadcast(filename, body, headHash, sender);
      } catch (err) {
        console.error('[LiveSync] Error broadcasting:', err.message);
      }
    });

    console.log(`[LiveSync] Watching ${baseDir} for HTML changes`);
  } else {
    console.log(`[LiveSync] Running in hosted mode (no file watching)`);
  }

  /**
   * Extract body innerHTML and head hash from full HTML
   */
  function extractBodyAndHead(content) {
    const bodyMatch = content.match(/<body[^>]*>([\s\S]*)<\/body>/i);
    const headMatch = content.match(/<head[^>]*>([\s\S]*)<\/head>/i);

    const body = bodyMatch ? bodyMatch[1] : content;
    const headHash = headMatch
      ? crypto.createHash('md5').update(headMatch[1]).digest('hex').slice(0, 8)
      : null;

    return { body, headHash };
  }

  /**
   * Broadcast to all clients watching a specific file
   */
  function broadcast(file, body, headHash, sender) {
    const subs = clients.get(file);
    if (!subs || subs.size === 0) return;

    const message = `data: ${JSON.stringify({ body, headHash, sender })}\n\n`;
    const deadConnections = [];

    subs.forEach(res => {
      try {
        res.write(message);
      } catch (e) {
        deadConnections.push(res);
      }
    });

    deadConnections.forEach(res => subs.delete(res));

    console.log(`[LiveSync] Broadcast to ${subs.size} client(s): ${file} (sender: ${sender})`);
  }

  // SSE endpoint - receive updates
  app.get(`${prefix}/stream`, async (req, res) => {
    const file = req.query.file;

    if (!file) {
      return res.status(400).send('Missing file parameter');
    }

    if (checkAccess) {
      const hasAccess = await checkAccess(req, file);
      if (!hasAccess) {
        return res.status(403).send('Access denied');
      }
    }

    // SSE headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });

    // Track connection
    if (!clients.has(file)) {
      clients.set(file, new Set());
    }
    clients.get(file).add(res);
    console.log(`[LiveSync] Client connected: ${file} (${clients.get(file).size} total)`);

    // Send existing state to new client (hosted mode)
    if (!isLocalMode && memoryState.has(file)) {
      const { body, headHash } = memoryState.get(file);
      res.write(`data: ${JSON.stringify({ body, headHash, sender: 'initial' })}\n\n`);
    }

    // Keep-alive ping every 30 seconds
    const keepAlive = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch (e) {
        clearInterval(keepAlive);
      }
    }, 30000);

    // Cleanup on disconnect
    req.on('close', () => {
      clearInterval(keepAlive);
      clients.get(file)?.delete(res);
      console.log(`[LiveSync] Client disconnected: ${file}`);

      // Clean up empty rooms after delay (hosted mode)
      if (!isLocalMode && clients.get(file)?.size === 0) {
        setTimeout(() => {
          if (clients.get(file)?.size === 0) {
            clients.delete(file);
            memoryState.delete(file);
            console.log(`[LiveSync] Cleaned up state for ${file}`);
          }
        }, 60000);
      }
    });

    // Connection established
    res.write(': connected\n\n');
  });

  // Save endpoint - write browser changes
  app.post(`${prefix}/save`, async (req, res) => {
    const { file, body, sender } = req.body;

    if (!file || body === undefined || !sender) {
      return res.status(400).json({ error: 'Missing file, body, or sender' });
    }

    if (body.length > maxPayloadSize) {
      return res.status(413).json({ error: `Body too large (max ${maxPayloadSize} bytes)` });
    }

    if (checkAccess) {
      const hasAccess = await checkAccess(req, file);
      if (!hasAccess) {
        return res.status(403).json({ error: 'Access denied' });
      }
    }

    if (isLocalMode) {
      // Local mode: write to file
      // Security: prevent path traversal
      if (file.includes('..') || !file.match(/^[\w\-\/]+\.html$/)) {
        return res.status(400).json({ error: 'Invalid filename' });
      }

      const filepath = path.join(baseDir, file);

      // Check file exists (don't create new files via sync)
      try {
        await fs.promises.access(filepath);
      } catch {
        return res.status(404).json({ error: 'File not found' });
      }

      try {
        const content = await fs.promises.readFile(filepath, 'utf8');
        const newContent = content.replace(
          /(<body[^>]*>)([\s\S]*)(<\/body>)/i,
          `$1${body}$3`
        );

        lastSender.set(file, sender);
        await fs.promises.writeFile(filepath, newContent, 'utf8');

        console.log(`[LiveSync] Saved: ${file} (from: ${sender})`);
        res.json({ success: true });
      } catch (err) {
        console.error('[LiveSync] Save error:', err.message);
        res.status(500).json({ error: 'Failed to save file' });
      }
    } else {
      // Hosted mode: store in memory and broadcast
      const headHash = memoryState.get(file)?.headHash || null;
      memoryState.set(file, { body, headHash });
      broadcast(file, body, headHash, sender);
      console.log(`[LiveSync] Broadcast: ${file} (from: ${sender})`);
      res.json({ success: true });
    }
  });

  // Debug endpoint
  app.get(`${prefix}/debug`, (req, res) => {
    const file = req.query.file;

    const state = {};
    memoryState.forEach((data, key) => {
      if (!file || key === file) {
        state[key] = {
          length: data.body.length,
          preview: data.body.substring(0, 100) + (data.body.length > 100 ? '...' : '')
        };
      }
    });

    const rooms = [];
    clients.forEach((room, id) => {
      if (!file || id === file) {
        rooms.push({ id, connections: room.size });
      }
    });

    res.json({
      mode: isLocalMode ? 'local' : 'hosted',
      filter: file || 'all',
      rooms,
      stateKeys: Object.keys(state).length,
      state
    });
  });

  // Stats endpoint
  app.get(`${prefix}/stats`, (req, res) => {
    res.json(getRealtimeStats());
  });

  function getRealtimeStats() {
    let totalConnections = 0;
    clients.forEach(room => {
      totalConnections += room.size;
    });

    return {
      mode: isLocalMode ? 'local' : 'hosted',
      rooms: clients.size,
      connections: totalConnections,
      stateKeys: memoryState.size
    };
  }

  return { watcher, clients, getRealtimeStats };
}

module.exports = { setupLiveSync };
