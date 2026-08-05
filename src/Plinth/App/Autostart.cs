using Microsoft.Win32;

namespace Plinth.App;

/// <summary>The "Start with Windows" tray toggle, backed by the per-user Run key.
///
/// <para>Its own type because two callers need it and they must not drift: the tray menu
/// reads and writes the current value, and <see cref="LegacyInstall"/> has to recognise the
/// pre-rename one. Duplicating the key path and the value name across those two would be a
/// silent breakage the moment either changed — and the value name has already changed once,
/// which is the whole reason LegacyInstall exists.</para></summary>
internal static class Autostart
{
    /// <summary>The Run value this build owns. Renaming this without adding the old spelling
    /// to <see cref="LegacyInstall"/> strands a startup entry pointing at an executable that
    /// is no longer the app.</summary>
    public const string ValueName = "Plinth";

    private const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";

    public static bool IsEnabled() => HasValue(ValueName);

    /// <summary>Whether a named Run value is present. Read-only handle: the caller may only
    /// be asking a question, and the common answer is "no".</summary>
    public static bool HasValue(string name)
    {
        using var key = Registry.CurrentUser.OpenSubKey(RunKey);
        return key?.GetValue(name) is not null;
    }

    public static void SetEnabled(bool enabled)
    {
        using var key = Registry.CurrentUser.CreateSubKey(RunKey);
        if (enabled)
            key.SetValue(ValueName, $"\"{Environment.ProcessPath}\"");
        else
            key.DeleteValue(ValueName, throwOnMissingValue: false);
    }

    /// <summary>Removes a Run value by name — used for spellings this build no longer owns.
    /// Opened writable only by callers that have already established there is something to
    /// remove.</summary>
    public static void RemoveValue(string name)
    {
        using var key = Registry.CurrentUser.OpenSubKey(RunKey, writable: true);
        key?.DeleteValue(name, throwOnMissingValue: false);
    }
}
