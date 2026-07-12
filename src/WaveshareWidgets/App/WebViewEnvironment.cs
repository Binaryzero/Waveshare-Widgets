using Microsoft.Web.WebView2.Core;

namespace WaveshareWidgets.App;

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
                AdditionalBrowserArguments =
                    "--disable-background-timer-throttling " +
                    "--disable-renderer-backgrounding " +
                    "--disable-features=CalculateNativeWinOcclusion",
            });
    }
}
