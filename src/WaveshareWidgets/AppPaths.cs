namespace WaveshareWidgets;

/// <summary>Well-known file system locations used by the app.</summary>
internal static class AppPaths
{
    public static string DataDir { get; } = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "WaveshareWidgets");

    public static string WidgetsDir { get; } = Path.Combine(DataDir, "widgets");
    public static string LayoutFile { get; } = Path.Combine(DataDir, "layout.json");
    public static string ConfigFile { get; } = Path.Combine(DataDir, "config.json");
    public static string WebViewUserDataDir { get; } = Path.Combine(DataDir, "webview2");

    /// <summary>Web assets for the dashboard shell page, shipped next to the exe.</summary>
    public static string ShellDir { get; } = Path.Combine(AppContext.BaseDirectory, "Shell");

    /// <summary>Stock widgets shipped next to the exe; seeded into <see cref="WidgetsDir"/> on first run.</summary>
    public static string StockWidgetsDir { get; } = Path.Combine(AppContext.BaseDirectory, "stock-widgets");

    public static void EnsureCreated()
    {
        Directory.CreateDirectory(DataDir);
        Directory.CreateDirectory(WidgetsDir);
        Directory.CreateDirectory(WebViewUserDataDir);
    }
}
