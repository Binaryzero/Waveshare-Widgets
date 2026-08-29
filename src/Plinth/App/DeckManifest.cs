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
    /// Device models that are NETWORK-attached virtual decks, with no window on this
    /// desktop at all.
    /// </summary>
    /// <remarks>
    /// "VSD2/WiFi" is the device iCUE creates through its own bridge — a different icon in
    /// the Stream Deck app, a different model string here, and, decisively, a different
    /// TRANSPORT. iCUE's Streamdeck widget is a network client of it: it pairs (hence the
    /// widget's "Go to the Stream Deck app and approve the iCUE connection" card),
    /// receives per-key faces pushed over the wire as data URLs, and sends presses back
    /// the same way. Nothing about it is on this desktop to capture or click.
    ///
    /// So this is NOT simply another entry alongside <see cref="LocalWindowModels"/>. The
    /// two are different mechanisms, and conflating them is what made the last round
    /// wrong: a "just add the model string" fix would have found the profile, published a
    /// grid, and then silently dropped every press, because the window the click path
    /// targets does not exist for this device. What IS readable is the profile on disk —
    /// grid, titles and static key images — which is real, and is all that is real
    /// without speaking Elgato's network protocol.
    /// </remarks>
    public static readonly IReadOnlyList<string> NetworkModels = ["VSD2/WiFi"];

    /// <summary>Every model the bridge recognizes, of either kind.</summary>
    public static IReadOnlyList<string> KnownModels { get; } =
        [.. LocalWindowModels, .. NetworkModels];

    /// <summary>Whether this model names a deck the bridge can read a profile for.</summary>
    public static bool IsKnownModel(string? model) => Matches(KnownModels, model);

    /// <summary>Whether this model's deck is drawn in a window here — the precondition for
    /// live capture and for clicks landing anywhere.</summary>
    public static bool IsLocalWindowModel(string? model) => Matches(LocalWindowModels, model);

    /// <summary>Whether this model is a network device, so faces come from the profile on
    /// disk and presses have nowhere local to go.</summary>
    public static bool IsNetworkModel(string? model) => Matches(NetworkModels, model);

    /// <remarks>
    /// Case- and whitespace-insensitive: these strings are written by other software and
    /// travel through JSON, and refusing a real deck over a stray space or a capital would
    /// reproduce the exact failure this list exists to fix. Nothing is inferred beyond the
    /// listed names — a substring or prefix rule would happily match an unrelated device.
    /// </remarks>
    private static bool Matches(IReadOnlyList<string> models, string? model) =>
        !string.IsNullOrWhiteSpace(model)
        && models.Contains(model.Trim(), StringComparer.OrdinalIgnoreCase);

    /// <summary>One profile on disk, reduced to what choosing between them needs.</summary>
    public readonly record struct ProfileCandidate(string Name, string Model, DateTime LastWriteUtc);

    /// <summary>
    /// Index of the profile to mirror, or -1 when none can be.
    /// </summary>
    /// <remarks>
    /// A NETWORK deck is never chosen, and that is the point of this function rather than
    /// an oversight in it. Its profile is perfectly readable — grid, titles, static key
    /// images — so mirroring it produces a convincing deck whose every key is dead. A
    /// widget that does not do what it says is worse than one that says it cannot: the
    /// dead deck looks like a bug in the buttons, while "no deck" names the thing to fix
    /// (create a Virtual Stream Deck in the Stream Deck app). Discovery still FINDS
    /// network decks, because saying which ones exist is how the caller explains itself.
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