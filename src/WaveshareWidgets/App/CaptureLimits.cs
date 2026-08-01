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

    /// <summary>Largest total pixel count that will be captured at all.</summary>
    /// <remarks>
    /// The edge bound alone is not a budget. 8192x8192 satisfies it and is 64 megapixels —
    /// roughly 256 MiB of bitmap, allocated and then PrintWindow'd, hashed and JPEG-encoded
    /// synchronously on the UI thread, all before the encoded-size ceiling downstream gets
    /// to refuse the result. That ceiling cannot give the allocation back.
    ///
    /// Four megapixels is several times any real Virtual Stream Deck window (roughly
    /// 1200x500) and about 16 MiB of pixels, which is a cost the UI thread can absorb.
    /// </remarks>
    public const int MaxTotalPixels = 4_000_000;

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

    /// <summary>Would starting a capture now leave the UI thread busy more than half the
    /// time?</summary>
    /// <remarks>
    /// The second half of the rate limit, and it exists because a single fixed gap cannot
    /// satisfy both things the floor has to do.
    ///
    /// Measuring the gap from when a capture STARTED bounds how often one may begin, but
    /// leaves no idle time at all once a capture itself takes longer than the gap — the next
    /// one is authorised the instant this one returns. Measuring it from when a capture ENDED
    /// fixes that and breaks the honest caller instead: the widget supports a 150 ms poll, so
    /// a 60 ms capture plus a 100 ms idle floor pushes the next allowed start to 160 ms and
    /// the 150 ms poll is refused — fresh frames every 300 ms instead of every 150 ms.
    ///
    /// So the two are separate questions. <see cref="TooSoon"/> keeps the start-to-start
    /// floor, which is what the honest caller is measured against; this bounds the DUTY CYCLE,
    /// which is what the UI thread actually cares about. A capture may not begin until at
    /// least its own duration has passed since the last one finished, so the thread is idle
    /// at least half the time no matter how expensive a single capture becomes.
    ///
    /// The honest caller never meets it: a 60 ms capture on a 150 ms poll has 90 ms of idle
    /// before the next tick, which is more than the 60 ms required.
    /// </remarks>
    public static bool WouldExceedDutyCycle(long lastStartMs, long lastEndMs, long nowMs)
    {
        // No capture yet, or stamps that cannot be believed (a resumed machine, an end before
        // its own start). Same reasoning as TooSoon: refusing on nonsense would look exactly
        // like the deck being broken.
        if (lastStartMs <= 0 || lastEndMs < lastStartMs || nowMs < lastEndMs)
            return false;
        var duration = lastEndMs - lastStartMs;
        // A duration longer than any real capture is not a measurement of work — it is a
        // measurement of a SUSPENSION that happened to fall between the two stamps.
        // Environment.TickCount64 is GetTickCount64, whose elapsed time includes sleep and
        // hibernate (that is why QueryUnbiasedInterruptTime exists as a separate API), so a
        // lid closed mid-capture reads back as a capture that took as long as the nap. Used
        // as a delay, that refuses every capture for another nap's worth of time and the deck
        // sits on its pre-suspend frame — the wedge this whole file is written to avoid.
        //
        // Capped rather than measured with an unbiased clock on purpose: this class is pure
        // arithmetic, which is the only reason it can be driven from a probe at all, and
        // reaching for a Windows timing API here would trade that away to handle a case the
        // cap already handles. An implausible duration simply does not delay anything; the
        // start-to-start floor still applies, and a capture slow enough to be capped is
        // already self-limiting, since it blocks the UI thread it would be competing with.
        if (duration > MaxPlausibleCaptureMs)
            return false;
        return nowMs - lastEndMs < duration;
    }

    /// <summary>Longest duration still believed to be a capture rather than a suspension.</summary>
    /// <remarks>A four-megapixel capture — the largest this file permits — is a PrintWindow, a
    /// sampled hash and a JPEG encode, which is far below this even on slow hardware. Erring
    /// LOW is the safe direction: too low only forgoes the duty-cycle delay for a freakishly
    /// slow capture, while too high leaves the deck frozen after a resume.</remarks>
    public const int MaxPlausibleCaptureMs = 2000;

    /// <summary>Is a window of this size worth capturing?</summary>
    public static bool SaneSize(int width, int height) =>
        width > 0 && height > 0 && width <= MaxEdgePixels && height <= MaxEdgePixels
        // long, not int: 8192*8192 is 67 million and fits, but a caller passing larger
        // edges would overflow the multiply and wrap to a small positive number — a size
        // check that says yes to the largest inputs of all.
        && (long)width * height <= MaxTotalPixels;

    /// <summary>Is the encoded frame small enough to send?</summary>
    public static bool EncodedTooLarge(long bytes) => bytes > MaxEncodedBytes;
}
