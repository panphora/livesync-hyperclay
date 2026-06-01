const { liveSync } = require('../../index.js');

// Mock Express res — captures write() calls into a log.
function mockRes() {
  const writes = [];
  return {
    writes,
    write(msg) { writes.push(msg); },
    get count() { return writes.length; }
  };
}

function parseSSE(msg) {
  // "data: {...}\n\n" → {...}
  const m = msg.match(/^data: (.+)\n\n$/);
  return m ? JSON.parse(m[1]) : null;
}

describe('subscribe / broadcast key isolation', () => {
  test('same key delivers', () => {
    const res = mockRes();
    liveSync.subscribe('alice:blog/post.html', res);
    liveSync.broadcast('alice:blog/post.html', { html: '<p>hi</p>', sender: 'A' });
    expect(res.count).toBe(1);
    const msg = parseSSE(res.writes[0]);
    expect(msg).toMatchObject({ html: '<p>hi</p>', sender: 'A' });
    expect(typeof msg.seq).toBe('number');
    liveSync.unsubscribe('alice:blog/post.html', res);
  });

  test('different keys do not cross-deliver', () => {
    const alice = mockRes();
    const bob = mockRes();
    liveSync.subscribe('alice:post.html', alice);
    liveSync.subscribe('bob:post.html', bob);
    liveSync.broadcast('alice:post.html', { html: 'A', sender: 'x' });
    expect(alice.count).toBe(1);
    expect(bob.count).toBe(0);
    liveSync.unsubscribe('alice:post.html', alice);
    liveSync.unsubscribe('bob:post.html', bob);
  });

  test('unsubscribe removes the subscriber', () => {
    const res = mockRes();
    liveSync.subscribe('t:isolate.html', res);
    liveSync.unsubscribe('t:isolate.html', res);
    liveSync.broadcast('t:isolate.html', { html: 'x', sender: 'x' });
    expect(res.count).toBe(0);
  });

  test('multiple subscribers on same channel all receive', () => {
    const r1 = mockRes();
    const r2 = mockRes();
    liveSync.subscribe('t:multi.html', r1);
    liveSync.subscribe('t:multi.html', r2);
    liveSync.broadcast('t:multi.html', { html: 'x', sender: 'y' });
    expect(r1.count).toBe(1);
    expect(r2.count).toBe(1);
    liveSync.unsubscribe('t:multi.html', r1);
    liveSync.unsubscribe('t:multi.html', r2);
  });
});

describe('broadcast stamps a monotonic seq', () => {
  test('consecutive broadcasts produce strictly increasing seq', () => {
    const res = mockRes();
    liveSync.subscribe('t:seq.html', res);
    // Three back-to-back broadcasts — on fast machines all three land in the
    // same ms, which exercises the tie-break branch (lastSeq + 1).
    liveSync.broadcast('t:seq.html', { html: 'a', sender: 'x' });
    liveSync.broadcast('t:seq.html', { html: 'b', sender: 'x' });
    liveSync.broadcast('t:seq.html', { html: 'c', sender: 'x' });

    const seqs = res.writes.map(w => parseSSE(w).seq);
    expect(seqs.length).toBe(3);
    expect(seqs[0]).toBeLessThan(seqs[1]);
    expect(seqs[1]).toBeLessThan(seqs[2]);
    liveSync.unsubscribe('t:seq.html', res);
  });

  test('seq advances across different channels', () => {
    const r1 = mockRes();
    const r2 = mockRes();
    liveSync.subscribe('t:seq-a.html', r1);
    liveSync.subscribe('t:seq-b.html', r2);
    liveSync.broadcast('t:seq-a.html', { html: 'a', sender: 'x' });
    liveSync.broadcast('t:seq-b.html', { html: 'b', sender: 'x' });

    const s1 = parseSSE(r1.writes[0]).seq;
    const s2 = parseSSE(r2.writes[0]).seq;
    expect(s1).toBeLessThan(s2);
    liveSync.unsubscribe('t:seq-a.html', r1);
    liveSync.unsubscribe('t:seq-b.html', r2);
  });
});

describe('broadcast forwards identityMap when present', () => {
  test('identityMap is included in the SSE payload when defined', () => {
    const res = mockRes();
    liveSync.subscribe('t:idmap.html', res);
    liveSync.broadcast('t:idmap.html', {
      html: '<p>hi</p>',
      sender: 'A',
      identityMap: { '': 'A:1', '0': 'A:2' }
    });
    const msg = parseSSE(res.writes[0]);
    expect(msg.identityMap).toEqual({ '': 'A:1', '0': 'A:2' });
    liveSync.unsubscribe('t:idmap.html', res);
  });

  test('identityMap is absent (not undefined) when not provided', () => {
    const res = mockRes();
    liveSync.subscribe('t:idmap-absent.html', res);
    liveSync.broadcast('t:idmap-absent.html', { html: 'x', sender: 'A' });
    const raw = res.writes[0];
    expect(raw).not.toContain('identityMap');
    const msg = parseSSE(raw);
    expect('identityMap' in msg).toBe(false);
    liveSync.unsubscribe('t:idmap-absent.html', res);
  });

  test('broadcastToUser never carries identityMap even if passed', () => {
    const res = mockRes();
    liveSync.subscribeUser('u-idmap', res);
    liveSync.broadcastToUser('u-idmap', 'idx.html', {
      html: 'x',
      sender: 'A',
      identityMap: { '': 'A:1' }
    });
    const msg = parseSSE(res.writes[0]);
    expect('identityMap' in msg).toBe(false);
    liveSync.unsubscribeUser('u-idmap', res);
  });
});

describe('broadcast refuses bad input', () => {
  test('non-string html is refused', () => {
    const res = mockRes();
    liveSync.subscribe('t:bad.html', res);
    liveSync.broadcast('t:bad.html', { html: { not: 'a string' }, sender: 'x' });
    expect(res.count).toBe(0);
    liveSync.unsubscribe('t:bad.html', res);
  });

  test('empty subscriber set is a safe no-op', () => {
    expect(() => {
      liveSync.broadcast('t:nobody-here.html', { html: 'x', sender: 'y' });
    }).not.toThrow();
  });
});

describe('dead-connection cleanup', () => {
  test('throwing res gets removed from subscribers', () => {
    const live = mockRes();
    const dead = { write() { throw new Error('EPIPE'); } };
    liveSync.subscribe('t:dead.html', live);
    liveSync.subscribe('t:dead.html', dead);
    liveSync.broadcast('t:dead.html', { html: 'x', sender: 'y' });
    expect(live.count).toBe(1);
    // Second broadcast: dead one is already gone.
    liveSync.broadcast('t:dead.html', { html: 'y', sender: 'y' });
    expect(live.count).toBe(2);
    liveSync.unsubscribe('t:dead.html', live);
  });

  test('notify also cleans up dead connections', () => {
    const live = mockRes();
    const dead = { write() { throw new Error('EPIPE'); } };
    liveSync.subscribe('t:dead-notify.html', live);
    liveSync.subscribe('t:dead-notify.html', dead);
    liveSync.notify('t:dead-notify.html', { msgType: 'info', msg: 'hi' });
    expect(live.count).toBe(1);
    liveSync.notify('t:dead-notify.html', { msgType: 'info', msg: 'hi2' });
    expect(live.count).toBe(2);
    liveSync.unsubscribe('t:dead-notify.html', live);
  });
});

describe('markBrowserSave / wasBrowserSave', () => {
  test('within TTL, was is true', () => {
    liveSync.markBrowserSave('ttl/a.html');
    expect(liveSync.wasBrowserSave('ttl/a.html')).toBe(true);
  });

  test('different key is not matched', () => {
    liveSync.markBrowserSave('ttl/b.html');
    expect(liveSync.wasBrowserSave('ttl/different.html')).toBe(false);
  });

  test('full path with extension treated distinctly from basename', () => {
    // Core refactor invariant: keys are full paths, not bare names.
    liveSync.markBrowserSave('blog/post.html');
    expect(liveSync.wasBrowserSave('blog/post.html')).toBe(true);
    expect(liveSync.wasBrowserSave('post.html')).toBe(false);
    expect(liveSync.wasBrowserSave('blog/post')).toBe(false);
  });

  test('after TTL expires, was is false', async () => {
    liveSync.markBrowserSave('ttl/c.html');
    // BROWSER_SAVE_WINDOW_MS is 2000; wait 2100.
    await new Promise(r => setTimeout(r, 2100));
    expect(liveSync.wasBrowserSave('ttl/c.html')).toBe(false);
  }, 5000);
});

describe('broadcastToUser — user-level channel', () => {
  test('delivers to user subscribers with type:live-sync envelope', () => {
    const res = mockRes();
    liveSync.subscribeUser('alice', res);
    liveSync.broadcastToUser('alice', 'blog/post.html', { html: '<p/>', sender: 'x' });
    expect(res.count).toBe(1);
    const msg = parseSSE(res.writes[0]);
    expect(msg).toEqual({
      type: 'live-sync',
      file: 'blog/post.html',
      html: '<p/>',
      sender: 'x'
    });
    liveSync.unsubscribeUser('alice', res);
  });

  test('file-level subscribers do not receive user-level broadcasts', () => {
    const fileRes = mockRes();
    const userRes = mockRes();
    liveSync.subscribe('alice:index.html', fileRes);
    liveSync.subscribeUser('alice', userRes);
    liveSync.broadcastToUser('alice', 'index.html', { html: 'x', sender: 'y' });
    expect(fileRes.count).toBe(0);
    expect(userRes.count).toBe(1);
    liveSync.unsubscribe('alice:index.html', fileRes);
    liveSync.unsubscribeUser('alice', userRes);
  });

  test('different users are isolated', () => {
    const aliceRes = mockRes();
    const bobRes = mockRes();
    liveSync.subscribeUser('alice-iso', aliceRes);
    liveSync.subscribeUser('bob-iso', bobRes);
    liveSync.broadcastToUser('alice-iso', 'x.html', { html: 'x', sender: 'y' });
    expect(aliceRes.count).toBe(1);
    expect(bobRes.count).toBe(0);
    liveSync.unsubscribeUser('alice-iso', aliceRes);
    liveSync.unsubscribeUser('bob-iso', bobRes);
  });
});

describe('broadcastNodeSaved — payload shape per type', () => {
  test('site without content is refused', () => {
    const res = mockRes();
    liveSync.subscribeUser('u1', res);
    liveSync.broadcastNodeSaved('u1', {
      nodeId: 1, nodeType: 'site', name: 'idx.html', path: 'idx.html',
      checksum: 'abc', modifiedAt: '2026-04-15T00:00:00Z'
      // no content → refused
    });
    expect(res.count).toBe(0);
    liveSync.unsubscribeUser('u1', res);
  });

  test('site with content delivers', () => {
    const res = mockRes();
    liveSync.subscribeUser('u2', res);
    liveSync.broadcastNodeSaved('u2', {
      nodeId: 1, nodeType: 'site', name: 'idx.html', path: 'idx.html',
      content: '<html/>', checksum: 'abc', modifiedAt: '2026-04-15T00:00:00Z'
    });
    expect(res.count).toBe(1);
    const msg = parseSSE(res.writes[0]);
    expect(msg.type).toBe('node-saved');
    expect(msg.content).toBe('<html/>');
    expect(msg.path).toBe('idx.html');
    liveSync.unsubscribeUser('u2', res);
  });

  test('upload does not carry content even if passed', () => {
    const res = mockRes();
    liveSync.subscribeUser('u3', res);
    liveSync.broadcastNodeSaved('u3', {
      nodeId: 2, nodeType: 'upload', name: 'a.png', path: 'a.png',
      content: 'should-be-stripped', size: 42, checksum: 'h',
      modifiedAt: '2026-04-15T00:00:00Z'
    });
    expect(res.count).toBe(1);
    const msg = parseSSE(res.writes[0]);
    expect(msg.content).toBeUndefined();
    expect(msg.size).toBe(42);
    liveSync.unsubscribeUser('u3', res);
  });

  test('folder has no content or size', () => {
    const res = mockRes();
    liveSync.subscribeUser('u4', res);
    liveSync.broadcastNodeSaved('u4', {
      nodeId: 3, nodeType: 'folder', name: 'blog', path: 'blog',
      modifiedAt: '2026-04-15T00:00:00Z'
    });
    const msg = parseSSE(res.writes[0]);
    expect(msg.type).toBe('node-saved');
    expect(msg.content).toBeUndefined();
    expect(msg.size).toBeUndefined();
    liveSync.unsubscribeUser('u4', res);
  });
});

describe('broadcastNodeMoved — backfills oldName/newName from name', () => {
  test('legacy caller passing only name gets same name in both fields', () => {
    const res = mockRes();
    liveSync.subscribeUser('u5', res);
    liveSync.broadcastNodeMoved('u5', {
      nodeId: 1, nodeType: 'site', name: 'post.html',
      oldPath: 'blog/post.html', newPath: 'projects/post.html'
      // no oldName / newName provided
    });
    const msg = parseSSE(res.writes[0]);
    expect(msg.oldName).toBe('post.html');
    expect(msg.newName).toBe('post.html');
    liveSync.unsubscribeUser('u5', res);
  });

  test('explicit oldName/newName are preserved (move+rename case)', () => {
    const res = mockRes();
    liveSync.subscribeUser('u6', res);
    liveSync.broadcastNodeMoved('u6', {
      nodeId: 1, nodeType: 'site', name: 'new.html',
      oldName: 'old.html', newName: 'new.html',
      oldPath: 'blog/old.html', newPath: 'projects/new.html'
    });
    const msg = parseSSE(res.writes[0]);
    expect(msg.oldName).toBe('old.html');
    expect(msg.newName).toBe('new.html');
    liveSync.unsubscribeUser('u6', res);
  });
});

describe('broadcastNodeRenamed', () => {
  test('delivers with type:node-renamed envelope', () => {
    const res = mockRes();
    liveSync.subscribeUser('u7', res);
    liveSync.broadcastNodeRenamed('u7', {
      nodeId: 1, nodeType: 'site',
      oldName: 'a.html', newName: 'b.html',
      oldPath: 'a.html', newPath: 'b.html'
    });
    const msg = parseSSE(res.writes[0]);
    expect(msg.type).toBe('node-renamed');
    expect(msg.oldPath).toBe('a.html');
    expect(msg.newPath).toBe('b.html');
    liveSync.unsubscribeUser('u7', res);
  });
});

describe('broadcastNodeDeleted', () => {
  test('delivers with type:node-deleted envelope', () => {
    const res = mockRes();
    liveSync.subscribeUser('u8', res);
    liveSync.broadcastNodeDeleted('u8', {
      nodeId: 1, nodeType: 'site',
      name: 'idx.html', path: 'blog/idx.html'
    });
    const msg = parseSSE(res.writes[0]);
    expect(msg.type).toBe('node-deleted');
    expect(msg.path).toBe('blog/idx.html');
    liveSync.unsubscribeUser('u8', res);
  });
});

describe('notify', () => {
  test('delivers with type:notification envelope', () => {
    const res = mockRes();
    liveSync.subscribe('t:notify.html', res);
    liveSync.notify('t:notify.html', { msgType: 'warning', msg: 'File changed', action: 'reload' });
    const msg = parseSSE(res.writes[0]);
    expect(msg.type).toBe('notification');
    expect(msg.msgType).toBe('warning');
    expect(msg.msg).toBe('File changed');
    expect(msg.action).toBe('reload');
    liveSync.unsubscribe('t:notify.html', res);
  });

  test('omits action field when not provided', () => {
    const res = mockRes();
    liveSync.subscribe('t:notify-noaction.html', res);
    liveSync.notify('t:notify-noaction.html', { msgType: 'info', msg: 'hi' });
    const msg = parseSSE(res.writes[0]);
    expect(msg.action).toBeUndefined();
    liveSync.unsubscribe('t:notify-noaction.html', res);
  });
});

describe('getStats', () => {
  test('reports room + connection counts', () => {
    const before = liveSync.getStats();
    const a = mockRes(), b = mockRes();
    liveSync.subscribe('t:stats/a.html', a);
    liveSync.subscribe('t:stats/b.html', b);
    const after = liveSync.getStats();
    expect(after.rooms).toBeGreaterThanOrEqual(before.rooms + 2);
    expect(after.connections).toBeGreaterThanOrEqual(before.connections + 2);
    liveSync.unsubscribe('t:stats/a.html', a);
    liveSync.unsubscribe('t:stats/b.html', b);
  });

  test('reports userConnections count', () => {
    const before = liveSync.getStats();
    const res = mockRes();
    liveSync.subscribeUser('stats-user', res);
    const after = liveSync.getStats();
    expect(after.userConnections).toBeGreaterThanOrEqual(before.userConnections + 1);
    liveSync.unsubscribeUser('stats-user', res);
  });
});

describe('broadcastCollectionRecord — named SSE event for dashboards', () => {
  // Named-event frames are "event: collection-record\ndata: {...}\n\n", so the
  // bare data-only parseSSE() above won't match them — parse explicitly here.
  function parseNamedSSE(msg) {
    const m = msg.match(/^event: collection-record\ndata: (.+)\n\n$/);
    return m ? JSON.parse(m[1]) : null;
  }

  test('create frame carries op/id/data and a named event', () => {
    const res = mockRes();
    liveSync.subscribe('owner:forms/dashboard.html', res);
    const n = liveSync.broadcastCollectionRecord('owner:forms/dashboard.html', {
      op: 'create', id: 'x', data: { a: 1 }, modifiedAt: 't'
    });
    expect(n).toBe(1);
    const raw = res.writes[0];
    expect(raw.startsWith('event: collection-record\n')).toBe(true);
    const msg = parseNamedSSE(raw);
    expect(msg).toMatchObject({ type: 'collection-record', op: 'create', id: 'x', data: { a: 1 }, modifiedAt: 't' });
    expect(typeof msg.seq).toBe('number');
    liveSync.unsubscribe('owner:forms/dashboard.html', res);
  });

  test('delete frame omits data', () => {
    const res = mockRes();
    liveSync.subscribe('owner:forms/d2.html', res);
    liveSync.broadcastCollectionRecord('owner:forms/d2.html', { op: 'delete', id: 'gone' });
    const raw = res.writes[0];
    expect(raw).not.toContain('"data"');
    const msg = parseNamedSSE(raw);
    expect(msg.op).toBe('delete');
    expect(msg.id).toBe('gone');
    expect('data' in msg).toBe(false);
    liveSync.unsubscribe('owner:forms/d2.html', res);
  });

  test('no subscribers is a safe no-op returning 0', () => {
    expect(liveSync.broadcastCollectionRecord('owner:nobody.html', { op: 'create', id: 'x', data: {} })).toBe(0);
  });

  test('dead connection is cleaned up', () => {
    const live = mockRes();
    const dead = { write() { throw new Error('EPIPE'); } };
    liveSync.subscribe('owner:dead-cr.html', live);
    liveSync.subscribe('owner:dead-cr.html', dead);
    liveSync.broadcastCollectionRecord('owner:dead-cr.html', { op: 'create', id: '1', data: {} });
    expect(live.count).toBe(1);
    liveSync.broadcastCollectionRecord('owner:dead-cr.html', { op: 'create', id: '2', data: {} });
    expect(live.count).toBe(2);
    liveSync.unsubscribe('owner:dead-cr.html', live);
  });
});
