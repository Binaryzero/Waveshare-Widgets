using Microsoft.Web.WebView2.Core;

namespace Plinth.App;

/// <summary>
/// One shared CoreWebView2Environment for all DASHBOARD windows. WebView2 requires every
/// control sharing a user-data folder to be created with identical environment options,
/// so both the dashboard and the settings window must come through here.
///
/// The browser-fetch tier does NOT: it navigates untrusted external origins with
/// forwarded credentials in reach, so it gets <see cref="GetSecureAsync"/> — a separate
/// profile on its own user-data folder.
///
/// Deliberately ABSENT from both tiers: every renderer network-gate relaxation this
/// file once carried for LAN media playback. Four field rounds each disabled a gate
/// (mixed-content autoupgrade, mixed-content blocking, Local Network Access by flag,
/// then by permission grant) and playback died identically every time — so media left
/// the renderer's network stack instead (<see cref="MediaRelay"/>), and the browser
/// runs with stock security everywhere. If LAN playback ever breaks again, the
/// renderer-console mirror (<see cref="MirrorRendererConsole"/>) makes the engine name
/// the blocker in app.log instead of leaving it to inference.
/// </summary>
internal static class WebViewEnvironment
{
    private static Task<CoreWebView2Environment>? _instance;
    private static Task<CoreWebView2Environment>? _secureInstance;

    public static Task<CoreWebView2Environment> GetAsync()
    {
        return _instance ??= CoreWebView2Environment.CreateAsync(null, AppPaths.WebViewUserDataDir,
            new CoreWebView2EnvironmentOptions
            {
                // The dashboard is always visible but almost never focused; Chromium must
                // not throttle its timers or renderer for being "in the background".
                AdditionalBrowserArguments =
                    "--disable-background-timer-throttling " +
                    "--disable-renderer-backgrounding " +
                    "--disable-features=CalculateNativeWinOcclusion",
            });
    }

    /// <summary>
    /// The environment for BrowserFetcher's bot-wall tier. That tier NAVIGATES real
    /// external origins and runs their page scripts with the caller's Authorization /
    /// API-key headers and full URL passed into an in-page fetch — the one place in
    /// this app where a foreign page's scripts and a live credential share a world.
    /// Its own user-data folder keeps it a separate profile whose options can never
    /// be dragged along by dashboard needs (WebView2 binds options per folder, and
    /// the dashboard HAS diverged before).
    /// </summary>
    public static Task<CoreWebView2Environment> GetSecureAsync()
    {
        return _secureInstance ??= CoreWebView2Environment.CreateAsync(null, AppPaths.WebViewFetchUserDataDir,
            new CoreWebView2EnvironmentOptions
            {
                AdditionalBrowserArguments =
                    "--disable-background-timer-throttling " +
                    "--disable-renderer-backgrounding " +
                    "--disable-features=CalculateNativeWinOcclusion",
            });
    }

    /// <summary>
    /// Mirror the renderer's warning/error console entries into app.log. Chromium
    /// announces every request it blocks — mixed content, Local Network Access, CORS,
    /// CSP — in the console and NOWHERE a page can read, which is how four field
    /// rounds got spent inferring gates from a media element's rs/ns numbers. Query
    /// strings are stripped before logging: blocked-URL messages can quote a media
    /// URL, and the api_key rides its query.
    /// </summary>
    public static async void MirrorRendererConsole(CoreWebView2 core)
    {
        try
        {
            await core.CallDevToolsProtocolMethodAsync("Log.enable", "{}");
            core.GetDevToolsProtocolEventReceiver("Log.entryAdded").DevToolsProtocolEventReceived += (_, e) =>
            {
                try
                {
                    var entry = System.Text.Json.Nodes.JsonNode.Parse(e.ParameterObjectAsJson)?["entry"];
                    var level = entry?["level"]?.GetValue<string>() ?? "";
                    if (level is not ("error" or "warning"))
                        return;
                    var text = entry?["text"]?.GetValue<string>() ?? "";
                    text = System.Text.RegularExpressions.Regex.Replace(text, @"\?\S+", "?…");
                    if (text.Length > 300)
                        text = text[..300];
                    Log.Info($"[renderer:{level}] {text}");
                }
                catch { /* diagnostics must never take the dashboard down */ }
            };
        }
        catch (Exception ex)
        {
            Log.Warn($"renderer console mirror unavailable: {ex.Message}");
        }
    }
}
