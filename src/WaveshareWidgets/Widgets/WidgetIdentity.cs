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
    /// computed the same way as <see cref="StockWidget.Fingerprint"/>. A CALLBACK, and
    /// invoked only once the folder name matches a shipped widget: hashing is the
    /// expensive half, the folder it would hash is attacker-controlled, and a claim from a
    /// folder no stock widget lives in is refused whatever its contents are. So the cost
    /// is bounded to the couple of dozen names the app actually ships.</param>
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
    public static bool MayClaim(string? id, string folderName, Func<string?> installedFingerprint,
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
            if (!string.Equals(shipped.FolderName, folderName, StringComparison.OrdinalIgnoreCase))
                return false;
            var actual = installedFingerprint();
            return !string.IsNullOrEmpty(actual)
                && string.Equals(actual, shipped.Fingerprint, StringComparison.Ordinal);
        }
        return false;
    }

    /// <summary>The folder a package declaring <paramref name="id"/> would be extracted
    /// into — and therefore the copy that the installer, not a leftover, produced.</summary>
    public static string InstallFolderName(string id) => Slug(id);

    /// <summary>Would installing a package that declares <paramref name="id"/> take that id
    /// away from a widget already installed somewhere else?</summary>
    /// <remarks>
    /// The installer always extracts to <see cref="InstallFolderName"/>, and the duplicate
    /// tiebreak prefers that folder because the app itself wrote it. That is provenance for
    /// the FOLDER and says nothing about the CONTENTS, which came from the package.
    ///
    /// So when a widget is installed by direct folder drop — a supported path, under
    /// whatever name the user chose — a package declaring the same id lands in the canonical
    /// folder, wins the tiebreak on provenance alone, and inherits the persisted virtual
    /// host: the original widget's origin, and its stored data. Nothing about the package
    /// was authenticated at any point in that chain.
    ///
    /// Upgrading in place is unaffected — same id, same canonical folder, no second
    /// claimant. Only taking an id that currently lives elsewhere is refused.
    /// </remarks>
    public static bool WouldStealId(string id, IEnumerable<(string Id, string Folder)> installed)
    {
        var canonical = InstallFolderName(id);
        foreach (var (installedId, folder) in installed)
        {
            if (!string.Equals(installedId, id, StringComparison.Ordinal))
                continue;
            if (!string.Equals(folder, canonical, StringComparison.OrdinalIgnoreCase))
                return true;
        }
        return false;
    }

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

    /// <summary>The folder a widget's origin is actually served from.</summary>
    /// <remarks>
    /// For a stock widget: the SHIPPED folder, never the seeded copy in the writable
    /// widgets directory — even though the fingerprint check proved the two identical.
    /// That check is a moment in time and a virtual host mapping is continuous: it serves
    /// whatever is in its folder at the instant of each request, watcher events are
    /// debounced, and in that window another widget can iframe the stock origin with a
    /// cache-busting query and run whatever was just written there. No amount of checking
    /// harder closes a gap between the check and every subsequent read — only pointing the
    /// origin somewhere the install path cannot write does.
    ///
    /// The fingerprint's job changes rather than disappears: it no longer authorizes the
    /// writable copy to be served, it establishes that the widget the user has is the
    /// widget the app ships, and then the app serves its own.
    ///
    /// Non-stock widgets serve from where they were found, because editing them in place is
    /// the documented workflow and the only origin at stake is their own.
    /// </remarks>
    public static string ServingFolder(string id, string scannedFolder, string shippedRoot) =>
        IsReserved(id)
            ? Path.Combine(shippedRoot, Path.GetFileName(scannedFolder.TrimEnd('/', '\\')))
            : scannedFolder;

    /// <summary>Which currently-mapped virtual hosts must stop being served, given the
    /// widgets the library now lists.</summary>
    /// <remarks>
    /// A mapping is what makes an origin exist, so removing one is how a widget stops being
    /// reachable — and only the dashboard used to do it. The settings window mapped the
    /// current library over whatever was already there and cleared nothing, which meant a
    /// widget the library had REFUSED stayed served from the folder it was refused for.
    /// Any other widget could then iframe that origin, and the refused page would run
    /// inside the origin whose stored data the refusal was protecting.
    ///
    /// Separated from the WebView call so the rule can be checked without one: what the
    /// library does not list is not served, and hosts that are not widgets are left alone.
    /// </remarks>
    public static IReadOnlyList<string> StaleHosts(
        IEnumerable<string> mapped, IReadOnlyCollection<string> fixedHosts,
        IEnumerable<string> wanted)
    {
        var keep = new HashSet<string>(wanted, StringComparer.OrdinalIgnoreCase);
        var exempt = new HashSet<string>(fixedHosts, StringComparer.OrdinalIgnoreCase);
        return mapped.Where(h => !exempt.Contains(h) && !keep.Contains(h)).ToList();
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

    /// <summary>Ids that more than one folder claims. None of them is served.</summary>
    /// <remarks>
    /// There is no tiebreak here any more, and that is the point. Every tiebreak tried was
    /// a way to take another widget's origin: the manifest VERSION let the challenger pick
    /// the winning number, and preferring the folder the installer writes still let a
    /// hand-dropped `com-example-cpu/` claim the id of a widget living under any other
    /// name — unzipping into the widgets directory is how the docs tell people to install,
    /// so that folder name is not evidence of anything. Whoever won inherited the id's
    /// persisted virtual host, and with it the storage scoped to that origin.
    ///
    /// Nothing on disk records which folder is the rightful owner, so the question is
    /// declined rather than guessed. Both copies are refused and both are named. An
    /// attacker able to write to the widgets folder can already delete a widget outright,
    /// so failing closed gives up an availability the user never really had.
    ///
    /// ORDINAL on the id, matching the identity the rest of the library uses: ids differing
    /// only in case are two different widgets, and folding them together would refuse two
    /// innocent ones. Folder names compare case-insensitively, because Windows does.
    /// </remarks>
    public static IReadOnlySet<string> AmbiguousIds(IEnumerable<(string Id, string Folder)> candidates)
    {
        var folders = new Dictionary<string, HashSet<string>>(StringComparer.Ordinal);
        foreach (var (id, folder) in candidates)
        {
            if (!folders.TryGetValue(id, out var set))
                folders[id] = set = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            set.Add(folder);
        }
        return folders.Where(kv => kv.Value.Count > 1)
                      .Select(kv => kv.Key)
                      .ToHashSet(StringComparer.Ordinal);
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
