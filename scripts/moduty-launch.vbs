Option Explicit
' MoDuty Shell Verb hidden launcher.
'
' Why: Explorer invoking node.exe directly launches a console program, so Windows
' first allocates a console window (the black window that flashes). This script
' starts the bridge through WScript.Shell.Run with window style 0 (hidden), so no
' console window ever appears.
'
' Comments are intentionally ASCII-only: Windows Script Host reads .vbs as ANSI,
' and non-ASCII comments can shift the parser under some locales.
'
' Usage (registry command value):
'   wscript.exe //Nologo "<path to this file>" "%1"

Dim fso, sh, baseDir, bridge, node, args, cmd, i, q

Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
q = Chr(34)

baseDir = fso.GetParentFolderName(WScript.ScriptFullName)
bridge = fso.BuildPath(baseDir, "shell-verb-bridge.mjs")

' node resolution: MODUTY_NODE env var -> Program Files -> Program Files(x86) -> PATH
node = sh.ExpandEnvironmentStrings("%MODUTY_NODE%")
If node = "%MODUTY_NODE%" Or Not fso.FileExists(node) Then
  node = sh.ExpandEnvironmentStrings("%ProgramFiles%\nodejs\node.exe")
End If
If Not fso.FileExists(node) Then
  node = sh.ExpandEnvironmentStrings("%ProgramFiles(x86)%\nodejs\node.exe")
End If
If Not fso.FileExists(node) Then
  node = "node.exe"
End If

args = ""
For i = 0 To WScript.Arguments.Count - 1
  args = args & " " & q & WScript.Arguments(i) & q
Next

cmd = q & node & q & " " & q & bridge & q & args

If Not fso.FileExists(bridge) Then
  MsgBox "MoDuty bridge script not found:" & vbCrLf & bridge, 16, "MoDuty"
  WScript.Quit 1
End If

sh.Run cmd, 0, False
