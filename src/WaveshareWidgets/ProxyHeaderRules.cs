namespace WaveshareWidgets;

/// <summary>
/// Which request headers a WIDGET may choose, on each tier of the fetch ladder (#92).
///
/// The host proxy exists so widgets can reach APIs a browser would block, and it lets
/// them supply extra headers because real APIs need them (Hue CLIP v2's
/// <c>hue-application-key</c>, an <c>Authorization</c> bearer). The question this file
/// answers is the other half: which names does the HOST keep for itself.
///
/// Two properties make that answer load-bearing rather than cosmetic:
///
///   1. The proxy reaches loopback and LAN targets. Local services routinely decide what
///      to allow from the request's own metadata — <c>Sec-Fetch-Site</c>, <c>Origin</c>,
///      <c>Referer</c>, the <c>User-Agent</c> — precisely because a browser owns those
///      and a page cannot forge them. Forwarding a widget's value hands it the one thing
///      that made those checks worth anything.
///   2. The defaults GAP-FILL. A forwarded header owns its name outright, so supplying
///      one does not merely add a value, it SUPPRESSES the host's honest one. There is
///      no version of this where the host's default and the widget's value both appear.
///
/// The two tiers disagreeing about a name is itself the bug: the browser tier already
/// refused browser-owned headers (a page-context fetch throws on them, which would kill
/// the retry), while the proxy tier forwarded them. A header the browser tier will not
/// replay is one the proxy tier has no business sending either, so both tiers now read
/// their rule from here and <c>P7</c> in the probe asserts they cannot drift apart.
/// </summary>
public static class ProxyHeaderRules
{
    /// <summary>Names the host owns on EVERY tier: browser-controlled metadata a page
    /// script can never set, plus the identity the request presents.</summary>
    private static bool IsHostOwned(string lower) =>
        lower is "user-agent" or "referer" or "origin"
        || lower.StartsWith("sec-", StringComparison.Ordinal)
        || lower.StartsWith("proxy-", StringComparison.Ordinal);

    /// <summary>Whether a widget-supplied header may be copied onto the proxy request.
    /// Rejects host-owned metadata, plus hop-by-hop and body-framing names that belong to
    /// HttpClient (forwarding those corrupts the request rather than spoofing anything).
    /// </summary>
    /// <param name="name">Header name; compared case-insensitively.</param>
    public static bool IsWidgetSuppliable(string? name)
    {
        if (string.IsNullOrWhiteSpace(name)) return false;
        var lower = name.ToLowerInvariant();
        if (IsHostOwned(lower)) return false;
        return lower is not ("host" or "content-length" or "transfer-encoding"
            or "connection" or "cookie");
    }

    /// <summary>Whether a widget-supplied header can be replayed from a page-context
    /// fetch in the hidden-browser tier. Names the Fetch spec forbids page scripts to set
    /// (the browser throws, killing the whole retry) and anything the browser must own
    /// stay out; auth and API-key headers pass through, because an Authorization header
    /// must survive EVERY tier of the ladder or a private feed keeps answering 403 right
    /// when the bot wall forces the escalation (#37).</summary>
    public static bool IsBrowserForwardable(string? name)
    {
        if (string.IsNullOrWhiteSpace(name)) return false;
        var lower = name.ToLowerInvariant();
        if (IsHostOwned(lower)) return false;
        return lower is not ("accept-charset" or "accept-encoding" or "connection"
            or "content-length" or "content-type" or "cookie" or "cookie2" or "date"
            or "dnt" or "expect" or "host" or "keep-alive" or "te" or "trailer"
            or "transfer-encoding" or "upgrade" or "via")
            && !lower.StartsWith("access-control-", StringComparison.Ordinal);
    }
}
