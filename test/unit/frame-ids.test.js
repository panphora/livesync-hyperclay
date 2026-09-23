// Opt-in frame ids and the frame tap. Both are off until a host asks, so each
// test loads a fresh copy of the module: frameIds and the tap set are module
// state, and a leak between tests would make "off by default" untestable.
let liveSync;

beforeEach(() => {
  jest.isolateModules(() => {
    ({ liveSync } = require('../../index.js'));
  });
});

// Mock Express res — captures write() calls into a log.
function mockRes() {
  const writes = [];
  return {
    writes,
    write(msg) { writes.push(msg); },
    get count() { return writes.length; }
  };
}

describe('frame ids are opt-in', () => {
  test('ids are off by default', () => {
    const res = mockRes();
    liveSync.subscribe('t:ids/off.html', res);
    liveSync.broadcast('t:ids/off.html', { html: '<p>a</p>', sender: 'A' });

    expect(res.count).toBe(1);
    expect(res.writes[0].startsWith('data: ')).toBe(true);
    expect(res.writes[0].startsWith('id: ')).toBe(false);
  });

  test('configure({ frameIds: true }) prefixes id equal to payload seq', () => {
    liveSync.configure({ frameIds: true });
    const res = mockRes();
    liveSync.subscribe('t:ids/on.html', res);
    liveSync.broadcast('t:ids/on.html', { html: '<p>a</p>', sender: 'A' });

    const m = res.writes[0].match(/^id: (\d+)\ndata: (.+)\n\n$/);
    expect(m).not.toBeNull();
    expect(JSON.parse(m[2]).seq).toBe(Number(m[1]));
  });

  test('notify gets an id when ids are on, and its payload gains no seq', () => {
    liveSync.configure({ frameIds: true });
    const res = mockRes();
    liveSync.subscribe('t:ids/notify.html', res);
    liveSync.notify('t:ids/notify.html', { msgType: 'info', msg: 'hi' });

    const m = res.writes[0].match(/^id: (\d+)\ndata: (.+)\n\n$/);
    expect(m).not.toBeNull();
    const payload = JSON.parse(m[2]);
    expect(payload).toEqual({ type: 'notification', msgType: 'info', msg: 'hi' });
    expect('seq' in payload).toBe(false);
  });
});

describe('onFrame taps every file-channel frame', () => {
  test('sees a broadcast with no subscribers', () => {
    const frames = [];
    liveSync.onFrame(f => frames.push(f));

    liveSync.broadcast('t:tap/nobody.html', { html: '<p>a</p>', sender: 'A' });

    expect(frames).toHaveLength(1);
    expect(frames[0].file).toBe('t:tap/nobody.html');
    expect(frames[0].lane).toBe('live');
    expect(frames[0].message).toBe(
      `data: ${JSON.stringify({ html: '<p>a</p>', sender: 'A', seq: frames[0].seq })}\n\n`
    );
  });

  test('sees notify', () => {
    const frames = [];
    liveSync.onFrame(f => frames.push(f));

    liveSync.notify('t:tap/notify.html', { msgType: 'warning', msg: 'careful' });

    expect(frames).toHaveLength(1);
    expect(frames[0].seq).toEqual(expect.any(Number));
    expect(JSON.parse(frames[0].message.match(/^data: (.+)\n\n$/)[1])).toEqual({
      type: 'notification',
      msgType: 'warning',
      msg: 'careful'
    });
  });

  test('sees collection-record with lane live', () => {
    const frames = [];
    liveSync.onFrame(f => frames.push(f));

    liveSync.broadcastCollectionRecord('t:tap/records.html', {
      op: 'update',
      id: 'r1',
      data: { a: 1 }
    });

    expect(frames).toHaveLength(1);
    expect(frames[0].file).toBe('t:tap/records.html');
    expect(frames[0].lane).toBe('live');
    expect(frames[0].message.startsWith('event: collection-record\n')).toBe(true);
  });

  test('a throwing tap does not stop delivery', () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const seen = [];
    liveSync.onFrame(() => { throw new Error('boom'); });
    liveSync.onFrame(f => seen.push(f));

    const res = mockRes();
    liveSync.subscribe('t:tap/throw.html', res);
    liveSync.broadcast('t:tap/throw.html', { html: '<p>a</p>', sender: 'A' });

    expect(res.count).toBe(1);
    expect(seen).toHaveLength(1);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  test('the unsubscribe function returned by onFrame removes the tap', () => {
    const frames = [];
    const off = liveSync.onFrame(f => frames.push(f));

    liveSync.broadcast('t:tap/off.html', { html: 'x', sender: 'A' });
    off();
    liveSync.broadcast('t:tap/off.html', { html: 'y', sender: 'A' });

    expect(frames).toHaveLength(1);
  });

  test('writeEvent frames carry no id and are not tapped', () => {
    liveSync.configure({ frameIds: true });
    const frames = [];
    liveSync.onFrame(f => frames.push(f));

    const res = mockRes();
    liveSync.subscribe('t:tap/write-event.html', res);
    liveSync.writeEvent('t:tap/write-event.html', 'private', () => ({ hello: 'there' }));

    expect(frames).toHaveLength(0);
    expect(res.writes[0]).toBe('event: private\ndata: {"hello":"there"}\n\n');
  });
});
