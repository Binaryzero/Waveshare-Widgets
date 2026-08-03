namespace WaveshareWidgets;

/// <summary>
/// One body-size ceiling for every tier of the fetch ladder (issue #117).
///
/// The proxy tier has always capped, streaming the response and refusing past the bound.
/// The browser tier — added as a fallback for GETs the proxy gets 403 or 429 on — did not,
/// and that is worse than an uncapped path in isolation: the host ADVERTISES a limit that a
/// caller can rely on, and the escalation to the browser is triggered by the remote server's
/// own status code. The attacker chooses when the guarantee stops holding.
///
/// Nothing about that ladder is exercisable without WebView2, a Windows host and a remote
/// server that answers 403, so the ceiling and the script that enforces it in the page are
/// values rather than behaviour, and tools/FetchLimits checks that the two tiers cannot
/// drift apart on the number — which is the shape the defect actually had.
/// </summary>
public static class FetchLimits
{
    /// <summary>Largest response body any tier will materialise, in bytes.</summary>
    /// <remarks>Not a tuning knob. It is the number the proxy tier has always enforced, and
    /// the only reason it is named here rather than left in DashboardWindow is that a second
    /// tier now has to agree with it.</remarks>
    public const int MaxBodyBytes = 5 * 1024 * 1024;

    /// <summary>The forwarded response-header names as a JS array literal, for the
    /// generated page script. Derived from <see cref="ProxyHeaderRules.ResponseAllowList"/>
    /// so the browser tier cannot fall behind the host's own list — the same reason
    /// tools/ProxyHeaders derives its parity check from that property rather than from a
    /// copy.</summary>
    private static string ResponseHeaderNamesJs =>
        "[" + string.Join(",", ProxyHeaderRules.ResponseAllowList
            .Select(n => System.Text.Json.JsonSerializer.Serialize(n))) + "]";

    /// <summary>The ceiling for one request: what the caller asked for, but never above
    /// <see cref="MaxBodyBytes"/>.</summary>
    /// <remarks>
    /// A widget can LOWER its own ceiling per call (WW.fetch's init.maxBytes) and cannot
    /// raise it — the clamp is here rather than trusted from the message because the number
    /// arrives from the widget, and a ceiling a widget can lift is not a ceiling.
    ///
    /// It has to reach this tier at all, though, or "lowered" means only that the wrapper in
    /// the page throws afterwards: the host would still have fetched, buffered, base64'd and
    /// posted the full 5 MiB first, which is every cost the number was meant to avoid. Zero
    /// and negative mean "unspecified" — the default, not a refusal of everything.
    /// </remarks>
    public static int EffectiveCap(long requested) =>
        requested > 0 && requested < MaxBodyBytes ? (int)requested : MaxBodyBytes;

    /// <summary>A declared Content-Length that is already past the ceiling.</summary>
    /// <remarks>Zero and negative are NOT over: a missing or unparsed length is unknown, not
    /// large, and refusing on it would reject every chunked response. The streaming check
    /// below is what actually holds the line — this only avoids reading a body that has
    /// already announced it is too big.</remarks>
    public static bool DeclaredTooLarge(long contentLength, int maxBytes) => contentLength > maxBytes;

    /// <summary>Would appending <paramref name="adding"/> bytes to <paramref name="soFar"/>
    /// cross the ceiling?</summary>
    /// <remarks>Asked BEFORE the append, so the bytes past the bound are never held. A check
    /// afterwards would have already paid for them, which on this path is the entire cost
    /// being avoided.</remarks>
    public static bool WouldExceed(long soFar, int adding, int maxBytes) => soFar + adding > maxBytes;

    /// <summary>The in-page script the browser tier runs to fetch a URL on the target's own
    /// origin, capped.</summary>
    /// <remarks>
    /// Built here so the ceiling reaches the page as the SAME constant the proxy tier uses.
    /// It had to be enforced inside the page rather than after: the body used to be read with
    /// arrayBuffer(), turned into a binary string, base64-encoded, handed across
    /// ExecuteScriptAsync, JSON-parsed and decoded — six copies of a length the remote server
    /// chooses, before anything on the C# side could have looked at it. Streaming with a
    /// budget and cancelling the reader means the bytes past the bound are never received at
    /// all.
    ///
    /// The result shape is unchanged except for `tooLarge`, which the caller treats as a
    /// failed fetch — the same as any other browser-tier failure, so no widget learns a new
    /// error mode from this.
    /// </remarks>
    /// <param name="jsUrl">The URL as a JSON-quoted JS string literal.</param>
    /// <param name="jsHeaders">The request headers as a JSON object literal.</param>
    /// <param name="maxBytes">The ceiling for this request — the caller's own if it asked
    /// for a lower one, clamped here so a script can never be generated with a higher
    /// ceiling than the host enforces elsewhere. This tier is entered when the remote
    /// server answers 403 or 429, which for the widget that needs it most (Reddit, whose
    /// TLS fingerprinting is why this tier exists at all) is EVERY request — so a
    /// per-request ceiling that stopped at the proxy tier would be absent exactly where
    /// its widget relies on it.</param>
    public static string BrowserFetchScript(string jsUrl, string jsHeaders, int maxBytes) => $$"""
        (() => {
          window.__wwResult = null;
          const MAX = {{EffectiveCap(maxBytes)}};
          // GENERATED from ProxyHeaderRules.ResponseAllowList, never typed out here. This
          // tier and the proxy tier answer the same WW.fetch call, so a widget must be able
          // to read the same headers whichever one served it — and a list kept in two
          // places is a list that drifts, which on the REQUEST side it did three times.
          const KEEP = {{ResponseHeaderNamesJs}};
          const readHeaders = (r) => {
            const out = {};
            for (const k of KEEP) { const v = r.headers.get(k); if (v !== null) out[k] = v; }
            return out;
          };
          const fail = (e) => { window.__wwResult = { status: 0, ct: '', b64: '', error: String(e) }; };
          fetch({{jsUrl}}, { credentials: 'include', headers: {{jsHeaders}} })
            .then(async (r) => {
              const declared = Number(r.headers.get('content-length') || 0);
              if (declared > MAX) {
                // Cancel, do not merely return. Walking away from an unread body leaves the
                // transfer running to completion in the background — the whole oversized
                // response still crosses the wire, which is most of what the ceiling exists
                // to prevent. Refusing early is only a saving if the socket is torn down.
                try { await r.body.cancel(); } catch (e) { /* nothing to cancel */ }
                window.__wwResult = { status: r.status, ct: '', b64: '', tooLarge: true, size: declared };
                return;
              }
              // 204 and 205 forbid a body, and Fetch exposes r.body as null for them.
              // arrayBuffer() used to absorb that as an empty read; getReader() throws, and
              // the throw would land in the catch below, discard a SUCCESSFUL retry, and
              // leave the widget holding the 403 the proxy tier got. An empty body is an
              // answer, not a failure.
              if (!r.body) {
                window.__wwResult = { status: r.status, ct: r.headers.get('content-type') || '', b64: '', headers: readHeaders(r) };
                return;
              }
              const chunks = [];
              let total = 0;
              const reader = r.body.getReader();
              for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                if (total + value.length > MAX) {
                  try { await reader.cancel(); } catch (e) { /* already closed */ }
                  window.__wwResult = { status: r.status, ct: '', b64: '', tooLarge: true, size: total + value.length };
                  return;
                }
                chunks.push(value);
                total += value.length;
              }
              const bytes = new Uint8Array(total);
              let at = 0;
              for (const c of chunks) { bytes.set(c, at); at += c.length; }
              let bin = '';
              for (let i = 0; i < bytes.length; i += 0x8000)
                bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
              window.__wwResult = { status: r.status, ct: r.headers.get('content-type') || '', b64: btoa(bin), headers: readHeaders(r) };
            })
            .catch(fail);
        })();
        """;
}
