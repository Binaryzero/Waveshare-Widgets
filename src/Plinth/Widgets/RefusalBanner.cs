namespace Plinth.Widgets;

/// <summary>A widget on disk that the library refused to load, and why (issue #57).
///
/// Refusing is the whole point of the credential rule, but a refusal that only reaches
/// app.log means the user's first symptom is a tile that quietly stopped existing. The
/// settings window reads this list so the reason is visible where the widget isn't.
///
/// <paramref name="RedactNames"/> is redaction metadata, not display data: a refused
/// widget has no manifest in the library, so nothing downstream can tell which of its
/// stored settings are credentials. Carrying the names here is what lets the two windows
/// plan those addresses as <see cref="SecretIntent.ProtectWithoutReveal"/> — masked,
/// encrypted, never handed back out — instead of the refusal itself publishing the
/// plaintext it was raised over.</summary>
public sealed record RejectedWidget(
    string Id, string Name, string Folder, string Reason, IReadOnlyList<string> RedactNames);

/// <summary>One entry in the settings window's refusal banner.</summary>
/// <param name="Shadowed">A same-id widget loaded; this is an older refused copy beside it.</param>
/// <param name="Withheld">For a shadowed refusal: the settings the loaded copy declares that
/// this refusal is keeping from it. Empty otherwise.</param>
public sealed record BannerRefusal(RejectedWidget Refusal, bool Shadowed, IReadOnlyList<string> Withheld);

/// <summary>Which refusals the settings banner shows (#151). Pure, so tools/SecretRoundTrip
/// covers it without the library's scan.</summary>
public static class RefusalBanner
{
    /// <summary>A refusal with no loaded widget of its id is always shown: the widget is
    /// unavailable. A refusal SHADOWED by a same-id widget that loaded is shown only when it
    /// withholds something from that copy: its credential names are planned
    /// ProtectWithoutReveal for the id, so a name the loaded copy also declares never
    /// reaches it. Upgrading by unzipping a fixed version beside the refused one does exactly
    /// that, and until this the only trace was a line in app.log. A shadowed refusal that
    /// withholds nothing stays hidden: telling the user a working widget is unavailable
    /// sends them looking for a problem they do not have.
    ///
    /// Ids match ordinally, as the library's duplicate resolution does.</summary>
    public static IReadOnlyList<BannerRefusal> Entries(
        IEnumerable<RejectedWidget> refusals, Func<string, WidgetManifest?> loadedById)
    {
        var entries = new List<BannerRefusal>();
        foreach (var r in refusals)
        {
            if (loadedById(r.Id) is not { } loaded)
            {
                entries.Add(new BannerRefusal(r, false, []));
                continue;
            }
            var declared = new HashSet<string>(
                loaded.Properties.Select(p => p.Name).Where(n => !string.IsNullOrEmpty(n)), StringComparer.Ordinal);
            var withheld = r.RedactNames.Where(declared.Contains).Distinct(StringComparer.Ordinal).ToList();
            if (withheld.Count > 0)
                entries.Add(new BannerRefusal(r, true, withheld));
        }
        return entries;
    }
}
