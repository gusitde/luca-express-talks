# Luca Talks - Health Check Script

$ErrorActionPreference = "SilentlyContinue"

function Write-Green($msg) { Write-Host "[PASS] $msg" -ForegroundColor Green }
function Write-Red($msg) { Write-Host "[FAIL] $msg" -ForegroundColor Red }
function Write-Yellow($msg) { Write-Host "[INFO] $msg" -ForegroundColor Yellow }

Write-Host ""
Write-Host "Luca Talks Health Check" -ForegroundColor Cyan
Write-Host "========================" -ForegroundColor Cyan
Write-Host ""

$failed = 0

# Check PersonaPlex server
Write-Yellow "Checking PersonaPlex server..."
try {
    $response = Invoke-WebRequest -Uri "https://localhost:8998" -SkipCertificateCheck -TimeoutSec 5
    if ($response.StatusCode -eq 200) {
        Write-Green "PersonaPlex server is running"
    } else {
        Write-Red "PersonaPlex server returned status $($response.StatusCode)"
        $failed++
    }
} catch {
    Write-Red "PersonaPlex server is not responding"
    Write-Yellow "  Start it with: .\scripts\start.ps1 -ServerOnly"
    $failed++
}

# Check React client
Write-Yellow "Checking React client..."
try {
    $response = Invoke-WebRequest -Uri "http://localhost:5173" -TimeoutSec 5
    if ($response.StatusCode -eq 200) {
        Write-Green "React client is running"
    } else {
        Write-Red "React client returned status $($response.StatusCode)"
        $failed++
    }
} catch {
    Write-Red "React client is not responding"
    Write-Yellow "  Start it with: cd luca-talks && npm run dev"
    $failed++
}

# Check GPU
Write-Yellow "Checking NVIDIA GPU..."
$gpu = (nvidia-smi --query-gpu=name,memory.used,memory.total --format=csv,noheader 2>$null)
if ($gpu) {
    Write-Green "GPU detected: $gpu"
} else {
    Write-Red "NVIDIA GPU not detected or nvidia-smi not available"
    $failed++
}

# Check HF_TOKEN
Write-Yellow "Checking HF_TOKEN..."
if ($env:HF_TOKEN) {
    Write-Green "HF_TOKEN is set"
} else {
    Write-Red "HF_TOKEN is not set"
    $failed++
}

Write-Host ""
if ($failed -eq 0) {
    Write-Host "All checks passed!" -ForegroundColor Green
    exit 0
} else {
    Write-Host "$failed check(s) failed" -ForegroundColor Red
    exit 1
}
