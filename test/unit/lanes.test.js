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
  const m = msg.match(/^data: (.+)\n\n$/);
  return m ? JSON.parse(m[1]) : null;
}

describe('subscriber lanes', () => {
  test('default subscribe lands on live lane and receives default broadcasts', () => {
    const res = mockRes();
    liveSync.subscribe('t:lane-default.html', res);
    liveSync.broadcast('t:lane-default.html', { html: '<p>x</p>', sender: 'A' });
    expect(res.count).toBe(1);
    liveSync.unsubscribe('t:lane-default.html', res);
  });

  test('saved-lane subscriber does not receive live broadcasts', () => {
    const live = mockRes();
    const saved = mockRes();
    liveSync.subscribe('t:lane-split.html', live);
    liveSync.subscribe('t:lane-split.html', saved, { lane: 'saved' });

    liveSync.broadcast('t:lane-split.html', { html: '<p>pre-strip</p>', sender: 'A' });
    expect(live.count).toBe(1);
    expect(saved.count).toBe(0);

    liveSync.unsubscribe('t:lane-split.html', live);
    liveSync.unsubscribe('t:lane-split.html', saved);
  });

  test('saved-lane broadcast reaches only saved subscribers', () => {
    const live = mockRes();
    const saved = mockRes();
    liveSync.subscribe('t:lane-saved.html', live);
    liveSync.subscribe('t:lane-saved.html', saved, { lane: 'saved' });

    liveSync.broadcast('t:lane-saved.html', { html: '<p>on-disk</p>', sender: 'server-save' }, { lane: 'saved' });
    expect(live.count).toBe(0);
    expect(saved.count).toBe(1);
    expect(parseSSE(saved.writes[0])).toMatchObject({ html: '<p>on-disk</p>', sender: 'server-save' });

    liveSync.unsubscribe('t:lane-saved.html', live);
    liveSync.unsubscribe('t:lane-saved.html', saved);
  });

  test('lane "all" reaches both lanes', () => {
    const live = mockRes();
    const saved = mockRes();
    liveSync.subscribe('t:lane-all.html', live);
    liveSync.subscribe('t:lane-all.html', saved, { lane: 'saved' });

    liveSync.broadcast('t:lane-all.html', { html: '<p>disk</p>', sender: 's' }, { lane: 'all' });
    expect(live.count).toBe(1);
    expect(saved.count).toBe(1);

    liveSync.unsubscribe('t:lane-all.html', live);
    liveSync.unsubscribe('t:lane-all.html', saved);
  });

  test('unknown lane value on subscribe coerces to live', () => {
    const res = mockRes();
    liveSync.subscribe('t:lane-coerce.html', res, { lane: 'bogus' });
    liveSync.broadcast('t:lane-coerce.html', { html: 'x', sender: 'A' });
    expect(res.count).toBe(1);
    liveSync.unsubscribe('t:lane-coerce.html', res);
  });

  test('notify defaults to live lane only', () => {
    const live = mockRes();
    const saved = mockRes();
    liveSync.subscribe('t:lane-notify.html', live);
    liveSync.subscribe('t:lane-notify.html', saved, { lane: 'saved' });

    liveSync.notify('t:lane-notify.html', { msgType: 'warning', msg: 'File changed on disk', action: 'reload' });
    expect(live.count).toBe(1);
    expect(saved.count).toBe(0);
    expect(parseSSE(live.writes[0])).toMatchObject({ type: 'notification', msgType: 'warning' });

    liveSync.unsubscribe('t:lane-notify.html', live);
    liveSync.unsubscribe('t:lane-notify.html', saved);
  });

  test('collection-record events stay on live lane', () => {
    const live = mockRes();
    const saved = mockRes();
    liveSync.subscribe('t:lane-col.html', live);
    liveSync.subscribe('t:lane-col.html', saved, { lane: 'saved' });

    liveSync.broadcastCollectionRecord('t:lane-col.html', { op: 'create', id: 'r1', data: { a: 1 } });
    expect(live.count).toBe(1);
    expect(saved.count).toBe(0);

    liveSync.unsubscribe('t:lane-col.html', live);
    liveSync.unsubscribe('t:lane-col.html', saved);
  });

  test('dead saved-lane connection is cleaned up without touching live subscribers', () => {
    const live = mockRes();
    const deadSaved = {
      write() { throw new Error('EPIPE'); }
    };
    liveSync.subscribe('t:lane-dead.html', live);
    liveSync.subscribe('t:lane-dead.html', deadSaved, { lane: 'saved' });

    liveSync.broadcast('t:lane-dead.html', { html: 'x', sender: 's' }, { lane: 'saved' });
    // Dead connection removed; a follow-up all-lane broadcast reaches only live.
    liveSync.broadcast('t:lane-dead.html', { html: 'y', sender: 's' }, { lane: 'all' });
    expect(live.count).toBe(1);

    liveSync.unsubscribe('t:lane-dead.html', live);
  });

  test('closeChannel closes both lanes', () => {
    let liveClosed = false;
    let savedClosed = false;
    const live = { write() {}, end() { liveClosed = true; } };
    const saved = { write() {}, end() { savedClosed = true; } };
    liveSync.subscribe('t:lane-close.html', live);
    liveSync.subscribe('t:lane-close.html', saved, { lane: 'saved' });

    const closed = liveSync.closeChannel('t:lane-close.html');
    expect(closed).toBe(2);
    expect(liveClosed).toBe(true);
    expect(savedClosed).toBe(true);
  });
});
