using System.Diagnostics;

namespace WaveshareWidgets;

/// <summary>Minimal rolling file logger (single file, truncated when it grows past 1 MB).</summary>
internal static class Log
{
    private static readonly object Sync = new();
    private static string LogFile => Path.Combine(AppPaths.DataDir, "app.log");

    public static void Info(string message) => Write("INFO", message);
    public static void Warn(string message) => Write("WARN", message);
    public static void Error(string message) => Write("ERROR", message);

    private static void Write(string level, string message)
    {
        var line = $"{DateTime.Now:yyyy-MM-dd HH:mm:ss} [{level}] {message}";
        Debug.WriteLine(line);
        try
        {
            lock (Sync)
            {
                if (File.Exists(LogFile) && new FileInfo(LogFile).Length > 1_000_000)
                    File.Delete(LogFile);
                File.AppendAllText(LogFile, line + Environment.NewLine);
            }
        }
        catch
        {
            // Logging must never take the app down.
        }
    }
}
