# Application-owned code embedded into -EncodedCommand. Request is alphabet-only
# base64 JSON appended by the host; no paths or argv become PowerShell source.
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class LockedPath {
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    public static extern uint GetFinalPathNameByHandle(SafeFileHandle file, StringBuilder result, uint length, uint flags);
}
'@
function Quote-Argument([string]$value) {
    $quoted = '"'; $slashes = 0
    foreach ($character in $value.ToCharArray()) {
        if ($character -eq '\') { $slashes++; continue }
        if ($character -eq '"') { $quoted += ('\' * ($slashes * 2 + 1)) + '"' }
        else { $quoted += ('\' * $slashes) + $character }
        $slashes = 0
    }
    return $quoted + ('\' * ($slashes * 2)) + '"'
}
function Open-VerifiedInput($file, $streams) {
    $cursor = [IO.Path]::GetFullPath($file.path)
    while ($cursor) {
        if (([IO.File]::GetAttributes($cursor) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Input ancestry contains a reparse point' }
        $cursor = [IO.Path]::GetDirectoryName($cursor)
    }
    $stream = New-Object IO.FileStream($file.path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    $streams.Add($stream)
    $final = New-Object Text.StringBuilder 32768
    $length = [LockedPath]::GetFinalPathNameByHandle($stream.SafeFileHandle, $final, 32768, 0)
    if ($length -eq 0 -or $length -ge 32768) { throw 'Unable to verify opened input path' }
    $actual = $final.ToString()
    if ($actual.StartsWith('\\?\UNC\')) { $actual = '\\' + $actual.Substring(8) }
    elseif ($actual.StartsWith('\\?\')) { $actual = $actual.Substring(4) }
    if (-not [String]::Equals($actual, [IO.Path]::GetFullPath($file.path), [StringComparison]::OrdinalIgnoreCase)) { throw 'Opened input path differs from declared path' }
    if ($stream.Length -ne $file.size) { throw 'Locked input size changed' }
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $hash = [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
    if ($hash -ne $file.hash) { throw 'Locked input hash changed' }
    $stream.Position = 0
    return $stream
}
function Invoke-LockedToolFile([string]$encoded) { return Invoke-LockedTool $encoded $true }
function Invoke-LockedTool([string]$encoded, [bool]$fromFile = $false) {
    $streams = New-Object 'System.Collections.Generic.List[System.IO.FileStream]'
    $child = $null; $started = $false
    try {
        $request = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encoded)) | ConvertFrom-Json
        if ($fromFile) {
            if ($request.size -lt 1 -or $request.size -gt 16777216) { throw 'Locked request exceeds byte budget' }
            $manifest = Open-VerifiedInput $request $streams
            $bytes = New-Object byte[] ([int]$manifest.Length)
            $offset = 0
            while ($offset -lt $bytes.Length) {
                $count = $manifest.Read($bytes, $offset, $bytes.Length - $offset)
                if ($count -eq 0) { throw 'Locked request truncated' }
                $offset += $count
            }
            $utf8 = New-Object Text.UTF8Encoding($false, $true)
            $request = $utf8.GetString($bytes) | ConvertFrom-Json
        }
        foreach ($file in $request.files) {
            $null = Open-VerifiedInput $file $streams
        }
        $info = New-Object Diagnostics.ProcessStartInfo
        $info.FileName = $request.executable
        $info.WorkingDirectory = $request.cwd
        $info.Arguments = (($request.args | ForEach-Object { Quote-Argument $_ }) -join ' ')
        $info.UseShellExecute = $false
        $info.CreateNoWindow = $true
        $info.RedirectStandardOutput = $true
        $info.RedirectStandardError = $true
        $child = New-Object Diagnostics.Process
        $child.StartInfo = $info
        if (-not $child.Start()) { throw 'Unable to start owned native process' }
        $started = $true
        $readers = @($child.StandardOutput, $child.StandardError)
        $buffers = @((New-Object 'char[]' 4096), (New-Object 'char[]' 4096))
        $pending = @($readers[0].ReadAsync($buffers[0], 0, 4096), $readers[1].ReadAsync($buffers[1], 0, 4096))
        $done = @($false, $false); $count = 0; $watch = [Diagnostics.Stopwatch]::StartNew()
        while (-not ($done[0] -and $done[1] -and $child.HasExited)) {
            if ($watch.ElapsedMilliseconds -gt $request.timeoutMs) { throw 'Owned native process timed out' }
            for ($i = 0; $i -lt 2; $i++) {
                if (-not $done[$i] -and $pending[$i].IsCompleted) {
                    $length = $pending[$i].GetAwaiter().GetResult()
                    if ($length -eq 0) { $done[$i] = $true; continue }
                    $text = New-Object string($buffers[$i], 0, $length)
                    $count += [Text.Encoding]::UTF8.GetByteCount($text)
                    if ($count -gt 1048576) { throw 'Owned native output exceeded budget' }
                    if ($i -eq 0) { [Console]::Out.Write($text) } else { [Console]::Error.Write($text) }
                    $pending[$i] = $readers[$i].ReadAsync($buffers[$i], 0, 4096)
                }
            }
            [Threading.Thread]::Sleep(10)
        }
        return $child.ExitCode
    } catch {
        [Console]::Error.WriteLine($_.Exception.Message)
        return 125
    } finally {
        try {
            if ($null -ne $child) {
                if ($started -and -not $child.HasExited) { $child.Kill(); $child.WaitForExit() }
                $child.Dispose()
            }
        } finally { foreach ($stream in $streams) { $stream.Dispose() } }
    }
}
