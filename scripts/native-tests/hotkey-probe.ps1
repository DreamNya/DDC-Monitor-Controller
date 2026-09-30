param(
    [Parameter(Mandatory)][int]$TargetProcessId,
    [ValidateSet('available', 'dispatch')][string]$Action,
    [int]$NativeId = 0x4000,
    [int]$VirtualKey = 0x83
)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class HotkeyProbe {
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string className, string title);
    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr SendMessageTimeout(IntPtr window, uint message, UIntPtr wParam,
        IntPtr lParam, uint flags, uint timeout, out UIntPtr result);
    [DllImport("user32.dll")]
    public static extern bool RegisterHotKey(IntPtr window, int id, uint modifiers, uint virtualKey);
    [DllImport("user32.dll")]
    public static extern bool UnregisterHotKey(IntPtr window, int id);
}
'@
$targetWindow = [IntPtr]::Zero
do {
    $targetWindow = [HotkeyProbe]::FindWindowEx([IntPtr]::Zero, $targetWindow, 'WebViewNativeShellWindow', 'WebView Native Shell')
    if ($targetWindow -eq [IntPtr]::Zero) { throw 'Test message window was not found' }
    [uint32]$ownerProcessId = 0
    [void][HotkeyProbe]::GetWindowThreadProcessId($targetWindow, [ref]$ownerProcessId)
} while ($ownerProcessId -ne $TargetProcessId)

# Synchronize with the tested shell's UI command queue, without keyboard input
# or interaction with another application's windows.
[UIntPtr]$messageResult = [UIntPtr]::Zero
if ([HotkeyProbe]::SendMessageTimeout($targetWindow, 0x8001, [UIntPtr]::Zero,
        [IntPtr]::Zero, 2, 5000, [ref]$messageResult) -eq [IntPtr]::Zero) {
    throw 'Could not drain the test shell command queue'
}
if ($Action -eq 'available') {
    $available = [HotkeyProbe]::RegisterHotKey([IntPtr]::Zero, 1, 7, $VirtualKey)
    if ($available) { [void][HotkeyProbe]::UnregisterHotKey([IntPtr]::Zero, 1) }
    @{ available = $available } | ConvertTo-Json -Compress
} else {
    $payload = [IntPtr](($VirtualKey -shl 16) -bor 7)
    if ([HotkeyProbe]::SendMessageTimeout($targetWindow, 0x0312, [UIntPtr]::new([uint64]$NativeId),
            $payload, 2, 5000, [ref]$messageResult) -eq [IntPtr]::Zero) {
        throw 'Could not dispatch a test WM_HOTKEY'
    }
    @{ dispatched = $true } | ConvertTo-Json -Compress
}
