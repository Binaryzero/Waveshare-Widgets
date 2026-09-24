namespace Plinth;

/// <summary>The private-host policy, and the redirect rule that keeps the proxy's
/// certificate-blind LAN client inside it (#303). Pure apart from the send it is handed,
/// so tools/LanRedirects can cover it without WebView2 or a network.</summary>
internal static class PrivateNetwork
{
    /// <summary>Loopback or RFC1918/link-local private addresses only (no DNS lookups —
    /// a hostname that isn't a literal private IP or localhost doesn't qualify).
    /// THE private-host policy: the insecure proxy tier, every redirect it follows, and
    /// the media relay all gate on exactly this set.</summary>
    public static bool IsPrivateHost(Uri uri)
    {
        if (uri.IsLoopback)
            return true;
        if (!System.Net.IPAddress.TryParse(uri.Host, out var ip))
            return false;
        var b = ip.GetAddressBytes();
        if (b.Length != 4)
            return false;
        return b[0] == 10
            || (b[0] == 172 && b[1] >= 16 && b[1] <= 31)
            || (b[0] == 192 && b[1] == 168)
            || (b[0] == 169 && b[1] == 254);
    }

    /// <summary>Redirects followed before the last 3xx is handed back as the answer.
    /// LAN devices redirect once or twice (HTTP to HTTPS, / to a login page); a chain
    /// longer than this is a loop.</summary>
    public const int MaxRedirects = 5;

    /// <param name="Response">The answer to hand the widget: the first non-redirect, or
    /// a redirect that was not followed.</param>
    /// <param name="Stopped">Why a redirect was not followed, for the log; null when
    /// the response is simply the end of the chain.</param>
    public sealed record Outcome(HttpResponseMessage Response, string? Stopped);

    /// <summary>Sends <paramref name="first"/> and follows its redirects by hand, the way
    /// HttpClient's own handler does, except that every hop must pass
    /// <see cref="IsPrivateHost"/>.
    ///
    /// The client this serves accepts every certificate, which is safe only while the
    /// peer is on the private network. Its built-in redirect handling decided that once,
    /// for the first URL, and then followed a LAN device's redirect anywhere with checks
    /// still off. A hop off the private network is not followed here: its 3xx goes back
    /// to the widget as the answer. Following it on the checked client instead would send
    /// the device's own headers (a Hue application key, say) to an internet host.
    ///
    /// The rest matches HttpClient, so nothing that works today changes: 301/302 turn a
    /// POST into a GET, 303 turns anything but GET/HEAD into a GET, 307/308 keep the method
    /// and body, Authorization is dropped, and HTTPS never redirects down to HTTP.
    ///
    /// <paramref name="deadline"/> covers the whole chain. The client's own timeout is per
    /// send, and the client holds one connection per device, so a chain of slow hops would
    /// otherwise hold that connection long after the widget stopped waiting.</summary>
    public static async Task<Outcome> SendAsync(
        HttpRequestMessage first,
        Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> send,
        TimeSpan deadline)
    {
        // Snapshot before the first send: a sent request cannot be sent again, so each
        // hop is a new one built from these.
        var headers = first.Headers.ToList();
        var body = first.Content is null ? null : await first.Content.ReadAsByteArrayAsync();
        var contentHeaders = first.Content?.Headers.ToList();

        using var budget = new CancellationTokenSource(deadline);
        var request = first;
        var redirects = 0;
        try
        {
            while (true)
            {
                var response = await send(request, budget.Token);
                var status = (int)response.StatusCode;
                if (status is not (300 or 301 or 302 or 303 or 307 or 308) || response.Headers.Location is not { } location)
                    return new(response, null);

                var from = request.RequestUri!;
                var target = location.IsAbsoluteUri ? location : new Uri(from, location);
                string? stop =
                    target.Scheme != Uri.UriSchemeHttp && target.Scheme != Uri.UriSchemeHttps
                        ? $"a {status} to a non-HTTP address"
                    : from.Scheme == Uri.UriSchemeHttps && target.Scheme == Uri.UriSchemeHttp
                        ? $"a {status} from HTTPS down to HTTP"
                    : !IsPrivateHost(target)
                        ? $"a {status} off the private network, not followed with certificate checks off"
                    : redirects == MaxRedirects
                        ? $"a {status} past {MaxRedirects} redirects"
                    : null;
                if (stop is not null)
                    return new(response, stop);

                redirects++;
                response.Dispose();

                var method = request.Method;
                if ((status is 300 or 301 or 302 && method == HttpMethod.Post)
                    || (status == 303 && method != HttpMethod.Get && method != HttpMethod.Head))
                {
                    // For the rest of the chain, not just this hop: a later 307 keeps
                    // the GET, and must not bring the POST's body back with it.
                    method = HttpMethod.Get;
                    body = null;
                }

                var next = new HttpRequestMessage(method, target)
                {
                    Version = first.Version,
                    VersionPolicy = first.VersionPolicy,
                };
                foreach (var (name, values) in headers)
                    if (!name.Equals("Authorization", StringComparison.OrdinalIgnoreCase))
                        next.Headers.TryAddWithoutValidation(name, values);
                if (body is not null)
                {
                    next.Content = new ByteArrayContent(body);
                    foreach (var (name, values) in contentHeaders!)
                        next.Content.Headers.TryAddWithoutValidation(name, values);
                }
                if (!ReferenceEquals(request, first))
                    request.Dispose();
                request = next;
            }
        }
        catch (OperationCanceledException) when (budget.IsCancellationRequested)
        {
            throw new TimeoutException(
                $"The request timed out after {deadline.TotalSeconds:0} seconds, redirects included.");
        }
    }
}
