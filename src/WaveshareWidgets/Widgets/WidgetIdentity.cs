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

    /// <summary>Key prefix for host-map entries that reserve an origin without granting it
    /// to anyone. Contains NUL so no manifest id can collide with one — and
    /// <see cref="MayClaim"/> refuses any id that starts with it anyway, because a widget
    /// answering to a reservation key would be handed the very origin the reservation
    /// exists to keep away from it.</summary>
    public const string ReservationPrefix = "\0reserved-host\0";

    /// <summary>A widget the app ships: where it lives in the shipped folder, the id it
    /// declares, and a content hash of the shipped files.</summary>
    /// <param name="Fingerprint">The authority. A folder NAME says nothing about who wrote
    /// what is in it — the widgets directory is documented as a place users unzip things
    /// into (docs/WIDGET-SPEC.md), so the name is attacker-reachable and the contents are
    /// the only thing that is not.</param>
    public readonly record struct StockWidget(string FolderName, string Id, string Fingerprint);

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
    /// <param name="installedFingerprint">Content hash of the folder making the claim,
    /// computed the same way as <see cref="StockWidget.Fingerprint"/>.</param>
    /// <param name="stock">The widgets the app ships, read from next to the exe — the one
    /// statement about stock identity that installing a widget cannot edit.</param>
    /// <remarks>
    /// Unreserved ids may come from anywhere — that is the whole point of installing a
    /// widget. A RESERVED id is only legitimate from the seeded copy, and "the seeded copy"
    /// is decided by CONTENT, not by folder name.
    ///
    /// The name is not evidence. `docs/WIDGET-SPEC.md` tells users to unzip widgets straight
    /// into the widgets directory, and file changes there hot-reload — so anyone who can
    /// talk a user into unzipping an archive can put whatever they like in `widgets/hue`
    /// and declare `ws.stock.hue`. Checking the name would have accepted it, and the rescan
    /// the unzip itself triggers would then serve it from the real Hue widget's origin,
    /// where that widget's bridge token lives. Re-seeding repairs this at the next launch,
    /// which is far too late: the watcher rescan happens immediately.
    ///
    /// So the folder must hash to exactly what shipped. An attacker can copy the name, and
    /// can copy the seed marker (it is just a file), but cannot produce different content
    /// with the same hash.
    ///
    /// A reserved id the app ships NOTHING by belongs to nobody: refused everywhere. A
    /// retired stock widget must not become a name anyone can pick up.
    /// </remarks>
    public static bool MayClaim(string? id, string folderName, string? installedFingerprint,
                                IReadOnlyList<StockWidget> stock)
    {
        if (string.IsNullOrEmpty(id))
            return false;
        // A widget answering to a reservation key would be handed the origin that key
        // exists to withhold. Nothing legitimate declares an id with a NUL in it.
        if (id.StartsWith(ReservationPrefix, StringComparison.Ordinal))
            return false;
        if (!IsReserved(id))
            return true;
        foreach (var shipped in stock)
        {
            if (!string.Equals(shipped.Id, id, StringComparison.Ordinal))
                continue;
            return string.Equals(shipped.FolderName, folderName, StringComparison.OrdinalIgnoreCase)
                && !string.IsNullOrEmpty(installedFingerprint)
                && string.Equals(installedFingerprint, shipped.Fingerprint, StringComparison.Ordinal);
        }
        return false;
    }

    /// <summary>The folder a package declaring <paramref name="id"/> would be extracted
    /// into — and therefore the copy that the installer, not a leftover, produced.</summary>
    public static string InstallFolderName(string id) => Slug(id);

    /// <summary>The shipped set, minus widgets the app has retired.</summary>
    /// <remarks>
    /// The retirement list is authoritative and is never inferred from a folder's absence,
    /// because extracting a release over an old install leaves stale folders behind in the
    /// SHIPPED directory too. The seeder already knew that. This did not, and the gap was
    /// exactly one retirement enforced in the place that copies files and ignored in the
    /// place that decides identity: a leftover `fans/` still authorized `ws.stock.fans`
    /// from a hand-dropped folder, and — the other direction, easy to miss — it also made
    /// the install guard refuse an ordinary widget whose id merely slugs to "fans".
    /// </remarks>
    public static IReadOnlyList<StockWidget> Shipped(
        IEnumerable<StockWidget> found, IReadOnlyCollection<string> retired)
    {
        var skip = new HashSet<string>(retired, StringComparer.OrdinalIgnoreCase);
        return found.Where(w => !skip.Contains(w.FolderName)).ToList();
    }

    /// <summary>Which resolved widgets may actually be SERVED, given whether the host map
    /// this scan read is the whole record.</summary>
    /// <remarks>
    /// A map that could not be read is not a map with nothing in it. Minting origins from
    /// an empty one and serving them is how a newly installed widget lands on the clean
    /// origin of an owner that is merely uninstalled, reading whatever storage the browser
    /// still holds there. The file being briefly locked is not consent to reassign anyone's
    /// origin — so widgets whose host was minted blind are withheld, while widgets that
    /// already had an entry are unaffected, because their origin was decided when the map
    /// could still be read.
    /// </remarks>
    public static bool MayServe(string id, IReadOnlyDictionary<string, string> mintedThisScan,
                                bool mapIsTrustworthy) =>
        mapIsTrustworthy || !mintedThisScan.ContainsKey(id);

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
    /// KNOWN LIMIT: this cannot protect an origin whose widget is gone AND whose map entry
    /// never existed. Uninstalling a widget does not release its host — the entry stays —
    /// and a host withheld from a collision is now written down as a reservation. What is
    /// left is the case where the map is lost outright while a previous owner is already
    /// uninstalled, which is why an unreadable map is neither overwritten nor served from
    /// (see WidgetLibrary.LoadHostMap).
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
            var clean = slug + HostSuffix;
            var host = clean;
            if (claimants[slug] > 1 || !used.Add(host))
            {
                // Withholding the clean host only for THIS scan was not enough. The
                // withheld origin may already hold the trusted widget's data from before
                // the map existed, and nothing recorded that. Retire one of the colliding
                // ids, install a third that slugs the same way, and it is now the sole
                // fresh claimant of an origin that no map entry ever mentioned — so it
                // takes it, and the data with it. The reservation is written down, so a
                // host withheld once is withheld for good.
                if (claimants[slug] > 1 && used.Add(clean))
                    assigned[ReservationPrefix + clean] = clean;
                host = $"{slug}-{ShortHash(id)}{HostSuffix}";
                for (var bump = 2; !used.Add(host); bump++)
                    host = $"{slug}-{ShortHash(id)}{bump}{HostSuffix}";
            }
            assigned[id] = host;
        }
        return assigned;
    }
}
