using Microsoft.Web.WebView2.Core;

namespace Plinth.App;

/// <summary>
/// One shared CoreWebView2Environment for all DASHBOARD windows. WebView2 requires every
/// control sharing a user-data folder to be created with identical environment options,
/// so both the dashboard and the settings window must come through here.
///
/// The browser-fetch tier does NOT: it navigates untrusted external origins with
/// forwarded credentials in reach, so it gets <see cref="GetSecureAsync"/> — a separate
/// profile without the dashboard's mixed-content allowance.
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

    /// <summary>
    /// Hosts whose certificate errors the dashboard-tier WebViews may accept. An entry
    /// appears only when a widget exercises WW.fetch's documented insecure opt-in
    /// (init.insecure, honored for private hosts only) — the Jellyfin widget sets it
    /// exactly when its certificate-check setting says Allow self-signed. Keyed by
    /// scheme://authority; concurrent because proxy fetches register from worker
    /// threads while the certificate handler reads on the WebView's.
    /// </summary>
    private static readonly System.Collections.Concurrent.ConcurrentDictionary<string, byte> InsecureLanHosts =
        new(StringComparer.OrdinalIgnoreCase);

    /// <summary>
    /// Record a widget's insecure (skip certificate validation) opt-in for a PRIVATE
    /// host, unlocking browser-side media on it for this app run. The caller gates on
    /// <see cref="DashboardWindow.IsPrivateHost"/>; this trusts, but keys narrowly.
    /// The entry outlives a widget's later change of heart — accepted residue, and not
    /// new: WebView2 caches an AlwaysAllow per host+certificate for the session anyway.
    /// </summary>
    public static void AllowInsecureLanHost(Uri uri) =>
        InsecureLanHosts.TryAdd(uri.Scheme + "://" + uri.Authority, 0);

    /// <summary>
    /// Accept certificate errors on this WebView for hosts a widget explicitly opted
    /// into. Self-hosted LAN services (Jellyfin above all) overwhelmingly run https
    /// with a self-signed certificate, and the media they stream goes through the
    /// browser — WW.fetch's insecure proxy tier cannot carry a &lt;video&gt; element.
    /// The event raises for every web resource (unhandled, a non-navigation request
    /// like that stream is cancelled silently), so without this the stream dies with
    /// no story to tell.
    ///
    /// The scope is deliberately DOUBLE-gated rather than all private hosts: a blanket
    /// private allowance would also let a widget's NATIVE fetch — which carries live
    /// credentials like X-Emby-Token — sail past a bad certificate even when that
    /// widget's own setting demands validation, silently bypassing the insecure:false
    /// enforcement the proxy tier would have applied. A host qualifies only when it is
    /// private (loopback or literal RFC1918/link-local IPv4, per
    /// <see cref="DashboardWindow.IsPrivateHost"/>) AND registered through
    /// <see cref="AllowInsecureLanHost"/> — the same opt-in contract the proxy
    /// enforces, now spanning both layers. An attacker who can answer for a private IP
    /// on the panel's LAN could as easily MITM the plain http Jellyfin ships as its
    /// default, so the opt-in accepts no risk that baseline doesn't already carry.
    /// NEVER wire this on the secure fetch tier: BrowserFetcher navigates untrusted
    /// external origins with credentials in reach.
    /// </summary>
    public static void AllowLanSelfSignedCertificates(CoreWebView2 core)
    {
        core.ServerCertificateErrorDetected += (_, e) =>
        {
            e.Action = Uri.TryCreate(e.RequestUri, UriKind.Absolute, out var uri)
                       && DashboardWindow.IsPrivateHost(uri)
                       && InsecureLanHosts.ContainsKey(uri.Scheme + "://" + uri.Authority)
                ? CoreWebView2ServerCertificateErrorAction.AlwaysAllow
                : CoreWebView2ServerCertificateErrorAction.Default;
        };
    }

    /// <summary>
    /// The environment for BrowserFetcher's bot-wall tier. That tier NAVIGATES real
    /// external origins and runs their page scripts with the caller's Authorization /
    /// API-key headers and full URL passed into an in-page fetch — the one place in
    /// this app where a foreign page's scripts and a live credential share a world.
    /// Granting it the dashboard's mixed-content allowance would let an https bootstrap
    /// on a hostile network pull an http ACTIVE script into exactly that world, so this
    /// environment carries none of it: full mixed-content blocking, own user-data
    /// folder (WebView2 binds options per folder, so sharing the dashboard's was never
    /// an option once the two diverged).
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
}
