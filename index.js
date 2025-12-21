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
  },

  /**
   * Unsubscribe an SSE response from a file's updates
   * @param {string} file - Site identifier
   * @param {ServerResponse} res - Express response object
   */
  unsubscribe(file, res) {
    clients.get(file)?.delete(res);
    if (clients.get(file)?.size === 0) {
      clients.delete(file);
    }
  },

  /**
   * Broadcast an update to all clients subscribed to a file
   * @param {string} file - Site identifier
   * @param {Object} data - { body, headHash, sender }
   * @param {string} data.body - Body innerHTML
   * @param {string} data.headHash - SHA-256 hash of head (first 16 hex chars)
   * @param {string} data.sender - Client ID or 'file-system'
   */
  broadcast(file, { body, headHash, sender }) {
    const subscribers = clients.get(file);
    if (!subscribers?.size) return;

    // Never broadcast null/undefined body
    if (typeof body !== 'string') {
      console.error(`[LiveSync] Refusing to broadcast non-string body for ${file}`);
      return;
    }

    const message = `data: ${JSON.stringify({ body, headHash, sender })}\n\n`;
    const dead = [];

    for (const res of subscribers) {
      try {
        res.write(message);
      } catch {
        dead.push(res);
      }
    }

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
