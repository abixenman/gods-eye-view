# Windows launcher for the local Ollama voice + HUD path.
# Usage:  powershell -ExecutionPolicy Bypass -File scripts\dev-local.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

# ffmpeg (installed via winget Gyan.FFmpeg) must be on PATH for the audio worker.
$ff = Get-ChildItem "$env:LOCALAPPDATA\Microsoft\WinGet\Packages\Gyan.FFmpeg*\ffmpeg-*\bin" -Directory -ErrorAction SilentlyContinue | Select-Object -First 1
if ($ff -and -not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) { $env:PATH = "$($ff.FullName);$env:PATH" }
if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) { throw "ffmpeg not found. Install with: winget install Gyan.FFmpeg" }

$env:AI_PROVIDER = 'ollama'
if (-not $env:PYTHON) { $env:PYTHON = Join-Path $root '.venv-local\Scripts\python.exe' }
if (-not (Test-Path $env:PYTHON)) { throw "Python venv missing at $env:PYTHON. Create it with: python -m venv .venv-local; .venv-local\Scripts\pip install faster-whisper piper-tts websockets" }
if (-not $env:PIPER_MODEL) { $env:PIPER_MODEL = Join-Path $root '.local\voices\en_US-lessac-medium.onnx' }

# Make sure Ollama is answering before the app starts.
try { Invoke-RestMethod 'http://localhost:11434/api/version' -TimeoutSec 3 | Out-Null }
catch { Start-Process ollama -ArgumentList 'serve' -WindowStyle Hidden; Start-Sleep -Seconds 3 }

npm run dev
