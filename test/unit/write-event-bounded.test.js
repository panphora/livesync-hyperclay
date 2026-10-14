const { EventEmitter } = require('node:events');
const { liveSync } = require('../../index.js');

// A response whose socket can be told to fall behind: write() returns false
// while `behind` is set, writableLength grows with what it refused, and
// emitting 'drain' catches it up.
function slowRes() {
  const res = new EventEmitter();
  res.writes = [];
  res.behind = false;
  res.writableLength = 0;
  res.destroyed = 0;
  res.ended = 0;
  res.write = (msg) => {
    res.writes.push(msg);
    if (res.behind) {
      res.writableLength += msg.length;
      return false;
    }
    return true;
  };
  res.catchUp = () => {
    res.behind = false;
    res.writableLength = 0;
    res.emit('drain');
  };
  res.destroy = () => { res.destroyed++; };
  res.end = () => { res.ended++; };
  return res;
}

const registered = [];
afterEach(() => {
  while (registered.length) registered.pop()();
});

const LIMITS = { maxBacklogFrames: 3, maxBacklogBytes: 10_000 };

test('without limits, a connection that is behind keeps receiving, as before', () => {
  const file = 't:bounded/none.html';
  const res = slowRes();
  liveSync.subscribe(file, res);
  res.behind = true;
  for (let i = 0; i < 50; i++) liveSync.writeEvent(file, 'data', () => ({ i }));
  expect(res.writes).toHaveLength(50);
  expect(res.destroyed).toBe(0);
  liveSync.closeChannel(file);
});

test('with limits, a connection past maxBacklogFrames is dropped once, through onRemove', () => {
  const file = 't:bounded/frames.html';
  const log = [];
  registered.push(liveSync.onRemove((f, info) => log.push({ f, ...info })));
  const fast = slowRes();
  const stuck = slowRes();
  liveSync.subscribe(file, fast, { meta: 'fast' });
  liveSync.subscribe(file, stuck, { meta: 'stuck' });
  stuck.behind = true;

  for (let i = 0; i < 3; i++) expect(liveSync.writeEvent(file, 'data', () => ({ i }), LIMITS)).toBe(2);
  expect(stuck.destroyed).toBe(0);

  expect(liveSync.writeEvent(file, 'data', () => ({ i: 3 }), LIMITS)).toBe(2);
  expect(stuck.destroyed).toBe(1);
  expect(log).toEqual([{ f: file, lane: 'live', meta: 'stuck' }]);

  expect(liveSync.writeEvent(file, 'data', () => ({ i: 4 }), LIMITS)).toBe(1);
  expect(stuck.writes).toHaveLength(4);
  expect(fast.writes).toHaveLength(5);
  expect(fast.destroyed).toBe(0);
  liveSync.closeChannel(file);
});

test('a drain resets the count, so a connection that catches up stays', () => {
  const file = 't:bounded/drain.html';
  const res = slowRes();
  liveSync.subscribe(file, res);
  for (let round = 0; round < 5; round++) {
    res.behind = true;
    for (let i = 0; i < 3; i++) liveSync.writeEvent(file, 'data', () => ({ round, i }), LIMITS);
    res.catchUp();
  }
  expect(res.destroyed).toBe(0);
  expect(res.writes).toHaveLength(15);
  liveSync.closeChannel(file);
});

test('a connection holding more than maxBacklogBytes unsent is dropped', () => {
  const file = 't:bounded/bytes.html';
  const res = slowRes();
  liveSync.subscribe(file, res);
  res.behind = true;
  liveSync.writeEvent(file, 'data', () => ({ blob: 'x'.repeat(20_000) }), LIMITS);
  expect(res.destroyed).toBe(1);
  expect(liveSync.writeEvent(file, 'data', () => ({ i: 1 }), LIMITS)).toBe(0);
});

test('a response without destroy is ended instead', () => {
  const file = 't:bounded/end.html';
  const res = slowRes();
  delete res.destroy;
  liveSync.subscribe(file, res);
  res.behind = true;
  liveSync.writeEvent(file, 'data', () => ({ blob: 'x'.repeat(20_000) }), LIMITS);
  expect(res.ended).toBe(1);
});

test('limits with neither field set behave like no limits', () => {
  const file = 't:bounded/empty.html';
  const res = slowRes();
  liveSync.subscribe(file, res);
  res.behind = true;
  for (let i = 0; i < 40; i++) liveSync.writeEvent(file, 'data', () => ({ i }), {});
  expect(res.destroyed).toBe(0);
  liveSync.closeChannel(file);
});
