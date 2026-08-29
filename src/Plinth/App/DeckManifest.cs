using System.Text.Json;

namespace Plinth.App;

/// <summary>
/// Reading the grid out of a Stream Deck profile manifest (issue #122).
///
/// Separated from StreamDeckBridge because it is a pure function of a JsonElement, and
/// because the way it failed was invisible: System.Text.Json's TryGetProperty THROWS
/// InvalidOperationException when the element is not an object, ReadProfile catches
/// everything, and the dashboard then reports "no Stream Deck". A profile carrying
/// `"Size": "5x3"` — a string where an object was assumed — therefore turned into an empty
/// deck rather than into grid inference from the occupied keys.
///
/// An empty Control Deck is the recurring field failure in this project, and a code path
/// that produces it silently is worth removing whether or not anyone has hit this one.
/// </summary>
public static class DeckManifest
{
    /// <summary>Columns and rows from Device.Size, or (null, null) when the manifest does
    /// not carry a usable pair.</summary>
    /// <remarks>
    /// Every step is optional by design: absent, wrong-typed and out-of-range all mean "not
    /// stated" and fall through to the caller's inference from occupied keys. A profile is
    /// third-party data from software this app does not control and whose format can change
    /// between versions — "shaped differently than expected" is a thing to survive, not a
    /// thing to fail on.
    ///
    /// TryGetProperty is only safe on an Object, so both Device and Size are checked. That
    /// is the whole defect: `size.TryGetProperty` on a JSON string throws, and the throw
    /// travelled all the way out to "profile unavailable".
    /// </remarks>
    public static (int? Cols, int? Rows) ReadDeviceSize(JsonElement manifest)
    {
        if (manifest.ValueKind != JsonValueKind.Object ||
            !manifest.TryGetProperty("Device", out var device) ||
            device.ValueKind != JsonValueKind.Object ||
            !device.TryGetProperty("Size", out var size) ||
            size.ValueKind != JsonValueKind.Object)
            return (null, null);

        int? Read(params string[] names)
        {
            foreach (var key in names)
                if (size.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.Number
                    && v.TryGetInt32(out var i) && i > 0 && i <= 32)
                    return i;
            return null;
        }
        return (Read("Columns", "Cols", "Width"), Read("Rows", "Height"));
    }

    /// <summary>Device.Model from a profile manifest, or null when it does not carry one.</summary>
    /// <remarks>
    /// Shape-safe for the same reason <see cref="ReadDeviceSize"/> is: TryGetProperty throws
    /// on a non-object, the caller catches everything, and a profile with an oddly-shaped
    /// Device would then be skipped in silence rather than reported as an unrecognized
    /// model. Silence is precisely how the model bug below stayed invisible.
    /// </remarks>
    public static string? ReadDeviceModel(JsonElement manifest)
    {
        if (manifest.ValueKind != JsonValueKind.Object ||
            !manifest.TryGetProperty("Device", out var device) ||
            device.ValueKind != JsonValueKind.Object ||
            !device.TryGetProperty("Model", out var model) ||
            model.ValueKind != JsonValueKind.String)
            return null;
        var s = model.GetString();
        return string.IsNullOrWhiteSpace(s) ? null : s.Trim();
    }

    /// <summary>
    /// Device models whose deck is drawn in a LOCAL WINDOW on this desktop, so it can be
    /// captured with PrintWindow and clicked with PostMessage.
    /// </summary>
    /// <remarks>
    /// "UI Stream Deck" is Elgato's own Virtual Stream Deck, created in the Stream Deck
    /// app. This is the deck Plinth's own Stream Deck widget mirrors, and the window is
    /// the whole mechanism: no window, no capture and no clicks.
    /// </remarks>
    public static readonly IReadOnlyList<string> LocalWindowModels = ["UI Stream Deck"];

    /// <summary>
    /// Device models this app recognizes but can never mirror: network-attached decks,
    /// with no window on this desktop at all.
    /// </summary>
    /// <remarks>
    /// "VSD2/WiFi" and "VSD/WiFi" are Elgato's model strings for a network-attached,
    /// Stream Deck Mobile-class device — a paired phone, or a bridge that registers as
    /// one, which is what Corsair's iCUE does. (Elgato's own marketplace-connect-for-obs
    /// maps both strings to "Stream Deck Mobile"; this file used to call VSD2/WiFi "the
    /// device iCUE creates", which is over-specific and wrong for the more likely owner.)
    ///
    /// They are recognized here, and never mirrored, for one reason each:
    ///
    /// RECOGNIZED, because dropping the strings is worse than keeping them. An unlisted
    /// model falls into the skipped-model branch, whose advice is "report that model
    /// string to have it added" — soliciting exactly the bug this list exists to prevent,
    /// for a model that provably can never be added.
    ///
    /// NEVER MIRRORED, because there is no way to press a key on one. This is settled, not
    /// pending, and the evidence is worth keeping so nobody re-opens it:
    ///   · Elgato's plugin WebSocket has no actuation command at all — keyDown/keyUp are
    ///     inbound only — and the SDK states the isolation as a design property: "it is
    ///     not possible to access or control actions that are not owned by your plugin".
    ///   · StreamDeckEmbeded, the project this bridge's technique comes from, IS a
    ///     registered plugin with the whole SDK available, and still falls back to
    ///     PostMessage on the deck window. A windowless device has no such fallback.
    ///   · The network transport is pairing-authenticated with no published spec and no
    ///     open-source client; every public reverse engineering is USB HID, which a
    ///     device with no USB endpoint cannot use.
    ///   · Corsair's own SDK exposes no Stream Deck surface, so there is no way in from
    ///     that side either.
    ///
    /// The profile on disk is still perfectly readable — grid, titles, static key images —
    /// and that is precisely the trap: mirroring it yields a convincing deck whose every
    /// key is dead, which reads as broken buttons rather than as a deck that was never
    /// going to work. Refusing it is the feature.
    /// </remarks>
    public static readonly IReadOnlyList<string> UnmirrorableModels = ["VSD2/WiFi", "VSD/WiFi"];

    /// <summary>Every model this app recognizes, mirrorable or not.</summary>
    public static IReadOnlyList<string> KnownModels { get; } =
        [.. LocalWindowModels, .. UnmirrorableModels];

    /// <summary>Whether this model names a deck the bridge can read a profile for.</summary>
    public static bool IsKnownModel(string? model) => Matches(KnownModels, model);

    /// <summary>Whether this model's deck is drawn in a window here — the precondition for
    /// live capture and for clicks landing anywhere.</summary>
    public static bool IsLocalWindowModel(string? model) => Matches(LocalWindowModels, model);

    /// <summary>Whether this model is recognized but can never be mirrored — no window
    /// here, and no local API that can press one of its keys.</summary>
    public static bool IsUnmirrorableModel(string? model) => Matches(UnmirrorableModels, model);

    /// <remarks>
    /// Case- and whitespace-insensitive: these strings are written by other software and
    /// travel through JSON, and refusing a real deck over a stray space or a capital would
    /// reproduce the exact failure this list exists to fix. Nothing is inferred beyond the
    /// listed names — a substring or prefix rule would happily match an unrelated device.
    /// </remarks>
    private static bool Matches(IReadOnlyList<string> models, string? model) =>
        !string.IsNullOrWhiteSpace(model)
        && models.Contains(model.Trim(), StringComparer.OrdinalIgnoreCase);

    /// <summary>
    /// Whether every deck this machine has is one we recognize AND cannot mirror — the
    /// only state in which telling the user "your decks are network-attached" is true.
    /// </summary>
    /// <remarks>
    /// <paramref name="skippedCount"/> is the load-bearing argument. Discovery drops
    /// profiles whose model it does not recognize, so "everything I found is unmirrorable"
    /// and "everything on the machine is unmirrorable" are different claims whenever
    /// anything was dropped — and it is the second one the user is shown. A machine with a
    /// network deck beside a local deck of an unrecognized model satisfies the first and
    /// not the second: advising that user to create another deck is wrong, when what they
    /// need is to report the model string they already have.
    ///
    /// The same distinction is already made for the log line one level up; this exists so
    /// the user-facing message cannot drift from it again.
    /// </remarks>
    public static bool IsUnmirrorableOnly(IReadOnlyList<string> foundModels, int skippedCount)
    {
        if (skippedCount != 0 || foundModels is null || foundModels.Count == 0)
            return false;
        foreach (var model in foundModels)
            if (!IsUnmirrorableModel(model))
                return false;
        return true;
    }

    /// <summary>One profile on disk, reduced to what choosing between them needs.</summary>
    public readonly record struct ProfileCandidate(string Name, string Model, DateTime LastWriteUtc);

    /// <summary>
    /// Index of the profile to mirror, or -1 when none can be.
    /// </summary>
    /// <remarks>
    /// An UNMIRRORABLE deck is never chosen, and that is the point of this function rather
    /// than an oversight in it. Its profile is perfectly readable — grid, titles, static
    /// key images — so mirroring it produces a convincing deck whose every key is dead. A
    /// widget that does not do what it says is worse than one that says it cannot: the
    /// dead deck looks like a bug in the buttons, while "no deck" names the thing to fix
    /// (create a Virtual Stream Deck in the Stream Deck app). Discovery still FINDS such
    /// decks, because saying which ones exist is how the caller explains itself.
    ///
    /// Among the eligible: an exact name wins (the user's setting), else the most recently
    /// edited — the deck they are actually using; directory order is not stable and "first
    /// found" made the mirrored deck flip between runs. A preferred name that matches
    /// nothing eligible falls through to that default rather than failing, which is what
    /// a stale setting or a renamed profile needs.
    /// </remarks>
    public static int ChooseMirrorable(IReadOnlyList<ProfileCandidate> candidates, string? preferredName)
    {
        if (candidates is null || candidates.Count == 0)
            return -1;

        var best = -1;
        for (var i = 0; i < candidates.Count; i++)
        {
            if (!IsLocalWindowModel(candidates[i].Model))
                continue;
            if (!string.IsNullOrWhiteSpace(preferredName)
                && string.Equals(candidates[i].Name, preferredName, StringComparison.OrdinalIgnoreCase))
                return i;
            if (best < 0)
            {
                best = i;
                continue;
            }
            // Ties broken by name, ordinal, so a machine whose profiles share a timestamp
            // (a fresh install, a restored backup) mirrors the same deck on every poll
            // instead of alternating between them.
            var c = candidates[i].LastWriteUtc.CompareTo(candidates[best].LastWriteUtc);
            if (c > 0 || (c == 0 && string.CompareOrdinal(candidates[i].Name, candidates[best].Name) < 0))
                best = i;
        }
        return best;
    }
}