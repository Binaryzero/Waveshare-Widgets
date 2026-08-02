namespace WaveshareWidgets.App;

/// <summary>
/// Whether a completed notification poll may still publish its result (issue #132).
///
/// A poll is `async void` and awaits real I/O, so it can be in flight for a long time.
/// Turning demand off disposes the timer but cannot cancel a poll that is already awaiting,
/// so that poll resumes and tries to publish whatever it found — under whatever demand
/// happens to exist by then.
///
/// The decision is extracted because the poll itself needs WinRT, a packaged identity and a
/// user with real toasts, none of which a test can reach; the part that was wrong is a
/// comparison of three values.
/// </summary>
public static class NotificationGate
{
    /// <summary>May a poll that began in <paramref name="pollEpoch"/> publish now?</summary>
    /// <remarks>
    /// The epoch is the load-bearing part and the reason the other two are not enough.
    ///
    /// Checking <paramref name="watching"/> alone asks whether ANYONE is watching at the
    /// moment the poll finishes, not whether this poll belongs to that watching. Demand can
    /// go off and back on while a poll awaits, and the flag reads true again at the end.
    ///
    /// Checking the signature alone does not help either, and specifically fails in exactly
    /// this case: re-declaring demand deliberately clears the last signature so a rebuilt
    /// widget gets a full push rather than sitting on "loading". A stale payload therefore
    /// arrives with nothing to be deduplicated against — the dedup guard is not merely
    /// bypassed, it has just been reset for a reason that has nothing to do with staleness.
    ///
    /// So the epoch is what distinguishes "found while THIS demand was in force" from
    /// "found earlier and delivered late". It is bumped on every change to the demand
    /// situation, including a repeated on, which is a new shell page re-declaring demand
    /// its predecessor never withdrew — a poll begun for the previous page describes a
    /// document that no longer exists.
    /// </remarks>
    public static bool ShouldPush(long pollEpoch, long currentEpoch, string signature,
                                  string lastSignature, bool watching) =>
        pollEpoch == currentEpoch
        && watching
        // Unchanged content is not worth a push and never was; kept last because it is the
        // cheap dedup, not the staleness rule, and conflating the two is what let a stale
        // payload through when the signature had just been cleared.
        && !string.Equals(signature, lastSignature, StringComparison.Ordinal);
}
