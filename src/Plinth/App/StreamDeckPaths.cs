namespace Plinth.App;

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
    /// wrong.
    ///
    /// Comparison is ORDINAL, not case-insensitive, even though Windows usually is not.
    /// Windows 10 supports per-directory case sensitivity, so `Profiles\Page` and
    /// `Profiles\page` can both exist — and OrdinalIgnoreCase would then let a path under
    /// one satisfy containment for the other. Ordinal is available to us because every
    /// candidate here is built by Path.Combine from the root itself and therefore carries
    /// the root's exact spelling. A caller that builds a candidate some other way, from a
    /// differently-spelled root, will be refused rather than silently trusted — the safe
    /// direction, and the reason this constraint is written down rather than assumed.
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
        return fullCandidate.StartsWith(fullRoot, StringComparison.Ordinal);
    }

    /// <summary>Is any component of <paramref name="candidate"/> below
    /// <paramref name="root"/> a junction or symbolic link?</summary>
    /// <remarks>
    /// <see cref="IsInside"/> is LEXICAL. Path.GetFullPath collapses `..` and normalises
    /// separators; it does not follow reparse points, and the read that comes afterwards
    /// does. So `pageDir\link\secret.png` satisfies containment while `link` targets
    /// somewhere else entirely — the containment check passes and the file read escapes
    /// anyway, which is the whole primitive back again by another route.
    ///
    /// Walks upward from the candidate to the root rather than resolving a final target:
    /// File.ResolveLinkTarget answers for the LAST component only, and the interesting case
    /// is a directory partway along the path.
    ///
    /// The root is INCLUDED. It is tempting to treat it as the app's own installation and
    /// stop above it, and that is wrong here: a page directory comes out of a profile
    /// bundle and each `.sdPlugin` directory out of the plugins folder, so the root handed
    /// to this method is itself something the input can choose. If it is a link, every path
    /// "inside" it is outside the tree that was meant. The root's ANCESTORS are not checked
    /// — those really are the installation, and a user who has relocated AppData or Program
    /// Files with a junction should not lose every icon over it.
    /// </remarks>
    public static bool CrossesLink(string root, string candidate)
    {
        string stop, current;
        try
        {
            stop = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar);
            current = Path.GetFullPath(candidate);
        }
        catch (Exception)
        {
            return true;   // unrepresentable: treat as unsafe rather than reason about it
        }
        while (current.Length >= stop.Length)
        {
            try
            {
                // Missing is fine: a component that does not exist cannot redirect a read,
                // and File.Exists further down is what decides whether there is anything to
                // read at all.
                if (File.Exists(current) || Directory.Exists(current))
                {
                    var attrs = File.GetAttributes(current);
                    if ((attrs & FileAttributes.ReparsePoint) != 0)
                        return true;
                }
            }
            catch (Exception)
            {
                return true;   // cannot tell — refuse
            }
            var parent = Path.GetDirectoryName(current);
            if (parent is null || parent == current)
                break;
            current = parent;
        }
        return false;
    }

    /// <summary>The question the resolver actually needs answered: may this candidate be
    /// opened?</summary>
    /// <remarks>Both halves, in one place, so a call site cannot take the lexical one and
    /// forget the other — which is precisely the mistake the first version of this file
    /// made.</remarks>
    public static bool IsSafeCandidate(string root, string candidate) =>
        IsInside(root, candidate) && !CrossesLink(root, candidate);
}
