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
/// THE RECURRING DEFECT is not any single name — it is the two tiers disagreeing. A
/// header the browser tier will not replay is one the proxy tier has no business
/// sending, because the escalation ladder would then change the request's
/// trustworthiness halfway up. That drifted three times: first <c>Sec-*</c> and
/// <c>User-Agent</c> (#92), then <c>Cookie2</c>, then <c>Via</c>/<c>Upgrade</c>/
/// <c>TE</c>/<c>Trailer</c> (#126) — each time because the shared names lived as two
/// hand-written lists that had to be edited in step.
///
/// So they are ONE set now, named and exported. Each tier refuses the shared set plus
/// its own content-negotiation quirks, and <c>tools/ProxyHeaders</c> derives its parity
/// check FROM <see cref="SharedRefusals"/> rather than from a list in the probe — so a
/// name added here is covered by the probe the moment it is added, and a name added to
/// one tier only cannot pass unnoticed.
/// </summary>
public static class ProxyHeaderRules
{
    /// <summary>Browser-controlled metadata a page script can never set, plus the
    /// identity the request presents. Prefix rules, so the reserved namespaces are
    /// covered without enumerating them.</summary>
    private static bool IsHostOwned(string lower) =>
        lower is "user-agent" or "referer" or "origin"
        || lower.StartsWith("sec-", StringComparison.Ordinal)
        || lower.StartsWith("proxy-", StringComparison.Ordinal);

    /// <summary>Hop-by-hop and connection-management names. These belong to whatever is
    /// actually making the connection; a caller-chosen value either corrupts the request
    /// or describes a hop that is not the one being made.</summary>
    private static readonly HashSet<string> HopByHop = new(StringComparer.Ordinal)
    {
        "connection", "keep-alive", "te", "trailer", "transfer-encoding", "upgrade",
        "via", "host", "content-length",
    };

    /// <summary>Cookie state. A page-context fetch cannot set it, so neither tier may
    /// present a caller-chosen one.</summary>
    private static readonly HashSet<string> CookieState = new(StringComparer.Ordinal)
    {
        "cookie", "cookie2",
    };

    /// <summary>Every name BOTH tiers must refuse — the invariant the probe derives its
    /// parity check from. Exposed so that check cannot fall behind this file: it is the
    /// same data, not a copy of it.</summary>
    public static IEnumerable<string> SharedRefusals =>
        new[] { "user-agent", "referer", "origin", "sec-fetch-site", "sec-ch-ua", "proxy-authorization" }
            .Concat(HopByHop).Concat(CookieState);

    private static bool IsSharedRefusal(string lower) =>
        IsHostOwned(lower) || HopByHop.Contains(lower) || CookieState.Contains(lower);

    /// <summary>Whether a widget-supplied header may be copied onto the proxy request.
    /// </summary>
    /// <param name="name">Header name; compared case-insensitively.</param>
    public static bool IsWidgetSuppliable(string? name)
    {
        if (string.IsNullOrWhiteSpace(name)) return false;
        return !IsSharedRefusal(name.ToLowerInvariant());
    }

    /// <summary>Whether a widget-supplied header can be replayed from a page-context
    /// fetch in the hidden-browser tier. The shared set, plus the names the Fetch spec
    /// forbids page scripts to set for content-negotiation reasons (the browser throws,
    /// killing the whole retry). Auth and API-key headers pass through, because an
    /// Authorization header must survive EVERY tier of the ladder or a private feed keeps
    /// answering 403 right when the bot wall forces the escalation (#37).</summary>
    public static bool IsBrowserForwardable(string? name)
    {
        if (string.IsNullOrWhiteSpace(name)) return false;
        var lower = name.ToLowerInvariant();
        if (IsSharedRefusal(lower)) return false;
        // Browser-tier-only. content-type is carried on the dedicated field instead, so
        // refusing it here does not lose it; the rest a page fetch simply cannot set.
        return lower is not ("accept-charset" or "accept-encoding" or "content-type"
            or "date" or "dnt" or "expect")
            && !lower.StartsWith("access-control-", StringComparison.Ordinal);
    }

    // ---- the RESPONSE direction (#169) ---------------------------------------------

    /// <summary>Response headers the host carries back across the proxy hop.
    ///
    /// <para>The hop used to return four fields — status, statusText, contentType and the
    /// body — so a widget that read any response header saw nothing the moment its
    /// request escalated. That is not a rare path: the shim escalates EVERY direct 403 or
    /// 429 through the proxy, on the reasoning that bot walls serve their block page with
    /// CORS headers. So the responses most likely to carry meaningful metadata — rate
    /// limits — were exactly the ones routed through the tier that discarded it. A
    /// primary rate limit answering 403 with <c>x-ratelimit-remaining: 0</c> arrived as a
    /// bare "Forbidden", which reads as a permissions problem, so a widget kept polling
    /// instead of waiting for the reset.</para>
    ///
    /// <para>An ALLOW-LIST rather than a copy, for two reasons. Response headers are
    /// unbounded in size and count, and this payload crosses a postMessage hop that
    /// already carries the whole body. And some names must not cross at all:
    /// <c>Set-Cookie</c> above all — the proxy holds cookies the page cannot see, and
    /// handing their values to widget script would undo that — along with the transport's
    /// own framing, which describes the host's connection and not the widget's.</para>
    ///
    /// <para><c>Content-Type</c> is deliberately absent: it rides its own field and the
    /// shim applies it, so listing it here would be a second source for one value.</para>
    /// </summary>
    private static readonly HashSet<string> ResponseAllowed = new(StringComparer.Ordinal)
    {
        // Conditional requests. Without these a widget can only do conditional GETs on
        // the direct tier and silently loses its own caching the moment it escalates.
        "etag", "last-modified",
        // The one standard way a server says how long to wait, and RFC 8288 pagination —
        // how GitHub and many others express "there is more".
        "retry-after", "link",
        // Rate limits. Not standardised, but near-universal in this spelling, and the
        // reason this issue was filed.
        "x-ratelimit-limit", "x-ratelimit-remaining", "x-ratelimit-reset",
        "x-ratelimit-used", "x-ratelimit-resource",
    };

    /// <summary>The forwarded names, lowercase. Exported so the host, the hidden-browser
    /// script and the probe all read ONE list — the request direction learned three times
    /// over that a rule kept as two hand-written copies drifts, and the drift is invisible
    /// until a widget on one tier behaves differently from the same widget on the other.
    /// </summary>
    public static IEnumerable<string> ResponseAllowList => ResponseAllowed;

    /// <summary>Whether a response header is carried back to the widget.</summary>
    /// <param name="name">Header name; compared case-insensitively.</param>
    public static bool IsForwardableResponseHeader(string? name)
    {
        if (string.IsNullOrWhiteSpace(name)) return false;
        return ResponseAllowed.Contains(name.ToLowerInvariant());
    }
}
