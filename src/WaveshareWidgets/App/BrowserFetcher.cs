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
    private const string ExtractScript = """
        (() => {
          const ct = document.contentType || '';
          let body;
          if (ct.includes('json') || ct.includes('text/plain'))
            body = document.body ? document.body.innerText : '';
          else if (ct.includes('xml') && !ct.includes('html'))
            body = new XMLSerializer().serializeToString(document);
          else
            body = document.documentElement ? document.documentElement.outerHTML : '';
          return JSON.stringify({ ct, body });
        })()
        """;

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

    /// <summary>Fetches a URL through a real browser navigation. Returns null on failure.</summary>
    public async Task<(int Status, string? ContentType, byte[] Body)?> FetchAsync(string url)
    {
        await _gate.WaitAsync();
        try
        {
            await EnsureReadyAsync();
            var core = _webView.CoreWebView2;

            var navDone = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
            var status = 0;

            void OnResponse(object? sender, CoreWebView2WebResourceResponseReceivedEventArgs e)
            {
                if (status == 0 && string.Equals(e.Request.Uri, url, StringComparison.OrdinalIgnoreCase))
                    status = e.Response.StatusCode;
            }
            void OnCompleted(object? sender, CoreWebView2NavigationCompletedEventArgs e) =>
                navDone.TrySetResult(e.IsSuccess);

            core.WebResourceResponseReceived += OnResponse;
            core.NavigationCompleted += OnCompleted;
            try
            {
                core.Navigate(url);
                using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(20));
                await using var registration = timeout.Token.Register(() => navDone.TrySetCanceled());
                await navDone.Task;
                await Task.Delay(600); // let JS challenges / late redirects settle

                var extracted = await core.ExecuteScriptAsync(ExtractScript);
                var inner = JsonSerializer.Deserialize<string>(extracted) ?? "{}";
                using var payload = JsonDocument.Parse(inner);
                var body = payload.RootElement.TryGetProperty("body", out var b) ? b.GetString() ?? "" : "";
                var contentType = payload.RootElement.TryGetProperty("ct", out var c) ? c.GetString() : null;

                return (status == 0 ? 200 : status, contentType, System.Text.Encoding.UTF8.GetBytes(body));
            }
            finally
            {
                core.WebResourceResponseReceived -= OnResponse;
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
