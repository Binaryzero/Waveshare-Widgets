// LAN proxy redirects (issue #303).
//
// The proxy's LAN client accepts every certificate, which is safe only while the peer is
// on the private network. Its handler checked that for the FIRST URL, then followed a
// device's redirect wherever it pointed with checks still off. PrivateNetwork.SendAsync
// now follows redirects itself and checks every hop.
//
// L1-L4   hops that stay private are followed; a hop off the network is not, at any depth
// L5      the chain is bounded
// L6-L7   the rest matches HttpClient: method rewriting, Authorization dropped
// L8-L9   what is not a followable redirect comes back as it is
// L10     one deadline covers the whole chain
// L11     the private-host policy itself
// L12     the wiring: the handler no longer follows redirects before this code sees them
using System.Net;
using System.Text;
using Plinth;

var failures = 0;
void Check(string name, bool ok, string? detail = null)
{
    Console.WriteLine($"  {(ok ? "PASS" : "FAIL")} {name}{(detail is null ? "" : " - " + detail)}");
    if (!ok) failures++;
}

var deadline = TimeSpan.FromSeconds(15);

// ---- L1-L4: the per-hop gate --------------------------------------------------------

{
    var net = new StubNet()
        .Redirect("http://192.168.1.20/api", 302, "https://192.168.1.20/api")
        .Ok("https://192.168.1.20/api");
    var o = await PrivateNetwork.SendAsync(Get("http://192.168.1.20/api"), net.Send, deadline);
    Check("L1 a redirect that stays on the private network is followed",
        o.Response.StatusCode == HttpStatusCode.OK && o.Stopped is null && net.Urls == "http://192.168.1.20/api https://192.168.1.20/api",
        net.Urls);
}

{
    var net = new StubNet()
        .Redirect("http://10.0.0.5/app/start", 301, "../login?next=1")
        .Ok("http://10.0.0.5/login?next=1");
    var o = await PrivateNetwork.SendAsync(Get("http://10.0.0.5/app/start"), net.Send, deadline);
    Check("L2 a relative Location resolves against the hop that sent it",
        o.Response.StatusCode == HttpStatusCode.OK && net.Urls.EndsWith("http://10.0.0.5/login?next=1"), net.Urls);
}

{
    var net = new StubNet()
        .Redirect("https://192.168.1.20/api", 302, "https://example.com/api");
    var o = await PrivateNetwork.SendAsync(Get("https://192.168.1.20/api"), net.Send, deadline);
    Check("L3 a redirect to an internet host is not followed: the 302 is the answer",
        o.Response.StatusCode == HttpStatusCode.Found && o.Stopped is not null && net.Count == 1,
        $"status={(int)o.Response.StatusCode} sent={net.Urls} stopped={o.Stopped}");
}

{
    // A name is never private, whatever it resolves to: the policy does no DNS, and a
    // name a device chose is exactly what an attacker on the path controls.
    var net = new StubNet()
        .Redirect("https://192.168.1.20/api", 307, "https://nas.local/api");
    var o = await PrivateNetwork.SendAsync(Get("https://192.168.1.20/api"), net.Send, deadline);
    Check("L3b ...nor one to a host NAME, even a .local one",
        o.Response.StatusCode == HttpStatusCode.TemporaryRedirect && net.Count == 1, net.Urls);
}

{
    // The finding: the gate was applied once. It must be applied at EVERY hop, so a
    // chain that leaves the network on its second redirect stops there.
    var net = new StubNet()
        .Redirect("http://192.168.1.20/", 302, "https://192.168.1.20/")
        .Redirect("https://192.168.1.20/", 302, "https://203.0.113.9/");
    var o = await PrivateNetwork.SendAsync(Get("http://192.168.1.20/"), net.Send, deadline);
    Check("L4 a chain that leaves the network on a LATER hop stops at that hop",
        o.Response.StatusCode == HttpStatusCode.Found && o.Stopped is not null
            && net.Urls == "http://192.168.1.20/ https://192.168.1.20/",
        net.Urls);
}

// ---- L5: bounded --------------------------------------------------------------------

{
    var net = new StubNet()
        .Redirect("http://10.0.0.5/a", 302, "http://10.0.0.5/b")
        .Redirect("http://10.0.0.5/b", 302, "http://10.0.0.5/a");
    var o = await PrivateNetwork.SendAsync(Get("http://10.0.0.5/a"), net.Send, deadline);
    Check($"L5 a redirect loop stops after {PrivateNetwork.MaxRedirects} redirects and hands back the last 3xx",
        o.Response.StatusCode == HttpStatusCode.Found && o.Stopped is not null && net.Count == PrivateNetwork.MaxRedirects + 1,
        $"sent {net.Count}");
}

// ---- L6-L7: HttpClient's own rules --------------------------------------------------

async Task<StubNet.Seen> Second(string method, int status, string? body = "{\"on\":true}")
{
    var net = new StubNet()
        .Redirect("http://10.0.0.5/x", status, "http://10.0.0.5/y")
        .Ok("http://10.0.0.5/y");
    var req = new HttpRequestMessage(new HttpMethod(method), "http://10.0.0.5/x")
    {
        Version = HttpVersion.Version11,
        VersionPolicy = HttpVersionPolicy.RequestVersionOrLower,
    };
    if (body is not null)
        req.Content = new StringContent(body, Encoding.UTF8, "application/json");
    req.Headers.TryAddWithoutValidation("Authorization", "Bearer secret");
    req.Headers.TryAddWithoutValidation("hue-application-key", "k1");
    await PrivateNetwork.SendAsync(req, net.Send, deadline);
    return net.Log.Count == 2 ? net.Log[1] : new StubNet.Seen("(not followed)", "", null, null, new(), new Version());
}

{
    var r301 = await Second("POST", 301);
    var r302 = await Second("POST", 302);
    var r300 = await Second("POST", 300);
    Check("L6 301/302/300 turn a POST into a bodiless GET",
        new[] { r301, r302, r300 }.All(s => s.Method == "GET" && s.Body is null && s.ContentType is null),
        string.Join(" ", new[] { r301, r302, r300 }.Select(s => $"{s.Method}/{s.Body ?? "-"}")));

    var put302 = await Second("PUT", 302);
    var del301 = await Second("DELETE", 301);
    Check("L6b ...but leave PUT and DELETE alone, as HttpClient does",
        put302.Method == "PUT" && put302.Body == "{\"on\":true}" && del301.Method == "DELETE",
        $"{put302.Method}/{put302.Body} {del301.Method}");

    var put303 = await Second("PUT", 303);
    var head303 = await Second("HEAD", 303, body: null);
    Check("L6c 303 turns anything but GET/HEAD into a bodiless GET; HEAD stays HEAD",
        put303.Method == "GET" && put303.Body is null && head303.Method == "HEAD",
        $"{put303.Method}/{put303.Body ?? "-"} {head303.Method}");

    var r307 = await Second("POST", 307);
    var r308 = await Second("PUT", 308);
    Check("L6d 307/308 keep the method, the body and its type",
        r307.Method == "POST" && r307.Body == "{\"on\":true}" && r307.ContentType?.StartsWith("application/json") == true
            && r308.Method == "PUT" && r308.Body == "{\"on\":true}",
        $"{r307.Method}/{r307.Body}/{r307.ContentType} {r308.Method}/{r308.Body}");

    Check("L7 Authorization is dropped on a redirect; the device's own headers and HTTP version are kept",
        !r307.Headers.ContainsKey("Authorization") && r307.Headers.GetValueOrDefault("hue-application-key") == "k1"
            && r307.Version == HttpVersion.Version11,
        string.Join(", ", r307.Headers.Keys) + $" v{r307.Version}");
}

// ---- L8-L9: not a followable redirect -----------------------------------------------

{
    var net = new StubNet()
        .Redirect("https://192.168.1.20/", 302, "http://192.168.1.20/");
    var o = await PrivateNetwork.SendAsync(Get("https://192.168.1.20/"), net.Send, deadline);
    Check("L8 HTTPS is never redirected down to HTTP, as HttpClient refuses too",
        o.Response.StatusCode == HttpStatusCode.Found && net.Count == 1, net.Urls);
}

{
    var net = new StubNet()
        .Status("http://10.0.0.5/a", 304)
        .Redirect("http://10.0.0.5/b", 302, null)
        .Status("http://10.0.0.5/c", 404);
    var a = await PrivateNetwork.SendAsync(Get("http://10.0.0.5/a"), net.Send, deadline);
    var b = await PrivateNetwork.SendAsync(Get("http://10.0.0.5/b"), net.Send, deadline);
    var c = await PrivateNetwork.SendAsync(Get("http://10.0.0.5/c"), net.Send, deadline);
    Check("L9 a 304, a 3xx with no Location and a 404 come back as they are",
        (int)a.Response.StatusCode == 304 && (int)b.Response.StatusCode == 302 && (int)c.Response.StatusCode == 404
            && a.Stopped is null && b.Stopped is null && c.Stopped is null && net.Count == 3,
        net.Urls);
}

// ---- L10: one deadline for the chain ------------------------------------------------

{
    // Each hop alone is well inside the deadline; the chain is not. The client's own
    // timeout is per send, so without a shared one this would run 6 × 150 ms.
    var net = new StubNet { Delay = TimeSpan.FromMilliseconds(150) }
        .Redirect("http://10.0.0.5/a", 302, "http://10.0.0.5/b")
        .Redirect("http://10.0.0.5/b", 302, "http://10.0.0.5/a");
    Exception? thrown = null;
    try { await PrivateNetwork.SendAsync(Get("http://10.0.0.5/a"), net.Send, TimeSpan.FromMilliseconds(400)); }
    catch (Exception ex) { thrown = ex; }
    Check("L10 the deadline covers the whole chain, and says so when it fires",
        thrown is TimeoutException && net.Count <= 3, $"{thrown?.GetType().Name ?? "no exception"} after {net.Count} sends");

    var quick = new StubNet { Delay = TimeSpan.FromMilliseconds(150) }.Ok("http://10.0.0.5/ok");
    var o = await PrivateNetwork.SendAsync(Get("http://10.0.0.5/ok"), quick.Send, TimeSpan.FromMilliseconds(400));
    Check("L10b ...and does not fire on a chain that fits inside it",
        o.Response.StatusCode == HttpStatusCode.OK);
}

// ---- L11: the policy ----------------------------------------------------------------

{
    string[] inside = ["http://10.1.2.3/", "http://172.16.0.1/", "http://172.31.255.254/", "http://192.168.0.1/",
        "http://169.254.1.1/", "http://127.0.0.1/", "http://localhost/", "http://[::1]/"];
    string[] outside = ["http://172.15.0.1/", "http://172.32.0.1/", "http://8.8.8.8/", "http://nas.local/",
        "http://example.com/", "http://[fd00::1]/", "http://192.169.0.1/"];
    var wrongIn = inside.Where(u => !PrivateNetwork.IsPrivateHost(new Uri(u))).ToList();
    var wrongOut = outside.Where(u => PrivateNetwork.IsPrivateHost(new Uri(u))).ToList();
    Check("L11 the private set is loopback plus literal RFC1918 and link-local IPv4, nothing else",
        wrongIn.Count == 0 && wrongOut.Count == 0,
        $"refused: [{string.Join(", ", wrongIn)}] admitted: [{string.Join(", ", wrongOut)}]");
}

// ---- L12: the wiring ----------------------------------------------------------------

{
    // Everything above is moot if the handler still follows redirects itself: it would
    // do so before PrivateNetwork ever saw a 3xx.
    var window = FindUpwards("src/Plinth/App/DashboardWindow.cs");
    if (window is null)
        Check("L12 setup: DashboardWindow.cs found", false);
    else
    {
        var code = File.ReadAllText(window);
        var start = code.IndexOf("ProxyClientInsecure = new(", StringComparison.Ordinal);
        var end = start < 0 ? -1 : code.IndexOf("Timeout = ", start, StringComparison.Ordinal);
        var init = start < 0 || end < 0 ? "" : code[start..end];
        Check("L12 the insecure client's handler does not follow redirects",
            init.Contains("AllowAutoRedirect = false"), init.Length == 0 ? "initializer not found" : null);

        var sends = System.Text.RegularExpressions.Regex.Matches(code, @"ProxyClientInsecure\.SendAsync\(").Count;
        Check("L12b ...and its only send goes through PrivateNetwork.SendAsync",
            sends == 1 && System.Text.RegularExpressions.Regex.IsMatch(code,
                @"PrivateNetwork\.SendAsync\(request,\s*\(hop, token\) => ProxyClientInsecure\.SendAsync\("),
            $"{sends} sends");
    }
}

Console.WriteLine(failures > 0 ? $"{failures} FAILURES" : "ALL PASS");
return failures > 0 ? 1 : 0;

static HttpRequestMessage Get(string url) => new(HttpMethod.Get, url);

static string? FindUpwards(string relative)
{
    var dir = new DirectoryInfo(AppContext.BaseDirectory);
    while (dir is not null)
    {
        var candidate = Path.Combine(dir.FullName, relative.Replace('/', Path.DirectorySeparatorChar));
        if (File.Exists(candidate)) return candidate;
        dir = dir.Parent;
    }
    return null;
}

/// <summary>A network of canned answers, keyed by absolute URL. Every request is logged,
/// including one to a URL it was not given (answered 200), so a check that a host is
/// never contacted fails on the log rather than on an exception.</summary>
sealed class StubNet
{
    public sealed record Seen(string Method, string Url, string? Body, string? ContentType,
        Dictionary<string, string> Headers, Version Version);

    private readonly Dictionary<string, Func<HttpResponseMessage>> _routes = new();
    public List<Seen> Log { get; } = new();
    public TimeSpan Delay { get; init; }
    public int Count => Log.Count;
    public string Urls => string.Join(" ", Log.Select(s => s.Url));

    public StubNet Ok(string url) => Status(url, 200);

    public StubNet Status(string url, int status)
    {
        _routes[url] = () => new HttpResponseMessage((HttpStatusCode)status) { Content = new StringContent("{}") };
        return this;
    }

    public StubNet Redirect(string url, int status, string? location)
    {
        _routes[url] = () =>
        {
            var r = new HttpResponseMessage((HttpStatusCode)status);
            if (location is not null)
                r.Headers.Location = new Uri(location, UriKind.RelativeOrAbsolute);
            return r;
        };
        return this;
    }

    public async Task<HttpResponseMessage> Send(HttpRequestMessage request, CancellationToken token)
    {
        if (Delay > TimeSpan.Zero)
            await Task.Delay(Delay, token);
        var url = request.RequestUri!.AbsoluteUri;
        var headers = request.Headers.ToDictionary(h => h.Key, h => string.Join(",", h.Value), StringComparer.OrdinalIgnoreCase);
        var body = request.Content is null ? null : await request.Content.ReadAsStringAsync(token);
        Log.Add(new Seen(request.Method.Method, url, body, request.Content?.Headers.ContentType?.ToString(), headers, request.Version));
        var response = _routes.TryGetValue(url, out var answer)
            ? answer()
            : new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent("unrouted") };
        response.RequestMessage = request;
        return response;
    }
}
