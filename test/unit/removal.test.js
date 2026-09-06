const { liveSync } = require('../../index.js');

// Same mock response the other suites use, plus the two things a teardown test
// needs: an end() that counts (closeChannel ends), and a write() that throws
// (the dead-drop path, which the other suites inline as a bare object).
function mockRes({ failWrite = false } = {}) {
  const writes = [];
  return {
    writes,
    ended: 0,
    write(msg) {
      if (failWrite) throw new Error('EPIPE');
      writes.push(msg);
    },
    end() { this.ended++; },
    get count() { return writes.length; }
  };
}

// Handlers are process-global, so every test unregisters its own.
const registered = [];
function watch(log) {
  const off = liveSync.onRemove((file, info) => log.push({ file, ...info }));
  registered.push(off);
  return off;
}
afterEach(() => {
  while (registered.length) registered.pop()();
});

describe('onRemove fires on every teardown path', () => {
  test('unsubscribe fires once with the subscribing lane and meta', () => {
    const seen = [];
    watch(seen);
    const res = mockRes();
    const meta = { personId: 7 };
    liveSync.subscribe('t:rm/plain.html', res, { meta });

    liveSync.unsubscribe('t:rm/plain.html', res);

    expect(seen).toHaveLength(1);
    expect(seen[0].file).toBe('t:rm/plain.html');
    expect(seen[0].lane).toBe('live');
    expect(seen[0].meta).toBe(meta);
  });

  test('closeChannel fires once per connection, before it ends them', () => {
    const seen = [];
    watch(seen);
    const a = mockRes();
    const b = mockRes();
    liveSync.subscribe('t:rm/close.html', a, { meta: { personId: 1 } });
    liveSync.subscribe('t:rm/close.html', b, { meta: { personId: 2 }, lane: 'saved' });

    const closed = liveSync.closeChannel('t:rm/close.html');

    expect(closed).toBe(2);
    expect(a.ended).toBe(1);
    expect(b.ended).toBe(1);
    expect(seen).toHaveLength(2);
    expect(seen.map(s => s.meta.personId).sort()).toEqual([1, 2]);
    expect(seen.map(s => s.lane).sort()).toEqual(['live', 'saved']);
  });

  // The path the invariant is about: a write threw, so the connection left the
  // channel without unsubscribe() and without the request's close handler ever
  // firing. Any per-connection index built on the other two paths goes stale here.
  test('a connection dropped by a failed write fires onRemove with its meta', () => {
    const seen = [];
    watch(seen);
    const live = mockRes();
    const dead = mockRes({ failWrite: true });
    const deadMeta = { personId: 9, label: 'Dana' };
    liveSync.subscribe('t:rm/dead.html', live, { meta: { personId: 1 } });
    liveSync.subscribe('t:rm/dead.html', dead, { meta: deadMeta });

    liveSync.broadcast('t:rm/dead.html', { html: 'x', sender: 'A' });

    expect(live.count).toBe(1);
    expect(seen).toHaveLength(1);
    expect(seen[0].file).toBe('t:rm/dead.html');
    expect(seen[0].meta).toBe(deadMeta);

    liveSync.unsubscribe('t:rm/dead.html', live);
  });

  test('a failed write on the saved lane reports lane saved', () => {
    const seen = [];
    watch(seen);
    const dead = mockRes({ failWrite: true });
    liveSync.subscribe('t:rm/dead-saved.html', dead, { lane: 'saved', meta: { personId: 4 } });

    liveSync.broadcast('t:rm/dead-saved.html', { html: 'x', sender: 'A' }, { lane: 'saved' });

    expect(seen).toHaveLength(1);
    expect(seen[0].lane).toBe('saved');
  });

  test('notify and broadcastCollectionRecord drop dead connections through the same hook', () => {
    const seen = [];
    watch(seen);
    const deadNotify = mockRes({ failWrite: true });
    const deadRecord = mockRes({ failWrite: true });
    liveSync.subscribe('t:rm/dead-notify.html', deadNotify, { meta: { via: 'notify' } });
    liveSync.subscribe('t:rm/dead-record.html', deadRecord, { meta: { via: 'record' } });

    liveSync.notify('t:rm/dead-notify.html', { msgType: 'info', msg: 'hi' });
    liveSync.broadcastCollectionRecord('t:rm/dead-record.html', { op: 'create', id: '1', data: {} });

    expect(seen.map(s => s.meta.via).sort()).toEqual(['notify', 'record']);
  });

  test('the removed connection is gone from the channel by the time the hook runs', () => {
    const dead = mockRes({ failWrite: true });
    liveSync.subscribe('t:rm/gone.html', dead, { meta: { personId: 3 } });
    let remainingAtHook = null;
    registered.push(liveSync.onRemove((file) => {
      remainingAtHook = Array.from(liveSync.subscribers(file)).length;
    }));

    liveSync.broadcast('t:rm/gone.html', { html: 'x', sender: 'A' });

    expect(remainingAtHook).toBe(0);
  });

  // A dropped write used to delete straight out of the Set, leaving an empty
  // channel in `clients` forever when it took the last connection with it.
  test('a failed write that takes the last connection drops the channel too', () => {
    const before = liveSync.getStats().rooms;
    const dead = mockRes({ failWrite: true });
    liveSync.subscribe('t:rm/lastone.html', dead);
    expect(liveSync.getStats().rooms).toBe(before + 1);

    liveSync.broadcast('t:rm/lastone.html', { html: 'x', sender: 'A' });

    expect(liveSync.getStats().rooms).toBe(before);
  });
});

describe('onRemove fires exactly once per connection', () => {
  // closeChannel ends a response; a real server then fires that request's own
  // close handler, which calls unsubscribe. Modelled here by ending through a
  // res whose end() runs the close handler, because that second call is the one
  // a naive implementation double-counts.
  test('closeChannel followed by the request close handler fires no second hook', () => {
    const seen = [];
    watch(seen);
    const file = 't:rm/once-close.html';
    const res = mockRes();
    const rawEnd = res.end.bind(res);
    res.end = () => {
      rawEnd();
      liveSync.unsubscribe(file, res); // what req.on('close') does
    };
    liveSync.subscribe(file, res, { meta: { personId: 5 } });

    liveSync.closeChannel(file);

    expect(res.ended).toBe(1);
    expect(seen).toHaveLength(1);
  });

  test('a failed write followed by a genuine close fires no second hook', () => {
    const seen = [];
    watch(seen);
    const dead = mockRes({ failWrite: true });
    liveSync.subscribe('t:rm/once-dead.html', dead, { meta: { personId: 6 } });

    liveSync.broadcast('t:rm/once-dead.html', { html: 'x', sender: 'A' });
    liveSync.unsubscribe('t:rm/once-dead.html', dead); // the close handler, later

    expect(seen).toHaveLength(1);
  });

  test('unsubscribing twice fires one hook', () => {
    const seen = [];
    watch(seen);
    const res = mockRes();
    liveSync.subscribe('t:rm/once-twice.html', res);

    liveSync.unsubscribe('t:rm/once-twice.html', res);
    liveSync.unsubscribe('t:rm/once-twice.html', res);

    expect(seen).toHaveLength(1);
  });

  test('two broadcasts to the same dead connection fire one hook', () => {
    const seen = [];
    watch(seen);
    const live = mockRes();
    const dead = mockRes({ failWrite: true });
    liveSync.subscribe('t:rm/once-two-writes.html', live);
    liveSync.subscribe('t:rm/once-two-writes.html', dead);

    liveSync.broadcast('t:rm/once-two-writes.html', { html: 'a', sender: 'A' });
    liveSync.broadcast('t:rm/once-two-writes.html', { html: 'b', sender: 'A' });

    expect(seen).toHaveLength(1);
    expect(live.count).toBe(2);
    liveSync.unsubscribe('t:rm/once-two-writes.html', live);
  });

  test('unsubscribing a connection that was never subscribed fires nothing', () => {
    const seen = [];
    watch(seen);
    liveSync.unsubscribe('t:rm/never.html', mockRes());
    const res = mockRes();
    liveSync.subscribe('t:rm/stranger.html', res);
    liveSync.unsubscribe('t:rm/stranger.html', mockRes());

    expect(seen).toHaveLength(0);
    liveSync.unsubscribe('t:rm/stranger.html', res);
  });

  test('a user-channel connection dropped by a failed write fires no file hook', () => {
    const seen = [];
    watch(seen);
    const dead = mockRes({ failWrite: true });
    liveSync.subscribeUser('rm-user', dead);

    liveSync.broadcastToUser('rm-user', 'a.html', { html: 'x', sender: 'A' });

    expect(seen).toHaveLength(0);
    expect(liveSync.getStats().userConnections).toBe(0);
  });
});

describe('onRemove registration', () => {
  test('the returned function unregisters', () => {
    const seen = [];
    const off = watch(seen);
    const first = mockRes();
    liveSync.subscribe('t:rm/reg.html', first);
    liveSync.unsubscribe('t:rm/reg.html', first);
    expect(seen).toHaveLength(1);

    off();
    const second = mockRes();
    liveSync.subscribe('t:rm/reg.html', second);
    liveSync.unsubscribe('t:rm/reg.html', second);
    expect(seen).toHaveLength(1);
  });

  test('every registered handler is called', () => {
    const a = [];
    const b = [];
    watch(a);
    watch(b);
    const res = mockRes();
    liveSync.subscribe('t:rm/multi.html', res, { meta: { personId: 2 } });

    liveSync.unsubscribe('t:rm/multi.html', res);

    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });

  test('a throwing handler does not stop the removal or the other handlers', () => {
    const seen = [];
    registered.push(liveSync.onRemove(() => { throw new Error('consumer blew up'); }));
    watch(seen);
    const res = mockRes();
    liveSync.subscribe('t:rm/throwing.html', res);

    expect(() => liveSync.unsubscribe('t:rm/throwing.html', res)).not.toThrow();
    expect(seen).toHaveLength(1);
    expect(Array.from(liveSync.subscribers('t:rm/throwing.html'))).toHaveLength(0);
  });

  test('a non-function registration is refused', () => {
    expect(() => liveSync.onRemove('nope')).toThrow(TypeError);
    expect(() => liveSync.onRemove()).toThrow(TypeError);
  });
});

describe('subscribers(file)', () => {
  test('yields res, lane and meta for each connection', () => {
    const editor = mockRes();
    const viewer = mockRes();
    const editorMeta = { personId: 1 };
    const viewerMeta = { personId: 2 };
    liveSync.subscribe('t:rm/iter.html', editor, { meta: editorMeta });
    liveSync.subscribe('t:rm/iter.html', viewer, { lane: 'saved', meta: viewerMeta });

    const rows = Array.from(liveSync.subscribers('t:rm/iter.html'));

    expect(rows).toHaveLength(2);
    expect(rows.find(r => r.res === editor)).toEqual({ res: editor, lane: 'live', meta: editorMeta });
    expect(rows.find(r => r.res === viewer)).toEqual({ res: viewer, lane: 'saved', meta: viewerMeta });

    liveSync.unsubscribe('t:rm/iter.html', editor);
    liveSync.unsubscribe('t:rm/iter.html', viewer);
  });

  test('meta is undefined when the caller passed none', () => {
    const res = mockRes();
    liveSync.subscribe('t:rm/nometa.html', res);
    const [row] = Array.from(liveSync.subscribers('t:rm/nometa.html'));
    expect(row.meta).toBeUndefined();
    expect(row.lane).toBe('live');
    liveSync.unsubscribe('t:rm/nometa.html', res);
  });

  test('an unknown channel yields nothing', () => {
    expect(Array.from(liveSync.subscribers('t:rm/nobody.html'))).toEqual([]);
  });

  test('removing during iteration is safe and the channel keeps the rest', () => {
    const a = mockRes();
    const b = mockRes();
    liveSync.subscribe('t:rm/iter-mutate.html', a, { meta: { drop: true } });
    liveSync.subscribe('t:rm/iter-mutate.html', b, { meta: { drop: false } });

    const visited = [];
    for (const { res, meta } of liveSync.subscribers('t:rm/iter-mutate.html')) {
      visited.push(res);
      if (meta.drop) liveSync.unsubscribe('t:rm/iter-mutate.html', res);
    }

    expect(visited).toHaveLength(2);
    const left = Array.from(liveSync.subscribers('t:rm/iter-mutate.html'));
    expect(left).toHaveLength(1);
    expect(left[0].res).toBe(b);

    liveSync.unsubscribe('t:rm/iter-mutate.html', b);
  });

  test('a connection subscribed during iteration is not visited in the same pass', () => {
    const first = mockRes();
    liveSync.subscribe('t:rm/iter-add.html', first);

    const visited = [];
    for (const { res } of liveSync.subscribers('t:rm/iter-add.html')) {
      visited.push(res);
      if (visited.length === 1) liveSync.subscribe('t:rm/iter-add.html', mockRes());
    }

    expect(visited).toEqual([first]);
    liveSync.closeChannel('t:rm/iter-add.html');
  });

  test('the library never reads meta: any value survives round trip unchanged', () => {
    const res = mockRes();
    const meta = 'just-a-string';
    liveSync.subscribe('t:rm/opaque.html', res, { meta });
    expect(Array.from(liveSync.subscribers('t:rm/opaque.html'))[0].meta).toBe('just-a-string');
    liveSync.unsubscribe('t:rm/opaque.html', res);
  });
});

describe('existing callers are unaffected', () => {
  test('subscribe with no options still delivers and unsubscribes', () => {
    const res = mockRes();
    liveSync.subscribe('t:rm/compat.html', res);
    liveSync.broadcast('t:rm/compat.html', { html: 'x', sender: 'A' });
    expect(res.count).toBe(1);
    liveSync.unsubscribe('t:rm/compat.html', res);
    liveSync.broadcast('t:rm/compat.html', { html: 'y', sender: 'A' });
    expect(res.count).toBe(1);
  });

  test('subscribe with only a lane still splits the lanes', () => {
    const live = mockRes();
    const saved = mockRes();
    liveSync.subscribe('t:rm/compat-lane.html', live);
    liveSync.subscribe('t:rm/compat-lane.html', saved, { lane: 'saved' });
    liveSync.broadcast('t:rm/compat-lane.html', { html: 'x', sender: 'A' }, { lane: 'saved' });
    expect(live.count).toBe(0);
    expect(saved.count).toBe(1);
    liveSync.unsubscribe('t:rm/compat-lane.html', live);
    liveSync.unsubscribe('t:rm/compat-lane.html', saved);
  });

  test('unsubscribing the last connection still drops the channel', () => {
    const before = liveSync.getStats().rooms;
    const res = mockRes();
    liveSync.subscribe('t:rm/compat-room.html', res);
    liveSync.unsubscribe('t:rm/compat-room.html', res);
    expect(liveSync.getStats().rooms).toBe(before);
  });
});
