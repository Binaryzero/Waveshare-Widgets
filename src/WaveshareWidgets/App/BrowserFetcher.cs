using System.Text.Json;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace WaveshareWidgets.App;

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
    /// JSON endpoint comes back as parseable JSON, not the browser's JSON viewer). Returns
    /// null on failure.
    /// </summary>
    public async Task<(int Status, string? ContentType, byte[] Body)?> FetchAsync(string url)
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

                // Kick off a same-origin fetch and stash its result on window; then poll.
                var jsUrl = JsonSerializer.Serialize(url); // safely quoted JS string literal
                await core.ExecuteScriptAsync($$"""
                    (() => {
                      window.__wwResult = null;
                      fetch({{jsUrl}}, { credentials: 'include', headers: { 'Accept': 'application/json,text/plain,*/*' } })
                        .then(r => r.text().then(t => {
                          window.__wwResult = { status: r.status, ct: r.headers.get('content-type') || '', body: t };
                        }))
                        .catch(e => { window.__wwResult = { status: 0, ct: '', body: '', error: String(e) }; });
                    })();
                    """);

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
                        Log.Warn($"browser fetch script error ({url}): {err.GetString()}");
                        return null;
                    }
                    var status = root.TryGetProperty("status", out var s) ? s.GetInt32() : 0;
                    var contentType = root.TryGetProperty("ct", out var c) ? c.GetString() : null;
                    var body = root.TryGetProperty("body", out var b) ? b.GetString() ?? "" : "";
                    return (status == 0 ? 200 : status, contentType, System.Text.Encoding.UTF8.GetBytes(body));
                }
                Log.Warn($"browser fetch timed out ({url})");
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
            Log.Warn($"browser fetch failed ({url}): {ex.Message}");
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
