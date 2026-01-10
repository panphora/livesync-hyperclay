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
   * Get statistics about active connections
   * @returns {{ rooms: number, connections: number }}
   */
  getStats() {
    let totalConnections = 0;
    clients.forEach(room => {
      totalConnections += room.size;
    });

    return {
      rooms: clients.size,
      connections: totalConnections
    };
  }
};

// CommonJS export
module.exports = { liveSync };
