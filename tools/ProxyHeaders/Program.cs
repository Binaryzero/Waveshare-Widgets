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
using WaveshareWidgets;

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

Console.WriteLine(failures > 0 ? $"{failures} FAILURES" : "ALL PASS");
return failures > 0 ? 1 : 0;
