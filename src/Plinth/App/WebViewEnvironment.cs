using Microsoft.Web.WebView2.Core;

namespace Plinth.App;

/// <summary>
/// One shared CoreWebView2Environment for all windows. WebView2 requires every control
/// sharing a user-data folder to be created with identical environment options, so both
/// the dashboard and the settings window must come through here.
/// </summary>
internal static class WebViewEnvironment
{
    private static Task<CoreWebView2Environment>? _instance;

    public static Task<CoreWebView2Environment> GetAsync()
    {
        return _instance ??= CoreWebView2Environment.CreateAsync(null, AppPaths.WebViewUserDataDir,
            new CoreWebView2EnvironmentOptions
            {
                // The dashboard is always visible but almost never focused; Chromium must
                // not throttle its timers or renderer for being "in the background".
                //
                // AutoupgradeMixedContent is disabled because widgets live on https virtual
                // hosts while the media they play lives on plain-http LAN servers (Jellyfin's
                // default is http://<server>:8096). Chromium rewrites such <video>/<audio>
                // requests to https and, when the server has no TLS on that port, kills them —
                // so on-panel playback silently failed for the standard setup. Disabling the
                // upgrade restores the older behavior for optionally-blockable content only:
                // media and images load (with a console warning); ACTIVE mixed content —
                // scripts, stylesheets, fetch, frames — stays blocked exactly as before.
                // One --disable-features flag, comma-separated: repeating the switch would
                // not merge, the last occurrence would win and silently drop the other.
                AdditionalBrowserArguments =
                    "--disable-background-timer-throttling " +
                    "--disable-renderer-backgrounding " +
                    "--disable-features=CalculateNativeWinOcclusion,AutoupgradeMixedContent",
            });
    }
}
