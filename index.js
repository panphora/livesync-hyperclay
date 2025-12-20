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

// Rate limiting: track saves per client
// Structure: Map<clientId, { count: number, resetTime: number }>
const clientRateLimits = new Map();

// Limits
const MAX_ROOMS = 100;
const MAX_CONNECTIONS_PER_ROOM = 50;
const MAX_SAVES_PER_SECOND = 10;

/**
 * Validate file parameter - accepts site identifier (e.g., "mysite" or "folder/mysite")
 * @param {string} file - The site identifier to validate
 * @returns {{ valid: boolean, error?: string }}
 */
function validateFileParam(file) {
  // Must be a non-empty string
  if (typeof file !== 'string' || file.length === 0) {
    return { valid: false, error: 'File must be a non-empty string' };
  }

  // Max length to prevent abuse
  if (file.length > 255) {
    return { valid: false, error: 'Site identifier too long' };
  }

  // No absolute paths
  if (path.isAbsolute(file)) {
    return { valid: false, error: 'Absolute paths not allowed' };
  }

  // No backslashes (Windows path separator)
  if (file.includes('\\')) {
    return { valid: false, error: 'Backslashes not allowed' };
  }

  // No path traversal
  if (file.includes('..')) {
    return { valid: false, error: 'Path traversal not allowed' };
  }

  // No leading slash
  if (file.startsWith('/')) {
    return { valid: false, error: 'Leading slash not allowed' };
  }

  // No .html extension allowed - file param is a site identifier
  if (file.endsWith('.html')) {
    return { valid: false, error: 'Do not include .html extension - use site identifier only' };
  }

  // Only allow safe characters: alphanumeric, hyphen, underscore, forward slash
  if (!/^[\w\-\/]+$/.test(file)) {
    return { valid: false, error: 'Invalid characters in site identifier' };
  }

  return { valid: true };
}

/**
 * Check rate limit for a client
 * @param {string} clientId - The client ID
 * @param {number} maxPerSecond - Max requests per second
 * @returns {{ allowed: boolean, retryAfter?: number }}
 */
function checkRateLimit(clientId, maxPerSecond = MAX_SAVES_PER_SECOND) {
  const now = Date.now();
  const windowMs = 1000; // 1 second window

  let limit = clientRateLimits.get(clientId);

  if (!limit || now >= limit.resetTime) {
    // Start new window
    clientRateLimits.set(clientId, { count: 1, resetTime: now + windowMs });
    return { allowed: true };
  }

  if (limit.count >= maxPerSecond) {
    const retryAfter = Math.ceil((limit.resetTime - now) / 1000);
    return { allowed: false, retryAfter };
  }

  limit.count++;
  return { allowed: true };
}

/**
 * Resolve and validate file path stays within baseDir
 * Adds .html extension to site identifier for file system operations
 * @param {string} baseDir - The base directory
 * @param {string} file - The site identifier (without .html)
 * @returns {{ valid: boolean, resolved?: string, error?: string }}
 */
function resolveAndValidatePath(baseDir, file) {
  const validation = validateFileParam(file);
  if (!validation.valid) {
    return validation;
  }

  // Add .html extension for file system path
  const filename = file + '.html';
  const resolved = path.resolve(baseDir, filename);
  const resolvedBase = path.resolve(baseDir);

  // Ensure resolved path is within baseDir
  if (!resolved.startsWith(resolvedBase + path.sep) && resolved !== resolvedBase) {
    return { valid: false, error: 'Path escapes base directory' };
  }

  return { valid: true, resolved };
}

/**
 * Validate headHash parameter (short hex string)
 * @param {*} headHash - The headHash to validate
 * @returns {string|null} - Validated headHash or null
 */
function validateHeadHash(headHash) {
  if (typeof headHash !== 'string') return null;
  if (headHash.length === 0 || headHash.length > 32) return null;
  if (!/^[a-f0-9]+$/i.test(headHash)) return null;
  return headHash.toLowerCase();
}

/**
 * Setup live sync endpoints and optional file watcher
 *
 * @param {Express} app - Express app instance
 * @param {Object} options - Configuration options
 * @param {string|null} options.baseDir - Base directory for file watching (null = hosted mode)
 * @param {Function} options.checkAccess - Auth callback: async (req, file) => boolean
 * @param {number} options.maxPayloadSize - Max body size in bytes (default: 10MB)
 * @param {string} options.prefix - Route prefix (default: '/live-sync')
 * @param {number} options.maxRooms - Max concurrent rooms (default: 100)
 * @param {number} options.maxConnectionsPerRoom - Max connections per room (default: 50)
 *
 * @returns {{ watcher, clients, getRealtimeStats }}
 */
function setupLiveSync(app, options = {}) {
  const {
    baseDir = null,
    checkAccess = null,
    maxPayloadSize = 10 * 1024 * 1024,
    prefix = '/live-sync',
    maxRooms = MAX_ROOMS,
    maxConnectionsPerRoom = MAX_CONNECTIONS_PER_ROOM
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
      // Convert filename (e.g., "mysite.html") to site identifier (e.g., "mysite")
      const siteId = filename.replace(/\.html$/, '');
      const subs = clients.get(siteId);
      if (!subs || subs.size === 0) return;

      try {
        const filepath = path.join(baseDir, filename);
        const content = await fs.promises.readFile(filepath, 'utf8');
        const { body, headHash, error } = extractBodyAndHead(content);

        if (error) {
          broadcastError(siteId, error);
          return;
        }

        const sender = lastSender.get(siteId) || 'file-system';
        lastSender.delete(siteId);

        broadcast(siteId, body, headHash, sender);
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
   * @returns {{ body: string|null, headHash: string|null, error?: string }}
   */
  function extractBodyAndHead(content) {
    const bodyMatch = content.match(/<body[^>]*>([\s\S]*)<\/body>/i);
    const headMatch = content.match(/<head[^>]*>([\s\S]*)<\/head>/i);

    if (!bodyMatch) {
      return { body: null, headHash: null, error: 'File does not contain <body> tags' };
    }

    const body = bodyMatch[1];
    const headHash = headMatch
      ? crypto.createHash('md5').update(headMatch[1]).digest('hex').slice(0, 8)
      : null;

    return { body, headHash };
  }

  /**
   * Broadcast to all clients watching a specific file
   * Never sends null body - sends error event instead
   */
  function broadcast(file, body, headHash, sender) {
    const subs = clients.get(file);
    if (!subs || subs.size === 0) return;

    // Never broadcast null body - this should not happen but guard against it
    if (typeof body !== 'string') {
      console.error(`[LiveSync] Refusing to broadcast non-string body for ${file}`);
      return;
    }

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

  /**
   * Broadcast an error event to all clients watching a specific file
   */
  function broadcastError(file, error) {
    const subs = clients.get(file);
    if (!subs || subs.size === 0) return;

    const message = `data: ${JSON.stringify({ error })}\n\n`;
    const deadConnections = [];

    subs.forEach(res => {
      try {
        res.write(message);
      } catch (e) {
        deadConnections.push(res);
      }
    });

    deadConnections.forEach(res => subs.delete(res));

    console.log(`[LiveSync] Broadcast error to ${subs.size} client(s): ${file} - ${error}`);
  }

  // SSE endpoint - receive updates
  app.get(`${prefix}/stream`, async (req, res) => {
    const file = req.query.file;

    // Validate file parameter
    const validation = validateFileParam(file);
    if (!validation.valid) {
      return res.status(400).send(validation.error);
    }

    // Check room limits
    if (!clients.has(file) && clients.size >= maxRooms) {
      return res.status(503).send('Too many active rooms');
    }

    if (clients.has(file) && clients.get(file).size >= maxConnectionsPerRoom) {
      return res.status(503).send('Too many connections for this file');
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

      // Clean up empty rooms (both modes)
      if (clients.get(file)?.size === 0) {
        if (isLocalMode) {
          // Local mode: clean up immediately
          clients.delete(file);
          console.log(`[LiveSync] Cleaned up empty room: ${file}`);
        } else {
          // Hosted mode: clean up after delay (allow reconnects)
          setTimeout(() => {
            if (clients.get(file)?.size === 0) {
              clients.delete(file);
              memoryState.delete(file);
              console.log(`[LiveSync] Cleaned up state for ${file}`);
            }
          }, 60000);
        }
      }
    });

    // Connection established
    res.write(': connected\n\n');
  });

  /**
   * Compute headHash from head content
   * @param {string} head - The <head> innerHTML content
   * @returns {string} - 8-char hex hash
   */
  function computeHeadHash(head) {
    if (typeof head !== 'string' || head.length === 0) {
      return null;
    }
    return crypto.createHash('md5').update(head).digest('hex').slice(0, 8);
  }

  // Save endpoint - write browser changes
  app.post(`${prefix}/save`, async (req, res) => {
    const { file, body, sender, head, headHash } = req.body;

    // Strict type validation
    if (typeof file !== 'string' || file.length === 0) {
      return res.status(400).json({ error: 'file must be a non-empty string' });
    }
    if (typeof body !== 'string') {
      return res.status(400).json({ error: 'body must be a string' });
    }
    if (typeof sender !== 'string' || sender.length === 0) {
      return res.status(400).json({ error: 'sender must be a non-empty string' });
    }

    // Compute headHash from head content if provided, otherwise use provided headHash
    const computedHeadHash = head ? computeHeadHash(head) : validateHeadHash(headHash);

    // Rate limiting (10 saves/second per client)
    const rateCheck = checkRateLimit(sender);
    if (!rateCheck.allowed) {
      res.set('Retry-After', rateCheck.retryAfter);
      return res.status(429).json({ error: 'Too many requests', retryAfter: rateCheck.retryAfter });
    }

    // Byte-size enforcement
    const bodyByteSize = Buffer.byteLength(body, 'utf8');
    if (bodyByteSize > maxPayloadSize) {
      return res.status(413).json({ error: `Body too large (${bodyByteSize} bytes, max ${maxPayloadSize})` });
    }

    if (checkAccess) {
      const hasAccess = await checkAccess(req, file);
      if (!hasAccess) {
        return res.status(403).json({ error: 'Access denied' });
      }
    }

    if (isLocalMode) {
      // Local mode: write to file
      const pathValidation = resolveAndValidatePath(baseDir, file);
      if (!pathValidation.valid) {
        return res.status(400).json({ error: pathValidation.error });
      }

      const filepath = pathValidation.resolved;

      // Check file exists (don't create new files via sync)
      try {
        await fs.promises.access(filepath);
      } catch {
        return res.status(404).json({ error: 'File not found' });
      }

      try {
        const content = await fs.promises.readFile(filepath, 'utf8');

        // Check if file has <body> tag
        if (!/<body[^>]*>[\s\S]*<\/body>/i.test(content)) {
          return res.status(422).json({ error: 'File does not contain <body>...</body> tags' });
        }

        // Use function replacer to avoid $1, $&, etc. being treated as replacement tokens
        const newContent = content.replace(
          /(<body[^>]*>)([\s\S]*)(<\/body>)/i,
          (match, openTag, oldBody, closeTag) => openTag + body + closeTag
        );

        // Verify the replacement actually happened
        if (newContent === content && body !== content.match(/<body[^>]*>([\s\S]*)<\/body>/i)?.[1]) {
          return res.status(422).json({ error: 'Failed to replace body content' });
        }

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

      // Validate file parameter
      const fileValidation = validateFileParam(file);
      if (!fileValidation.valid) {
        return res.status(400).json({ error: fileValidation.error });
      }

      // Check room/state limits - only create new state if under limit
      if (!memoryState.has(file) && memoryState.size >= maxRooms) {
        return res.status(503).json({ error: 'Too many active rooms' });
      }

      // Use computed headHash, fall back to existing state's headHash
      const finalHeadHash = computedHeadHash || memoryState.get(file)?.headHash || null;
      memoryState.set(file, { body, headHash: finalHeadHash });
      broadcast(file, body, finalHeadHash, sender);
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
      stateKeys: memoryState.size,
      rateLimitedClients: clientRateLimits.size,
      limits: {
        maxRooms,
        maxConnectionsPerRoom,
        maxSavesPerSecond: MAX_SAVES_PER_SECOND
      }
    };
  }

  return { watcher, clients, getRealtimeStats };
}

module.exports = { setupLiveSync };
