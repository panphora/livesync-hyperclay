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

// Lane per subscriber connection. Two lanes share each per-file channel:
//   'live'  — edit-mode tabs. Carries pre-strip peer snapshots (may contain
//             [no-save] runtime content), notifications, collection-record.
//             Owner-gated by the caller. The default everywhere, so untouched
//             callsites and old clients keep today's exact behavior.
//   'saved' — view-mode tabs. Carries whole documents meant for viewers: the
//             post-strip on-disk HTML the save seams broadcast, plus a client's
//             own {document} relay through the host's spec §10 /_/sync route,
//             which is owner-gated and validated as a complete document but is
//             never persisted, backed up, or scanned. Never pre-strip content.
// Structure: WeakMap<response, 'live'|'saved'>; absent = 'live'.
const subscriberLanes = new WeakMap();

function laneOf(res) {
  return subscriberLanes.get(res) || 'live';
}

// Opaque per-connection metadata, handed in at subscribe time and handed back
// unread by subscribers() and the onRemove hook. The library never looks inside
// it: hyperclay stores who a connection belongs to, hyperclay-local stores
// nothing. Left in place when a connection leaves, exactly like the lane above —
// both maps are keyed on the response and clear themselves when it is collected.
// Structure: WeakMap<response, any>
const subscriberMeta = new WeakMap();

// Handlers registered through onRemove(), fired once per connection that leaves
// a file channel, by whichever teardown path removed it.
// Structure: Set<(file, { lane, meta }) => void>
const removeHandlers = new Set();

/**
 * The one place a connection leaves a file channel. All three teardown paths go
 * through here — unsubscribe(), closeChannel(), and writeToAll's dead-drop — so
 * a consumer watching onRemove sees every departure, including the one that
 * never fires the request's own close handler: a write that threw.
 *
 * Membership in the channel Set is the record of whether a connection is still
 * here, which makes this idempotent. That is what "exactly once" rests on:
 * closeChannel ends a response, and the real server then fires that request's
 * close handler, which calls unsubscribe for a connection already gone.
 *
 * @param {string} file - Full identity key — same shape as subscribe()
 * @param {ServerResponse} res
 * @returns {boolean} true when this call is the one that removed the connection
 */
function _remove(file, res) {
  const subscribers = clients.get(file);
  if (!subscribers?.has(res)) return false;
  subscribers.delete(res);
  if (subscribers.size === 0) {
    clients.delete(file);
  }
  const info = { lane: laneOf(res), meta: subscriberMeta.get(res) };
  for (const handler of removeHandlers) {
    try {
      handler(file, info);
    } catch (e) {
      console.log(`[LiveSync] onRemove handler threw for "${file}":`, e.message);
    }
  }
  return true;
}

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
 * Write `message` to every subscriber on the given lane; remove any whose
 * write throws. Returns the count of successful writes. Centralizes
 * dead-connection cleanup so every broadcast-like method has identical
 * failure semantics.
 *
 * @param {Set<ServerResponse>} subscribers
 * @param {string} message - pre-serialized SSE frame
 * @param {string} label - short identifier for logs (e.g. "broadcast blog/post.html")
 * @param {Object} [options]
 * @param {'live'|'saved'|'all'} [options.lane='live'] - which lane to write to
 * @param {string|null} [options.file=null] - the channel key `subscribers`
 *   belongs to, when it is a file channel. A connection dropped here then leaves
 *   through _remove like every other teardown. User-level channels pass none and
 *   drop theirs from the Set directly. Passed in rather than recovered by
 *   scanning `clients`: the caller already holds the key.
 */
function writeToAll(subscribers, message, label, { lane = 'live', file = null } = {}) {
  if (!subscribers?.size) return 0;
  const dead = [];
  let sent = 0;
  for (const res of subscribers) {
    if (lane !== 'all' && laneOf(res) !== lane) continue;
    try {
      res.write(message);
      sent++;
    } catch (e) {
      console.log(`[LiveSync] Failed to write (${label}):`, e.message);
      dead.push(res);
    }
  }
  for (const res of dead) {
    if (file === null) {
      subscribers.delete(res);
    } else {
      _remove(file, res);
    }
  }
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
   * @param {Object} [options]
   * @param {'live'|'saved'} [options.lane='live'] - 'saved' subscribes a
   *   view-mode tab that only receives post-strip on-disk HTML. The caller
   *   owns the auth decision per lane.
   * @param {any} [options.meta] - Opaque metadata stored against this
   *   connection and handed back, unread, by subscribers() and the onRemove
   *   hook. The library never inspects it. Optional: its absence is not an
   *   error, and a caller that passes none behaves exactly as before.
   */
  subscribe(file, res, { lane = 'live', meta } = {}) {
    if (!clients.has(file)) {
      clients.set(file, new Set());
    }
    clients.get(file).add(res);
    subscriberLanes.set(res, lane === 'saved' ? 'saved' : 'live');
    subscriberMeta.set(res, meta);
    console.log(`[LiveSync] Subscribed to "${file}" (lane=${laneOf(res)}), now ${clients.get(file).size} subscriber(s)`);
  },

  /**
   * Unsubscribe an SSE response from a file's updates
   * @param {string} file - Full identity key — same shape as subscribe()
   * @param {ServerResponse} res - Express response object
   */
  unsubscribe(file, res) {
    _remove(file, res);
    const remaining = clients.get(file)?.size || 0;
    console.log(`[LiveSync] Unsubscribed from "${file}", ${remaining} subscriber(s) remaining`);
  },

  /**
   * Iterate the connections currently on a file channel.
   * @param {string} file - Full identity key — same shape as subscribe()
   * @yields {{ res: ServerResponse, lane: 'live'|'saved', meta: any }}
   */
  *subscribers(file) {
    const set = clients.get(file);
    if (!set) return;
    // Iterate a snapshot: a consumer may remove connections as it goes.
    for (const res of Array.from(set)) {
      yield { res, lane: laneOf(res), meta: subscriberMeta.get(res) };
    }
  },

  /**
   * Register a handler fired once for every connection that leaves a file
   * channel, whichever path removed it: unsubscribe(), closeChannel(), or a
   * write that threw. Called as handler(file, { lane, meta }) with the meta the
   * connection subscribed with. A handler that throws is logged and skipped, so
   * one bad consumer cannot wedge a teardown.
   * @param {(file: string, info: { lane: 'live'|'saved', meta: any }) => void} handler
   * @returns {() => void} call to unregister
   */
  onRemove(handler) {
    if (typeof handler !== 'function') {
      throw new TypeError('[LiveSync] onRemove expects a function');
    }
    removeHandlers.add(handler);
    return () => removeHandlers.delete(handler);
  },

  /**
   * Broadcast an update to clients subscribed to a file
   * @param {string} file - Full identity key — same shape as subscribe()
   * @param {Object} data - { html, sender, identityMap? }
   * @param {string} data.html - Full document HTML
   * @param {string} data.sender - Client ID or 'file-system'
   * @param {Object} [data.identityMap] - Optional opaque element-identity map
   *   from the sender. Forwarded as-is to receivers; older clients ignore it.
   * @param {string} [data.etag] - Optional version stamp of what the host stored
   *   for the document these bytes were saved as (spec §6). It rides ON the
   *   content frame and never alone: a receiver may only adopt a stamp as part of
   *   applying the content that stamp describes, or it asserts "you are in step
   *   with disk" about bytes it has not got. Forwarded as-is; older clients
   *   ignore it.
   * @param {Object} [options]
   * @param {'live'|'saved'|'all'} [options.lane='live'] - Which lane receives
   *   this payload. Pre-strip snapshots must stay on 'live' (the default);
   *   'saved' and 'all' reach viewers, so only a whole document that is safe for
   *   anyone who can view the page may go there — on-disk HTML from the save
   *   seams, or an owner's {document} relay. Never [no-save] runtime content.
   */
  broadcast(file, { html, sender, identityMap, etag }, { lane = 'live' } = {}) {
    const subscribers = clients.get(file);
    console.log(`[LiveSync] Broadcasting to "${file}" (lane=${lane}): ${subscribers?.size || 0} subscriber(s), sender=${sender}`);

    if (!subscribers?.size) {
      console.log(`[LiveSync] No subscribers for "${file}", available rooms:`, Array.from(clients.keys()));
      return;
    }

    if (typeof html !== 'string') {
      console.error(`[LiveSync] Refusing to broadcast non-string html for ${file}`);
      return;
    }

    // Only attach the optional fields when defined — keeps the wire byte-identical
    // to today's payload for senders that haven't been updated.
    const payload = { html, sender, seq: nextSeq() };
    if (identityMap !== undefined) payload.identityMap = identityMap;

    // Spec §10: the stamp rides the editor lane only. A viewer holds a whole document
    // rather than a pre-strip snapshot and makes no saves, so it has no version to
    // answer for and a stamp there is at best noise and at worst a claim about bytes
    // the viewer does not hold. Enforced here rather than trusted to each caller:
    // every host has to remember the same rule otherwise, and one that forgets it
    // leaks the stamp with nothing failing.
    if (etag !== undefined && lane === 'live') payload.etag = etag;

    const total = subscribers.size;
    const message = `data: ${JSON.stringify(payload)}\n\n`;
    const sent = writeToAll(subscribers, message, `broadcast ${file}`, { lane, file });
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
   * Send a notification to clients subscribed to a file
   * Shows a toast instead of morphing content
   * @param {string} file - Full identity key — same shape as subscribe()
   * @param {Object} data - { msgType, msg, action? }
   * @param {string} data.msgType - Toast type: "warning", "info", "error", "success"
   * @param {string} data.msg - Message to display
   * @param {string} [data.action] - Optional action hint: "reload", etc.
   * @param {Object} [options]
   * @param {'live'|'saved'|'all'} [options.lane='live'] - Notifications are
   *   owner/edit-facing (data-loss chip, reload toasts), so they stay on the
   *   live lane unless a caller explicitly widens them.
   */
  notify(file, { msgType, msg, action, data }, { lane = 'live' } = {}) {
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
    const sent = writeToAll(subscribers, message, `notify ${file}`, { lane, file });
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
    // Live lane only — dashboards subscribe without a lane and land on 'live'.
    return writeToAll(subscribers, message, `collection-record ${file} ${id}`, { file });
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
    // Snapshot, then clear the channel one connection at a time through _remove
    // before ending any of them: each res's own close handler (which calls
    // unsubscribe) then finds nothing and fires no second onRemove.
    const doomed = Array.from(subscribers);
    for (const res of doomed) {
      _remove(file, res);
    }
    let closed = 0;
    for (const res of doomed) {
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
