#!/bin/bash
#
# LiveSync Module Test Script
#
# Tests the liveSync utility functions directly.
# For end-to-end testing, use hyperclay-local.
#
# Usage:
#   ./test/test-server.sh
#

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
PASS=0
FAIL=0

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

echo "========================================"
echo "LiveSync Module Tests"
echo "========================================"
echo ""

# Run Node.js tests
node -e "
const { liveSync } = require('$PROJECT_DIR');

let pass = 0;
let fail = 0;

function test(name, fn) {
    try {
        fn();
        console.log('\x1b[32mPASS\x1b[0m: ' + name);
        pass++;
    } catch (e) {
        console.log('\x1b[31mFAIL\x1b[0m: ' + name + ' - ' + e.message);
        fail++;
    }
}

function assert(condition, msg) {
    if (!condition) throw new Error(msg || 'Assertion failed');
}

// Mock response object
function mockRes() {
    const messages = [];
    return {
        messages,
        write(data) { messages.push(data); }
    };
}

console.log('--- Subscribe/Unsubscribe Tests ---');
console.log('');

test('getStats returns zeros initially', () => {
    const stats = liveSync.getStats();
    assert(stats.rooms === 0, 'Expected 0 rooms');
    assert(stats.connections === 0, 'Expected 0 connections');
});

test('subscribe creates a room', () => {
    const res = mockRes();
    liveSync.subscribe('test-file', res);
    const stats = liveSync.getStats();
    assert(stats.rooms === 1, 'Expected 1 room');
    assert(stats.connections === 1, 'Expected 1 connection');
    liveSync.unsubscribe('test-file', res);
});

test('unsubscribe removes connection', () => {
    const res = mockRes();
    liveSync.subscribe('test-file', res);
    liveSync.unsubscribe('test-file', res);
    const stats = liveSync.getStats();
    assert(stats.rooms === 0, 'Expected 0 rooms after unsubscribe');
    assert(stats.connections === 0, 'Expected 0 connections');
});

test('multiple subscribers to same file', () => {
    const res1 = mockRes();
    const res2 = mockRes();
    liveSync.subscribe('multi-test', res1);
    liveSync.subscribe('multi-test', res2);
    const stats = liveSync.getStats();
    assert(stats.rooms === 1, 'Expected 1 room');
    assert(stats.connections === 2, 'Expected 2 connections');
    liveSync.unsubscribe('multi-test', res1);
    liveSync.unsubscribe('multi-test', res2);
});

console.log('');
console.log('--- Broadcast Tests ---');
console.log('');

test('broadcast sends to all subscribers', () => {
    const res1 = mockRes();
    const res2 = mockRes();
    liveSync.subscribe('broadcast-test', res1);
    liveSync.subscribe('broadcast-test', res2);

    liveSync.broadcast('broadcast-test', { html: '<html><body><p>test</p></body></html>', sender: 'test-sender' });

    assert(res1.messages.length === 1, 'res1 should have 1 message');
    assert(res2.messages.length === 1, 'res2 should have 1 message');
    assert(res1.messages[0].includes('test-sender'), 'Message should contain sender');

    liveSync.unsubscribe('broadcast-test', res1);
    liveSync.unsubscribe('broadcast-test', res2);
});

test('broadcast to non-existent room is no-op', () => {
    // Should not throw
    liveSync.broadcast('nonexistent-room', { html: '<html></html>', sender: 'test' });
});

test('broadcast rejects non-string html', () => {
    const res = mockRes();
    liveSync.subscribe('html-test', res);

    // Should not throw but should not send
    liveSync.broadcast('html-test', { html: null, sender: 'test' });
    liveSync.broadcast('html-test', { html: undefined, sender: 'test' });
    liveSync.broadcast('html-test', { html: 123, sender: 'test' });

    assert(res.messages.length === 0, 'Should not send messages for non-string html');

    liveSync.unsubscribe('html-test', res);
});

test('broadcast allows empty string html', () => {
    const res = mockRes();
    liveSync.subscribe('empty-test', res);

    liveSync.broadcast('empty-test', { html: '', sender: 'test' });

    assert(res.messages.length === 1, 'Should send message for empty string html');

    liveSync.unsubscribe('empty-test', res);
});

console.log('');
console.log('--- User Broadcast Tests ---');
console.log('');

function parseSSE(raw) {
    return JSON.parse(raw.replace('data: ', '').trim());
}

test('broadcastFileSaved includes nodeId', () => {
    const res = mockRes();
    liveSync.subscribeUser('test-user', res);

    liveSync.broadcastFileSaved('test-user', 'my-site', {
        content: '<html></html>',
        checksum: 'abc123',
        modifiedAt: '2024-01-01T00:00:00Z',
        nodeId: 42
    });

    assert(res.messages.length === 1, 'Should send 1 message');
    const data = parseSSE(res.messages[0]);
    assert(data.type === 'file-saved', 'type should be file-saved');
    assert(data.nodeId === 42, 'nodeId should be 42');
    assert(data.file === 'my-site', 'file should be my-site');
    assert(data.checksum === 'abc123', 'checksum should match');

    liveSync.unsubscribeUser('test-user', res);
});

test('broadcastFileRenamed sends correct shape', () => {
    const res = mockRes();
    liveSync.subscribeUser('test-user', res);

    liveSync.broadcastFileRenamed('test-user', 99, 'old-name', 'new-name');

    assert(res.messages.length === 1, 'Should send 1 message');
    const data = parseSSE(res.messages[0]);
    assert(data.type === 'file-renamed', 'type should be file-renamed');
    assert(data.nodeId === 99, 'nodeId should be 99');
    assert(data.oldName === 'old-name', 'oldName should match');
    assert(data.newName === 'new-name', 'newName should match');

    liveSync.unsubscribeUser('test-user', res);
});

test('broadcastFileMoved sends correct shape', () => {
    const res = mockRes();
    liveSync.subscribeUser('test-user', res);

    liveSync.broadcastFileMoved('test-user', 55, 'my-site', 'my-site.html', 'blog/my-site.html');

    assert(res.messages.length === 1, 'Should send 1 message');
    const data = parseSSE(res.messages[0]);
    assert(data.type === 'file-moved', 'type should be file-moved');
    assert(data.nodeId === 55, 'nodeId should be 55');
    assert(data.file === 'my-site', 'file should be my-site');
    assert(data.fromPath === 'my-site.html', 'fromPath should match');
    assert(data.toPath === 'blog/my-site.html', 'toPath should match');

    liveSync.unsubscribeUser('test-user', res);
});

test('broadcastFileDeleted sends correct shape', () => {
    const res = mockRes();
    liveSync.subscribeUser('test-user', res);

    liveSync.broadcastFileDeleted('test-user', 77, 'blog/my-site');

    assert(res.messages.length === 1, 'Should send 1 message');
    const data = parseSSE(res.messages[0]);
    assert(data.type === 'file-deleted', 'type should be file-deleted');
    assert(data.nodeId === 77, 'nodeId should be 77');
    assert(data.file === 'blog/my-site', 'file should match');

    liveSync.unsubscribeUser('test-user', res);
});

test('new broadcast methods are no-ops with no subscribers', () => {
    // Should not throw
    liveSync.broadcastFileRenamed('nobody', 1, 'a', 'b');
    liveSync.broadcastFileMoved('nobody', 1, 'a', 'a.html', 'b.html');
    liveSync.broadcastFileDeleted('nobody', 1, 'a');
});

test('new broadcast methods clean up dead connections', () => {
    const dead = { write() { throw new Error('dead'); } };
    const alive = mockRes();
    liveSync.subscribeUser('cleanup-test', dead);
    liveSync.subscribeUser('cleanup-test', alive);

    liveSync.broadcastFileRenamed('cleanup-test', 1, 'a', 'b');

    assert(alive.messages.length === 1, 'Alive connection should receive message');
    const stats = liveSync.getStats();
    assert(stats.userConnections === 1, 'Dead connection should be removed');

    liveSync.unsubscribeUser('cleanup-test', alive);
});

console.log('');
console.log('========================================');
console.log('Results: ' + pass + ' passed, ' + fail + ' failed');
console.log('========================================');

if (fail > 0) process.exit(1);
"

echo ""
echo "All tests passed!"
