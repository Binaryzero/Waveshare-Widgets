using System.Diagnostics;

namespace Plinth;

/// <summary>The app's diagnostic log: app.log, one file per session, capped and rolled by
/// <see cref="RollingLog"/> (#256).</summary>
internal static class Log
{
    private static readonly RollingLog Sink = new(Path.Combine(AppPaths.DataDir, "app.log"));

    public static void Info(string message) => Write("INFO", message);
    public static void Warn(string message) => Write("WARN", message);
    public static void Error(string message) => Write("ERROR", message);

    /// <summary>Starts this run's own app.log, moving the last run's to app.1.log. Called once,
    /// from Program, only after this process holds the single-instance lock. The few lines
    /// written before that point (the legacy-install and lock probes) land at the end of the
    /// previous file, which is where a second launch's lines belong too.</summary>
    public static void StartSession()
    {
        var line = Stamp("INFO", $"==== Plinth {AppVersion.Describe} · session start · pid {Environment.ProcessId} ====");
        Debug.WriteLine(line);
        try { Sink.StartSession(line); }
        catch { /* Logging must never take the app down. */ }
    }

    private static string Stamp(string level, string message) =>
        $"{DateTime.Now:yyyy-MM-dd HH:mm:ss} [{level}] {message}";

    private static void Write(string level, string message)
    {
        var line = Stamp(level, message);
        Debug.WriteLine(line);
        try
        {
            Sink.Append(line);
        }
        catch
        {
            // Logging must never take the app down.
        }
    }
}
