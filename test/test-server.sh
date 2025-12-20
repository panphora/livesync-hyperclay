#!/bin/bash
#
# LiveSync Server Test Script
#
# Prerequisites:
#   - hyperclay-local server running on localhost:4321
#   - A test.html file in the site directory with <body> tags
#
# Note: File parameters use site identifiers (e.g., "test" not "test.html")
#
# Usage:
#   ./test/test-server.sh
#

BASE_URL="http://localhost:4321"
PASS=0
FAIL=0

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo "========================================"
echo "LiveSync Server Tests"
echo "========================================"
echo ""

# Check if server is running
echo -n "Checking server availability... "
if curl -s --fail "$BASE_URL" > /dev/null 2>&1; then
    echo -e "${GREEN}OK${NC}"
else
    echo -e "${RED}FAILED${NC}"
    echo "Server not running at $BASE_URL"
    echo "Start hyperclay-local first: cd ../hyperclay-local && npm start"
    exit 1
fi

echo ""
echo "--- Validation Tests ---"
echo ""

# Test 1: Path traversal with ..
echo -n "Test 1: Reject path traversal (..)... "
RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "$BASE_URL/live-sync/save" \
    -H "Content-Type: application/json" \
    -d '{"file":"../../../etc/passwd","body":"test","sender":"test123"}')
HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
if [ "$HTTP_CODE" = "400" ]; then
    echo -e "${GREEN}PASS${NC} (got 400)"
    ((PASS++))
else
    echo -e "${RED}FAIL${NC} (expected 400, got $HTTP_CODE)"
    ((FAIL++))
fi

# Test 2: Absolute path
echo -n "Test 2: Reject absolute path... "
RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "$BASE_URL/live-sync/save" \
    -H "Content-Type: application/json" \
    -d '{"file":"/etc/passwd","body":"test","sender":"test123"}')
HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
if [ "$HTTP_CODE" = "400" ]; then
    echo -e "${GREEN}PASS${NC} (got 400)"
    ((PASS++))
else
    echo -e "${RED}FAIL${NC} (expected 400, got $HTTP_CODE)"
    ((FAIL++))
fi

# Test 3: Backslash
echo -n "Test 3: Reject backslash... "
RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "$BASE_URL/live-sync/save" \
    -H "Content-Type: application/json" \
    -d '{"file":"test\\file","body":"test","sender":"test123"}')
HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
if [ "$HTTP_CODE" = "400" ]; then
    echo -e "${GREEN}PASS${NC} (got 400)"
    ((PASS++))
else
    echo -e "${RED}FAIL${NC} (expected 400, got $HTTP_CODE)"
    ((FAIL++))
fi

# Test 4: Reject .html extension (use site identifier only)
echo -n "Test 4: Reject .html extension... "
RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "$BASE_URL/live-sync/save" \
    -H "Content-Type: application/json" \
    -d '{"file":"test.html","body":"test","sender":"test123"}')
HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
if [ "$HTTP_CODE" = "400" ]; then
    echo -e "${GREEN}PASS${NC} (got 400)"
    ((PASS++))
else
    echo -e "${RED}FAIL${NC} (expected 400, got $HTTP_CODE)"
    ((FAIL++))
fi

# Test 5: Missing file parameter
echo -n "Test 5: Reject missing file... "
RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "$BASE_URL/live-sync/save" \
    -H "Content-Type: application/json" \
    -d '{"body":"test","sender":"test123"}')
HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
if [ "$HTTP_CODE" = "400" ]; then
    echo -e "${GREEN}PASS${NC} (got 400)"
    ((PASS++))
else
    echo -e "${RED}FAIL${NC} (expected 400, got $HTTP_CODE)"
    ((FAIL++))
fi

# Test 6: Missing sender
echo -n "Test 6: Reject missing sender... "
RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "$BASE_URL/live-sync/save" \
    -H "Content-Type: application/json" \
    -d '{"file":"test","body":"test"}')
HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
if [ "$HTTP_CODE" = "400" ]; then
    echo -e "${GREEN}PASS${NC} (got 400)"
    ((PASS++))
else
    echo -e "${RED}FAIL${NC} (expected 400, got $HTTP_CODE)"
    ((FAIL++))
fi

# Test 7: Empty file
echo -n "Test 7: Reject empty file string... "
RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "$BASE_URL/live-sync/save" \
    -H "Content-Type: application/json" \
    -d '{"file":"","body":"test","sender":"test123"}')
HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
if [ "$HTTP_CODE" = "400" ]; then
    echo -e "${GREEN}PASS${NC} (got 400)"
    ((PASS++))
else
    echo -e "${RED}FAIL${NC} (expected 400, got $HTTP_CODE)"
    ((FAIL++))
fi

# Test 8: File not found (site identifier without .html)
echo -n "Test 8: Return 404 for missing file... "
RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "$BASE_URL/live-sync/save" \
    -H "Content-Type: application/json" \
    -d '{"file":"nonexistent-file-xyz","body":"test","sender":"test123"}')
HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
if [ "$HTTP_CODE" = "404" ]; then
    echo -e "${GREEN}PASS${NC} (got 404)"
    ((PASS++))
else
    echo -e "${RED}FAIL${NC} (expected 404, got $HTTP_CODE)"
    ((FAIL++))
fi

echo ""
echo "--- Endpoint Tests ---"
echo ""

# Test 9: Stats endpoint
echo -n "Test 9: Stats endpoint works... "
RESPONSE=$(curl -s -w "\n%{http_code}" "$BASE_URL/live-sync/stats")
HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
BODY=$(echo "$RESPONSE" | head -n -1)
if [ "$HTTP_CODE" = "200" ] && echo "$BODY" | grep -q '"mode"'; then
    echo -e "${GREEN}PASS${NC}"
    ((PASS++))
else
    echo -e "${RED}FAIL${NC} (expected 200 with mode field)"
    ((FAIL++))
fi

# Test 10: Debug endpoint
echo -n "Test 10: Debug endpoint works... "
RESPONSE=$(curl -s -w "\n%{http_code}" "$BASE_URL/live-sync/debug")
HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
BODY=$(echo "$RESPONSE" | head -n -1)
if [ "$HTTP_CODE" = "200" ] && echo "$BODY" | grep -q '"rooms"'; then
    echo -e "${GREEN}PASS${NC}"
    ((PASS++))
else
    echo -e "${RED}FAIL${NC} (expected 200 with rooms field)"
    ((FAIL++))
fi

# Test 11: SSE stream validation (path traversal)
echo -n "Test 11: SSE rejects invalid file param... "
RESPONSE=$(curl -s -w "\n%{http_code}" "$BASE_URL/live-sync/stream?file=../test")
HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
if [ "$HTTP_CODE" = "400" ]; then
    echo -e "${GREEN}PASS${NC} (got 400)"
    ((PASS++))
else
    echo -e "${RED}FAIL${NC} (expected 400, got $HTTP_CODE)"
    ((FAIL++))
fi

# Test 12: SSE stream missing file
echo -n "Test 12: SSE rejects missing file param... "
RESPONSE=$(curl -s -w "\n%{http_code}" "$BASE_URL/live-sync/stream")
HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
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
