# Runs scrape_steamrip_recent.py and pushes the result to both remotes if
# it found anything new. Meant to be triggered by a scheduled task on this
# machine (see CLAUDE.md / README for why: steamrip.com is only reachable
# from a normal machine, not from Anthropic's cloud sandbox - a scheduled
# cloud routine for this same job was tried and always failed with a 403
# at the sandbox's own network policy layer, never even reaching steamrip.com).
#
# Usage (manual):
#   powershell -ExecutionPolicy Bypass -File scrape_and_push.ps1
#
# Registered as a daily Windows Scheduled Task ("WD Games - steamrip scrape").

$RepoDir = "D:\wd-games-main"
$LogFile = Join-Path $RepoDir "scrape_and_push.log"

function Log($msg) {
    # Write-Host (not Write-Output) deliberately: Log is called from inside
    # Invoke-Logged, and anything written to the pipeline there leaks into
    # that function's return value, corrupting the exit-code integer it's
    # supposed to return.
    $line = "[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $msg
    Write-Host $line
    Add-Content -Path $LogFile -Value $line
}

# Runs a native command (git/python) without PowerShell 5.1 turning its
# stderr output into a thrown NativeCommandError on success. Logs combined
# output and returns the process exit code.
function Invoke-Logged {
    param([string]$Exe, [string[]]$ArgList)
    $prevPref = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    $output = & $Exe @ArgList 2>&1 | Out-String
    $ErrorActionPreference = $prevPref
    if ($output.Trim()) { Log $output.Trim() }
    return $LASTEXITCODE
}

Set-Location $RepoDir
Log "=== Run started ==="

# Refuse to run over uncommitted local changes - surface it instead of
# silently stashing/discarding someone's in-progress edit.
$dirty = git status --porcelain -- steamrip_games_updated.json
if ($dirty) {
    Log "ABORT: steamrip_games_updated.json has uncommitted local changes. Resolve manually before the next scheduled run."
    exit 1
}

Log "Pulling latest from origin..."
Invoke-Logged git @("fetch", "origin", "main") | Out-Null
$code = Invoke-Logged git @("merge", "--ff-only", "origin/main")
if ($code -ne 0) {
    Log "ABORT: local main could not be fast-forwarded to origin/main (diverged). Resolve manually."
    exit 1
}

Log "Running scrape_steamrip_recent.py..."
Invoke-Logged python @("scrape_steamrip_recent.py") | Out-Null

$changed = git status --porcelain -- steamrip_games_updated.json
if (-not $changed) {
    Log "No new games found. Nothing to commit."
    Log "=== Run finished (no changes) ==="
    exit 0
}

$dateStr = Get-Date -Format "yyyy-MM-dd"
Log "Changes found - committing and pushing."
Invoke-Logged git @("add", "steamrip_games_updated.json") | Out-Null
Invoke-Logged git @("commit", "-m", "Add steamrip.com Recently Added scrape ($dateStr)") | Out-Null

Log "Pushing to origin (adii83/wd-games)..."
$code = Invoke-Logged git @("push", "origin", "main")
if ($code -ne 0) {
    Log "Push to origin was rejected - attempting one pull+retry."
    Invoke-Logged git @("pull", "--no-edit", "origin", "main") | Out-Null
    $code = Invoke-Logged git @("push", "origin", "main")
    if ($code -ne 0) {
        Log "ABORT: push to origin still failing after retry. Needs manual attention."
        exit 1
    }
}

# Deliberately origin-only here: adii83/wd-games is what actually serves
# wdgames.store (GitHub Pages) and what admin.html reads/writes, so it's
# the push that matters. A second push to the personal fork used to run
# right after this and, on any conflict, merge + push back to origin again
# - which kept racing origin's own "Regenerate derived game data" Action
# (already mid-run from the first push) and getting rejected, silently
# losing that run's enrichment work. Syncing the personal fork periodically
# is a manual/occasional task instead (see CLAUDE.md - drift between the
# two remotes on derived files is expected, not an error).

Log "=== Run finished (pushed new games) ==="
