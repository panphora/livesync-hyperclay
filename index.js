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

// Track SSE connections per file
// Structure: Map<filename, Set<response>>
const clients = new Map();

// Track SSE connections per user (for sync engine subscriptions)
// Structure: Map<username, Set<response>>
const userClients = new Map();

/**
 * LiveSync utility object
 */
const liveSync = {
  /**
   * Subscribe an SSE response to a file's updates
   * @param {string} file - Site identifier (e.g., "mysite")
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
   * @param {string} file - Site identifier
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
   * @param {string} file - Site identifier
   * @param {Object} data - { html, sender }
   * @param {string} data.html - Full document HTML
   * @param {string} data.sender - Client ID or 'file-system'
   */
  broadcast(file, { html, sender }) {
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

    const message = `data: ${JSON.stringify({ html, sender })}\n\n`;
    const dead = [];
    let sent = 0;

    for (const res of subscribers) {
      try {
        res.write(message);
        sent++;
      } catch (e) {
        console.log(`[LiveSync] Failed to write to subscriber:`, e.message);
        dead.push(res);
      }
    }

    console.log(`[LiveSync] Sent to ${sent}/${subscribers.size} subscribers`);

    // Clean up dead connections
    dead.forEach(res => subscribers.delete(res));
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
   * @param {string} file - Site identifier that changed
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
    const dead = [];
    let sent = 0;

    for (const res of subscribers) {
      try {
        res.write(message);
        sent++;
      } catch (e) {
        console.log(`[LiveSync] Failed to write to user subscriber:`, e.message);
        dead.push(res);
      }
    }

    if (sent > 0) {
      console.log(`[LiveSync] Sent to user "${username}": ${sent} connection(s), file=${file}`);
    }

    // Clean up dead connections
    dead.forEach(res => subscribers.delete(res));
  },

  /**
   * Broadcast a file-saved event to a user's sync engine connections
   * This is for disk sync - sends stripped content for writing to disk
   * @param {string} username - User identifier
   * @param {string} file - Site identifier that was saved
   * @param {Object} data - { content, checksum, modifiedAt }
   */
  broadcastFileSaved(username, file, { content, checksum, modifiedAt }) {
    const subscribers = userClients.get(username);

    if (!subscribers?.size) {
      return; // No user subscribers, that's fine
    }

    if (typeof content !== 'string') {
      console.error(`[LiveSync] Refusing to broadcast non-string content for user ${username}`);
      return;
    }

    const message = `data: ${JSON.stringify({
      type: 'file-saved',
      file,
      content,
      checksum,
      modifiedAt
    })}\n\n`;

    const dead = [];
    let sent = 0;

    for (const res of subscribers) {
      try {
        res.write(message);
        sent++;
      } catch (e) {
        console.log(`[LiveSync] Failed to write file-saved to user subscriber:`, e.message);
        dead.push(res);
      }
    }

    if (sent > 0) {
      console.log(`[LiveSync] Sent file-saved to user "${username}": ${sent} connection(s), file=${file}`);
    }

    // Clean up dead connections
    dead.forEach(res => subscribers.delete(res));
  },

  /**
   * Send a notification to all clients subscribed to a file
   * Shows a toast instead of morphing content
   * @param {string} file - Site identifier
   * @param {Object} data - { msgType, msg, action? }
   * @param {string} data.msgType - Toast type: "warning", "info", "error", "success"
   * @param {string} data.msg - Message to display
   * @param {string} [data.action] - Optional action hint: "reload", etc.
   */
  notify(file, { msgType, msg, action }) {
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

    const message = `data: ${JSON.stringify(payload)}\n\n`;
    const dead = [];
    let sent = 0;

    for (const res of subscribers) {
      try {
        res.write(message);
        sent++;
      } catch (e) {
        console.log(`[LiveSync] Failed to write notification to subscriber:`, e.message);
        dead.push(res);
      }
    }

    console.log(`[LiveSync] Notification sent to ${sent}/${subscribers.size} subscribers`);

    // Clean up dead connections
    dead.forEach(res => subscribers.delete(res));
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
  }
};

// CommonJS export
module.exports = { liveSync };
