# load-vectors.ps1
$workerUrl = "http://localhost:8787"

Write-Host "=== Loading Data into Vector Index ===" -ForegroundColor Green
Write-Host "Worker: $workerUrl" -ForegroundColor Cyan
Write-Host ""

Write-Host "1. Checking initial status..." -ForegroundColor Yellow
try {
    $initialStatus = Invoke-RestMethod -Uri "$workerUrl/api/vectorize/status" -Method Get
    $json = $initialStatus | ConvertTo-Json -Depth 5
    Write-Host $json -ForegroundColor Gray
} catch {
    Write-Host "Error connecting to worker. Make sure 'npx wrangler dev --remote' is running." -ForegroundColor Red
    Write-Host "Error Details: $_" -ForegroundColor Red
    exit 1
}

Write-Host "`n2. Starting vectorization..." -ForegroundColor Yellow
Write-Host "This will load 20 properties from D1 and create 80 chunks." -ForegroundColor Cyan
Write-Host "Target Index: embeddings-index (1024 dimensions)" -ForegroundColor Cyan

$choice = Read-Host "Start loading? (y/n)"
if ($choice -ne 'y') {
    Write-Host "Cancelled." -ForegroundColor Yellow
    exit 0
}

Write-Host "Starting vectorization..." -ForegroundColor Green
try {
    $response = Invoke-RestMethod -Uri "$workerUrl/api/vectorize" -Method Post -TimeoutSec 300
    $responseJson = $response | ConvertTo-Json -Depth 5
    Write-Host "Response: $responseJson" -ForegroundColor Green
} catch {
    Write-Host "Error starting vectorization: $_" -ForegroundColor Red
    exit 1
}

Write-Host "`n3. Monitoring progress..." -ForegroundColor Yellow
Write-Host "Will check status every 5 seconds..." -ForegroundColor Cyan

for ($i = 1; $i -le 10; $i++) {
    Start-Sleep -Seconds 5
    Write-Host "Check #$i..." -ForegroundColor Gray
    
    try {
        $status = Invoke-RestMethod -Uri "$workerUrl/api/vectorize/status" -Method Get
        
        $vectorsCount = $status.vector_index.vectors_count
        Write-Host "Current Vector Count: $vectorsCount" -ForegroundColor Cyan
        
        if ($vectorsCount -ge 80) {
            Write-Host "Vectorization complete! 80+ vectors loaded." -ForegroundColor Green
            break
        }
    } catch {
        Write-Host "Error checking status: $_" -ForegroundColor Red
    }
}

Write-Host "`n4. Testing search..." -ForegroundColor Yellow
$testChoice = Read-Host "Test search with sample query? (y/n)"
if ($testChoice -eq 'y') {
    Write-Host "Testing search: 'apartment in kathmandu'" -ForegroundColor Cyan
    try {
        $searchResult = Invoke-RestMethod -Uri "$workerUrl/api/search" -Method Post -ContentType "application/json" -Body '{"query": "apartment in kathmandu"}'
        $searchJson = $searchResult | ConvertTo-Json -Depth 5
        Write-Host "Search result:" -ForegroundColor Green
        Write-Host $searchJson -ForegroundColor Gray
    } catch {
        Write-Host "Search test failed." -ForegroundColor Yellow
        Write-Host "Error: $_" -ForegroundColor Red
    }
}

Write-Host "`n=== Vector Loading Complete ===" -ForegroundColor Green