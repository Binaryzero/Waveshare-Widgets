namespace Plinth;

/// <summary>Well-known file system locations used by the app.</summary>
internal static class AppPaths
{
    public static string DataDir { get; } = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Plinth");

    public static string WidgetsDir { get; } = Path.Combine(DataDir, "widgets");
    public static string LayoutFile { get; } = Path.Combine(DataDir, "layout.json");
    public static string ConfigFile { get; } = Path.Combine(DataDir, "config.json");
    public static string WebViewUserDataDir { get; } = Path.Combine(DataDir, "webview2");

    /// <summary>Separate profile for the browser-fetch tier. WebView2 requires every
    /// control on a user-data folder to share identical environment options, and the
    /// fetch tier must NOT share the dashboard's mixed-content allowance — it navigates
    /// untrusted external origins with forwarded credentials in reach (see
    /// WebViewEnvironment).</summary>
    public static string WebViewFetchUserDataDir { get; } = Path.Combine(DataDir, "webview2-fetch");

    /// <summary>User-chosen dashboard background images/videos, served from a virtual host.</summary>
    public static string BackgroundsDir { get; } = Path.Combine(DataDir, "backgrounds");

    /// <summary>User media library (Gallery widget etc.), served as https://media.plinth/.</summary>
    public static string MediaDir { get; } = Path.Combine(DataDir, "media");

    /// <summary>Persisted widget-id → virtual-host assignments. Hosts are browser
    /// ORIGINS (localStorage keys, credentials); once assigned they must never
    /// change or be handed to a different widget.</summary>
    public static string HostMapFile { get; } = Path.Combine(DataDir, "widget-hosts.json");

    /// <summary>Credentials widgets DERIVE at runtime — an OAuth bearer bought with a
    /// `secret` property — sealed with the same DPAPI envelope those properties get
    /// (#175). Its own file rather than a corner of layout.json: layout.json is copied,
    /// synced and pasted into issues, and nothing in it is meant to be a live credential
    /// store. See WidgetSecrets.</summary>
    public static string WidgetSecretsFile { get; } = Path.Combine(DataDir, "widget-secrets.json");

    /// <summary>Web assets for the dashboard shell page, shipped next to the exe.</summary>
    public static string ShellDir { get; } = Path.Combine(AppContext.BaseDirectory, "Shell");

    /// <summary>Stock widgets shipped next to the exe; seeded into <see cref="WidgetsDir"/> on first run.</summary>
    public static string StockWidgetsDir { get; } = Path.Combine(AppContext.BaseDirectory, "stock-widgets");

    public static void EnsureCreated()
    {
        Directory.CreateDirectory(DataDir);
        Directory.CreateDirectory(WidgetsDir);
        Directory.CreateDirectory(WebViewUserDataDir);
        Directory.CreateDirectory(WebViewFetchUserDataDir);
        Directory.CreateDirectory(BackgroundsDir);
        Directory.CreateDirectory(MediaDir);
    }
}
