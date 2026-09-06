const { liveSync } = require('../../index.js');

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

const registered = [];
function watch(log) {
  const off = liveSync.onRemove((file, info) => log.push({ file, ...info }));
  registered.push(off);
  return off;
}
afterEach(() => {
  while (registered.length) registered.pop()();
});

// A named frame is `event: <name>\ndata: <json>\n\n`. Parsing it this strictly is
// the test: a frame missing its name still parses as SSE, and that is precisely
// the frame this must never write.
function parseNamed(raw) {
  const m = raw.match(/^event: ([^\n]+)\ndata: (.+)\n\n$/);
  if (!m) return null;
  return { name: m[1], data: JSON.parse(m[2]) };
}

describe('writeEvent names every frame it writes', () => {
  // The invariant. Every connection on the channel is a recipient whether or not
  // it can parse the event: an old tab, a hyperclayjs tab and a collection
  // dashboard are all here and none of them listens for `presence`. A frame
  // written without its name lands on their default onmessage handler, which
  // reads a frame as a document.
  test('no connection receives a bare data: line for the event', () => {
    const file = 't:we/named.html';
    const listener = mockRes();
    const oldTab = mockRes();
    const dashboard = mockRes();
    liveSync.subscribe(file, listener, { meta: { personId: 1 } });
    liveSync.subscribe(file, oldTab, { meta: { personId: 2 } });
    liveSync.subscribe(file, dashboard);

    const sent = liveSync.writeEvent(file, 'presence', () => ({ people: [], anonymous: 3 }));

    expect(sent).toBe(3);
    for (const res of [listener, oldTab, dashboard]) {
      expect(res.writes).toHaveLength(1);
      expect(res.writes[0].startsWith('event: presence\n')).toBe(true);
      expect(parseNamed(res.writes[0]).name).toBe('presence');
    }

    liveSync.closeChannel(file);
  });

  test('the frame is exactly the built payload, with nothing added to it', () => {
    const file = 't:we/verbatim.html';
    const res = mockRes();
    liveSync.subscribe(file, res, { meta: { personId: 1 } });

    liveSync.writeEvent(file, 'presence', () => ({ people: [{ id: 'p1' }], anonymous: 0 }));

    const { data } = parseNamed(res.writes[0]);
    expect(data).toEqual({ people: [{ id: 'p1' }], anonymous: 0 });
    expect('seq' in data).toBe(false);

    liveSync.closeChannel(file);
  });

  test('both lanes receive it, the same as any other channel write', () => {
    const file = 't:we/lanes.html';
    const live = mockRes();
    const saved = mockRes();
    liveSync.subscribe(file, live, { lane: 'live', meta: { personId: 1 } });
    liveSync.subscribe(file, saved, { lane: 'saved', meta: { personId: 2 } });

    const lanes = [];
    liveSync.writeEvent(file, 'presence', ({ lane }) => {
      lanes.push(lane);
      return { lane };
    });

    expect(lanes.sort()).toEqual(['live', 'saved']);
    expect(parseNamed(live.writes[0]).data.lane).toBe('live');
    expect(parseNamed(saved.writes[0]).data.lane).toBe('saved');

    liveSync.closeChannel(file);
  });
});

describe('writeEvent builds per recipient', () => {
  test('build is called once per connection with its own lane and meta', () => {
    const file = 't:we/percall.html';
    const owner = mockRes();
    const viewer = mockRes();
    const ownerMeta = { personId: 1, canView: true };
    const viewerMeta = { personId: 2, canView: false };
    liveSync.subscribe(file, owner, { meta: ownerMeta });
    liveSync.subscribe(file, viewer, { lane: 'saved', meta: viewerMeta });

    const calls = [];
    liveSync.writeEvent(file, 'presence', info => {
      calls.push(info);
      return { ok: true };
    });

    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({ lane: 'live', meta: ownerMeta });
    expect(calls[1]).toEqual({ lane: 'saved', meta: viewerMeta });
    expect(calls[0].meta).toBe(ownerMeta);

    liveSync.closeChannel(file);
  });

  // The whole reason this exists next to broadcast(): one message serialized for
  // everyone cannot answer "what may this connection be told".
  test('two recipients receive two different payloads', () => {
    const file = 't:we/different.html';
    const owner = mockRes();
    const stranger = mockRes();
    liveSync.subscribe(file, owner, { meta: { canView: true } });
    liveSync.subscribe(file, stranger, { meta: { canView: false } });

    liveSync.writeEvent(file, 'presence', ({ meta }) => (
      meta.canView
        ? { people: [{ id: 'p1', name: 'Dana' }], anonymous: 0 }
        : { people: [], anonymous: 1 }
    ));

    expect(parseNamed(owner.writes[0]).data.people).toEqual([{ id: 'p1', name: 'Dana' }]);
    expect(parseNamed(stranger.writes[0]).data).toEqual({ people: [], anonymous: 1 });
    expect(JSON.stringify(stranger.writes)).not.toContain('Dana');

    liveSync.closeChannel(file);
  });

  test('returning null skips that connection entirely, writing it nothing', () => {
    const file = 't:we/skip.html';
    const wanted = mockRes();
    const skipped = mockRes();
    liveSync.subscribe(file, wanted, { meta: { tell: true } });
    liveSync.subscribe(file, skipped, { meta: { tell: false } });

    const sent = liveSync.writeEvent(file, 'presence', ({ meta }) => (meta.tell ? { ok: 1 } : null));

    expect(sent).toBe(1);
    expect(wanted.writes).toHaveLength(1);
    expect(skipped.writes).toHaveLength(0);

    liveSync.closeChannel(file);
  });

  test('returning nothing at all skips it too', () => {
    const file = 't:we/undef.html';
    const res = mockRes();
    liveSync.subscribe(file, res, { meta: { personId: 1 } });

    expect(liveSync.writeEvent(file, 'presence', () => {})).toBe(0);
    expect(res.writes).toHaveLength(0);

    liveSync.closeChannel(file);
  });

  // Unlike closeWhere, a meta-less connection is a recipient like any other here:
  // it is on the channel, so it is in the roster, and build decides what it sees.
  test('a meta-less connection is offered to build with meta undefined', () => {
    const file = 't:we/nometa.html';
    const bare = mockRes();
    liveSync.subscribe(file, bare);

    const seen = [];
    liveSync.writeEvent(file, 'presence', info => {
      seen.push(info);
      return { anonymous: 1 };
    });

    expect(seen).toEqual([{ lane: 'live', meta: undefined }]);
    expect(bare.writes).toHaveLength(1);

    liveSync.closeChannel(file);
  });

  test('an unknown channel writes nothing and never calls build', () => {
    let calls = 0;
    expect(liveSync.writeEvent('t:we/nobody.html', 'presence', () => { calls++; return {}; })).toBe(0);
    expect(calls).toBe(0);
  });
});

describe('writeEvent failure semantics match every other write', () => {
  test('a connection whose write throws leaves through onRemove and the rest still receive', () => {
    const seen = [];
    watch(seen);
    const file = 't:we/dead.html';
    const dead = mockRes({ failWrite: true });
    const alive = mockRes();
    const deadMeta = { personId: 9 };
    liveSync.subscribe(file, dead, { meta: deadMeta });
    liveSync.subscribe(file, alive, { meta: { personId: 1 } });

    const sent = liveSync.writeEvent(file, 'presence', () => ({ ok: 1 }));

    expect(sent).toBe(1);
    expect(alive.writes).toHaveLength(1);
    expect(seen).toHaveLength(1);
    expect(seen[0].file).toBe(file);
    expect(seen[0].meta).toBe(deadMeta);
    expect(Array.from(liveSync.subscribers(file)).map(r => r.res)).toEqual([alive]);

    liveSync.closeChannel(file);
  });

  test('a build that removes a connection mid-pass does not write to it', () => {
    const file = 't:we/mutate.html';
    const first = mockRes();
    const second = mockRes();
    liveSync.subscribe(file, first, { meta: { drop: 'second' } });
    liveSync.subscribe(file, second, { meta: { drop: null } });

    liveSync.writeEvent(file, 'presence', ({ meta }) => {
      if (meta.drop === 'second') liveSync.unsubscribe(file, second);
      return { ok: 1 };
    });

    expect(first.writes).toHaveLength(1);
    expect(second.writes).toHaveLength(0);

    liveSync.closeChannel(file);
  });

  test('a throwing build reaches the caller', () => {
    const file = 't:we/throwing.html';
    const res = mockRes();
    liveSync.subscribe(file, res, { meta: { personId: 1 } });

    expect(() => liveSync.writeEvent(file, 'presence', () => {
      throw new Error('roster blew up');
    })).toThrow('roster blew up');

    liveSync.closeChannel(file);
  });
});

describe('writeEvent refuses a name it cannot write', () => {
  // A defaulted or empty name is the one way a bare `data:` frame could reach a
  // tab that is not listening, so there is no path that writes one.
  test('a missing, empty or non-string name is refused before anything is written', () => {
    const file = 't:we/badname.html';
    const res = mockRes();
    liveSync.subscribe(file, res, { meta: { personId: 1 } });

    expect(() => liveSync.writeEvent(file, '', () => ({}))).toThrow(TypeError);
    expect(() => liveSync.writeEvent(file, undefined, () => ({}))).toThrow(TypeError);
    expect(() => liveSync.writeEvent(file, 42, () => ({}))).toThrow(TypeError);
    expect(res.writes).toHaveLength(0);

    liveSync.closeChannel(file);
  });

  // A newline in the name would close the event field and let the rest of the
  // string write its own frames.
  test('a name carrying a newline is refused', () => {
    const file = 't:we/newline.html';
    const res = mockRes();
    liveSync.subscribe(file, res, { meta: { personId: 1 } });

    expect(() => liveSync.writeEvent(file, 'presence\ndata: {}', () => ({}))).toThrow(TypeError);
    expect(() => liveSync.writeEvent(file, 'presence\r', () => ({}))).toThrow(TypeError);
    expect(res.writes).toHaveLength(0);

    liveSync.closeChannel(file);
  });

  test('a non-function build is refused', () => {
    expect(() => liveSync.writeEvent('t:we/badbuild.html', 'presence', null)).toThrow(TypeError);
    expect(() => liveSync.writeEvent('t:we/badbuild.html', 'presence')).toThrow(TypeError);
  });
});
