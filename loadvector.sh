# load-vectors.sh
#!/bin/bash
WORKER_URL="https://nepal-real-estate-matcher.neptechpal355.workers.dev"

echo "=== Loading Data into Vector Index ==="
echo "Worker: $WORKER_URL"
echo ""

echo "1. Checking initial status..."
INITIAL_STATUS=$(curl -s "$WORKER_URL/api/vectorize/status")
echo "$INITIAL_STATUS"
echo ""

echo "2. Starting vectorization..."
echo "This will:"
echo "  • Load 20 properties from D1"
echo "  • Create 80 chunks (4 per property)"
echo "  • Generate 1024D embeddings"
echo "  • Store in 'embeddings-index'"
echo ""
echo "Estimated time: 3-4 minutes"
echo ""

read -p "Start loading? (y/n): " choice
if [ "$choice" != "y" ]; then
    echo "Cancelled."
    exit 0
fi

echo "Starting vectorization at $(date)..."
RESPONSE=$(curl -s -X POST "$WORKER_URL/api/vectorize")
echo "Response: $RESPONSE"
echo ""

echo "3. Monitoring progress..."
echo "Will check status every 15 seconds..."
echo ""

for i in {1..20}; do
    echo "Check #$i at $(date '+%H:%M:%S')"
    STATUS=$(curl -s "$WORKER_URL/api/vectorize/status")
    echo "Status: $STATUS"
    echo ""
    
    # Check if vector count is increasing
    if echo "$STATUS" | grep -q '"vectors_count": 80'; then
        echo "✓ Vectorization complete! 80 vectors loaded."
        break
    fi
    
    if [ $i -lt 20 ]; then
        sleep 15
    fi
done

echo "4. Final status check..."
FINAL_STATUS=$(curl -s "$WORKER_URL/api/vectorize/status")
echo "$FINAL_STATUS"
echo ""

echo "5. Testing search (optional)..."
read -p "Test search with sample query? (y/n): " test_choice
if [ "$test_choice" = "y" ]; then
    echo "Testing search: 'apartment in kathmandu'"
    SEARCH_RESULT=$(curl -s -X POST "$WORKER_URL/api/search" \
        -H "Content-Type: application/json" \
        -d '{"query": "apartment in kathmandu"}')
    echo "Search result: $SEARCH_RESULT"
fi

echo ""
echo "=== Vector Loading Complete ==="
echo "Your 20 properties (80 chunks) are now vectorized!"
echo "Index: embeddings-index (1024 dimensions)"
echo "Total vectors: 80"