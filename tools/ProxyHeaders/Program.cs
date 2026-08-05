// Proxy header rules — what a widget may choose, and what the host keeps (issue #92).
//
// The reported hole: the extra-header denylist did not reject browser-owned names, so a
// widget could send `Sec-Fetch-Site: same-origin` (or its own User-Agent) and, because
// the host's defaults only fill GAPS, suppress the honest value at the same time. A
// local service that trusts fetch metadata to tell same-origin from cross-site then sees
// exactly what the caller wanted it to see.
//
// P1-P4  the host keeps what is its
// P5-P6  ...without taking the headers real APIs need
// P7     the two tiers agree about host-owned names — the drift that WAS the finding
// P8     name handling is case- and junk-proof
using System.Text.Json;
using Plinth;

var failures = 0;
void Check(string name, bool ok, string? detail = null)
{
    Console.WriteLine($"  {(ok ? "PASS" : "FAIL")} {name}{(detail is null ? "" : " - " + detail)}");
    if (!ok) failures++;
}

// ---- P1-P4: host-owned names are refused on the proxy tier -------------------------

// Fetch Metadata is the finding's own example: a browser owns these, which is the entire
// reason a local service is entitled to believe them.
string[] fetchMetadata = ["Sec-Fetch-Site", "Sec-Fetch-Mode", "Sec-Fetch-Dest", "Sec-Fetch-User", "Sec-CH-UA"];
Check("P1 Sec-* fetch metadata cannot be supplied by a widget",
    fetchMetadata.All(h => !ProxyHeaderRules.IsWidgetSuppliable(h)),
    string.Join(", ", fetchMetadata.Where(ProxyHeaderRules.IsWidgetSuppliable)));

// The identity the request presents. Gap-filled, so a supplied value is the ONLY one.
string[] identity = ["User-Agent", "Referer", "Origin"];
Check("P2 the request's identity headers cannot be supplied by a widget",
    identity.All(h => !ProxyHeaderRules.IsWidgetSuppliable(h)),
    string.Join(", ", identity.Where(ProxyHeaderRules.IsWidgetSuppliable)));

Check("P3 Proxy-* is refused",
    !ProxyHeaderRules.IsWidgetSuppliable("Proxy-Authorization"));

// Not spoofing — these belong to HttpClient, and forwarding them corrupts the request.
string[] framing = ["Host", "Content-Length", "Transfer-Encoding", "Connection", "Cookie", "Cookie2"];
Check("P4 hop-by-hop and body-framing headers stay under HttpClient's control",
    framing.All(h => !ProxyHeaderRules.IsWidgetSuppliable(h)),
    string.Join(", ", framing.Where(ProxyHeaderRules.IsWidgetSuppliable)));

// ---- P5-P6: the rule must not eat the headers the ladder exists for ----------------

// A rule that refused everything would pass every check above. These are the names real
// widgets ship today (Hue CLIP v2, any bearer-token API); refusing them breaks the app
// silently, which is the failure direction nothing else here would catch.
string[] needed = ["Authorization", "hue-application-key", "X-API-Key", "Accept", "Accept-Language", "If-None-Match"];
Check("P5 the headers real widgets send still pass",
    needed.All(ProxyHeaderRules.IsWidgetSuppliable),
    string.Join(", ", needed.Where(h => !ProxyHeaderRules.IsWidgetSuppliable(h))));

Check("P6 ...and Authorization survives the browser tier too, or a 403 retry loses it (#37)",
    ProxyHeaderRules.IsBrowserForwardable("Authorization")
    && ProxyHeaderRules.IsBrowserForwardable("hue-application-key"));

// ---- P7: the tiers cannot disagree -------------------------------------------------

// The bug was never one name. The proxy tier forwarded a category the browser tier
// already refused, so the escalation ladder changed the request's trustworthiness
// halfway up. Any name refused as browser-forwardable for being browser-OWNED must be
// refused on the proxy tier as well.
// DERIVED, not listed. Twice this probe missed a drift because its corpus was a set of
// strings I maintained by hand — Cookie2 was added after the first miss and the check
// was still incomplete at the next one (#126). The corpus is now the rules' own shared
// set, so a name added there is covered here the moment it is added, and no edit to this
// file is needed to keep the check honest.
var shared = ProxyHeaderRules.SharedRefusals.ToArray();
Check("P7 setup: the shared refusal set is non-trivial", shared.Length >= 10, $"{shared.Length} names");

var drifted = shared.Where(h =>
    ProxyHeaderRules.IsWidgetSuppliable(h) != ProxyHeaderRules.IsBrowserForwardable(h)).ToArray();
Check("P7 the two tiers agree on every shared name",
    drifted.Length == 0, string.Join(", ", drifted));

Check("P7b and both REFUSE them, rather than agreeing to allow them",
    shared.All(h => !ProxyHeaderRules.IsWidgetSuppliable(h) && !ProxyHeaderRules.IsBrowserForwardable(h)),
    string.Join(", ", shared.Where(ProxyHeaderRules.IsWidgetSuppliable)));

// The names from the finding, spelled out so the regression is legible in the output
// even though the derived check above already covers them.
string[] hopByHop = ["Via", "Upgrade", "TE", "Trailer", "Connection", "Keep-Alive"];
Check("P7c hop-by-hop names are refused on the proxy tier too (#126)",
    hopByHop.All(h => !ProxyHeaderRules.IsWidgetSuppliable(h)),
    string.Join(", ", hopByHop.Where(ProxyHeaderRules.IsWidgetSuppliable)));

// ---- P8: name handling ------------------------------------------------------------

Check("P8 matching is case-insensitive — SEC-FETCH-SITE is the same header",
    !ProxyHeaderRules.IsWidgetSuppliable("SEC-FETCH-SITE")
    && !ProxyHeaderRules.IsWidgetSuppliable("user-agent")
    && !ProxyHeaderRules.IsWidgetSuppliable("UsEr-AgEnT"));

Check("P8b a missing or blank name is not a header",
    !ProxyHeaderRules.IsWidgetSuppliable(null) && !ProxyHeaderRules.IsWidgetSuppliable("")
    && !ProxyHeaderRules.IsWidgetSuppliable("   ")
    && !ProxyHeaderRules.IsBrowserForwardable(null));

// The prefix is `sec-`, hyphen included, and the hyphen is doing real work: it is the
// boundary between the reserved namespace and an ordinary header that merely begins with
// those letters. Refusing `Security-Token` would break a widget for a spelling
// coincidence, which is the direction a prefix rule fails in if nobody checks.
Check("P8c the sec- prefix covers the reserved namespace and stops there",
    !ProxyHeaderRules.IsWidgetSuppliable("Sec-Custom-Thing")
    && ProxyHeaderRules.IsWidgetSuppliable("Security-Token")
    && ProxyHeaderRules.IsWidgetSuppliable("Secret-Handshake"));

// ---- R1-R6: the RESPONSE direction (#169) -----------------------------------------
//
// The proxy hop returned status, statusText, contentType and the body, so a widget that
// read any response header saw nothing once its request escalated — and the shim
// escalates every direct 403 and 429, which is exactly where a rate limit lives. The
// forwarding is an allow-list, and the same reasoning as the request direction applies:
// the danger is not one missing name, it is the two TIERS disagreeing, so R6 derives its
// parity check from the exported list rather than restating it.

// The names from the issue, spelled out so the intent is legible in the output.
string[] wanted = [
    "ETag", "Last-Modified", "Retry-After", "Link",
    "X-RateLimit-Limit", "X-RateLimit-Remaining", "X-RateLimit-Reset",
    "X-RateLimit-Used", "X-RateLimit-Resource",
];
Check("R1 the metadata a widget cannot get any other way is forwarded",
    wanted.All(ProxyHeaderRules.IsForwardableResponseHeader),
    string.Join(", ", wanted.Where(h => !ProxyHeaderRules.IsForwardableResponseHeader(h))));

// An allow-list, not a copy. Set-Cookie is the one that matters most: the proxy holds
// cookies the page cannot see, and handing their values to widget script would undo
// exactly that. The rest describe the HOST's connection, not the widget's.
string[] mustNotCross = [
    "Set-Cookie", "Set-Cookie2", "Authorization", "WWW-Authenticate", "Proxy-Authenticate",
    "Connection", "Keep-Alive", "Transfer-Encoding", "Content-Length", "Trailer", "Upgrade",
    "Server", "Strict-Transport-Security", "Content-Security-Policy",
];
Check("R2 nothing outside the list crosses the hop — cookies above all",
    mustNotCross.All(h => !ProxyHeaderRules.IsForwardableResponseHeader(h)),
    string.Join(", ", mustNotCross.Where(ProxyHeaderRules.IsForwardableResponseHeader)));

// Content-Type rides its own field and the shim applies it after the map. Listing it
// here as well would be two sources for one value, and the shim would have to decide
// which wins — a decision with no right answer that is better not to create.
Check("R3 Content-Type is NOT in the list, because it has its own field",
    !ProxyHeaderRules.IsForwardableResponseHeader("Content-Type"));

Check("R4 matching is case-insensitive, because header names are",
    ProxyHeaderRules.IsForwardableResponseHeader("etag")
    && ProxyHeaderRules.IsForwardableResponseHeader("ETAG")
    && ProxyHeaderRules.IsForwardableResponseHeader("X-RateLimit-REMAINING"));

Check("R4b a missing or blank name is not a header",
    !ProxyHeaderRules.IsForwardableResponseHeader(null)
    && !ProxyHeaderRules.IsForwardableResponseHeader("")
    && !ProxyHeaderRules.IsForwardableResponseHeader("   "));

// The list is exact, not a prefix rule: `x-ratelimit-` is a family, but forwarding
// whatever else happens to start with it is how an allow-list stops being one.
Check("R5 the list is exact rather than prefix-matched",
    !ProxyHeaderRules.IsForwardableResponseHeader("X-RateLimit-Secret")
    && !ProxyHeaderRules.IsForwardableResponseHeader("ETag-Internal")
    && !ProxyHeaderRules.IsForwardableResponseHeader("Linkage"));

// R6 is the point of this block, and the counterpart of P7. The hidden-browser tier
// collects its headers in a script GENERATED from the same property, so a name added to
// ProxyHeaderRules reaches both tiers or neither. Restating the list in the script is
// the drift the request direction suffered three times.
var listed = ProxyHeaderRules.ResponseAllowList.ToArray();
Check("R6 setup: the exported list is non-trivial", listed.Length >= 9, $"{listed.Length} names");
Check("R6 setup: the list is lowercase, which is what the script's header.get calls assume",
    listed.All(n => n == n.ToLowerInvariant()),
    string.Join(", ", listed.Where(n => n != n.ToLowerInvariant())));

var script = FetchLimits.BrowserFetchScript("\"https://example.test/\"", "{}", FetchLimits.MaxBodyBytes);
Check("R6 every forwarded name reaches the generated page script",
    listed.All(n => script.Contains($"\"{n}\"", StringComparison.Ordinal)),
    string.Join(", ", listed.Where(n => !script.Contains($"\"{n}\"", StringComparison.Ordinal))));
Check("R6b ...and the script actually reads them off the response",
    script.Contains("r.headers.get(k)", StringComparison.Ordinal)
    && script.Contains("headers: readHeaders(r)", StringComparison.Ordinal));
// A refusal carries no headers because it carries no response — but a SUCCESS on either
// tier must, including the null-body statuses, which take their own branch in the script.
Check("R6c ...on the null-body branch too, which is a separate assignment",
    script.Split("readHeaders(r)").Length - 1 >= 2,
    (script.Split("readHeaders(r)").Length - 1) + " assignment(s)");

// R7: the JSON fixture the Node harness reads is the SAME set. A harness with its own
// copy of the list would go on proving tier parity for a list the host no longer
// forwards — a probe passing because it is testing itself.
var fixtureFile = Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "proxy-response-headers.json");
if (!File.Exists(fixtureFile))
{
    Check("R7 setup: tools/proxy-response-headers.json exists", false, fixtureFile);
}
else
{
    using var fixture = JsonDocument.Parse(File.ReadAllText(fixtureFile));
    var fromFixture = fixture.RootElement.GetProperty("forward")
        .EnumerateArray().Select(e => e.GetString() ?? "").ToHashSet(StringComparer.Ordinal);
    var fromRules = ProxyHeaderRules.ResponseAllowList.ToHashSet(StringComparer.Ordinal);
    Check("R7 the harness fixture and the host's list are the same set",
        fromFixture.SetEquals(fromRules),
        "only in fixture: [" + string.Join(", ", fromFixture.Except(fromRules))
        + "] only in rules: [" + string.Join(", ", fromRules.Except(fromFixture)) + "]");
}

Console.WriteLine(failures > 0 ? $"{failures} FAILURES" : "ALL PASS");
return failures > 0 ? 1 : 0;
