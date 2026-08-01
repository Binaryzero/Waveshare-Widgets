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
        // CLAMPED, not discarded. A duration longer than any real capture is usually not a
        // measurement of work but of a SUSPENSION that fell between the two stamps:
        // Environment.TickCount64 is GetTickCount64, whose elapsed time includes sleep and
        // hibernate (that is why QueryUnbiasedInterruptTime exists as a separate API), so a
        // lid closed mid-capture reads back as a capture that took as long as the nap. Used
        // unclamped as a delay, that freezes the deck on its pre-suspend frame for another
        // nap's worth of time — the wedge this whole file is written to avoid.
        //
        // But an over-long duration must still cost SOMETHING, because the other reading of
        // it is a genuinely slow capture, and dropping the delay there hands a tight caller
        // continuous occupancy of the UI thread. Being slow is NOT self-limiting: the capture
        // blocks the thread while it runs, and the next queued poll is processed the instant
        // it returns — by which time the start-to-start floor is long satisfied. Clamping
        // gives both readings a bounded answer: at most this much idle after a nap, at least
        // this much idle after a slow capture.
        //
        // Clamped rather than measured with an unbiased clock on purpose: this class is pure
        // arithmetic, which is the only reason a probe can drive it at all, and reaching for a
        // Windows timing API would trade that away.
        var duration = Math.Min(lastEndMs - lastStartMs, MaxPlausibleCaptureMs);
        return nowMs - lastEndMs < duration;
    }

    /// <summary>Ceiling on the duty-cycle delay, in milliseconds.</summary>
    /// <remarks>
    /// Two jobs at once, which is why it is a clamp rather than a threshold. It is the longest
    /// delay a single capture can impose — so a suspension mistaken for a capture costs this
    /// and not the length of the nap — and it is the delay imposed by any capture at least
    /// this slow, so a genuinely expensive one still leaves the UI thread idle.
    ///
    /// A four-megapixel capture, the largest this file permits, is a PrintWindow, a sampled
    /// hash and a JPEG encode: far below this even on slow hardware, so a real capture is
    /// governed by its own duration and never by the clamp. The number only decides how the
    /// two pathological readings are treated, and it bounds both.
    /// </remarks>
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
