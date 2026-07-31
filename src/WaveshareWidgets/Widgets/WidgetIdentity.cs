using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

namespace WaveshareWidgets.Widgets;

/// <summary>
/// Who is allowed to be whom, and where each widget's origin comes from (#93, #94).
///
/// A widget's virtual host IS its browser origin: localStorage, credentials, everything
/// the same-origin policy separates. So "which widget owns this host" is a security
/// decision, and every input to it that an untrusted manifest can choose is a way to
/// take another widget's storage. Two such inputs existed:
///
/// * the manifest VERSION decided which of two same-id folders won, and one side of that
///   comparison ships with the attacker's package;
/// * directory ENUMERATION ORDER decided which of two slug-colliding ids got the clean
///   host whenever the persisted map was empty.
///
/// Everything here is a pure function of ids and folder names, so it can be exercised
/// without a widgets folder, a WebView, or Windows — see tools/WidgetIdentity.
/// </summary>
public static partial class WidgetIdentity
{
    /// <summary>Id namespace reserved for widgets the app itself ships.</summary>
    public const string ReservedPrefix = "ws.stock.";

    public const string HostSuffix = ".widgets.wsw";

    /// <summary>Lowercases a widget id into a hostname-safe label
    /// ("com.example.CPU" -&gt; "com-example-cpu").</summary>
    public static string Slug(string id)
    {
        var slug = SlugPattern().Replace(id.ToLowerInvariant(), "-").Trim('-');
        return slug.Length == 0 ? "widget" : slug;
    }

    [GeneratedRegex("[^a-z0-9-]+")]
    private static partial Regex SlugPattern();

    /// <summary>Short stable discriminator for host-slug collisions between distinct ids.</summary>
    public static string ShortHash(string value)
    {
        var bytes = SHA256.HashData(Encoding.UTF8.GetBytes(value));
        return Convert.ToHexString(bytes, 0, 4).ToLowerInvariant();
    }

    /// <summary>Is this id in the namespace reserved for stock widgets?</summary>
    /// <remarks>Ordinal-ignore-case: the check must not be dodged by "WS.Stock.Hue", and
    /// it must not depend on the machine's culture the way a linguistic comparison would
    /// (Turkish dotless-i is the classic way an id sails past a case-insensitive prefix
    /// test written the obvious way).</remarks>
    public static bool IsReserved(string? id) =>
        id is not null && id.StartsWith(ReservedPrefix, StringComparison.OrdinalIgnoreCase);

    /// <summary>
    /// May the widget folder named <paramref name="folderName"/> claim <paramref name="id"/>?
    /// </summary>
    /// <param name="stockFolderIds">Folder name → manifest id, read from the stock widgets
    /// shipped NEXT TO THE EXE. That directory is the provenance: it is written by the
    /// installer, not by anything a package can reach, so it is the one statement about
    /// stock identity that a hostile manifest cannot edit.</param>
    /// <remarks>
    /// Unreserved ids may come from anywhere — that is the whole point of installing a
    /// widget. A RESERVED id is only ever legitimate from the folder the seeder puts it
    /// in, so a package claiming "ws.stock.hue" (which extracts to ws-stock-hue/, never
    /// to hue/) is refused before it can share an origin with the widget it is imitating.
    ///
    /// A reserved id the app ships NOTHING by belongs to nobody: refused everywhere. A
    /// retired stock widget must not become a name anyone can pick up.
    /// </remarks>
    public static bool MayClaim(string? id, string folderName,
                                IReadOnlyDictionary<string, string> stockFolderIds)
    {
        if (string.IsNullOrEmpty(id))
            return false;
        if (!IsReserved(id))
            return true;
        foreach (var (stockFolder, stockId) in stockFolderIds)
        {
            if (!string.Equals(stockId, id, StringComparison.Ordinal))
                continue;
            return string.Equals(stockFolder, folderName, StringComparison.OrdinalIgnoreCase);
        }
        return false;
    }

    /// <summary>The folder a package declaring <paramref name="id"/> would be extracted
    /// into — and therefore the copy that the installer, not a leftover, produced.</summary>
    public static string InstallFolderName(string id) => Slug(id);

    /// <summary>
    /// Two folders declare the same id. Which one loads?
    /// </summary>
    /// <returns>true to prefer <paramref name="candidateFolder"/> over <paramref name="keptFolder"/>.</returns>
    /// <remarks>
    /// NOT by version. Version used to decide this, and a package ships its own: claiming
    /// 999.0.0 was enough to shadow the copy already installed under that id and inherit
    /// its origin. One side of that comparison was always attacker-controlled.
    ///
    /// Provenance decides instead. The installer extracts to Slug(id) and nowhere else, so
    /// the folder with that name is the copy the app itself wrote; anything else is a
    /// leftover, a hand-copied folder, or a rename. Ordinal folder name breaks the
    /// remaining tie so the answer does not depend on enumeration order.
    ///
    /// This does not regress what the version tiebreak was added for — a stale package
    /// copy shadowing a fresh stock re-seed. That case cannot reach here at all now:
    /// a reserved id from a non-stock folder is refused outright by <see cref="MayClaim"/>.
    /// </remarks>
    public static bool PreferCandidate(string id, string candidateFolder, string keptFolder)
    {
        var canonical = InstallFolderName(id);
        var candidateIsCanonical = string.Equals(candidateFolder, canonical, StringComparison.OrdinalIgnoreCase);
        var keptIsCanonical = string.Equals(keptFolder, canonical, StringComparison.OrdinalIgnoreCase);
        if (candidateIsCanonical != keptIsCanonical)
            return candidateIsCanonical;
        return string.CompareOrdinal(candidateFolder, keptFolder) < 0;
    }

    /// <summary>
    /// Assigns a virtual host to every id that does not already have one, without letting
    /// enumeration order decide who gets the clean host.
    /// </summary>
    /// <param name="ids">Every id resolved by this scan, in any order.</param>
    /// <param name="existing">The persisted id → host map. Entries here are never
    /// reassigned: an id keeps its origin forever, which is what protects the widget that
    /// already has data under it.</param>
    /// <returns>Only the NEW assignments. An empty result means nothing changed and the
    /// map on disk does not need rewriting.</returns>
    /// <remarks>
    /// Two passes, and the first one is the fix. When the map is empty — an upgrade from
    /// a build that had none, or a scan that could not read the file — every id needs an
    /// assignment at once. Handing the clean host to whichever id was resolved first means
    /// a widget that slug-collides with one the user already trusts can take the origin
    /// that widget's tokens live under, decided by nothing more than directory order.
    ///
    /// So: count the claimants per slug FIRST. A slug with more than one claimant gives
    /// the clean host to none of them — every claimant is suffixed with a hash of its own
    /// id. Nobody inherits, and the loser of a race that no longer exists loses nothing it
    /// could not have lost by being enumerated second.
    ///
    /// Fresh ids are assigned in ordinal order rather than the caller's, so the same
    /// installed set produces the same hosts on every scan, on every machine.
    ///
    /// KNOWN LIMIT: this cannot protect an origin whose widget is gone. If the map is lost
    /// AND the widget that held a host has been uninstalled, a later widget slugging to the
    /// same name is the only claimant and takes it, along with whatever storage the browser
    /// still holds for that origin. Only the persisted map remembers retired owners, which
    /// is why an unreadable map is never overwritten (see WidgetLibrary.LoadHostMap).
    /// </remarks>
    public static Dictionary<string, string> AssignHosts(
        IEnumerable<string> ids, IReadOnlyDictionary<string, string> existing)
    {
        var used = new HashSet<string>(existing.Values, StringComparer.OrdinalIgnoreCase);
        var fresh = ids.Where(id => !existing.ContainsKey(id))
                       .Distinct(StringComparer.Ordinal)
                       .OrderBy(id => id, StringComparer.Ordinal)
                       .ToList();

        var claimants = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
        foreach (var id in fresh)
        {
            var slug = Slug(id);
            claimants[slug] = claimants.TryGetValue(slug, out var n) ? n + 1 : 1;
        }

        var assigned = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var id in fresh)
        {
            var slug = Slug(id);
            var host = slug + HostSuffix;
            if (claimants[slug] > 1 || !used.Add(host))
            {
                host = $"{slug}-{ShortHash(id)}{HostSuffix}";
                for (var bump = 2; !used.Add(host); bump++)
                    host = $"{slug}-{ShortHash(id)}{bump}{HostSuffix}";
            }
            assigned[id] = host;
        }
        return assigned;
    }
}
