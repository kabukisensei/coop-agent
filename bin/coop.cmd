@echo off
rem coop.cmd - Windows shim for the Cooptimize agent. Invokes the PowerShell core.
rem A thin layer on top of Pi (@earendil-works/pi-coding-agent); never a fork.
powershell -ExecutionPolicy Bypass -File "%~dp0coop.ps1" %*
