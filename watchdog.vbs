' ocwrapper-watchdog.vbs — checks if ocwrapper is alive, restarts if dead
' Managed by Hermes. Do not delete.
Dim shell, http, port, isAlive
port = "3333"
Set shell = CreateObject("WScript.Shell")
Set http = CreateObject("MSXML2.XMLHTTP")
isAlive = False
On Error Resume Next
http.Open "GET", "http://127.0.0.1:" & port & "/", False
http.Send
If Err.Number = 0 And http.Status = 200 Then
  isAlive = True
End If
On Error GoTo 0
If Not isAlive Then
  ' Kill any zombie processes first
  shell.Run "taskkill /F /FI ""IMAGENAME eq node.exe"" /FI ""WINDOWTITLE eq ocwrapper*""", 0, True
  WScript.Sleep 2000
  ' Relaunch
  Dim fso, nodeExe, scriptPath, cmd
  Set fso = CreateObject("Scripting.FileSystemObject")
  shell.CurrentDirectory = "C:\Projects\ocwrapper"
  nodeExe = "C:\Program Files\nodejs\node.exe"
  scriptPath = fso.BuildPath(shell.CurrentDirectory, "start-bg.js")
  cmd = """" & nodeExe & """ --expose-gc --max-old-space-size=1024 """ & scriptPath & """ --port " & port
  shell.Run cmd, 0, False
  Set fso = Nothing
End If
Set http = Nothing
Set shell = Nothing
