using System.Reflection;

namespace WaveshareWidgets;

/// <summary>The running build, human-readable and unambiguous. The SDK stamps
/// AssemblyInformationalVersion as "0.2.0+&lt;full git sha&gt;" at build time;
/// this trims the sha to 7 chars so every surface (tray, settings window, log)
/// shows the same stamp a bug report can quote.</summary>
public static class AppVersion
{
    public static readonly string Describe = Build();

    private static string Build()
    {
        var asm = typeof(AppVersion).Assembly;
        var info = asm.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion;
        if (string.IsNullOrWhiteSpace(info))
            return "v" + (asm.GetName().Version?.ToString(3) ?? "0.0.0");
        var plus = info.IndexOf('+');
        if (plus < 0) return "v" + info;
        var sha = info[(plus + 1)..];
        return "v" + info[..plus] + " (" + (sha.Length > 7 ? sha[..7] : sha) + ")";
    }
}
