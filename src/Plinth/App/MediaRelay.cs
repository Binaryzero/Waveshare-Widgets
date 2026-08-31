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
        //
        // Arming happens on the UI thread, so this IS the UI thread's id — kept so the
        // first read of a stream can say whether it arrived on that thread. Something
        // holds this thread for minutes at a time in the field and nothing in these logs
        // names it; a read landing here would. See the note on ConfigureAwait below.
        UiThreadId = Environment.CurrentManagedThreadId;
        Log.Info("media relay armed (all frames)");
        core.WebResourceRequested += async (_, e) =>
        {
            if (!e.Request.Uri.StartsWith($"https://{Host}/", StringComparison.OrdinalIgnoreCase))
                return;
            // The event arrives on the UI thread; the await hops off for the upstream
            // headers and the WinForms context brings the completion back, so the
            // deferral completes where WebView2 expects it. This lambda is async
            // void: ANY exception that escapes it is process death, so the deferral
            // calls are guarded too — both race view teardown.
            CoreWebView2Deferral deferral;
            try { deferral = e.GetDeferral(); }
            catch { return; }
            try
            {
                // BuildResponseAsync decides the response in plain managed terms and
                // deliberately touches NO WebView2 object, because it finishes on a
                // thread-pool thread (see the ConfigureAwait note there). This await
                // has no ConfigureAwait and so comes back to the UI thread, which is
                // where every WebView2 call below has to happen: creating the response
                // and assigning it are both calls into apartment-bound COM.
                var built = await BuildResponseAsync(e.Request);
                e.Response = core.Environment.CreateWebResourceResponse(
                    built.Body, built.Status, built.Reason, built.Headers);
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
                try { deferral.Complete(); }
                catch { /* already completed by teardown; nothing left to serve */ }
            }
        };
    }

    /// <summary>How much of an open-ended range is answered at once.
    ///
    /// A media element asks for "the rest of the file" — <c>Range: bytes=0-</c> — and a
    /// direct-play answer to that is the whole file. WebView2 then pulls it as fast as
    /// the LAN allows into a buffer nothing on this side bounds, and when the element
    /// cannot start (a container whose moov sits at the END has nothing to play until
    /// the index is found) nothing is consuming it either. The field log of a 9.6 GB
    /// title has one attempt reading 268 MB in three seconds at readyState 0, abandoned
    /// attempts holding 883 MB, 259 MB and 222 MB at once, and then the process simply
    /// stops — no exception, no line, gone.
    ///
    /// So an open-ended range is answered a window at a time. The 206 still carries the
    /// real total in its Content-Range, so the element knows the size and asks for the
    /// next window when it wants one — which is what every ordinary HTTP media server
    /// makes it do. Memory per stream becomes the window instead of the file, and an
    /// abandoned attempt strands 8 MiB rather than most of a gigabyte.
    ///
    /// A range the renderer already bounded is its own business and passes untouched.</summary>
    private const long RangeWindow = 8L * 1024 * 1024;

    private static string BoundRange(string range)
    {
        var text = range.Trim();
        if (!text.StartsWith("bytes=", StringComparison.OrdinalIgnoreCase)) return range;
        var spec = text[6..];
        // Multipart ranges are not ours to rewrite, and a suffix range ("-500", the last
        // 500 bytes) is already bounded by construction.
        if (spec.Contains(',')) return range;
        var dash = spec.IndexOf('-');
        if (dash <= 0 || dash != spec.Length - 1) return range;
        if (!long.TryParse(spec[..dash], out var start) || start < 0) return range;
        return $"bytes={start}-{start + RangeWindow - 1}";
    }

    /// <summary>The thread the relay was armed on, which is the UI thread. A read that
    /// arrives on it is the head-of-line stall this file is chasing; one that does not
    /// rules it out. Zero when arming has not run.</summary>
    private static int UiThreadId;

    private static string ReadThread()
    {
        var id = Environment.CurrentManagedThreadId;
        return id == UiThreadId ? $"thread {id} = UI" : $"thread {id}";
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

    /// <summary>The live body stream for each piece of media, keyed by the target
    /// URL without its query. A server-side seek asks for a NEW transcode of the same
    /// title at a different offset and the element simply drops the old response on
    /// the floor; nothing else can release it (WebView2 never disposes a managed
    /// content stream), so without this every seek strands an upstream socket — and
    /// the ffmpeg behind it — for the whole idle window. A fresh stream for the same
    /// media therefore retires the one it replaces, immediately rather than in
    /// fifteen minutes.
    ///
    /// The key is the PATH, so a new position still matches the stream it supersedes.
    /// Two widgets playing the same title in the same instant would collide on it,
    /// and the loser takes a truncation its fallback chain recovers from, carrying
    /// its position — much the cheaper mistake than leaking a transcode per tap.</summary>
    private static readonly System.Collections.Concurrent.ConcurrentDictionary<string, GuardedStream> Live = new();

    /// <summary>The same thing for the widget's diagnostic probes, deliberately a
    /// SEPARATE registry rather than an exemption from the one above.
    ///
    /// A probe must not retire the element's stream — that is the bug this pair exists
    /// to fix, and sharing a registry is what caused it. But letting probes register
    /// nowhere, as the first attempt did, hands the marker a capability: probe=1 is a
    /// field any widget can append (WW.mediaUrl is public and the relay token reaches
    /// every slot), so an unbounded number of streams for one title could be held open
    /// at once by simply setting it. Their own registry gives them the same
    /// one-per-title ceiling playback has, and the marker now only chooses WHICH
    /// registry a request lands in — never whether it is bounded at all.</summary>
    private static readonly System.Collections.Concurrent.ConcurrentDictionary<string, GuardedStream> LiveProbes = new();

    /// <summary>Publish <paramref name="fresh"/> as the live stream for its media,
    /// retiring whatever it displaces.
    ///
    /// The swap is a compare-and-set loop and has to be. Until this file moved its
    /// continuations off the UI thread, two of these could not overlap and a
    /// read-then-write was atomic by accident; now they run on pool threads, and a
    /// plain TryGetValue followed by an assignment lets two arrivals both see the same
    /// prior, both dispose it, and then one silently overwrite the other's entry —
    /// stranding a LIVE stream that nothing holds a reference to and nothing will ever
    /// supersede, until its idle clock finds it minutes later. TryUpdate against the
    /// exact value observed makes the displacement and the write one step, so every
    /// stream is either in the registry or is the one being retired.</summary>
    private static void Supersede(
        System.Collections.Concurrent.ConcurrentDictionary<string, GuardedStream> registry,
        Uri target, GuardedStream fresh)
    {
        var key = target.GetLeftPart(UriPartial.Path);
        fresh.Key = key;
        fresh.Registry = registry;
        while (true)
        {
            if (registry.TryGetValue(key, out var prior))
            {
                if (ReferenceEquals(prior, fresh)) return;
                // Lost the race to another arrival: re-read and try again rather than
                // clobbering whatever it just published.
                if (!registry.TryUpdate(key, fresh, prior)) continue;
                Retire(prior);
                return;
            }
            if (registry.TryAdd(key, fresh)) return;
        }
    }

    private static void Retire(GuardedStream prior)
    {
        if (WebViewEnvironment.DiagnosticsBudget())
            Log.Info("media relay retiring an earlier stream of the same media");
        // OFF this thread: tearing a socket down inside the WebResourceRequested
        // continuation is the shape of mistake that has already cost this file one
        // field crash. The registry entry is removed by (key, value), so a doomed
        // stream can never take its successor out with it.
        System.Threading.Tasks.Task.Run(() => { try { prior.Dispose(); } catch { } });
    }

    // Every relay response — refusals included — carries this header. The video
    // element's no-cors request ignores it; the widget's diagnostic probe is an
    // ordinary cross-origin fetch, and without it Chromium reports TypeError for a
    // response the relay DID produce, making a working interceptor indistinguishable
    // from a dead one (which is precisely the question the probe exists to answer).
    // Statuses and media bytes are not secrets to the pages this WebView runs.
    private const string CorsHeader = "Access-Control-Allow-Origin: *\n";

    /// <summary>A response the relay has decided on, in plain managed terms.
    ///
    /// WebView2's own objects are apartment-bound: the environment, the request and the
    /// response all belong to the UI thread that created them, and a call from anywhere
    /// else is a wrong-thread failure rather than a slow one. The decision is therefore
    /// made off that thread and handed back as this — the handler, which resumes on the
    /// UI thread, is the only place a WebView2 object is built.</summary>
    private readonly record struct Relayed(int Status, string Reason, string Headers, Stream? Body);

    /// <summary>A logged refusal: the reason names the failed check (never the URL —
    /// the api_key rides its query; a bare authority is safe and is the useful bit).
    /// Logging rides the shared diagnostics budget: refusals are reachable from any
    /// page in the WebView, and a looping frame must not churn the rolling log.</summary>
    private static Relayed Refuse(int status, string reason)
    {
        if (WebViewEnvironment.DiagnosticsBudget())
            Log.Info($"media relay refused ({status}): {reason}");
        return new Relayed(status, status == 405 ? "Method Not Allowed" : "Forbidden", CorsHeader, null);
    }

    private static async Task<Relayed> BuildResponseAsync(CoreWebView2WebResourceRequest request)
    {
        // Read off the request BEFORE the await and never after: it is a WebView2
        // object, so the thread-pool thread this method finishes on has no business
        // touching it. Everything this method needs from the renderer is taken here.
        var method = request.Method;
        if (method != "GET" && method != "HEAD")
            return Refuse(405, "method " + method);
        var outer = new Uri(request.Uri);
        // The token gate comes first: a request from outside the widget channel is
        // refused before any of its claims about a target are even parsed.
        if (QueryValue(outer, "t") != Token)
            return Refuse(403, "missing or wrong relay token");
        if (!Uri.TryCreate(QueryValue(outer, "u"), UriKind.Absolute, out var target)
            || (target.Scheme != Uri.UriSchemeHttp && target.Scheme != Uri.UriSchemeHttps))
            return Refuse(403, "no parseable http(s) target");
        if (!DashboardWindow.IsPrivateHost(target))
            return Refuse(403, "not a private address: " + target.Host);
        if (!AllowedAuthorities.ContainsKey(target.Scheme + "://" + target.Authority))
            return Refuse(403, "authority not registered: " + target.Scheme + "://" + target.Authority);

        var upstream = new HttpRequestMessage(new HttpMethod(method), target);
        // Range is what makes a <video> seekable on a direct-played file; everything
        // else about the renderer's request is noise the upstream doesn't need. It is
        // BOUNDED on the way out — see RangeWindow.
        var range = TryGetHeader(request, "Range");
        // Held rather than inlined: the disposition line reports the range that went
        // OUT, and a window the relay narrowed silently is exactly what the last field
        // log could not distinguish from one the element asked for.
        var sentRange = range is null ? null : BoundRange(range);
        if (sentRange is not null)
            upstream.Headers.TryAddWithoutValidation("Range", sentRange);

        var client = QueryValue(outer, "insecure") == "1" ? ClientInsecure : Client;
        // The HEADER phase gets a finite deadline: an upstream that accepts the
        // connection and then stalls (a hung transcode) would otherwise pin this
        // await, the deferral, and the connection forever — the widget's watchdog
        // can replace pv.src but cannot cancel a host call. The timer dies with the
        // `using` when headers arrive in time, so it never touches the body stream,
        // which must be free to take hours.
        // The `using` is load-bearing in the opposite direction to what it looks like:
        // disposing the source DISARMS its 20-second timer, and the .NET 8 handler has
        // already dropped the token's registration by the time the content stream
        // exists — so a two-hour body streams on safely underneath. Handing the source
        // to the stream instead (as one round of this bug did) leaves the timer armed
        // to cancel live playback at T+20s, which is worse than anything it prevents.
        using var headerDeadline = new CancellationTokenSource(TimeSpan.FromSeconds(20));
        // NOT disposed here: the response object owns the connection the content
        // stream reads from, and WebView2 pulls that stream long after this method
        // returns. What releases the connection is GuardedStream's own idle timer
        // below — NOT WebView2, which never disposes a managed content stream (see
        // the note on `_idle`). This comment said the opposite for several rounds
        // and cost a misdiagnosis: a missing "stream closed" line was read as proof
        // WebView2 had not used the stream, when that line could never have fired.
        // ConfigureAwait(false) from here on, and what it does and does not buy is worth
        // being exact about, because the first draft of this comment overclaimed.
        //
        // It does NOT make relay requests parallel: they always were, since an await
        // occupies no thread. What it moves off the UI thread is every CONTINUATION —
        // the header copy, the stream construction, the supersede, the logging — which
        // otherwise all queue on that one thread behind whatever else it is doing. The
        // field says that queue matters: a relay-fetch HEAD, which builds no stream at
        // all (body is null for HEAD, so no GuardedStream, no window, no registration,
        // nothing that can block), was answered host-side at once and still took 189
        // seconds to reach the renderer; five of eight attempts never saw it. A request
        // issued and never answered is exactly readyState 0 with networkState 2 — the
        // `rs=0 ns=2` in every one of these logs. Whatever is holding that thread, less
        // of this work should be waiting behind it.
        //
        // What IS holding it is not established, and one tempting answer looks wrong on
        // inspection: that WebView2's synchronous Read() on a GuardedStream is marshalled
        // onto the UI apartment because the stream was built there. The CLR makes managed
        // objects handed to COM apartment-agile, so the thread a stream was constructed on
        // should not decide the thread it is read on. Rather than argue it, Announce now
        // names the thread of the first read and whether it is the one the relay armed on.
        // The next log answers it in one line.
        //
        // The bargain this strikes with WebView2: NOTHING below touches a WebView2 object
        // — not the request (its fields were read above), not the environment. This method
        // returns a plain decision and the handler, which resumes on the UI thread, builds
        // the response there. Those objects are apartment-bound, and calling one from the
        // pool is a wrong-thread failure, not a slow one.
        var response = await client.SendAsync(upstream, HttpCompletionOption.ResponseHeadersRead,
            headerDeadline.Token).ConfigureAwait(false);

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

        var isProbe = QueryValue(outer, "probe") == "1";
        var body = method == "HEAD" ? null
            : new GuardedStream(await response.Content.ReadAsStreamAsync().ConfigureAwait(false),
                response.Content.Headers.ContentLength, isProbe);
        // A HEAD carries no stream and so supersedes nothing — the pre-flight probes
        // this widget fires must never retire the stream that is actually playing.
        //
        // Neither must the widget's OTHER probe. Its body fetch asks the relay for a
        // 64 KiB window of the media the element is ALREADY playing, and the registry
        // is keyed on the path — so the probe reads as a fresh stream of the same title
        // and retires the element's live one, truncating the playback it was sent to
        // diagnose. In the field that was nine of every ten retirements. So the widget
        // marks that request probe=1 and it goes in a registry of its own: bounded the
        // same way, one live stream per title, but unable to reach the element's.
        // It also gets a much shorter clock (ProbeMs), because a probe against a
        // transcode — which answers 200, ignores the window, and has its body cancelled
        // unread — would otherwise hold an ffmpeg and a socket for the full read window.
        if (body is not null)
            Supersede(isProbe ? LiveProbes : Live, target, body);
        // What this line has to answer, which the field logs could not: WHICH request
        // (method, and whether it is a probe or the element), what window went out
        // after BoundRange narrowed it, and what came back — a 200 where a 206 was
        // asked for is the transcode ignoring the range, and the byte counts say
        // whether the window was honoured. None of it carries the api_key: Describe
        // yields host:port, and the ranges and lengths are the relay's own numbers.
        if (WebViewEnvironment.DiagnosticsBudget())
            Log.Info($"media relay {method}{(isProbe ? " probe" : "")} "
                + $"{SafeUrl.Describe(target)} -> {(int)response.StatusCode}"
                + (range is null ? "" : $" asked {range} sent {sentRange}")
                + (response.Content.Headers.ContentRange is null ? "" : $" got {response.Content.Headers.ContentRange}")
                + (response.Content.Headers.ContentLength is null ? "" : $" len {response.Content.Headers.ContentLength}"));
        return new Relayed((int)response.StatusCode, response.ReasonPhrase ?? "", headers.ToString(), body);
    }

    private static string? TryGetHeader(CoreWebView2WebResourceRequest request, string name)
    {
        try { return request.Headers.Contains(name) ? request.Headers.GetHeader(name) : null; }
        catch { return null; }
    }

    /// <summary>
    /// The upstream socket stream, made unable to throw. WebView2 pulls the response
    /// body through a COM IStream on a non-UI thread, and an exception escaping that
    /// callback is PROCESS DEATH, not a failed request — a mid-movie connection reset
    /// (a transcode the server killed, a Wi-Fi blip, the element abandoning a stream
    /// as it seeks) was taking the whole dashboard down with it. Every failure mode
    /// becomes EOF instead, and the app stays up. What the ELEMENT makes of that EOF
    /// depends on the response: with a declared Content-Length the truncation
    /// contradicts it and the element raises its own media error; a chunked response
    /// (a live transcode) genuinely cannot be told apart from a normal end at this
    /// layer, which is why the Jellyfin widget checks 'ended' against the item's own
    /// runtime before treating it as a finish. Disposal (which WebView2 also drives,
    /// racing the element) is swallowed the same way.
    /// </summary>
    private sealed class GuardedStream : Stream
    {
        private readonly Stream _inner;
        private readonly long? _length;
        private bool _faulted;
        private bool _announced;
        private bool _released;
        private long _served;
        private long _milestone = 64 * 1024;
        private long _lastRead = Environment.TickCount64;
        private readonly long _born = Environment.TickCount64;
        private readonly System.Threading.Timer _idle;

        // The registry this stream is published in and the key it is published under,
        // so releasing it — by supersession, by the idle timer, however — takes it back
        // out and no registry ever names a dead stream. Two registries exist (playback
        // and probes), so the stream has to carry which one is its own.
        internal string? Key;
        internal System.Collections.Concurrent.ConcurrentDictionary<string, GuardedStream>? Registry;

        // Nothing else ever closes this. WebView2 does not dispose a managed content
        // stream (a tracked defect of its own), so an abandoned response — a playback
        // attempt the watchdog gave up on, a diagnostic probe that read its window and
        // cancelled — would hold the upstream socket, and with it a live ffmpeg
        // transcode, until the process exits. One per failed attempt adds up on the
        // server long before it does here. So a stream releases ITSELF once nobody has
        // read it for long enough.
        //
        // "Long enough" has to tell an abandoned stream from a PAUSED one, because a
        // paused element deliberately stops reading while its source stays perfectly
        // valid, and closing that upstream turns the next read into a truncated
        // response — a media error, not a polite re-request. So the two cases get very
        // different clocks: a stream that never delivered a byte is dead beyond
        // argument and goes in two minutes, while one that was feeding a real element
        // gets fifteen, past any plausible pause. Even that worst case self-heals:
        // truncation walks the widget's fallback chain, which carries the position, so
        // an unusually long pause costs a reload from the same spot rather than the
        // playback.
        //
        // A PROBE gets neither clock. It is the widget's own diagnostic read: a bounded
        // 64 KiB window it cancels the moment it has counted, with no element behind it
        // that could pause and come back. It is also the one stream deliberately left out
        // of the supersede registry (see BuildResponseAsync), so nothing else will ever
        // collect it — and against a transcode, which ignores the window and answers 200,
        // "nothing else" means an ffmpeg process and a socket held for as long as the
        // clock says. Thirty seconds is far past any honest 64 KiB read and far short of
        // leaving that running.
        private const int DeadMs = 120_000;
        private const int IdleMs = 900_000;
        private const int ProbeMs = 30_000;

        private readonly bool _probe;

        public GuardedStream(Stream inner, long? length, bool probe = false)
        {
            _inner = inner;
            _length = length;
            _probe = probe;
            var tick = probe ? ProbeMs : DeadMs;
            _idle = new System.Threading.Timer(_ => IdleCheck(), null, tick, tick);
        }

        private void IdleCheck()
        {
            if (_released) return;
            var quiet = Environment.TickCount64 - Interlocked.Read(ref _lastRead);
            if (quiet < (_probe ? ProbeMs : _served == 0 ? DeadMs : IdleMs)) return;
            if (WebViewEnvironment.DiagnosticsBudget())
                Log.Info($"media relay stream idle {quiet / 1000}s after {_served} bytes"
                    + " — releasing the upstream");
            Dispose();
        }

        // These answers match what the RAW response stream returned in the build that
        // played — deliberately, because that object graph is the only one the field
        // has ever confirmed working. The one improvement: when the upstream declared
        // a Content-Length we hand it over instead of throwing, so a caller that asks
        // for the size gets a real answer rather than an exception crossing COM.
        public override bool CanRead => true;
        public override bool CanSeek => false;
        public override bool CanWrite => false;
        public override long Length => _length ?? throw new NotSupportedException();
        public override long Position
        {
            get => _served;
            set => throw new NotSupportedException();
        }
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
        // A no-op, NOT a delegation: HttpBaseStream.Flush() is sync-over-async, so
        // forwarding it puts a blocking wait — and anything it throws — on whatever
        // thread WebView2 calls from. A read stream has nothing to flush anyway.
        public override void Flush() { }

        private void Announce(string what)
        {
            if (_announced) return;
            _announced = true;
            if (WebViewEnvironment.DiagnosticsBudget())
                Log.Info($"media relay stream {what} [{ReadThread()}]");
        }

        /// <summary>The first read told us WebView2 pulls at all; these tell us whether it
        /// keeps pulling. A stream that stops at a few KB and one that streams megabytes
        /// look identical without them, and they are opposite bugs. Doubling thresholds
        /// keep a two-hour movie to a couple of dozen lines.</summary>
        private void Progress()
        {
            if (_served < _milestone) return;
            while (_milestone <= _served) _milestone *= 8;
            if (WebViewEnvironment.DiagnosticsBudget())
                Log.Info($"media relay stream served {_served} bytes"
                    + (_length is long total ? $" of {total}" : ""));
        }

        private int NoteFault(Exception ex)
        {
            if (!_faulted)
            {
                _faulted = true;
                // Type only: exception messages can echo the target URL, and the
                // api_key rides that URL's query.
                if (WebViewEnvironment.DiagnosticsBudget())
                    Log.Warn($"media relay stream ended early after {_served} bytes: {ex.GetType().Name}");
            }
            return 0;
        }

        public override int Read(byte[] buffer, int offset, int count)
        {
            if (_faulted) return 0;
            try
            {
                var n = _inner.Read(buffer, offset, count);
                _served += n;
                Interlocked.Exchange(ref _lastRead, Environment.TickCount64);
                Progress();
                Announce($"reading (sync, first {n} bytes)");
                return n;
            }
            catch (Exception ex) { return NoteFault(ex); }
        }

        // ConfigureAwait(false) is load-bearing, not hygiene: this is a WinForms app,
        // the WebResourceRequested handler awaits on the UI context, and an async
        // continuation captured onto that context deadlocks the moment anything
        // blocks on the returned task. The raw HttpClient stream never captured a
        // context; neither may its wrapper.
        public override async Task<int> ReadAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken)
        {
            if (_faulted) return 0;
            try
            {
                var n = await _inner.ReadAsync(buffer.AsMemory(offset, count), cancellationToken).ConfigureAwait(false);
                _served += n;
                Interlocked.Exchange(ref _lastRead, Environment.TickCount64);
                Progress();
                Announce($"reading (async, first {n} bytes)");
                return n;
            }
            catch (Exception ex) { return NoteFault(ex); }
        }

        public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
        {
            if (_faulted) return 0;
            try
            {
                var n = await _inner.ReadAsync(buffer, cancellationToken).ConfigureAwait(false);
                _served += n;
                Interlocked.Exchange(ref _lastRead, Environment.TickCount64);
                Progress();
                Announce($"reading (async, first {n} bytes)");
                return n;
            }
            catch (Exception ex) { return NoteFault(ex); }
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing && !_released)
            {
                _released = true;
                _idle.Dispose();
                if (Key is not null && Registry is not null)
                    Registry.TryRemove(new KeyValuePair<string, GuardedStream>(Key, this));
                // How far this stream got separates the failure modes: never announced
                // means WebView2 never pulled a byte; a few KB means the head arrived
                // and never parsed; megabytes means playback and an ordinary stop.
                //
                // The AGE separates them further, and the field logs could not: a
                // never-read stream gone in a second was taken by a supersede, while one
                // that lasted two minutes aged out on DeadMs — the first means something
                // retired it, the second that WebView2 genuinely never came for it. Both
                // printed the same line before.
                if (WebViewEnvironment.DiagnosticsBudget())
                    Log.Info($"media relay{(_probe ? " probe" : "")} stream closed after {_served} bytes"
                        + $" in {(Environment.TickCount64 - _born) / 1000}s"
                        + (_faulted ? " (faulted)" : _announced ? "" : " (never read)"));
                try { _inner.Dispose(); }
                catch { /* the connection is gone either way */ }
            }
            base.Dispose(disposing);
        }
    }
}
