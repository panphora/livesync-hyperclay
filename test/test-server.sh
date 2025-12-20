#!/bin/bash
#
# LiveSync Server Test Script (Self-contained)
#
# Spins up its own test server, runs tests, tears down.
# No external dependencies required.
#
# Usage:
#   ./test/test-server.sh
#

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
TEST_PORT=4567
BASE_URL="http://localhost:$TEST_PORT"
PASS=0
FAIL=0
SERVER_PID=""

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

cleanup() {
    if [ -n "$SERVER_PID" ]; then
        kill $SERVER_PID 2>/dev/null || true
        wait $SERVER_PID 2>/dev/null || true
    fi
    if [ -n "$TEST_DIR" ] && [ -d "$TEST_DIR" ]; then
        rm -rf "$TEST_DIR"
    fi
}

trap cleanup EXIT

echo "========================================"
echo "LiveSync Server Tests (Self-contained)"
echo "========================================"
echo ""

# Create temp test directory with test files
TEST_DIR=$(mktemp -d)
echo "Test directory: $TEST_DIR"

# Create a valid test HTML file
cat > "$TEST_DIR/test.html" << 'EOF'
<!DOCTYPE html>
<html>
<head><title>Test</title></head>
<body><p>Test content</p></body>
</html>
EOF

# Start test server
echo -n "Starting test server on port $TEST_PORT... "

node -e "
const express = require('express');
const { setupLiveSync } = require('$PROJECT_DIR');

const app = express();
app.use('/live-sync', express.json({ limit: '10mb' }));
setupLiveSync(app, { baseDir: '$TEST_DIR' });

const server = app.listen($TEST_PORT, 'localhost', () => {
    console.log('ready');
});

process.on('SIGTERM', () => {
    server.close(() => process.exit(0));
});
" &

SERVER_PID=$!

# Wait for server to be ready
sleep 1

if curl -s --fail "$BASE_URL/live-sync/stats" > /dev/null 2>&1; then
    echo -e "${GREEN}OK${NC}"
else
    echo -e "${RED}FAILED${NC}"
    echo "Could not start test server"
    exit 1
fi

echo ""
echo "--- Validation Tests (POST /live-sync/save) ---"
echo ""

# Test 1: Path traversal with ..
echo -n "Test 1: Reject path traversal (..)... "
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE_URL/live-sync/save" \
    -H "Content-Type: application/json" \
    -d '{"file":"../../../etc/passwd","body":"test","sender":"test123"}')
if [ "$HTTP_CODE" = "400" ]; then
    echo -e "${GREEN}PASS${NC} (got 400)"
    ((PASS++))
else
    echo -e "${RED}FAIL${NC} (expected 400, got $HTTP_CODE)"
    ((FAIL++))
fi

# Test 2: Absolute path
echo -n "Test 2: Reject absolute path... "
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE_URL/live-sync/save" \
    -H "Content-Type: application/json" \
    -d '{"file":"/etc/passwd","body":"test","sender":"test123"}')
if [ "$HTTP_CODE" = "400" ]; then
    echo -e "${GREEN}PASS${NC} (got 400)"
    ((PASS++))
else
    echo -e "${RED}FAIL${NC} (expected 400, got $HTTP_CODE)"
    ((FAIL++))
fi

# Test 3: Backslash
echo -n "Test 3: Reject backslash... "
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE_URL/live-sync/save" \
    -H "Content-Type: application/json" \
    -d '{"file":"test\\file","body":"test","sender":"test123"}')
if [ "$HTTP_CODE" = "400" ]; then
    echo -e "${GREEN}PASS${NC} (got 400)"
    ((PASS++))
else
    echo -e "${RED}FAIL${NC} (expected 400, got $HTTP_CODE)"
    ((FAIL++))
fi

# Test 4: Reject .html extension (use site identifier only)
echo -n "Test 4: Reject .html extension... "
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE_URL/live-sync/save" \
    -H "Content-Type: application/json" \
    -d '{"file":"test.html","body":"test","sender":"test123"}')
if [ "$HTTP_CODE" = "400" ]; then
    echo -e "${GREEN}PASS${NC} (got 400)"
    ((PASS++))
else
    echo -e "${RED}FAIL${NC} (expected 400, got $HTTP_CODE)"
    ((FAIL++))
fi

# Test 5: Missing file parameter
echo -n "Test 5: Reject missing file... "
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE_URL/live-sync/save" \
    -H "Content-Type: application/json" \
    -d '{"body":"test","sender":"test123"}')
if [ "$HTTP_CODE" = "400" ]; then
    echo -e "${GREEN}PASS${NC} (got 400)"
    ((PASS++))
else
    echo -e "${RED}FAIL${NC} (expected 400, got $HTTP_CODE)"
    ((FAIL++))
fi

# Test 6: Missing sender
echo -n "Test 6: Reject missing sender... "
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE_URL/live-sync/save" \
    -H "Content-Type: application/json" \
    -d '{"file":"test","body":"test"}')
if [ "$HTTP_CODE" = "400" ]; then
    echo -e "${GREEN}PASS${NC} (got 400)"
    ((PASS++))
else
    echo -e "${RED}FAIL${NC} (expected 400, got $HTTP_CODE)"
    ((FAIL++))
fi

# Test 7: Empty file
echo -n "Test 7: Reject empty file string... "
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE_URL/live-sync/save" \
    -H "Content-Type: application/json" \
    -d '{"file":"","body":"test","sender":"test123"}')
if [ "$HTTP_CODE" = "400" ]; then
    echo -e "${GREEN}PASS${NC} (got 400)"
    ((PASS++))
else
    echo -e "${RED}FAIL${NC} (expected 400, got $HTTP_CODE)"
    ((FAIL++))
fi

# Test 8: File not found (valid identifier but file doesn't exist)
echo -n "Test 8: Return 404 for missing file... "
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE_URL/live-sync/save" \
    -H "Content-Type: application/json" \
    -d '{"file":"nonexistent-file-xyz","body":"test","sender":"test123"}')
if [ "$HTTP_CODE" = "404" ]; then
    echo -e "${GREEN}PASS${NC} (got 404)"
    ((PASS++))
else
    echo -e "${RED}FAIL${NC} (expected 404, got $HTTP_CODE)"
    ((FAIL++))
fi

# Test 9: Successful save to existing file
echo -n "Test 9: Save to existing file... "
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE_URL/live-sync/save" \
    -H "Content-Type: application/json" \
    -d '{"file":"test","body":"<p>Updated content</p>","sender":"test123"}')
if [ "$HTTP_CODE" = "200" ]; then
    echo -e "${GREEN}PASS${NC} (got 200)"
    ((PASS++))
else
    echo -e "${RED}FAIL${NC} (expected 200, got $HTTP_CODE)"
    ((FAIL++))
fi

echo ""
echo "--- headHash Tests ---"
echo ""

# Test 10: Save with head content computes headHash
echo -n "Test 10: Save with head computes headHash... "
RESPONSE=$(curl -s -X POST "$BASE_URL/live-sync/save" \
    -H "Content-Type: application/json" \
    -d '{"file":"test","body":"<p>Updated</p>","head":"<title>Test</title>","sender":"test123"}')
if echo "$RESPONSE" | grep -q '"success":true'; then
    echo -e "${GREEN}PASS${NC}"
    ((PASS++))
else
    echo -e "${RED}FAIL${NC} (expected success, got: $RESPONSE)"
    ((FAIL++))
fi

# Test 11: headHash is included in SSE broadcast
echo -n "Test 11: SSE includes headHash in messages... "
# Connect to SSE, trigger a save, capture the message
curl -s -N --max-time 3 "$BASE_URL/live-sync/stream?file=test" > /tmp/sse_output.txt 2>/dev/null &
SSE_PID=$!
sleep 0.5
# Trigger a save with head content
curl -s -X POST "$BASE_URL/live-sync/save" \
    -H "Content-Type: application/json" \
    -d '{"file":"test","body":"<p>SSE test</p>","head":"<title>SSE Test</title>","sender":"sse-test"}' > /dev/null
sleep 1
kill $SSE_PID 2>/dev/null || true
wait $SSE_PID 2>/dev/null || true
if grep -q '"headHash":' /tmp/sse_output.txt; then
    echo -e "${GREEN}PASS${NC}"
    ((PASS++))
else
    echo -e "${RED}FAIL${NC} (headHash not in SSE message)"
    ((FAIL++))
fi
rm -f /tmp/sse_output.txt

echo ""
echo "--- Endpoint Tests ---"
echo ""

# Test 12: Stats endpoint
echo -n "Test 12: Stats endpoint returns mode... "
RESPONSE=$(curl -s "$BASE_URL/live-sync/stats")
if echo "$RESPONSE" | grep -q '"mode"'; then
    echo -e "${GREEN}PASS${NC}"
    ((PASS++))
else
    echo -e "${RED}FAIL${NC} (no mode field)"
    ((FAIL++))
fi

# Test 13: Debug endpoint
echo -n "Test 13: Debug endpoint returns rooms... "
RESPONSE=$(curl -s "$BASE_URL/live-sync/debug")
if echo "$RESPONSE" | grep -q '"rooms"'; then
    echo -e "${GREEN}PASS${NC}"
    ((PASS++))
else
    echo -e "${RED}FAIL${NC} (no rooms field)"
    ((FAIL++))
fi

# Test 14: SSE stream validation (path traversal)
echo -n "Test 14: SSE rejects invalid file param... "
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$BASE_URL/live-sync/stream?file=../test")
if [ "$HTTP_CODE" = "400" ]; then
    echo -e "${GREEN}PASS${NC} (got 400)"
    ((PASS++))
else
    echo -e "${RED}FAIL${NC} (expected 400, got $HTTP_CODE)"
    ((FAIL++))
fi

# Test 15: SSE stream missing file
echo -n "Test 15: SSE rejects missing file param... "
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$BASE_URL/live-sync/stream")
if [ "$HTTP_CODE" = "400" ]; then
    echo -e "${GREEN}PASS${NC} (got 400)"
    ((PASS++))
else
    echo -e "${RED}FAIL${NC} (expected 400, got $HTTP_CODE)"
    ((FAIL++))
fi

echo ""
echo "========================================"
echo -e "Results: ${GREEN}$PASS passed${NC}, ${RED}$FAIL failed${NC}"
echo "========================================"

if [ $FAIL -gt 0 ]; then
    exit 1
fi
exit 0
