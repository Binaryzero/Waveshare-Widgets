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
    private readonly Queue<string> _order = new();
    private readonly int _capacity;

    /// <param name="capacity">Upper bound on remembered consumers. Consumers are per
    /// DOCUMENT, so every slot reload mints a new one and the table cannot be allowed to
    /// grow forever.
    ///
    /// Past the bound the OLDEST entry is evicted, not the whole table. Clearing it
    /// looked simpler and was much worse: with more consumers than the bound, the first
    /// unknown one wipes everyone, the next poll from each of the others then looks new
    /// and wipes it again, and the dedup collapses into re-sending a full base64 frame on
    /// nearly every poll — the exact cost it exists to avoid, arriving only once someone
    /// has enough widgets to care.</param>
    public CaptureDedup(int capacity = 64) => _capacity = capacity;

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

        if (!_seen.ContainsKey(client))
        {
            while (_seen.Count >= _capacity && _order.Count > 0)
            {
                var oldest = _order.Dequeue();
                _seen.Remove(oldest);
            }
            _order.Enqueue(client);
        }
        _seen[client] = hash;
        return true;
    }

    // There is deliberately no Forget(). An earlier version had one, for a slot going
    // away — and nothing ever called it, while a probe exercised it and so looked like
    // coverage of a path that did not exist. The shell now varies the consumer identity
    // per document instead, which needs no cross-boundary lifecycle call at all and
    // cannot be forgotten to make.

    internal int TrackedCount => _seen.Count;
}
