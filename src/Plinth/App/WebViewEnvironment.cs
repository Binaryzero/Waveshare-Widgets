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

    // The diagnostics throttle: a noisy or hostile page (the embed widgets frame
    // real internet sites) must not be able to drive sustained disk writes through
    // the rolling log. Simple minute window, shared by every mirrored view, both
    // mirror event sources AND the media relay's dispositions — diagnostics are for
    // the first look, not for volume.
    private static long _mirrorWindowStart;
    private static int _mirrorCount;
    private static bool _mirrorMuted;

    internal static bool DiagnosticsBudget()
    {
        var now = Environment.TickCount64;
        if (now - _mirrorWindowStart > 60_000)
        {
            _mirrorWindowStart = now;
            _mirrorCount = 0;
            _mirrorMuted = false;
        }
        if (++_mirrorCount <= 30)
            return true;
        if (!_mirrorMuted)
        {
            _mirrorMuted = true;
            Log.Info("[renderer] mirror muted for the rest of the minute (volume)");
        }
        return false;
    }

    /// <summary>Every URL in renderer text collapses to scheme://authority/… before
    /// logging. SafeUrl's rule, applied to embedded text: paths, userinfo and queries
    /// are credential-bearing (the api_key rides a media URL's query), and logs get
    /// pasted into bug reports whole.</summary>
    private static string RedactUrls(string text)
    {
        // Renderer-controlled text stays ONE log line: an embedded \r\n would let a
        // hostile frame mint entries that read as the app's own in a pasted log.
        text = text.Replace('\r', ' ').Replace('\n', ' ');
        text = System.Text.RegularExpressions.Regex.Replace(text, @"https?://\S+", m =>
            Uri.TryCreate(m.Value.TrimEnd('.', ',', ')', '"', '\''), UriKind.Absolute, out var u)
                ? u.Scheme + "://" + u.Authority + "/…"
                : "url…");
        return System.Text.RegularExpressions.Regex.Replace(text, @"\?\S+", "?…");
    }

    /// <summary>
    /// Mirror the renderer's own account of failures into app.log. Chromium announces
    /// what it blocks — mixed content, Local Network Access, CORS, CSP — in places no
    /// page can read: the console (Log.entryAdded) and the network stack
    /// (Network.loadingFailed, which names the exact net::ERR_* and blocked reason).
    /// Four field rounds were spent inferring gates from a media element's rs/ns
    /// numbers, and a fifth discovered that silence: media failures may emit no
    /// console entry at all, which is why the network tap rides along.
    /// </summary>
    public static async void MirrorRendererConsole(CoreWebView2 core)
    {
        try
        {
            await core.CallDevToolsProtocolMethodAsync("Log.enable", "{}");
            await core.CallDevToolsProtocolMethodAsync("Network.enable", "{}");

            // Network.loadingFailed carries no URL — map requestId → authority from
            // requestWillBeSent, bounded so a busy page cannot grow it unbounded.
            var urls = new System.Collections.Concurrent.ConcurrentDictionary<string, string>();
            var order = new System.Collections.Concurrent.ConcurrentQueue<string>();

            core.GetDevToolsProtocolEventReceiver("Network.requestWillBeSent").DevToolsProtocolEventReceived += (_, e) =>
            {
                try
                {
                    var node = System.Text.Json.Nodes.JsonNode.Parse(e.ParameterObjectAsJson);
                    var id = node?["requestId"]?.GetValue<string>();
                    var url = node?["request"]?["url"]?.GetValue<string>();
                    if (id is null || url is null)
                        return;
                    var shown = Uri.TryCreate(url, UriKind.Absolute, out var u)
                        ? u.Scheme + "://" + u.Authority + "/…" : "url…";
                    // A redirect re-emits the same requestId with the NEW url, and a
                    // later failure belongs to the last hop — always overwrite, but
                    // enqueue an id for eviction only the first time it is seen.
                    var fresh = !urls.ContainsKey(id);
                    urls[id] = shown;
                    if (fresh)
                    {
                        order.Enqueue(id);
                        // `out var removed`, not `out _`: the enclosing lambda's sender
                        // parameter is named `_`, which makes the bare discard resolve
                        // to that object instead of a fresh string.
                        while (order.Count > 256 && order.TryDequeue(out var old))
                            urls.TryRemove(old, out var removed);
                    }
                }
                catch { /* diagnostics must never take the dashboard down */ }
            };

            core.GetDevToolsProtocolEventReceiver("Network.loadingFailed").DevToolsProtocolEventReceived += (_, e) =>
            {
                try
                {
                    var node = System.Text.Json.Nodes.JsonNode.Parse(e.ParameterObjectAsJson);
                    if (node?["canceled"]?.GetValue<bool>() == true)
                        return;
                    if (!DiagnosticsBudget())
                        return;
                    var id = node?["requestId"]?.GetValue<string>() ?? "";
                    var type = node?["type"]?.GetValue<string>() ?? "?";
                    var error = node?["errorText"]?.GetValue<string>() ?? "?";
                    var blocked = node?["blockedReason"]?.GetValue<string>();
                    Log.Info($"[renderer:net] {type} {(urls.TryGetValue(id, out var shown) ? shown : "?")} failed: {error}"
                        + (string.IsNullOrEmpty(blocked) ? "" : $" (blocked: {blocked})"));
                }
                catch { /* as above */ }
            };

            core.GetDevToolsProtocolEventReceiver("Log.entryAdded").DevToolsProtocolEventReceived += (_, e) =>
            {
                try
                {
                    var entry = System.Text.Json.Nodes.JsonNode.Parse(e.ParameterObjectAsJson)?["entry"];
                    var level = entry?["level"]?.GetValue<string>() ?? "";
                    if (level is not ("error" or "warning"))
                        return;
                    if (!DiagnosticsBudget())
                        return;
                    var text = RedactUrls(entry?["text"]?.GetValue<string>() ?? "");
                    if (text.Length > 300)
                        text = text[..300];
                    Log.Info($"[renderer:{level}] {text}");
                }
                catch { /* as above */ }
            };

            Log.Info("renderer mirror on (console + network failures)");
        }
        catch (Exception ex)
        {
            Log.Warn($"renderer mirror unavailable: {ex.Message}");
        }
    }
}
