namespace WaveshareWidgets.App;

/// <summary>
/// The two questions the Stream Deck icon resolver has to ask before a profile-supplied
/// string reaches the filesystem (issue #115).
///
/// A Stream Deck profile is written by Elgato's software from the user's own configuration,
/// so nothing here is remotely reachable in normal use — it needs a crafted or imported
/// profile. What raises it above a parse quirk is where the answer goes: a resolved icon is
/// base64'd into the profile payload and handed to a widget, so an arbitrary-file-read
/// primitive ends up somewhere a widget can read it.
///
/// Both are pure functions of strings, deliberately. The resolver itself needs a Stream Deck
/// installation, a profile on disk and a running bridge; none of that is reachable from a
/// test, and the part that was wrong is the part that is just string handling.
/// </summary>
public static class StreamDeckPaths
{
    /// <summary>Is this a UUID a real Stream Deck plugin or action could have?</summary>
    /// <remarks>
    /// REJECT, never sanitise. Stripping the dangerous parts of a hostile string leaves you
    /// reasoning about what is left, and the answer to "what does `..%c0%af..` become after
    /// my cleanup" is a worse question than "is this in the alphabet at all". Real UUIDs look
    /// like `com.elgato.discord.mute`: reverse-DNS, dots, dashes, underscores.
    ///
    /// The separator check is spelled out at the CHARACTER level rather than left to
    /// Path.GetFullPath, and that is not redundancy. This code only ever runs on Windows,
    /// where `\` separates paths — but the probe for it runs wherever the suite runs, and on
    /// Linux `Path.GetFullPath` treats `\` as an ordinary filename character. A containment
    /// check alone would therefore pass a probe on Linux for a string that escapes on
    /// Windows, which is the exact shape of a test that measures the wrong platform.
    /// </remarks>
    public static bool IsPlausibleUuid(string? uuid)
    {
        if (string.IsNullOrEmpty(uuid))
            return false;
        // A UUID is never this long; the cap keeps a pathological string out of Path.Combine
        // before anything else looks at it.
        if (uuid.Length > 200)
            return false;
        foreach (var c in uuid)
        {
            var ok = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')
                     || c == '.' || c == '-' || c == '_';
            if (!ok)
                return false;
        }
        // `..` is in the alphabet above and is the whole attack, so it is excluded by name.
        // Checked per dot-separated part rather than as a substring: `com.elgato..mute` has an
        // empty part and a literal `..`, while `a..b` as a Windows path segment is a parent
        // reference. Neither is a real UUID.
        foreach (var part in uuid.Split('.'))
        {
            if (part.Length == 0)
                return false;
        }
        return true;
    }

    /// <summary>Does <paramref name="candidate"/> resolve to something inside
    /// <paramref name="root"/>?</summary>
    /// <remarks>
    /// Defence in depth behind <see cref="IsPlausibleUuid"/>: the resolver builds paths from
    /// more than the UUIDs (mapped action names, extensions, fixed subdirectories), and a
    /// containment check is the thing that stays true when someone adds another candidate
    /// shape to that list without thinking about this file.
    ///
    /// The trailing separator on the root matters: without it `C:\Plugins` contains
    /// `C:\PluginsEvil\x.png` by prefix, which is the classic way this check is written
    /// wrong. Comparison is case-insensitive because the filesystem this runs on is.
    /// </remarks>
    public static bool IsInside(string root, string candidate)
    {
        if (string.IsNullOrEmpty(root) || string.IsNullOrEmpty(candidate))
            return false;
        string fullRoot, fullCandidate;
        try
        {
            fullRoot = Path.GetFullPath(root);
            fullCandidate = Path.GetFullPath(candidate);
        }
        catch (Exception)
        {
            // Unrepresentable path (bad characters, too long, malformed root). Not inside.
            return false;
        }
        if (!fullRoot.EndsWith(Path.DirectorySeparatorChar))
            fullRoot += Path.DirectorySeparatorChar;
        return fullCandidate.StartsWith(fullRoot, StringComparison.OrdinalIgnoreCase);
    }
}
