const { liveSync } = require('../../index.js');

// A res that counts ends and can be made to fail a write, same shape the removal
// suite uses. closeWhere both removes and ends, so a test needs both.
function mockRes({ failWrite = false, failEnd = false } = {}) {
  const writes = [];
  return {
    writes,
    ended: 0,
    write(msg) {
      if (failWrite) throw new Error('EPIPE');
      writes.push(msg);
    },
    end() {
      this.ended++;
      if (failEnd) throw new Error('already destroyed');
    },
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

// The half a close test usually skips: who is still here afterwards, and are they
// still receiving. Phase 2f's demotion is exactly that question.
function stillReceiving(file) {
  const before = new Map(
    Array.from(liveSync.subscribers(file)).map(({ res }) => [res, res.count])
  );
  liveSync.broadcast(file, { html: 'ping', sender: 'A' }, { lane: 'all' });
  return Array.from(before.keys()).filter(res => res.count === before.get(res) + 1);
}

describe('closeWhere ends the matching connections', () => {
  test('one person leaves, everyone else keeps receiving', () => {
    const seen = [];
    watch(seen);
    const file = 't:cw/member.html';
    const gone = mockRes();
    const stays = mockRes();
    const owner = mockRes();
    liveSync.subscribe(file, gone, { meta: { personId: 7 } });
    liveSync.subscribe(file, stays, { meta: { personId: 8 } });
    liveSync.subscribe(file, owner, { meta: { personId: 1 } });

    const closed = liveSync.closeWhere(file, m => m.personId === 7);

    expect(closed).toBe(1);
    expect(gone.ended).toBe(1);
    expect(stays.ended).toBe(0);
    expect(owner.ended).toBe(0);
    expect(seen).toHaveLength(1);
    expect(seen[0].meta.personId).toBe(7);
    expect(stillReceiving(file)).toEqual([stays, owner]);

    liveSync.closeChannel(file);
  });

  // Phase 2f: an editor demoted to viewer loses their editing streams and keeps
  // reading. Their own saved-lane tab surviving is the point of the predicate.
  test('a demotion closes that person live lane and keeps their saved-lane tabs', () => {
    const file = 't:cw/demote.html';
    const theirLive = mockRes();
    const theirSaved = mockRes();
    const otherLive = mockRes();
    liveSync.subscribe(file, theirLive, { meta: { personId: 4, lane: 'live' }, lane: 'live' });
    liveSync.subscribe(file, theirSaved, { meta: { personId: 4, lane: 'saved' }, lane: 'saved' });
    liveSync.subscribe(file, otherLive, { meta: { personId: 5, lane: 'live' }, lane: 'live' });

    const closed = liveSync.closeWhere(file, m => m.personId === 4 && m.lane === 'live');

    expect(closed).toBe(1);
    expect(theirLive.ended).toBe(1);
    expect(theirSaved.ended).toBe(0);
    expect(stillReceiving(file)).toEqual([theirSaved, otherLive]);

    liveSync.closeChannel(file);
  });

  test('a revoked link closes its guests and leaves the signed-in tabs', () => {
    const file = 't:cw/link.html';
    const guestA = mockRes();
    const guestB = mockRes();
    const member = mockRes();
    liveSync.subscribe(file, guestA, { meta: { shareLinkId: 12, guestId: 'g1' } });
    liveSync.subscribe(file, guestB, { meta: { shareLinkId: 12, guestId: 'g2' } });
    liveSync.subscribe(file, member, { meta: { personId: 3, shareLinkId: null } });

    expect(liveSync.closeWhere(file, m => m.shareLinkId === 12)).toBe(2);
    expect(stillReceiving(file)).toEqual([member]);

    liveSync.closeChannel(file);
  });

  test('going private drops whoever lost canView and keeps the owner tabs', () => {
    const file = 't:cw/private.html';
    const ownerTabOne = mockRes();
    const ownerTabTwo = mockRes();
    const viewer = mockRes();
    liveSync.subscribe(file, ownerTabOne, { meta: { personId: 1, canView: true } });
    liveSync.subscribe(file, ownerTabTwo, { meta: { personId: 1, canView: true }, lane: 'saved' });
    liveSync.subscribe(file, viewer, { meta: { personId: null, canView: false }, lane: 'saved' });

    expect(liveSync.closeWhere(file, m => !m.canView)).toBe(1);
    expect(viewer.ended).toBe(1);
    expect(stillReceiving(file)).toEqual([ownerTabOne, ownerTabTwo]);

    liveSync.closeChannel(file);
  });

  test('a predicate matching nothing closes nothing and ends nobody', () => {
    const file = 't:cw/nomatch.html';
    const a = mockRes();
    const b = mockRes();
    const seen = [];
    watch(seen);
    liveSync.subscribe(file, a, { meta: { personId: 1 } });
    liveSync.subscribe(file, b, { meta: { personId: 2 } });

    expect(liveSync.closeWhere(file, m => m.personId === 99)).toBe(0);

    expect(a.ended).toBe(0);
    expect(b.ended).toBe(0);
    expect(seen).toHaveLength(0);
    expect(stillReceiving(file)).toEqual([a, b]);

    liveSync.closeChannel(file);
  });

  test('closing the last connection drops the channel', () => {
    const before = liveSync.getStats().rooms;
    const file = 't:cw/last.html';
    const res = mockRes();
    liveSync.subscribe(file, res, { meta: { personId: 2 } });

    liveSync.closeWhere(file, () => true);

    expect(liveSync.getStats().rooms).toBe(before);
    expect(Array.from(liveSync.subscribers(file))).toHaveLength(0);
  });

  test('an unknown channel closes nothing and never calls the predicate', () => {
    let calls = 0;
    expect(liveSync.closeWhere('t:cw/nobody.html', () => { calls++; return true; })).toBe(0);
    expect(calls).toBe(0);
  });

  test('a res whose end() throws still leaves the channel', () => {
    const seen = [];
    watch(seen);
    const file = 't:cw/badend.html';
    const broken = mockRes({ failEnd: true });
    const fine = mockRes();
    liveSync.subscribe(file, broken, { meta: { personId: 1 } });
    liveSync.subscribe(file, fine, { meta: { personId: 2 } });

    expect(liveSync.closeWhere(file, m => m.personId === 1)).toBe(0);

    expect(seen).toHaveLength(1);
    expect(Array.from(liveSync.subscribers(file)).map(r => r.res)).toEqual([fine]);

    liveSync.closeChannel(file);
  });

  test('the request own close handler afterwards fires no second onRemove', () => {
    const seen = [];
    watch(seen);
    const file = 't:cw/once.html';
    const res = mockRes();
    const rawEnd = res.end.bind(res);
    res.end = () => {
      rawEnd();
      liveSync.unsubscribe(file, res); // what req.on('close') does
    };
    liveSync.subscribe(file, res, { meta: { personId: 5 } });

    liveSync.closeWhere(file, m => m.personId === 5);

    expect(res.ended).toBe(1);
    expect(seen).toHaveLength(1);
  });

  test('a connection dropped by a failed write is not closed a second time', () => {
    const seen = [];
    watch(seen);
    const file = 't:cw/dead.html';
    const dead = mockRes({ failWrite: true });
    liveSync.subscribe(file, dead, { meta: { personId: 6 } });

    liveSync.broadcast(file, { html: 'x', sender: 'A' });
    expect(liveSync.closeWhere(file, m => m.personId === 6)).toBe(0);

    expect(dead.ended).toBe(0);
    expect(seen).toHaveLength(1);
  });
});

// The decision, written down: a connection carrying no metadata carries nothing to
// match on, so it never matches and the predicate is never handed an undefined.
// hyperclay always passes meta; hyperclay-local passes none at all, and it is the
// consumer a throw here would break.
describe('closeWhere and a connection with no metadata', () => {
  test('a meta-less connection never matches and keeps receiving', () => {
    const seen = [];
    watch(seen);
    const file = 't:cw/nometa.html';
    const bare = mockRes();
    const known = mockRes();
    liveSync.subscribe(file, bare);
    liveSync.subscribe(file, known, { meta: { personId: 9 } });

    expect(liveSync.closeWhere(file, () => true)).toBe(1);

    expect(bare.ended).toBe(0);
    expect(known.ended).toBe(1);
    expect(seen).toHaveLength(1);
    expect(stillReceiving(file)).toEqual([bare]);

    liveSync.closeChannel(file);
  });

  test('the predicate is not called for it, so the natural form does not throw', () => {
    const file = 't:cw/nometa-throw.html';
    const bare = mockRes();
    liveSync.subscribe(file, bare);
    const seenMeta = [];

    expect(() => liveSync.closeWhere(file, m => {
      seenMeta.push(m);
      return m.personId === 1;
    })).not.toThrow();

    expect(seenMeta).toEqual([]);
    expect(bare.ended).toBe(0);

    liveSync.closeChannel(file);
  });

  // The other half of the same decision: a negated predicate must not sweep up
  // every connection that simply carries nothing.
  test('a negated predicate does not close it either', () => {
    const file = 't:cw/nometa-negated.html';
    const bare = mockRes();
    const viewer = mockRes();
    liveSync.subscribe(file, bare);
    liveSync.subscribe(file, viewer, { meta: { canView: false } });

    expect(liveSync.closeWhere(file, m => !m.canView)).toBe(1);

    expect(bare.ended).toBe(0);
    expect(viewer.ended).toBe(1);

    liveSync.closeChannel(file);
  });

  test('an explicit null meta is treated the same as none', () => {
    const file = 't:cw/nullmeta.html';
    const res = mockRes();
    liveSync.subscribe(file, res, { meta: null });

    expect(liveSync.closeWhere(file, () => true)).toBe(0);
    expect(res.ended).toBe(0);

    liveSync.closeChannel(file);
  });
});

describe('closeWhere refuses bad input', () => {
  test('a non-function predicate is refused', () => {
    expect(() => liveSync.closeWhere('t:cw/bad.html', 'nope')).toThrow(TypeError);
    expect(() => liveSync.closeWhere('t:cw/bad.html')).toThrow(TypeError);
  });

  // Matching runs over the whole snapshot before anything is ended, so a predicate
  // that blows up halfway leaves the channel as it found it rather than half closed.
  test('a throwing predicate closes nobody and the error reaches the caller', () => {
    const seen = [];
    watch(seen);
    const file = 't:cw/throwing.html';
    const first = mockRes();
    const second = mockRes();
    liveSync.subscribe(file, first, { meta: { personId: 1 } });
    liveSync.subscribe(file, second, { meta: { personId: 2 } });

    expect(() => liveSync.closeWhere(file, m => {
      if (m.personId === 2) throw new Error('consumer blew up');
      return true;
    })).toThrow('consumer blew up');

    expect(first.ended).toBe(0);
    expect(second.ended).toBe(0);
    expect(seen).toHaveLength(0);
    expect(stillReceiving(file)).toEqual([first, second]);

    liveSync.closeChannel(file);
  });
});
