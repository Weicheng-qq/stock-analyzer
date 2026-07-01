# US Stock Analyzer - Local Data Proxy (Windows PowerShell, ASCII only)
# Lets stock_analyzer.html read SEC EDGAR + Yahoo data from the browser.
# Run: double-click start.bat  (or right-click this file -> Run with PowerShell)

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

while ($listener.IsListening) {
    try {
        $ctx = $listener.GetContext()
        $req = $ctx.Request
        $res = $ctx.Response
        $res.AddHeader("Access-Control-Allow-Origin", "*")
        $res.AddHeader("Access-Control-Allow-Headers", "*")

        $target = $req.QueryString["url"]
        if ([string]::IsNullOrEmpty($target)) {
            $res.StatusCode = 400
            $b = [System.Text.Encoding]::UTF8.GetBytes('{"error":"missing url"}')
            $res.OutputStream.Write($b,0,$b.Length); $res.Close(); continue
        }
        # whitelist: SEC + Yahoo only
        if ($target -notmatch '^https://(data\.sec\.gov|www\.sec\.gov|query[12]\.finance\.yahoo\.com)/') {
            $res.StatusCode = 403
            $b = [System.Text.Encoding]::UTF8.GetBytes('{"error":"host not allowed"}')
            $res.OutputStream.Write($b,0,$b.Length); $res.Close(); continue
        }
        try {
            # SEC requires a descriptive User-Agent with contact info
            $data = Invoke-WebRequest -Uri $target -UseBasicParsing -TimeoutSec 25 `
                    -UserAgent "StockAnalyzer/1.0 (personal use; contact@example.com)" `
                    -Headers @{ "Accept-Encoding" = "gzip, deflate" }
            $res.ContentType = "application/json; charset=utf-8"
            $b = [System.Text.Encoding]::UTF8.GetBytes($data.Content)
            $res.OutputStream.Write($b,0,$b.Length)
            Write-Host ("  OK  " + $target.Substring(0,[Math]::Min(75,$target.Length))) -ForegroundColor Gray
        } catch {
            $res.StatusCode = 502
            $msg = '{"error":"' + ($_.Exception.Message -replace '"','') + '"}'
            $b = [System.Text.Encoding]::UTF8.GetBytes($msg)
            $res.OutputStream.Write($b,0,$b.Length)
            Write-Host ("  ERR " + $_.Exception.Message) -ForegroundColor Red
        }
        $res.Close()
    } catch { }
}
