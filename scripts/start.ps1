# Luca Talks - Startup Script
# This script starts both the PersonaPlex server and the React client

param(
    [switch]$ServerOnly,
    [switch]$ClientOnly
)

$ErrorActionPreference = "Stop"

# Configuration
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$PersonaPlexEnv = "D:\VoiceLuca\personaplex-env"
$HFToken = $env:HF_TOKEN

# Colors for output
function Write-Green($msg) { Write-Host $msg -ForegroundColor Green }
function Write-Yellow($msg) { Write-Host $msg -ForegroundColor Yellow }
function Write-Red($msg) { Write-Host $msg -ForegroundColor Red }

# Check prerequisites
function Test-Prerequisites {
    Write-Yellow "Checking prerequisites..."
    
    # Check HF_TOKEN
    if (-not $HFToken) {
        Write-Red "ERROR: HF_TOKEN environment variable not set"
        Write-Yellow "Set it with: `$env:HF_TOKEN = 'your_huggingface_token'"
        Write-Yellow "Get a token from: https://huggingface.co/settings/tokens"
        exit 1
    }
    
    # Check Python env
    if (-not (Test-Path "$PersonaPlexEnv\Scripts\python.exe")) {
        Write-Red "ERROR: PersonaPlex environment not found at $PersonaPlexEnv"
        exit 1
    }
    
    # Check Node.js
    if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
        Write-Red "ERROR: npm not found. Please install Node.js"
        exit 1
    }
    
    Write-Green "All prerequisites met!"
}

# Start PersonaPlex server
function Start-PersonaPlexServer {
    Write-Yellow "Starting PersonaPlex server..."
    
    $env:NO_TORCH_COMPILE = "1"
    $sslDir = Join-Path $env:TEMP "ssl_luca"
    New-Item -ItemType Directory -Path $sslDir -Force | Out-Null
    
    $serverProcess = Start-Process -FilePath "$PersonaPlexEnv\Scripts\python.exe" `
        -ArgumentList "-m", "moshi.server", "--ssl", $sslDir `
        -PassThru -NoNewWindow
    
    Write-Green "PersonaPlex server starting (PID: $($serverProcess.Id))"
    Write-Yellow "Waiting for server to be ready (loading 16GB model)..."
    
    # Wait for server to be ready (check port 8998)
    $maxWait = 600  # 10 minutes max
    $waited = 0
    while ($waited -lt $maxWait) {
        if ($serverProcess.HasExited) {
            Write-Red "Server process exited early with code $($serverProcess.ExitCode)"
            exit 1
        }
        try {
            $connectionTest = Test-NetConnection -ComputerName localhost -Port 8998 -WarningAction SilentlyContinue
            if ($connectionTest.TcpTestSucceeded) {
                Write-Green "PersonaPlex server is ready!"
                Write-Green "Access Web UI at: https://localhost:8998"
                return $serverProcess
            }
        } catch {}
        Start-Sleep -Seconds 5
        $waited += 5
        Write-Host "." -NoNewline
    }
    
    Write-Red "Server failed to start within timeout"
    exit 1
}

# Start React client
function Start-ReactClient {
    Write-Yellow "Starting React client..."
    
    Push-Location $ProjectRoot
    try {
        # Install deps if needed
        if (-not (Test-Path "node_modules")) {
            Write-Yellow "Installing dependencies..."
            npm install
        }
        
        # Start dev server
        Write-Green "Starting Vite dev server..."
        npm run dev
    } finally {
        Pop-Location
    }
}

# Main
Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "       LUCA TALKS - Voice Agent        " -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

Test-Prerequisites

if (-not $ClientOnly) {
    $serverProc = Start-PersonaPlexServer
}

if (-not $ServerOnly) {
    Start-ReactClient
}

Write-Green "Luca Talks is running!"
Write-Yellow "Press Ctrl+C to stop"
