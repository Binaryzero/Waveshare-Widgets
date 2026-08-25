using System.Net.Http;
using Microsoft.Web.WebView2.Core;

namespace Plinth.App;

/// <summary>
/// Streams LAN media to the renderer from inside the host. Four field rounds died on
/// renderer network gates killing a widget's &lt;video&gt; request before a byte left
/// (mixed-content autoupgrade, mixed-content blocking, Local Network Access by flag,
/// then by permission grant — each falsified in turn, same rs=0 ns=3 corpse every
/// time, while the same URL answered HTTP 200 video/mp4 through the host proxy). The
/// relay retires the CLASS instead of the next instance: the element asks for
/// https://stream.plinth/v?u=&lt;target&gt;, WebResourceRequested intercepts before
/// the renderer's network stack enters the story, and the host streams the upstream
/// response back — Range and all. A virtual-host response has no address space to
/// classify, no scheme to mix, and no certificate the renderer ever sees — which is
/// also what let every renderer-gate flag and the browser-layer certificate
/// machinery come OUT of this app again.
///
/// Reachability is deliberately narrow. A relay is an SSRF amplifier if any page in
/// the WebView can aim it (the embed widgets frame real internet sites), so a target
/// must be BOTH private (loopback or literal RFC1918/link-local IPv4 — the proxy's
/// own policy) AND an authority some widget has already reached through the host
/// proxy this run. Foreign pages have no path to the proxy — the shell refuses their
/// origins — so they cannot mint entries; and because the per-run <see cref="Token"/>
/// gates every request, they cannot replay a widget's requests either.
///
/// TLS policy is PER REQUEST, not per authority: the widget instance that builds the
/// relay URL appends insecure=1 exactly when its own certificate setting says allow
/// self-signed, so two instances sharing one server with different settings never
/// inherit each other's policy. A foreign page passing insecure=1 gains only what
/// the un-credentialed LAN already has: the validation skip applies to the relay's
/// own connection, and no credential travels unless the page already holds one.
/// </summary>
internal static class MediaRelay
{
    public const string Host = "stream.plinth";

    /// <summary>
    /// The per-run relay credential. Every relay request must carry it (t=), and it
    /// travels ONE path: the dashboard init payload → the shell → each verified
    /// widget document (the shell answers ww-init only to a slot frame whose
    /// WindowProxy identity AND origin both check out — a channel descendant foreign
    /// frames structurally cannot reach). That closes the review's replay concern:
    /// an embedded internet page inside an Embed/YouTube/Twitch widget can name
    /// stream.plinth but cannot present the token, so it gets 403 before any target
    /// checks run. The settings editor channel is credential-free by design (secrets
    /// are masked in its init), so the replica never receives the token — its widgets
    /// run on masked settings and could not play media regardless.
    /// </summary>
    internal static readonly string Token = Guid.NewGuid().ToString("N");

    private static readonly System.Collections.Concurrent.ConcurrentDictionary<string, byte> AllowedAuthorities =
        new(StringComparer.OrdinalIgnoreCase);

    // Infinite timeout on both: a movie is ONE response, and a client-level timeout
    // (the proxy's is 15 s) would cancel the body mid-stream right when playback is
    // going well. (The header phase gets its own deadline per request below.) Not
    // shared with the proxy's clients either — the insecure proxy client serializes
    // one connection per device for embedded-TLS IoT bridges, and a two-hour stream
    // on that one connection would starve every API poll behind it.
    //
    // Redirects are NOT followed: the target was validated as a private, allow-listed
    // authority, and an auto-followed Location from an open redirect on that server
    // would carry the relay to an authority nothing validated. A media endpoint that
    // redirects fails honestly instead.
    private static readonly HttpClient Client = new(new SocketsHttpHandler
    {
        AllowAutoRedirect = false,
    })
    { Timeout = Timeout.InfiniteTimeSpan };

    // Validation-off variant for insecure=1 requests (self-signed LAN servers).
    private static readonly HttpClient ClientInsecure = new(new SocketsHttpHandler
    {
        AllowAutoRedirect = false,
        SslOptions = new System.Net.Security.SslClientAuthenticationOptions
        {
            RemoteCertificateValidationCallback = (_, _, _, _) => true,
        },
    })
    { Timeout = Timeout.InfiniteTimeSpan };

    /// <summary>Record an authority a widget reached through the host proxy. Private
    /// hosts only — the caller gates on <see cref="DashboardWindow.IsPrivateHost"/>.</summary>
    public static void AllowHost(Uri uri) =>
        AllowedAuthorities.TryAdd(uri.Scheme + "://" + uri.Authority, 0);

    /// <summary>Intercept https://stream.plinth/* on this WebView and serve it from
    /// the host's own HTTP clients.</summary>
    public static void Attach(CoreWebView2 core)
    {
        // NOT the deprecated two-argument filter: the field proved it top-document-
        // scoped — armed, and yet NOTHING from the widget iframes (not their <video>
        // requests, not their fetches) ever reached the handler (ci.1186: zero
        // dispositions while the widget's relay probe threw TypeError). Widgets live
        // in cross-origin iframes; the explicit source-kinds overload covers every
        // requester, workers included.
        core.AddWebResourceRequestedFilter($"https://{Host}/*",
            CoreWebView2WebResourceContext.All, CoreWebView2WebResourceRequestSourceKinds.All);
        // The field taught this the hard way: a relay that refuses silently is
        // indistinguishable from a relay that never ran. Announce arming, and log
        // every disposition below.
        Log.Info("media relay armed (all frames)");
        core.WebResourceRequested += async (_, e) =>
        {
            if (!e.Request.Uri.StartsWith($"https://{Host}/", StringComparison.OrdinalIgnoreCase))
                return;
            // The event arrives on the UI thread; the await hops off for the upstream
            // headers and the WinForms context brings the completion back, so the
            // deferral completes where WebView2 expects it.
            var deferral = e.GetDeferral();
            try
            {
                e.Response = await BuildResponseAsync(core.Environment, e.Request);
            }
            catch (Exception ex)
            {
                // Type only: exception messages can echo the target URL, and the
                // api_key rides that URL's query. Budgeted like every other
                // disposition — a dead upstream hit concurrently must not churn
                // the rolling log either.
                if (WebViewEnvironment.DiagnosticsBudget())
                    Log.Warn($"media relay failed: {ex.GetType().Name}");
                // CORS here too: a 502 the probe reads as HTTP 502 is diagnosis; a
                // 502 it reads as TypeError is the exact ambiguity the header kills.
                try { e.Response = core.Environment.CreateWebResourceResponse(null, 502, "Bad Gateway", CorsHeader); }
                catch { /* teardown race; the request dies with the view */ }
            }
            finally
            {
                deferral.Complete();
            }
        };
    }

    /// <summary>Query values from the relay URL, parsed by hand: the target URL is a
    /// full encodeURIComponent blob and the only fields are ours.</summary>
    private static string? QueryValue(Uri outer, string name)
    {
        foreach (var pair in outer.Query.TrimStart('?').Split('&'))
            if (pair.StartsWith(name + "=", StringComparison.Ordinal))
                return Uri.UnescapeDataString(pair[(name.Length + 1)..]);
        return null;
    }

    // Every relay response — refusals included — carries this header. The video
    // element's no-cors request ignores it; the widget's diagnostic probe is an
    // ordinary cross-origin fetch, and without it Chromium reports TypeError for a
    // response the relay DID produce, making a working interceptor indistinguishable
    // from a dead one (which is precisely the question the probe exists to answer).
    // Statuses and media bytes are not secrets to the pages this WebView runs.
    private const string CorsHeader = "Access-Control-Allow-Origin: *\n";

    /// <summary>A logged refusal: the reason names the failed check (never the URL —
    /// the api_key rides its query; a bare authority is safe and is the useful bit).
    /// Logging rides the shared diagnostics budget: refusals are reachable from any
    /// page in the WebView, and a looping frame must not churn the rolling log.</summary>
    private static CoreWebView2WebResourceResponse Refuse(CoreWebView2Environment env, int status, string reason)
    {
        if (WebViewEnvironment.DiagnosticsBudget())
            Log.Info($"media relay refused ({status}): {reason}");
        return env.CreateWebResourceResponse(null, status, status == 405 ? "Method Not Allowed" : "Forbidden", CorsHeader);
    }

    private static async Task<CoreWebView2WebResourceResponse> BuildResponseAsync(
        CoreWebView2Environment env, CoreWebView2WebResourceRequest request)
    {
        if (request.Method != "GET" && request.Method != "HEAD")
            return Refuse(env, 405, "method " + request.Method);
        var outer = new Uri(request.Uri);
        // The token gate comes first: a request from outside the widget channel is
        // refused before any of its claims about a target are even parsed.
        if (QueryValue(outer, "t") != Token)
            return Refuse(env, 403, "missing or wrong relay token");
        if (!Uri.TryCreate(QueryValue(outer, "u"), UriKind.Absolute, out var target)
            || (target.Scheme != Uri.UriSchemeHttp && target.Scheme != Uri.UriSchemeHttps))
            return Refuse(env, 403, "no parseable http(s) target");
        if (!DashboardWindow.IsPrivateHost(target))
            return Refuse(env, 403, "not a private address: " + target.Host);
        if (!AllowedAuthorities.ContainsKey(target.Scheme + "://" + target.Authority))
            return Refuse(env, 403, "authority not registered: " + target.Scheme + "://" + target.Authority);

        var upstream = new HttpRequestMessage(new HttpMethod(request.Method), target);
        // Range is what makes a <video> seekable on a direct-played file; everything
        // else about the renderer's request is noise the upstream doesn't need.
        var range = TryGetHeader(request, "Range");
        if (range is not null)
            upstream.Headers.TryAddWithoutValidation("Range", range);

        var client = QueryValue(outer, "insecure") == "1" ? ClientInsecure : Client;
        // The HEADER phase gets a finite deadline: an upstream that accepts the
        // connection and then stalls (a hung transcode) would otherwise pin this
        // await, the deferral, and the connection forever — the widget's watchdog
        // can replace pv.src but cannot cancel a host call. The timer dies with the
        // `using` when headers arrive in time, so it never touches the body stream,
        // which must be free to take hours.
        using var headerDeadline = new CancellationTokenSource(TimeSpan.FromSeconds(20));
        // NOT disposed here: the response object owns the connection the content
        // stream reads from, and WebView2 pulls that stream long after this method
        // returns. WebView2 closes the stream when the element is done (or gone),
        // which releases the connection.
        var response = await client.SendAsync(upstream, HttpCompletionOption.ResponseHeadersRead, headerDeadline.Token);

        var headers = new System.Text.StringBuilder(CorsHeader);
        void Copy(string name, string? value)
        {
            if (!string.IsNullOrEmpty(value))
                headers.Append(name).Append(": ").Append(value).Append('\n');
        }
        Copy("Content-Type", response.Content.Headers.ContentType?.ToString());
        Copy("Content-Length", response.Content.Headers.ContentLength?.ToString());
        Copy("Content-Range", response.Content.Headers.ContentRange?.ToString());
        Copy("Accept-Ranges", response.Headers.AcceptRanges.Count > 0 ? string.Join(", ", response.Headers.AcceptRanges) : null);

        var body = request.Method == "HEAD" ? null : await response.Content.ReadAsStreamAsync();
        if (WebViewEnvironment.DiagnosticsBudget())
            Log.Info($"media relay {SafeUrl.Describe(target)} -> {(int)response.StatusCode}"
                + (range is null ? "" : " (ranged)"));
        return env.CreateWebResourceResponse(body, (int)response.StatusCode, response.ReasonPhrase ?? "", headers.ToString());
    }

    private static string? TryGetHeader(CoreWebView2WebResourceRequest request, string name)
    {
        try { return request.Headers.Contains(name) ? request.Headers.GetHeader(name) : null; }
        catch { return null; }
    }
}
