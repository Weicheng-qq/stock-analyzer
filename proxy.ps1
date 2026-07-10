# US Stock Analyzer - Local Data Proxy (Windows PowerShell, ASCII only)
# Concurrent version: handles many parallel requests (like the online Vercel proxy).
# Run: double-click 啟動.bat  (or right-click -> Run with PowerShell)

$port = 8765
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$port/")
try {
    $listener.Start()
} catch {
    Write-Host "Failed to start. Port $port may be in use. $($_.Exception.Message)" -ForegroundColor Red
    Read-Host "Press Enter to exit"; exit
}

Write-Host ""
Write-Host "  =====================================================" -ForegroundColor Green
Write-Host "   Stock data proxy running:  http://localhost:$port" -ForegroundColor Green
Write-Host "   Keep this window OPEN while using the web page." -ForegroundColor Green
Write-Host "   Press Ctrl + C to stop." -ForegroundColor Green
Write-Host "  =====================================================" -ForegroundColor Green
Write-Host ""

# Runspace pool so parallel browser requests are handled concurrently (not one-by-one)
$pool = [RunspaceFactory]::CreateRunspacePool(1, 16)
$pool.Open()

$worker = {
    param($ctx)
    $res = $ctx.Response
    try {
        $res.AddHeader("Access-Control-Allow-Origin", "*")
        $res.AddHeader("Access-Control-Allow-Headers", "*")
        $target = $ctx.Request.QueryString["url"]
        if ([string]::IsNullOrEmpty($target)) {
            $res.StatusCode = 400
            $b = [System.Text.Encoding]::UTF8.GetBytes('{"error":"missing url"}')
            $res.OutputStream.Write($b,0,$b.Length); $res.Close(); return
        }
        if ($target -notmatch '^https://(data\.sec\.gov|www\.sec\.gov|query[12]\.finance\.yahoo\.com)/') {
            $res.StatusCode = 403
            $b = [System.Text.Encoding]::UTF8.GetBytes('{"error":"host not allowed"}')
            $res.OutputStream.Write($b,0,$b.Length); $res.Close(); return
        }
        try {
            $data = Invoke-WebRequest -Uri $target -UseBasicParsing -TimeoutSec 25 `
                    -UserAgent "StockAnalyzer/1.0 (personal use; contact@example.com)" `
                    -Headers @{ "Accept-Encoding" = "gzip, deflate" }
            $res.ContentType = "application/json; charset=utf-8"
            $b = [System.Text.Encoding]::UTF8.GetBytes($data.Content)
            $res.OutputStream.Write($b,0,$b.Length)
        } catch {
            $res.StatusCode = 502
            $b = [System.Text.Encoding]::UTF8.GetBytes('{"error":"' + ($_.Exception.Message -replace '"','') + '"}')
            $res.OutputStream.Write($b,0,$b.Length)
        }
        $res.Close()
    } catch { try { $res.Close() } catch {} }
}

$jobs = New-Object System.Collections.ArrayList
while ($listener.IsListening) {
    try {
        $ctx = $listener.GetContext()          # blocks until a request arrives
        $ps = [PowerShell]::Create()
        $ps.RunspacePool = $pool
        [void]$ps.AddScript($worker).AddArgument($ctx)
        $h = $ps.BeginInvoke()
        [void]$jobs.Add([pscustomobject]@{ ps=$ps; h=$h })
        # tidy finished jobs occasionally
        if ($jobs.Count -gt 24) {
            for ($i=$jobs.Count-1; $i -ge 0; $i--) {
                if ($jobs[$i].h.IsCompleted) { try { $jobs[$i].ps.EndInvoke($jobs[$i].h); $jobs[$i].ps.Dispose() } catch {}; $jobs.RemoveAt($i) }
            }
        }
    } catch { }
}
