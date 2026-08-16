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
                //
                // LocalNetworkAccessChecks is the gate the mixed-content flags were blamed
                // for: Chromium (~M138, default-on by M142) permission-gates every request
                // from a "public" page to a private address, and a widget's virtual host
                // counts as public while the media server's LAN IP counts as private — so
                // the <video> request was cancelled before a byte went out (rs=0 ns=3 in
                // the field, while the same URL probed HTTP 200 video/mp4 through the host
                // proxy). Nothing in WebView2 grants that permission on the panel, so the
                // check is disabled for this tier — a LAN appliance whose widgets exist to
                // talk to the LAN. The PrivateNetworkAccess names cover the older preflight
                // generation of the same machinery on earlier runtimes; Chromium ignores
                // feature names it does not know.
                AdditionalBrowserArguments =
                    "--disable-background-timer-throttling " +
                    "--disable-renderer-backgrounding " +
                    "--allow-running-insecure-content " +
                    "--disable-features=CalculateNativeWinOcclusion,AutoupgradeMixedContent," +
                    "LocalNetworkAccessChecks,PrivateNetworkAccessSendPreflights," +
                    "PrivateNetworkAccessRespectPreflightResults",
            });
    }

    /// <summary>
    /// Hosts whose certificate errors the dashboard-tier WebViews may accept. An entry
    /// appears only when a widget exercises WW.fetch's MEDIA insecure opt-in
    /// (init.insecureMedia riding init.insecure, honored for private hosts only) —
    /// the Jellyfin widget sets both exactly when its certificate-check setting says
    /// Allow self-signed. Bare init.insecure does NOT register: the Endpoints widget
    /// sends it for every health probe, and a probe must not loosen certificate
    /// handling for a different widget on the same authority. Keyed by
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
    /// Grant permission KINDS newer than this SDK's enum to Plinth's own pages. The
    /// motivating kind is Chromium's Local Network Access permission (arrived after
    /// the pinned SDK): if the runtime routes LAN-request approval through
    /// PermissionRequested, an unhandled request is denied silently and widget media
    /// dies exactly like the field logs show — so this rides alongside the
    /// LocalNetworkAccessChecks disable as the second, scoped mechanism. Kinds the
    /// SDK knows keep their existing default handling untouched.
    ///
    /// The grant is scoped to pages that can only be ours: the https shell host and
    /// the https widget virtual hosts. A spoofed *.plinth name on a hostile LAN DNS
    /// cannot reach this — mapped hosts never touch DNS, an unmapped https fake dies
    /// on TLS (the certificate allowance above requires a literal private IP, which
    /// a NAME never is), and http fakes fail the scheme test. Foreign pages framed
    /// by the embed widgets never match: they keep default (deny) behavior.
    /// </summary>
    public static void GrantNewerPermissionKindsToPlinthPages(CoreWebView2 core)
    {
        core.PermissionRequested += (_, e) =>
        {
            if (Enum.IsDefined(e.PermissionKind))
                return;
            if (Uri.TryCreate(e.Uri, UriKind.Absolute, out var uri)
                && uri.Scheme == Uri.UriSchemeHttps
                && (uri.Host.Equals("app.plinth", StringComparison.OrdinalIgnoreCase)
                    || uri.Host.EndsWith(".widgets.plinth", StringComparison.OrdinalIgnoreCase)))
                e.State = CoreWebView2PermissionState.Allow;
        };
    }

    /// <summary>
    /// The environment for BrowserFetcher's bot-wall tier. That tier NAVIGATES real
    /// external origins and runs their page scripts with the caller's Authorization /
    /// API-key headers and full URL passed into an in-page fetch — the one place in
    /// this app where a foreign page's scripts and a live credential share a world.
    /// Granting it the dashboard's mixed-content allowance would let an https bootstrap
    /// on a hostile network pull an http ACTIVE script into exactly that world, so this
    /// environment carries none of it: full mixed-content blocking, local-network-access
    /// checks left intact (a foreign page must not probe the LAN from this tier), own
    /// user-data folder (WebView2 binds options per folder, so sharing the dashboard's
    /// was never an option once the two diverged).
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
