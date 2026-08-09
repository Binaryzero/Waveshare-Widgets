using System.Text.Json;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace Plinth.App;

/// <summary>
/// Last-resort fetcher for bot-walled sites (Reddit): services that fingerprint the TLS
/// handshake reject any .NET HttpClient no matter how browser-like its headers are. This
/// navigates a hidden off-screen WebView2 to the URL — a real Chromium network stack with
/// a real TLS fingerprint, JS-challenge execution, and persistent cookies — and extracts
/// the response body from the rendered document. GET-only, serialized, slow-ish (~1-2 s);
/// used only after the fast HttpClient path returns 403/429.
/// </summary>
public sealed class BrowserFetcher : IDisposable
{

    private readonly Form _host;
    private readonly WebView2 _webView;
    private readonly SemaphoreSlim _gate = new(1, 1);
    private bool _ready;

    public BrowserFetcher()
    {
        _host = new Form
        {
            ShowInTaskbar = false,
            FormBorderStyle = FormBorderStyle.None,
            StartPosition = FormStartPosition.Manual,
            Location = new Point(-32000, -32000), // parked far off-screen; never Show()n
            Size = new Size(1024, 768),
            Opacity = 0,
        };
        _webView = new WebView2 { Dock = DockStyle.Fill };
        _host.Controls.Add(_webView);
    }

    private async Task EnsureReadyAsync()
    {
        if (_ready)
            return;
        _ = _host.Handle; // force handle creation without showing the form
        await _webView.EnsureCoreWebView2Async(await WebViewEnvironment.GetAsync());
        var core = _webView.CoreWebView2;
        core.Settings.AreDefaultContextMenusEnabled = false;
        core.Settings.IsStatusBarEnabled = false;
        core.IsMuted = true;
        _ready = true;
    }

    /// <summary>
    /// Fetches a URL through a real browser. First navigates to the target's origin root
    /// (this executes any JS bot-challenge and sets its cookies), then runs a same-origin
    /// fetch from inside that page — no CORS, cookies attached, raw text returned (so a
    /// JSON endpoint comes back as parseable JSON, not the browser's JSON viewer). The
    /// caller's replayable request headers ride the in-page fetch, so an authenticated
    /// request keeps its Authorization through this tier too (#37). Returns null on failure.
    /// </summary>
    /// <summary>
    /// The outcome of one hidden-browser fetch. <c>TooLarge</c> is its own state rather than
    /// a null return: this tier is entered only after the proxy tier got a 403 or 429, and
    /// reporting "the browser could not do better either" for a size refusal makes the caller
    /// keep that 403 — so a body whose only problem is its size is reported to the field as
    /// an authorization failure, and the ceiling the ladder advertises goes unmentioned.
    /// </summary>
    public readonly record struct BrowserFetch(
        int Status, string? ContentType, byte[] Body, bool TooLarge,
        IReadOnlyDictionary<string, string>? Headers = null)
    {
        public static BrowserFetch Refused(long size) => new(0, null, Array.Empty<byte>(), true);
    }

    /// <param name="maxBytes">The ceiling for this request, clamped by FetchLimits. REQUIRED,
    /// with no default on purpose: a default is what this bug looked like — the caller
    /// computed the widget's ceiling and then called a method that quietly substituted the
    /// shared one, so the number existed and did nothing. There is one call site; making it
    /// state the ceiling costs nothing and removes the failure mode rather than probing for
    /// it, which matters here because nothing about this class is reachable from a test.</param>
    public async Task<BrowserFetch?> FetchAsync(
        string url, IReadOnlyDictionary<string, string>? headers, int maxBytes)
    {
        await _gate.WaitAsync();
        try
        {
            await EnsureReadyAsync();
            var core = _webView.CoreWebView2;

            var origin = new Uri(url).GetLeftPart(UriPartial.Authority) + "/";
            var navDone = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
            void OnCompleted(object? sender, CoreWebView2NavigationCompletedEventArgs e) =>
                navDone.TrySetResult(e.IsSuccess);
            core.NavigationCompleted += OnCompleted;
            try
            {
                core.Navigate(origin);
                using (var navTimeout = new CancellationTokenSource(TimeSpan.FromSeconds(20)))
                await using (navTimeout.Token.Register(() => navDone.TrySetCanceled()))
                    await navDone.Task;
                await Task.Delay(700); // let a JS challenge finish and set cookies

                // The bootstrap can be REDIRECTED to a different origin, and the
                // fetch below runs inside whatever page the WebView landed on —
                // a foreign page's scripts can wrap window.fetch and read any
                // forwarded Authorization/API-key headers synchronously. A request
                // CARRYING caller headers therefore never runs from a foreign page.
                //
                // A header-less request may: there is nothing for the page to steal
                // but a URL the target site already knows, and the redirect is how
                // CDN hosts behave — preview.redd.it has no page at its root and
                // sends the browser to www.reddit.com, the very page whose
                // bot-challenge cookies and CORS grant exist so reddit's own app
                // can load these images (one field log: 679 refused image fetches,
                // every reddit tile dark). The fetch then runs cookieless ('omit'):
                // the CDN grants Access-Control-Allow-Origin without
                // allow-credentials, and the landed page's cookies have no business
                // riding a request addressed to a different host. CORS still gates
                // what the page is allowed to read.
                string finalOrigin;
                try { finalOrigin = new Uri(core.Source).GetLeftPart(UriPartial.Authority) + "/"; }
                catch { finalOrigin = ""; }
                var sameOrigin = string.Equals(finalOrigin, origin, StringComparison.OrdinalIgnoreCase);
                if (!sameOrigin)
                {
                    if (headers is { Count: > 0 }
                        || !finalOrigin.StartsWith("https://", StringComparison.OrdinalIgnoreCase))
                    {
                        Log.Warn($"browser fetch skipped ({SafeUrl.Describe(url)}): origin bootstrap redirected to '{SafeUrl.Describe(finalOrigin)}' — not running a request with caller headers from a foreign origin");
                        return null;
                    }
                    Log.Info($"browser fetch ({SafeUrl.Describe(url)}): origin root redirected to '{SafeUrl.Describe(finalOrigin)}'; running cookieless from the landed page (no caller headers to protect)");
                }

                // Kick off a same-origin fetch and stash its result on window; then poll.
                // The body crosses ExecuteScriptAsync as base64: reading text() UTF-8
                // mangles every binary response — the field's Reddit tiles showed the
                // caption (JSON listing survived) over a black image (JPEG destroyed).
                var jsUrl = JsonSerializer.Serialize(url); // safely quoted JS string literal
                var headerMap = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
                {
                    ["Accept"] = "application/json,image/*,text/plain,*/*",
                };
                if (headers is not null)
                    foreach (var (name, value) in headers) headerMap[name] = value; // caller's Accept wins
                var jsHeaders = JsonSerializer.Serialize(headerMap); // safe JS object literal
                // The cap is applied INSIDE the page, streaming, so the bytes past it are
                // never received — see FetchLimits, which is also where the proxy tier's
                // ceiling lives so the two cannot disagree.
                await core.ExecuteScriptAsync(FetchLimits.BrowserFetchScript(jsUrl, jsHeaders, maxBytes, sameOrigin));

                for (var i = 0; i < 60; i++) // up to ~15 s
                {
                    await Task.Delay(250);
                    var raw = await core.ExecuteScriptAsync("window.__wwResult");
                    if (raw is null or "null" or "undefined")
                        continue;

                    using var payload = JsonDocument.Parse(raw);
                    var root = payload.RootElement;
                    if (root.TryGetProperty("error", out var err))
                    {
                        Log.Warn($"browser fetch script error ({SafeUrl.Describe(url)}): {err.GetString()}");
                        return null;
                    }
                    if (root.TryGetProperty("tooLarge", out var big) && big.GetBoolean())
                    {
                        var size = root.TryGetProperty("size", out var sz) ? sz.GetInt64() : -1;
                        Log.Warn($"browser fetch refused ({SafeUrl.Describe(url)}): response exceeds " +
                                 $"{FetchLimits.EffectiveCap(maxBytes)} bytes (saw {size})");
                        return BrowserFetch.Refused(size);
                    }
                    var status = root.TryGetProperty("status", out var s) ? s.GetInt32() : 0;
                    var contentType = root.TryGetProperty("ct", out var c) ? c.GetString() : null;
                    var b64 = root.TryGetProperty("b64", out var b) ? b.GetString() ?? "" : "";
                    byte[] bodyBytes;
                    try { bodyBytes = Convert.FromBase64String(b64); }
                    catch (FormatException) { bodyBytes = Array.Empty<byte>(); }
                    // The allow-listed response headers the page collected (#169). This tier
                    // answers the same WW.fetch call the proxy tier does, so a widget has to
                    // be able to read the same metadata whichever one served it — and this is
                    // the tier that answers a bot wall's 403, where a Retry-After is most
                    // likely to be the only thing worth reading.
                    Dictionary<string, string>? headerMapOut = null;
                    if (root.TryGetProperty("headers", out var hs) && hs.ValueKind == JsonValueKind.Object)
                    {
                        headerMapOut = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
                        foreach (var h in hs.EnumerateObject())
                            if (h.Value.ValueKind == JsonValueKind.String)
                                headerMapOut[h.Name] = h.Value.GetString() ?? "";
                    }
                    return new BrowserFetch(status == 0 ? 200 : status, contentType, bodyBytes, false, headerMapOut);
                }
                Log.Warn($"browser fetch timed out ({SafeUrl.Describe(url)})");
                return null;
            }
            finally
            {
                core.NavigationCompleted -= OnCompleted;
                core.Navigate("about:blank");
            }
        }
        catch (Exception ex)
        {
            Log.Warn($"browser fetch failed ({SafeUrl.Describe(url)}): {ex.Message}");
            return null;
        }
        finally
        {
            _gate.Release();
        }
    }

    public void Dispose()
    {
        _webView.Dispose();
        _host.Dispose();
        _gate.Dispose();
    }
}
