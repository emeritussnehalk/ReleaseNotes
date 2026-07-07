$port = if ($env:PORT) { $env:PORT } else { 8000 }

Write-Host "Starting local server in $PSScriptRoot on http://localhost:$port/" -ForegroundColor Green
Write-Host "Press Ctrl+C to stop the server." -ForegroundColor Yellow

Set-Location -LiteralPath $PSScriptRoot
node .\server.js
