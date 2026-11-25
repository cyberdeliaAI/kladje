param(
    [Parameter(Mandatory)] [string] $Editor
)

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class KladjeWindowsMenu {
    [DllImport("user32.dll")] public static extern IntPtr GetMenu(IntPtr window);
    [DllImport("user32.dll")] public static extern IntPtr GetSubMenu(IntPtr menu, int position);
    [DllImport("user32.dll")] public static extern int GetMenuItemCount(IntPtr menu);
    [DllImport("user32.dll")] public static extern uint GetMenuItemID(IntPtr menu, int position);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetMenuString(IntPtr menu, uint position, StringBuilder text, int size, uint flags);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern IntPtr FindWindow(string windowClass, string windowName);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern bool PostMessage(IntPtr window, uint message, UIntPtr wParam, IntPtr lParam);
}
'@

function Wait-For([scriptblock] $Condition, [string] $Failure) {
    $deadline = (Get-Date).AddSeconds(30)
    do {
        $result = & $Condition
        if ($result) { return $result }
        Start-Sleep -Milliseconds 300
    } while ((Get-Date) -lt $deadline)
    throw $Failure
}

function Find-MenuPosition([IntPtr] $Menu, [string] $Label) {
    for ($position = 0; $position -lt [KladjeWindowsMenu]::GetMenuItemCount($Menu); $position++) {
        $text = [Text.StringBuilder]::new(256)
        $null = [KladjeWindowsMenu]::GetMenuString($Menu, $position, $text, $text.Capacity, 0x400)
        if ($text.ToString().Replace('&', '').Split("`t")[0] -eq $Label) { return $position }
    }
    throw "Menu item not found: $Label"
}

function Invoke-MenuItem([IntPtr] $Window, [string] $Group, [string] $Label) {
    $menu = [KladjeWindowsMenu]::GetMenu($Window)
    $submenu = [KladjeWindowsMenu]::GetSubMenu($menu, (Find-MenuPosition $menu $Group))
    $id = [KladjeWindowsMenu]::GetMenuItemID($submenu, (Find-MenuPosition $submenu $Label))
    if ($id -eq [uint32]::MaxValue -or
        ![KladjeWindowsMenu]::PostMessage($Window, 0x111, [UIntPtr]::new($id), [IntPtr]::Zero)) {
        throw "Could not invoke $Group > $Label."
    }
}

$folder = Join-Path $env:RUNNER_TEMP 'Kladje test folder'
$null = New-Item -ItemType Directory -Path $folder
$name = "Kladje test-$([char]0x00E9).md"
$document = Join-Path $folder $name
'# Test document' | Set-Content -LiteralPath $document -Encoding utf8

$app = Start-Process -FilePath $Editor -WorkingDirectory (Split-Path -Parent $Editor) -ArgumentList ('"{0}"' -f $document) -PassThru
try {
    $window = Wait-For {
        $app.Refresh()
        if ($app.HasExited) { throw "Kladje exited with code $($app.ExitCode)." }
        if ($app.MainWindowHandle -ne [IntPtr]::Zero -and $app.MainWindowTitle.Contains($name)) {
            $app.MainWindowHandle
        }
    } 'Kladje did not open the test Markdown document.'
    Write-Output "Opened the Markdown document: $name"

    Invoke-MenuItem $window 'Help' 'About Kladje'
    $about = Wait-For {
        $dialog = [KladjeWindowsMenu]::FindWindow([NullString]::Value, 'About Kladje')
        if ($dialog -ne [IntPtr]::Zero) { $dialog }
    } 'Help > About Kladje did not open the dialog.'
    Write-Output 'Verified Help > About Kladje.'
    if (![KladjeWindowsMenu]::PostMessage($about, 0x10, [UIntPtr]::Zero, [IntPtr]::Zero)) {
        throw 'Could not dismiss the About dialog.'
    }
    $null = Wait-For {
        [KladjeWindowsMenu]::FindWindow([NullString]::Value, 'About Kladje') -eq [IntPtr]::Zero
    } 'The About dialog stayed open.'

    Invoke-MenuItem $window 'File' 'Show in Folder'
    $shell = New-Object -ComObject Shell.Application
    $null = Wait-For {
        foreach ($explorer in $shell.Windows()) {
            try {
                if ($explorer.Document.Folder.Self.Path -ne $folder) { continue }
                foreach ($selected in $explorer.Document.SelectedItems()) {
                    if ($selected.Path -eq $document) { return $true }
                }
            } catch [System.Runtime.InteropServices.COMException] {
                # Explorer can register its window before its document is ready.
            }
        }
    } 'File > Show in Folder did not select the Markdown document in Explorer.'
    Write-Output 'Verified File > Show in Folder opened Explorer and selected the Markdown document.'
} finally {
    if (!$app.HasExited) { $app.Kill() }
}
