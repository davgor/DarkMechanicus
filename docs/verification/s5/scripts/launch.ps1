param([string]$Exe,[string]$Ud,[int]$Port,[string]$Log,[string]$Agent)
$S='C:\Users\davgo\AppData\Local\Temp\claude\5b2748231b82b70c\46f2df57-16a2-475c-9c1e-531c9afb4fd7\scratchpad\s3acc'
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
Remove-Item Env:PI_CODING_AGENT_DIR -ErrorAction SilentlyContinue
$env:DISABLE_AUTO_UPDATE='1'
$env:DARKMECHANICUS_HOME="$S\dmhome"
if ($Agent) { $env:PI_CODING_AGENT_DIR=$Agent }
$p=Start-Process -FilePath $Exe -ArgumentList "--user-data-dir=`"$Ud`"","--remote-debugging-port=$Port","--inspect=$($Port+1)" -RedirectStandardOutput $Log -RedirectStandardError "$Log.err" -PassThru
$p.Id
