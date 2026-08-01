using System.Text.Json;

namespace WaveshareWidgets.App;

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
}
