@echo off
rem coop.cmd - Windows shim for the Cooptimize agent. Invokes the PowerShell core.
rem A thin layer on top of Pi (@earendil-works/pi-coding-agent); never a fork.
rem Started from a PowerShell 7 window, Windows PowerShell 5.1 would inherit pwsh's
rem PSModulePath and lose its own modules (Get-FileHash and friends "not recognized").
rem Clearing it here makes 5.1 rebuild its default module path; nothing else is affected.
set "PSModulePath="
powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0coop.ps1" %*
