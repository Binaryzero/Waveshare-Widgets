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
                // Widgets live on https virtual hosts while the media they play lives on
                // plain-http LAN servers (Jellyfin's default is http://<server>:8096), and
                // Chromium's mixed-content machinery kills those <video>/<audio> requests two
                // ways: it rewrites them to an https the server cannot serve (the autoupgrade),
                // and it blocks what is not upgraded. Field-tested one flag at a time:
                // disabling AutoupgradeMixedContent alone was NOT enough — playback still
                // errored on the panel — so the explicit allowance rides with it. Both are
                // needed: the allowance without the upgrade-disable would still see requests
                // rewritten to https before it gets a say.
                // The cost is honest: --allow-running-insecure-content relaxes mixed-content
                // blocking for ACTIVE content too, app-wide. Installed widgets are already
                // trusted code with LAN reach through WW.fetch, and the panel is a LAN
                // appliance, so the added surface is accepted for working playback. A future
                // alternative is a host-side streaming relay, which would let both flags go.
                // One --disable-features flag, comma-separated: repeating the switch would
                // not merge, the last occurrence would win and silently drop the other.
                AdditionalBrowserArguments =
                    "--disable-background-timer-throttling " +
                    "--disable-renderer-backgrounding " +
                    "--allow-running-insecure-content " +
                    "--disable-features=CalculateNativeWinOcclusion,AutoupgradeMixedContent",
            });
    }
}
