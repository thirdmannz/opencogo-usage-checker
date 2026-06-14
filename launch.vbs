' launch.vbs — Start ocwrapper completely headless (no window).
' Usage: wscript launch.vbs [port]
'
' This avoids the CMD window that other projects can close.
Dim port
If WScript.Arguments.Length > 0 Then
  port = WScript.Arguments(0)
Else
  port = "3333"
End If

Dim shell
Set shell = CreateObject("WScript.Shell")
shell.CurrentDirectory = "C:\Projects\ocwrapper"

' Run node.exe fully detached — no console window at all.
Dim cmd
cmd = "node.exe --expose-gc --max-old-space-size=1024 start-bg.js --port " & port

' WindowStyle 0 = hidden. bWaitOnReturn false = fire-and-forget.
shell.Run cmd, 0, False

Set shell = Nothing
