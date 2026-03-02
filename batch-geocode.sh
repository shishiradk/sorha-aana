#!/bin/bash
URL="https://sorha-aana-worker.neptechpal355.workers.dev/api/geocode/batch"
STATUS_URL="https://sorha-aana-worker.neptechpal355.workers.dev/api/geocode/status"
BATCH=4
ROUND=0
TOTAL_OK=0
TOTAL_FAIL=0

while true; do
  ROUND=$((ROUND + 1))

  RESULT=$(curl -4 -s --connect-timeout 15 --max-time 180 -X POST "$URL" \
    -H "Content-Type: application/json" \
    -d "{\"batch_size\": $BATCH}" 2>/dev/null)

  if [ -z "$RESULT" ]; then
    echo "Round $ROUND: No response (timeout). Waiting 30s..."
    sleep 30
    continue
  fi

  # Cloudflare 1102 = Worker CPU/wall-time limit exceeded — reduce batch and retry
  if echo "$RESULT" | grep -q "error code: 1102"; then
    echo "Round $ROUND: Worker timeout (1102). Reducing batch and retrying..."
    BATCH=$((BATCH > 1 ? BATCH - 1 : 1))
    sleep 15
    continue
  fi

  ERROR=$(echo "$RESULT" | grep -o '"error"' 2>/dev/null)
  if [ -n "$ERROR" ]; then
    echo "Round $ROUND: Error response. Waiting 30s..."
    echo "  $RESULT"
    sleep 30
    continue
  fi

  PROCESSED=$(echo "$RESULT" | grep -o '"processed":[0-9]*' | grep -o '[0-9]*')
  BATCH_OK=$(echo "$RESULT" | grep -o '"success":[0-9]*' | grep -o '[0-9]*')
  BATCH_FAIL=$(echo "$RESULT" | grep -o '"failed":[0-9]*' | head -1 | grep -o '[0-9]*')

  if [ -z "$PROCESSED" ] || [ "$PROCESSED" = "0" ]; then
    echo "Round $ROUND: No more properties to geocode. Done!"
    break
  fi

  TOTAL_OK=$((TOTAL_OK + BATCH_OK))
  TOTAL_FAIL=$((TOTAL_FAIL + BATCH_FAIL))

  if [ $((ROUND % 5)) -eq 0 ]; then
    sleep 2
    STATUS=$(curl -4 -s --max-time 15 "$STATUS_URL" 2>/dev/null)
    PENDING=$(echo "$STATUS" | grep -o '"total_pending":[0-9]*' | grep -o '[0-9]*')
    GEOCODED=$(echo "$STATUS" | grep -o '"total_geocoded":[0-9]*' | grep -o '[0-9]*')
    echo "Round $ROUND: +$BATCH_OK ok, +$BATCH_FAIL fail | Session: $TOTAL_OK ok | DB: $GEOCODED geocoded, $PENDING pending"
  else
    echo "Round $ROUND: +$BATCH_OK ok, +$BATCH_FAIL fail | Session total: $TOTAL_OK ok, $TOTAL_FAIL fail"
  fi

  # Slower delay — each property now takes up to 3.3s (3 Nominatim tiers)
  sleep 8
done

echo ""
echo "=== GEOCODING RETRY COMPLETE ==="
echo "Session total: $TOTAL_OK success, $TOTAL_FAIL failed"

sleep 2
curl -4 -s --max-time 15 "$STATUS_URL" 2>/dev/null
echo ""
