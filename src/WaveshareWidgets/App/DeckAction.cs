using System.Diagnostics;
using System.Runtime.InteropServices;

namespace WaveshareWidgets.App;

/// <summary>
/// Executes Control Deck button actions on the host. Self-contained — no external
/// software required. Kinds:
///   launch  — start an app/file/folder (target = path)
///   url     — open a URL in the default browser (target = http/https URL)
///   hotkey  — send a keystroke combo (target = e.g. "ctrl+alt+k", "volumeup", "f5")
///   media   — transport control (target = "toggle" | "next" | "prev"), routed to the
///             media handler passed in by the caller
/// </summary>
internal static class DeckAction
{
    public static void Execute(string? kind, string? target, Action<string> mediaControl)
    {
        if (string.IsNullOrWhiteSpace(kind))
            return;
        try
        {
            switch (kind)
            {
                case "launch":
                    if (!string.IsNullOrWhiteSpace(target))
                        Process.Start(new ProcessStartInfo(target) { UseShellExecute = true });
                    break;

                case "url":
                    if (Uri.TryCreate(target, UriKind.Absolute, out var uri) &&
                        (uri.Scheme == Uri.UriSchemeHttp || uri.Scheme == Uri.UriSchemeHttps))
                        Process.Start(new ProcessStartInfo(uri.ToString()) { UseShellExecute = true });
                    break;

                case "media":
                    if (!string.IsNullOrWhiteSpace(target))
                        mediaControl(target);
                    break;

                case "hotkey":
                    SendHotkey(target);
                    break;

                default:
                    Log.Warn($"Unknown deck action kind '{kind}'");
                    break;
            }
        }
        catch (Exception ex)
        {
            Log.Warn($"Deck action '{kind}' ({target}) failed: {ex.Message}");
        }
    }

    /// <summary>Parses "ctrl+shift+n" style combos and injects them with SendInput.
    /// Modifiers are pressed, the final key tapped, then modifiers released.</summary>
    private static void SendHotkey(string? combo)
    {
        if (string.IsNullOrWhiteSpace(combo))
            return;

        var parts = combo.Split('+', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        var modifiers = new List<ushort>();
        ushort mainKey = 0;

        foreach (var part in parts)
        {
            switch (part.ToLowerInvariant())
            {
                case "ctrl" or "control": modifiers.Add(VK_CONTROL); break;
                case "alt": modifiers.Add(VK_MENU); break;
                case "shift": modifiers.Add(VK_SHIFT); break;
                case "win" or "meta" or "super": modifiers.Add(VK_LWIN); break;
                default:
                    var key = KeyFromName(part);
                    if (key != 0)
                        mainKey = key;
                    break;
            }
        }
        if (mainKey == 0)
            return;

        var sequence = new List<INPUT>();
        foreach (var mod in modifiers) sequence.Add(KeyInput(mod, down: true));
        sequence.Add(KeyInput(mainKey, down: true));
        sequence.Add(KeyInput(mainKey, down: false));
        for (var i = modifiers.Count - 1; i >= 0; i--) sequence.Add(KeyInput(modifiers[i], down: false));

        var inputs = sequence.ToArray();
        SendInput((uint)inputs.Length, inputs, Marshal.SizeOf<INPUT>());
    }

    private static ushort KeyFromName(string name)
    {
        name = name.ToLowerInvariant();
        if (name.Length == 1)
        {
            var c = char.ToUpperInvariant(name[0]);
            if (c is >= 'A' and <= 'Z' or >= '0' and <= '9')
                return c; // VK codes for A-Z and 0-9 equal their ASCII
        }
        return name switch
        {
            "space" => 0x20,
            "enter" or "return" => 0x0D,
            "tab" => 0x09,
            "esc" or "escape" => 0x1B,
            "backspace" => 0x08,
            "delete" or "del" => 0x2E,
            "up" => 0x26, "down" => 0x28, "left" => 0x25, "right" => 0x27,
            "home" => 0x24, "end" => 0x23, "pageup" => 0x21, "pagedown" => 0x22,
            "printscreen" or "prtsc" => 0x2C,
            "volumeup" => 0xAF, "volumedown" => 0xAE, "volumemute" => 0xAD,
            "medianext" => 0xB0, "mediaprev" => 0xB1, "mediastop" => 0xB2, "mediaplaypause" => 0xB3,
            _ when name.StartsWith('f') && int.TryParse(name.AsSpan(1), out var n) && n is >= 1 and <= 24
                => (ushort)(0x70 + n - 1), // F1..F24
            _ => 0,
        };
    }

    private const ushort VK_SHIFT = 0x10;
    private const ushort VK_CONTROL = 0x11;
    private const ushort VK_MENU = 0x12;   // Alt
    private const ushort VK_LWIN = 0x5B;
    private const uint INPUT_KEYBOARD = 1;
    private const uint KEYEVENTF_KEYUP = 0x0002;

    private static INPUT KeyInput(ushort vk, bool down) => new()
    {
        type = INPUT_KEYBOARD,
        u = new INPUTUNION
        {
            ki = new KEYBDINPUT { wVk = vk, dwFlags = down ? 0 : KEYEVENTF_KEYUP },
        },
    };

    [StructLayout(LayoutKind.Sequential)]
    private struct INPUT { public uint type; public INPUTUNION u; }

    [StructLayout(LayoutKind.Explicit)]
    private struct INPUTUNION
    {
        [FieldOffset(0)] public KEYBDINPUT ki;
        [FieldOffset(0)] public MOUSEINPUT mi;
        [FieldOffset(0)] public HARDWAREINPUT hi;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }

    [StructLayout(LayoutKind.Sequential)]
    private struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }

    [StructLayout(LayoutKind.Sequential)]
    private struct HARDWAREINPUT { public uint uMsg; public ushort wParamL; public ushort wParamH; }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
}
