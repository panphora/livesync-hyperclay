/**
 * livesync-hyperclay/index.js
 *
 * Stateless utility module for managing SSE client connections.
 * No routing, no auth, no file watching — just subscribe/unsubscribe/broadcast.
 *
 * Used by:
 * - hyperclay (hosted): handlers call broadcast() when browsers POST updates
 * - hyperclay-local: sync-engine calls broadcast() when files change on disk
 */

// Track SSE connections per channel key.
// Platform callers pass "{username}:{fullPath}" to scope by tenant.
// hyperclay-local callers pass "{fullPath}" (single-user, no tenant prefix).
// Full path = relative path including extension, e.g. "blog/post.html".
// Structure: Map<channelKey, Set<response>>
const clients = new Map();

// Track SSE connections per user (for sync engine subscriptions)
// Structure: Map<username, Set<response>>
const userClients = new Map();

// Track recent browser saves to avoid duplicate "file changed" notifications.
// Keys are full paths with extension (e.g. "blog/post.html"), matching
// wasBrowserSave() callsites in engine-watcher.
// Structure: Map<fullPath, timestamp>
const recentBrowserSaves = new Map();
const BROWSER_SAVE_WINDOW_MS = 2000;

// Monotonic sequence counter for broadcasts. Uses Date.now() so it survives
// process restarts (clients drop incoming messages whose seq is <= the last
// seq they applied). Bumped by 1 when two broadcasts land on the same ms.
let lastSeq = 0;
function nextSeq() {
  const now = Date.now();
  lastSeq = now > lastSeq ? now : lastSeq + 1;
  return lastSeq;
}

/**
 * Write `message` to every subscriber; remove any whose write throws.
 * Returns the count of successful writes. Centralizes dead-connection cleanup
 * so every broadcast-like method has identical failure semantics.
 *
 * @param {Set<ServerResponse>} subscribers
 * @param {string} message - pre-serialized SSE frame
 * @param {string} label - short identifier for logs (e.g. "broadcast blog/post.html")
 */
function writeToAll(subscribers, message, label) {
  if (!subscribers?.size) return 0;
  const dead = [];
  let sent = 0;
  for (const res of subscribers) {
    try {
      res.write(message);
      sent++;
    } catch (e) {
      console.log(`[LiveSync] Failed to write (${label}):`, e.message);
      dead.push(res);
    }
  }
  dead.forEach(res => subscribers.delete(res));
  return sent;
}

/**
 * LiveSync utility object
 */
const liveSync = {
  /**
   * Subscribe an SSE response to a file's updates
   * @param {string} file - Full identity key. Platform: "{username}:{path/name.ext}";
   *   hyperclay-local: "{path/name.ext}". Always includes extension.
   * @param {ServerResponse} res - Express response object for SSE
   */
  subscribe(file, res) {
    if (!clients.has(file)) {
      clients.set(file, new Set());
    }
    clients.get(file).add(res);
    console.log(`[LiveSync] Subscribed to "${file}", now ${clients.get(file).size} subscriber(s)`);
  },

  /**
   * Unsubscribe an SSE response from a file's updates
   * @param {string} file - Full identity key — same shape as subscribe()
   * @param {ServerResponse} res - Express response object
   */
  unsubscribe(file, res) {
    clients.get(file)?.delete(res);
    const remaining = clients.get(file)?.size || 0;
    console.log(`[LiveSync] Unsubscribed from "${file}", ${remaining} subscriber(s) remaining`);
    if (remaining === 0) {
      clients.delete(file);
    }
  },

  /**
   * Broadcast an update to all clients subscribed to a file
   * @param {string} file - Full identity key — same shape as subscribe()
   * @param {Object} data - { html, sender, identityMap? }
   * @param {string} data.html - Full document HTML
   * @param {string} data.sender - Client ID or 'file-system'
   * @param {Object} [data.identityMap] - Optional opaque element-identity map
   *   from the sender. Forwarded as-is to receivers; older clients ignore it.
   */
  broadcast(file, { html, sender, identityMap }) {
    const subscribers = clients.get(file);
    console.log(`[LiveSync] Broadcasting to "${file}": ${subscribers?.size || 0} subscriber(s), sender=${sender}`);

    if (!subscribers?.size) {
      console.log(`[LiveSync] No subscribers for "${file}", available rooms:`, Array.from(clients.keys()));
      return;
    }

    if (typeof html !== 'string') {
      console.error(`[LiveSync] Refusing to broadcast non-string html for ${file}`);
      return;
    }

    // Only attach identityMap when defined — keeps the wire byte-identical
    // to today's payload for senders that haven't been updated.
    const payload = { html, sender, seq: nextSeq() };
    if (identityMap !== undefined) payload.identityMap = identityMap;

    const total = subscribers.size;
    const message = `data: ${JSON.stringify(payload)}\n\n`;
    const sent = writeToAll(subscribers, message, `broadcast ${file}`);
    console.log(`[LiveSync] Sent to ${sent}/${total} subscribers`);
  },

  /**
   * Subscribe a user's sync engine to all their file updates
   * @param {string} username - User identifier
   * @param {ServerResponse} res - Express response object for SSE
   */
  subscribeUser(username, res) {
    if (!userClients.has(username)) {
      userClients.set(username, new Set());
    }
    userClients.get(username).add(res);
    console.log(`[LiveSync] User "${username}" subscribed, now ${userClients.get(username).size} connection(s)`);
  },

  /**
   * Unsubscribe a user's sync engine
   * @param {string} username - User identifier
   * @param {ServerResponse} res - Express response object
   */
  unsubscribeUser(username, res) {
    userClients.get(username)?.delete(res);
    const remaining = userClients.get(username)?.size || 0;
    console.log(`[LiveSync] User "${username}" unsubscribed, ${remaining} connection(s) remaining`);
    if (remaining === 0) {
      userClients.delete(username);
    }
  },

  /**
   * Broadcast a file update to a user's sync engine connections
   * @param {string} username - User identifier
   * @param {string} file - Full path with extension (e.g. "blog/post.html")
   * @param {Object} data - { html, sender }
   */
  broadcastToUser(username, file, { html, sender }) {
    const subscribers = userClients.get(username);

    if (!subscribers?.size) {
      return; // No user subscribers, that's fine
    }

    if (typeof html !== 'string') {
      console.error(`[LiveSync] Refusing to broadcast non-string html for user ${username}`);
      return;
    }

    // Include file name and type so sync engine knows which file changed and how to handle it
    const message = `data: ${JSON.stringify({ type: 'live-sync', file, html, sender })}\n\n`;
    const sent = writeToAll(subscribers, message, `broadcastToUser ${username}`);
    if (sent > 0) {
      console.log(`[LiveSync] Sent to user "${username}": ${sent} connection(s), file=${file}`);
    }
  },

  /**
   * Broadcast a node-saved event to a user's sync engine connections.
   *
   * For sites: includes inline content so receiving clients can write to disk directly.
   * For uploads: metadata only — receiving clients fetch content via GET /sync/nodes/:id/content.
   * For folders: metadata only (folders have no content).
   *
   * Also fires for create events (the receiving client distinguishes create vs update
   * by checking its own nodeMap for the nodeId).
   *
   * @param {string} username - User identifier
   * @param {Object} data
   * @param {number} data.nodeId - Node id
   * @param {string} data.nodeType - 'site' | 'upload' | 'folder'
   * @param {string} data.name - Node name (filename or folder name)
   * @param {string} data.path - Full path to the node (e.g. "projects/index.html")
   * @param {string} [data.checksum] - Content hash (sites + uploads only)
   * @param {string} [data.modifiedAt] - ISO timestamp of last modification
   * @param {string} [data.content] - Inline content — REQUIRED for sites, ABSENT for uploads + folders
   * @param {number} [data.size] - File size in bytes (uploads only)
   */
  broadcastNodeSaved(username, { nodeId, nodeType, name, path, checksum, modifiedAt, content, size }) {
    const subscribers = userClients.get(username);
    if (!subscribers?.size) return;

    // Validate: sites must include content; uploads/folders must NOT include content
    if (nodeType === 'site' && typeof content !== 'string') {
      console.error(`[LiveSync] Refusing to broadcast site node-saved without string content for user ${username}`);
      return;
    }
    if (nodeType !== 'site' && content !== undefined) {
      console.warn(`[LiveSync] Stripping content from ${nodeType} node-saved event (notification-only)`);
    }

    const payload = {
      type: 'node-saved',
      nodeId,
      nodeType,
      name,
      path,
      checksum,
      modifiedAt
    };

    if (nodeType === 'site') {
      payload.content = content;
    }
    if (nodeType === 'upload' && size !== undefined) {
      payload.size = size;
    }

    const message = `data: ${JSON.stringify(payload)}\n\n`;
    const sent = writeToAll(subscribers, message, `node-saved ${username} node=${nodeId}`);
    if (sent > 0) {
      console.log(`[LiveSync] Sent node-saved (${nodeType}) to user "${username}": ${sent} connection(s), node=${nodeId} path=${path}`);
    }
  },

  /**
   * Broadcast a node-renamed event.
   * For folder renames, the receiving client walks its own nodeMap descendants and
   * rewrites their paths locally. There are NO per-descendant events on the wire.
   *
   * @param {string} username
   * @param {Object} data
   * @param {number} data.nodeId
   * @param {string} data.nodeType - 'site' | 'upload' | 'folder'
   * @param {string} data.oldName
   * @param {string} data.newName
   * @param {string} data.oldPath - Full old path (e.g. "projects/old.html")
   * @param {string} data.newPath - Full new path (e.g. "projects/new.html")
   */
  broadcastNodeRenamed(username, { nodeId, nodeType, oldName, newName, oldPath, newPath }) {
    const subscribers = userClients.get(username);
    if (!subscribers?.size) return;

    const message = `data: ${JSON.stringify({
      type: 'node-renamed',
      nodeId,
      nodeType,
      oldName,
      newName,
      oldPath,
      newPath
    })}\n\n`;

    writeToAll(subscribers, message, `node-renamed ${username} node=${nodeId}`);
    console.log(`[LiveSync] Sent node-renamed (${nodeType}) to user "${username}": ${oldPath} → ${newPath}`);
  },

  /**
   * Broadcast a node-moved event.
   * For folder moves, the receiving client walks its own nodeMap descendants and
   * rewrites their paths locally. No per-descendant events.
   *
   * A move MAY also rename the node in the same atomic operation. When it does,
   * oldName !== newName. Subscribers that need to act on the rename should
   * compare oldName/newName rather than relying on basename(oldPath) vs
   * basename(newPath) (which also agrees, but is easier to get wrong for folders).
   *
   * @param {string} username
   * @param {Object} data
   * @param {number} data.nodeId
   * @param {string} data.nodeType
   * @param {string} data.name - Post-operation name (alias of newName, for back-compat)
   * @param {string} [data.oldName] - Name before the operation
   * @param {string} [data.newName] - Name after the operation (same as name)
   * @param {string} data.oldPath
   * @param {string} data.newPath
   * @param {number|string} [data.oldParentId]
   * @param {number|string} [data.newParentId]
   */
  broadcastNodeMoved(username, { nodeId, nodeType, name, oldName, newName, oldPath, newPath, oldParentId, newParentId }) {
    const subscribers = userClients.get(username);
    if (!subscribers?.size) return;

    const message = `data: ${JSON.stringify({
      type: 'node-moved',
      nodeId,
      nodeType,
      name,
      oldName: oldName ?? name,
      newName: newName ?? name,
      oldPath,
      newPath,
      oldParentId,
      newParentId
    })}\n\n`;

    writeToAll(subscribers, message, `node-moved ${username} node=${nodeId}`);
    console.log(`[LiveSync] Sent node-moved (${nodeType}) to user "${username}": ${oldPath} → ${newPath}`);
  },

  /**
   * Broadcast a node-deleted event.
   * For folder deletes, the receiving client walks its own nodeMap descendants and
   * removes them locally. No per-descendant events.
   *
   * @param {string} username
   * @param {Object} data
   * @param {number} data.nodeId
   * @param {string} data.nodeType
   * @param {string} data.name
   * @param {string} data.path
   */
  broadcastNodeDeleted(username, { nodeId, nodeType, name, path }) {
    const subscribers = userClients.get(username);
    if (!subscribers?.size) return;

    const message = `data: ${JSON.stringify({
      type: 'node-deleted',
      nodeId,
      nodeType,
      name,
      path
    })}\n\n`;

    writeToAll(subscribers, message, `node-deleted ${username} node=${nodeId}`);
    console.log(`[LiveSync] Sent node-deleted (${nodeType}) to user "${username}": ${path}`);
  },

  /**
   * Send a notification to all clients subscribed to a file
   * Shows a toast instead of morphing content
   * @param {string} file - Full identity key — same shape as subscribe()
   * @param {Object} data - { msgType, msg, action? }
   * @param {string} data.msgType - Toast type: "warning", "info", "error", "success"
   * @param {string} data.msg - Message to display
   * @param {string} [data.action] - Optional action hint: "reload", etc.
   */
  notify(file, { msgType, msg, action, data }) {
    const subscribers = clients.get(file);
    console.log(`[LiveSync] Notifying "${file}": ${subscribers?.size || 0} subscriber(s), msgType=${msgType}`);

    if (!subscribers?.size) {
      return;
    }

    const payload = {
      type: "notification",
      msgType,
      msg
    };
    if (action) {
      payload.action = action;
    }
    // Optional structured payload (e.g. the data-loss event for the guard chip).
    if (data !== undefined) {
      payload.data = data;
    }

    const total = subscribers.size;
    const message = `data: ${JSON.stringify(payload)}\n\n`;
    const sent = writeToAll(subscribers, message, `notify ${file}`);
    console.log(`[LiveSync] Notification sent to ${sent}/${total} subscribers`);
  },

  /**
   * Broadcast a collection-record change to browser subscribers of a file channel
   * (a collection dashboard). Focused sibling of notify()/broadcast(): one fixed
   * shape, so it can't clutter the channel. Emits a NAMED SSE event, so only
   * es.addEventListener('collection-record', …) receives it (not onmessage).
   *
   * @param {string} file - channel key "{ownerUsername}:{fullPath}"
   * @param {Object} data
   * @param {'create'|'update'|'delete'} data.op
   * @param {string} data.id - record id (the record's key)
   * @param {Object} [data.data] - record fields (omit for delete)
   * @param {string} [data.modifiedAt]
   * @returns {number} subscribers written to
   */
  broadcastCollectionRecord(file, { op, id, data, modifiedAt }) {
    const subscribers = clients.get(file);
    if (!subscribers?.size) return 0;
    const payload = { type: 'collection-record', op, id, modifiedAt, seq: nextSeq() };
    if (op !== 'delete') payload.data = data;
    const message = `event: collection-record\ndata: ${JSON.stringify(payload)}\n\n`;
    return writeToAll(subscribers, message, `collection-record ${file} ${id}`);
  },

  /**
   * Force-close every SSE response on a channel and drop the channel.
   * Connection-lifecycle only — the caller owns any auth decision. The platform
   * uses this to disconnect viewers when a share is revoked: each viewer's
   * EventSource then reconnects, re-runs the route's auth, and fails closed.
   * @param {string} file - Full identity key — same shape as subscribe()
   * @returns {number} responses closed
   */
  closeChannel(file) {
    const subscribers = clients.get(file);
    if (!subscribers?.size) return 0;
    // Clear the channel first so each res's own close handler (which calls
    // unsubscribe) is a harmless no-op while we end the connections.
    clients.delete(file);
    let closed = 0;
    for (const res of subscribers) {
      try {
        res.end();
        closed++;
      } catch (e) {
        console.log(`[LiveSync] closeChannel failed for "${file}":`, e.message);
      }
    }
    console.log(`[LiveSync] Closed channel "${file}": ${closed} stream(s)`);
    return closed;
  },

  /**
   * Get statistics about active connections
   * @returns {{ rooms: number, connections: number, userConnections: number }}
   */
  getStats() {
    let totalConnections = 0;
    clients.forEach(room => {
      totalConnections += room.size;
    });

    let totalUserConnections = 0;
    userClients.forEach(conns => {
      totalUserConnections += conns.size;
    });

    return {
      rooms: clients.size,
      connections: totalConnections,
      userConnections: totalUserConnections
    };
  },

  /**
   * Mark a file as recently saved by a browser.
   * Call after writing a file via browser save endpoint.
   * @param {string} file - Full path with extension (e.g. "blog/post.html")
   */
  markBrowserSave(file) {
    recentBrowserSaves.set(file, Date.now());
    setTimeout(() => {
      const savedAt = recentBrowserSaves.get(file);
      if (savedAt && Date.now() - savedAt >= BROWSER_SAVE_WINDOW_MS) {
        recentBrowserSaves.delete(file);
      }
    }, BROWSER_SAVE_WINDOW_MS + 100);
  },

  /**
   * Check if a file was recently saved by a browser.
   * Use to skip "file changed on disk" notifications for browser-initiated saves.
   * @param {string} file - Full path with extension (e.g. "blog/post.html")
   * @returns {boolean}
   */
  wasBrowserSave(file) {
    const savedAt = recentBrowserSaves.get(file);
    if (!savedAt) return false;
    return Date.now() - savedAt < BROWSER_SAVE_WINDOW_MS;
  }
};

// CommonJS export
module.exports = { liveSync };
