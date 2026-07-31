namespace WaveshareWidgets;

/// <summary>
/// "Has this consumer already seen this frame?" for the live Stream Deck mirror (#127).
///
/// The capture channel skips re-sending pixels that have not changed — a base64 PNG per
/// poll, several times a second, is the cost this avoids. That decision used to be made
/// against ONE global hash, which was correct only because the answer was broadcast: the
/// frame that advanced the hash reached every live widget at the same moment.
///
/// Routing replies to the requester broke that coupling and the dedup with it. Two live
/// widgets polling out of phase would have the first advance the global hash and receive
/// the image, and the second be told "unchanged" about pixels it had never been sent —
/// permanently, for as long as the phases held. The global hash was load-bearing on a
/// property that no longer exists.
///
/// So the question is asked per consumer, which is what it always meant. The throttle in
/// the caller stays global and unchanged: it governs how often the screen is actually
/// captured, which is a cost concern, not who has seen what.
/// </summary>
public sealed class CaptureDedup
{
    private readonly Dictionary<string, string> _seen = new(StringComparer.Ordinal);
    private readonly int _capacity;

    /// <param name="capacity">Upper bound on remembered consumers. Slots come and go
    /// across page edits and reloads, so this cannot grow forever; past the bound the
    /// table is dropped, which costs one redundant frame each and nothing else.</param>
    public CaptureDedup(int capacity = 32) => _capacity = capacity;

    /// <summary>True when <paramref name="client"/> still needs the pixels for
    /// <paramref name="hash"/> — and records that it is about to receive them.</summary>
    /// <remarks>
    /// An unidentified caller (null or blank client) always needs the frame. It cannot be
    /// tracked, and the failure direction matters: sending a redundant image wastes
    /// bandwidth, while withholding one it never received freezes the widget.
    /// </remarks>
    public bool NeedsFrame(string? client, string? hash)
    {
        if (string.IsNullOrEmpty(hash)) return true;
        if (string.IsNullOrWhiteSpace(client)) return true;

        if (_seen.TryGetValue(client, out var last) && last == hash) return false;

        if (!_seen.ContainsKey(client) && _seen.Count >= _capacity) _seen.Clear();
        _seen[client] = hash;
        return true;
    }

    /// <summary>Forgets a consumer — used when its slot goes away, so a later slot
    /// reusing the tag is not told "unchanged" about a frame it never saw.</summary>
    public void Forget(string? client)
    {
        if (!string.IsNullOrWhiteSpace(client)) _seen.Remove(client);
    }

    internal int TrackedCount => _seen.Count;
}
