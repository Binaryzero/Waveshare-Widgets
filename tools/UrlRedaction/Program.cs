// Probes for URL redaction in the log (#59 half 1), run against the real SafeUrl source.
// Exit code 0 = all pass.
//
// The spec calls a private ICS or webhook link credential-equivalent — the URL IS the
// credential. So the question these probes ask is not "does it shorten the URL" but
// "can the secret still be read out of what we wrote". U1 covers every place a secret
// hides in a URL; U5 sweeps the whole corpus for any leak the named cases missed.
using Plinth;

var failures = 0;
void Check(string name, bool ok, string? detail = null)
{
    Console.WriteLine($"  {(ok ? "PASS" : "FAIL")} {name}{(detail is null ? "" : " - " + detail)}");
    if (!ok) failures++;
}

// Every URL below carries this marker somewhere a real credential lives. Nothing SafeUrl
// returns may contain it.
const string Marker = "SUPERSECRET";

var leaky = new (string Label, string Url, string ExpectHost)[]
{
    ("token in the query",      $"https://api.example.com/v1/values?token={Marker}", "api.example.com"),
    ("api key in the query",    $"https://api.example.com/v1?api_key={Marker}&pretty=1", "api.example.com"),
    // The one that makes host-only the right answer rather than "drop the query":
    // Slack and Discord webhooks put the whole credential in the PATH.
    ("slack webhook path",      $"https://hooks.slack.com/services/T0000/B0000/{Marker}", "hooks.slack.com"),
    ("discord webhook path",    $"https://discord.com/api/webhooks/12345/{Marker}", "discord.com"),
    ("private ICS path",        $"https://calendar.google.com/calendar/ical/{Marker}/private/basic.ics", "calendar.google.com"),
    ("basic auth in userinfo",  $"https://admin:{Marker}@intranet.example.com/status", "intranet.example.com"),
    ("secret in the fragment",  $"https://example.com/page#access_token={Marker}", "example.com"),
    ("SAS-style query",         $"https://acct.blob.core.windows.net/c/b?sv=2021&sig={Marker}", "acct.blob.core.windows.net"),
};

// ---- U1 · nothing that can hold a credential survives ---------------------------------
foreach (var (label, url, host) in leaky)
{
    var shown = SafeUrl.Describe(url);
    Check($"U1 {label}: the secret is gone", !shown.Contains(Marker, StringComparison.OrdinalIgnoreCase), shown);
    // ...and the result is still worth logging. Without this, "return empty string"
    // would pass every leak check above — the failure mode of any redaction test.
    Check($"U1b {label}: the host is still named", shown == host, shown);
}

// ---- U2 · a non-default port is diagnostic, not secret --------------------------------
Check("U2 a non-default port rides along", SafeUrl.Describe("http://192.168.1.9:8123/api?x=1") == "192.168.1.9:8123",
    SafeUrl.Describe("http://192.168.1.9:8123/api?x=1"));
Check("U2b the default port is not noise", SafeUrl.Describe("https://example.com/a") == "example.com");
Check("U2c http on 80 is default too", SafeUrl.Describe("http://example.com/a") == "example.com");

// ---- U3 · degenerate input never throws and never echoes ------------------------------
// This runs inside catch blocks. Anything that throws here replaces a useful error with
// an unrelated one, and anything that echoes puts the leak back where it started.
var degenerate = new[]
{
    null, "", "   ", "not a url at all",
    $"ht tp://example.com/?t={Marker}",          // malformed: the space kills the parse
    $"/relative/path?token={Marker}",            // relative — no Host to read
    $"file:///C:/secrets/{Marker}.txt",
    $"mailto:{Marker}@example.com",
    $"javascript:fetch('{Marker}')",
    $"https://{Marker}.example.com/",            // marker IS the host: see U3c
};
var threw = "";
foreach (var input in degenerate)
{
    try
    {
        var shown = SafeUrl.Describe(input);
        if (input is not null && input.Contains(Marker) && shown.Contains(Marker) &&
            !input.StartsWith($"https://{Marker}", StringComparison.Ordinal))
            Check($"U3 '{Truncate(input)}' does not echo the secret", false, shown);
    }
    catch (Exception ex) { threw += $"{input ?? "(null)"} -> {ex.GetType().Name}; "; }
}
Check("U3 no input throws — this code runs inside catch blocks", threw.Length == 0, threw);
Check("U3b null and empty say so rather than printing nothing",
    SafeUrl.Describe((string?)null) == "(no url)" && SafeUrl.Describe("") == "(no url)");
Check("U3c an unparseable url is named as such, NOT echoed",
    SafeUrl.Describe($"ht tp://example.com/?t={Marker}") == "(unparseable url)",
    SafeUrl.Describe($"ht tp://example.com/?t={Marker}"));
Check("U3d a relative url has no host and is not echoed",
    !SafeUrl.Describe($"/relative/path?token={Marker}").Contains(Marker));
Check("U3e file:// has no host worth naming",
    SafeUrl.Describe($"file:///C:/secrets/{Marker}.txt") == "(unparseable url)",
    SafeUrl.Describe($"file:///C:/secrets/{Marker}.txt"));
// A secret that IS the hostname is out of scope and saying so is honest: the host is the
// one component the log is FOR, and a wildcard-subdomain token is not a shape the spec
// names. Pinned here so the limit is deliberate rather than discovered.
Check("U3f a hostname-shaped secret is reported — the host is what this prints",
    SafeUrl.Describe($"https://{Marker}.example.com/") == $"{Marker.ToLowerInvariant()}.example.com",
    SafeUrl.Describe($"https://{Marker}.example.com/"));

// ---- U4 · the exception logged BESIDE the url must not carry it either ----------------
// The issue asked for this explicitly, and it is the half that would otherwise be
// assumed: redacting the interpolated url buys nothing if `{ex.Message}` prints it back.
var httpMessage = "";
try
{
    using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(5) };
    // Port 1 refuses immediately — no network dependency, no wait.
    await client.GetAsync($"http://127.0.0.1:1/collect?token={Marker}");
}
catch (Exception ex) { httpMessage = ex.Message + " | " + (ex.InnerException?.Message ?? ""); }
Check("U4 setup: the request really failed", httpMessage.Length > 0, httpMessage);
Check("U4 an HttpClient failure message does not contain the url's secret",
    !httpMessage.Contains(Marker, StringComparison.OrdinalIgnoreCase), httpMessage);

var uriMessage = "";
try { _ = new Uri($"ht tp://example.com/?t={Marker}"); }
catch (Exception ex) { uriMessage = ex.Message; }
Check("U4b setup: the malformed uri really threw", uriMessage.Length > 0);
Check("U4c a UriFormatException does not quote the url",
    !uriMessage.Contains(Marker, StringComparison.OrdinalIgnoreCase), uriMessage);

// ---- U5 · sweep: no corpus input leaks, by any route ----------------------------------
// The named cases above are the shapes I thought of. This asserts the property over
// everything at once, so a future change that reintroduces the path (say) fails here
// even if nobody adds a case for the URL shape it breaks.
var leaked = leaky.Select(t => t.Url)
    .Where(u => SafeUrl.Describe(u).Contains(Marker, StringComparison.OrdinalIgnoreCase))
    .ToList();
Check($"U5 no url in the corpus leaks its secret ({leaky.Length} shapes)",
    leaked.Count == 0, string.Join(", ", leaked));
// The Uri overload is the one BrowserFetcher/DashboardWindow reach for when they already
// have a parsed Uri; it must not be the lenient sibling.
Check("U5b the Uri overload redacts identically",
    SafeUrl.Describe(new Uri($"https://hooks.slack.com/services/T/B/{Marker}")) == "hooks.slack.com");
Check("U5c a relative Uri instance does not throw on the Uri overload",
    SafeUrl.Describe(new Uri("/a/b", UriKind.Relative)) == "(unparseable url)");
Check("U5d a null Uri is handled", SafeUrl.Describe((Uri?)null) == "(no url)");

Console.WriteLine(failures == 0 ? "ALL PASS" : $"{failures} FAILURES");
return failures == 0 ? 0 : 1;

static string Truncate(string s) => s.Length <= 40 ? s : s[..40] + "…";
