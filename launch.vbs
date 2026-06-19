' launch.vbs — Start ocwrapper completely headless (no window).
' Usage: wscript launch.vbs [port]
Dim port
If WScript.Arguments.Length > 0 Then
  port = WScript.Arguments(0)
Else
  port = "3333"
End If

Dim shell, fso, nodeExe, scriptPath, url, cmd
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

shell.CurrentDirectory = "C:\Projects\ocwrapper"
nodeExe = "C:\Program Files\nodejs\node.exe"
scriptPath = fso.BuildPath(shell.CurrentDirectory, "start-bg.js")
url = "http://127.0.0.1:" & port

cmd = """" & nodeExe & """ --expose-gc --max-old-space-size=1024 """ & scriptPath & """ --port " & port
shell.Run cmd, 0, False

Set fso = Nothing
Set shell = Nothing
