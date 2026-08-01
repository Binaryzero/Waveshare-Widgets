namespace WaveshareWidgets.App;

/// <summary>
/// Bounds on live Stream Deck window capture (issue #114, item 3).
///
/// A capture is a synchronous PrintWindow, a full-bitmap pixel scan, a JPEG encode and a
/// base64 of the result, all on the UI thread. Nothing bounded how often that could be asked
/// for or how large the answer could be, so a widget polling in a tight loop degrades the
/// dashboard without needing to be hostile — a fast poll is the documented way to use this
/// API, and "faster" had no floor.
///
/// The two decisions are pure arithmetic, which is the whole reason they live here: the
/// capture itself needs Windows, a running Stream Deck and a real window handle, and none of
/// that is reachable from a test.
/// </summary>
public static class CaptureLimits
{
    /// <summary>Smallest gap between two captures, in milliseconds.</summary>
    /// <remarks>The widget polls about four times a second by design and the deck is idle
    /// most of the time, so this is a floor rather than a target: it bounds the worst case
    /// without changing the intended one. Well under the poll interval, so an honest caller
    /// never meets it.</remarks>
    public const int MinIntervalMs = 100;

    /// <summary>Largest encoded frame handed across the bridge, in bytes.</summary>
    /// <remarks>A Virtual Stream Deck window is a few hundred KB as JPEG. This is generous
    /// enough that a real capture never trips it and small enough that a pathological one —
    /// a window resized to something enormous — does not cross the bridge, get base64'd, and
    /// land in a widget's renderer.</remarks>
    public const int MaxEncodedBytes = 2 * 1024 * 1024;

    /// <summary>Largest window edge, in pixels, that will be captured at all.</summary>
    /// <remarks>Checked BEFORE allocating the bitmap. Refusing after the allocation would
    /// have already paid for it, which on this path is the entire cost being avoided — the
    /// same reasoning as the fetch ceiling's check-before-append.</remarks>
    public const int MaxEdgePixels = 8192;

    /// <summary>Is this capture too soon after the previous one?</summary>
    /// <remarks>Takes both stamps rather than reading the clock, so the decision stays a
    /// function of its inputs and can be driven without waiting in real time. A
    /// <paramref name="lastMs"/> of zero means "none yet" and is never too soon; a clock that
    /// appears to move backwards (a resumed machine) is treated the same way rather than
    /// blocking every future capture.</remarks>
    public static bool TooSoon(long lastMs, long nowMs)
    {
        if (lastMs <= 0 || nowMs < lastMs)
            return false;
        return nowMs - lastMs < MinIntervalMs;
    }

    /// <summary>Is a window of this size worth capturing?</summary>
    public static bool SaneSize(int width, int height) =>
        width > 0 && height > 0 && width <= MaxEdgePixels && height <= MaxEdgePixels;

    /// <summary>Is the encoded frame small enough to send?</summary>
    public static bool EncodedTooLarge(long bytes) => bytes > MaxEncodedBytes;
}
