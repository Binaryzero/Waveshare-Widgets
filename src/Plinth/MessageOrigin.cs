namespace Plinth;

/// <summary>
/// Decides whether a WebView2 message came from one of our own shell documents (#72).
///
/// The host's message handlers dispatch on the payload's <c>type</c> and act on it —
/// <c>save-layout</c> writes layout.json, <c>open-url</c> launches a browser,
/// <c>action</c> runs configured actions. Until this existed, nothing checked WHO sent
/// the message; the reason widget frames could not reach those handlers was three
/// properties of the hosting configuration rather than a decision:
///
///   1. every widget is mapped to its own virtual host (`{slug}.widgets.plinth`), so a frame
///      is cross-origin with the shell on `app.plinth` and cannot reach `parent.chrome.webview`;
///   2. the subscription is CoreWebView2.WebMessageReceived, raised for the TOP-LEVEL
///      document — frame messages surface on CoreWebView2Frame.WebMessageReceived;
///   3. nothing subscribes to FrameCreated, so that frame-level channel has no listener.
///
/// All three could be relaxed by an unrelated change — widget assets consolidated onto a
/// shared host, a FrameCreated subscription added for some other feature — with nothing
/// failing. docs/SECRET-ADDRESSING.md then wants to trust a client-declared slot
/// provenance over this channel, which is only safe if "the shell sent this" is checked
/// rather than inferred. So it is checked here.
/// </summary>
internal static class MessageOrigin
{
    /// <summary>True when <paramref name="source"/> is a document served from
    /// <paramref name="shellHost"/> over https.
    ///
    /// Scheme and host only, deliberately. The host is what separates the shell from
    /// widget frames — they live on different hosts entirely, so the port adds no
    /// security — while requiring a specific path or port would fail CLOSED if the shell
    /// ever gained a query string or moved page, silently dropping every message and
    /// leaving the app looking dead. Host comparison is case-insensitive because host
    /// names are; that is not the ordinal-identity rule the widget pipeline uses, which
    /// is about widget IDs.</summary>
    public static bool IsShell(string? source, string shellHost)
    {
        if (string.IsNullOrWhiteSpace(source) || string.IsNullOrEmpty(shellHost))
            return false;
        if (!Uri.TryCreate(source, UriKind.Absolute, out var uri))
            return false;
        return string.Equals(uri.Scheme, Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase)
            && string.Equals(uri.Host, shellHost, StringComparison.OrdinalIgnoreCase);
    }
}
