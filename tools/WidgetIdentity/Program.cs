using WaveshareWidgets.Widgets;

// Who may claim which id, and who gets which origin (#93, #94).
//
// Both findings are the same shape: something an untrusted manifest chooses was deciding
// which browser origin a widget was served from. The probes below are written against the
// ATTACK, not against the implementation — each one describes a package a user could be
// talked into installing, and asserts it cannot end up where the widget it imitates lives.

var failures = 0;
void Check(string name, bool ok, string? detail = null)
{
    // The reservation namespace contains NUL, and a NUL on stdout makes every tool that
    // reads CI logs treat them as a binary file.
    detail = detail?.Replace("\0", "\\0");
    Console.WriteLine($"  {(ok ? "PASS" : "FAIL")} {name}{(detail is null ? "" : " - " + detail)}");
    if (!ok) failures++;
}

// What the app ships: folder name, declared id, and the content fingerprint of the
// shipped files. The fingerprint is the part that carries authority — see I1b.
var stock = new List<WidgetIdentity.StockWidget>
{
    new("hue", "ws.stock.hue", "FINGERPRINT-HUE"),
    new("clock", "ws.stock.clock", "FINGERPRINT-CLOCK"),
    new("deck", "ws.stock.deck", "FINGERPRINT-DECK"),
};
const string ShippedHue = "FINGERPRINT-HUE";

Console.WriteLine("Reserved ids (#94)");

// I1 · the attack itself. A package declaring the stock Hue id extracts to Slug(id) —
// ws-stock-hue — because that is the only place InstallPackage writes. The seeded copy is
// in hue/. So the question the scan asks is exactly this one.
Check("I1 a package claiming a stock id cannot claim it from the folder it lands in",
    !WidgetIdentity.MayClaim("ws.stock.hue", WidgetIdentity.InstallFolderName("ws.stock.hue"), () => ShippedHue, stock),
    WidgetIdentity.InstallFolderName("ws.stock.hue"));

// I1b · the attack that the FOLDER NAME check missed entirely. docs/WIDGET-SPEC.md tells
// users to unzip widgets straight into the widgets directory, and those writes hot-reload —
// so `widgets/hue` is a name anyone who gets an archive opened can occupy, and the rescan
// that the unzip triggers would serve it from the real Hue widget's origin. Only content
// separates the seeded copy from something wearing its name.
Check("I1b a hostile folder WEARING the stock name and id is still refused",
    !WidgetIdentity.MayClaim("ws.stock.hue", "hue", () => "FINGERPRINT-HOSTILE", stock),
    "right name, wrong content");

// I1c · and a claim with no fingerprint at all is refused, not waved through. An
// unreadable folder is the case a null arrives from, and "could not check" must not read
// as "checked and fine".
Check("I1c an unfingerprintable folder cannot claim a stock id",
    !WidgetIdentity.MayClaim("ws.stock.hue", "hue", () => null, stock)
    && !WidgetIdentity.MayClaim("ws.stock.hue", "hue", () => "", stock));

// I2 · ...and the real stock widget still loads. A refusal that also refuses the thing it
// is protecting is not a fix, and this is the direction a too-broad rule breaks in.
Check("I2 the seeded stock copy still may",
    WidgetIdentity.MayClaim("ws.stock.hue", "hue", () => ShippedHue, stock));

// I2b · reservation keys are not ids. A widget answering to one would be handed the very
// origin the reservation exists to withhold from it.
Check("I2b nothing may claim an id in the reservation namespace",
    !WidgetIdentity.MayClaim(WidgetIdentity.ReservationPrefix + "anything", "whatever", () => null, stock));

// I3 · a stock id from ANY other folder is refused, including one a user hand-copied to a
// plausible name. Folder names carry no authority; only the shipped set does.
Check("I3 a stock id from any other folder is refused",
    !WidgetIdentity.MayClaim("ws.stock.hue", "hue-copy", () => ShippedHue, stock)
    && !WidgetIdentity.MayClaim("ws.stock.hue", "clock", () => ShippedHue, stock));

// I4 · case. "WS.Stock.Hue" is the same reserved namespace, and a case-sensitive prefix
// test would wave it straight through to the clean origin.
Check("I4 the namespace check is case-insensitive",
    WidgetIdentity.IsReserved("WS.Stock.Hue") && WidgetIdentity.IsReserved("ws.STOCK.evil"));

// I5 · a reserved id the app ships NOTHING by belongs to nobody. Retiring a stock widget
// (fans, for its elevation requirement) must not turn its name into a vacancy.
Check("I5 a reserved id with no shipped widget is refused everywhere",
    !WidgetIdentity.MayClaim("ws.stock.fans", "fans", () => "FINGERPRINT-FANS", stock)
    && !WidgetIdentity.MayClaim("ws.stock.fans", "ws-stock-fans", () => "FINGERPRINT-FANS", stock));

// I6 · and the rule stops at the namespace: ordinary ids install from anywhere, which is
// the entire point of installing a widget.
Check("I6 an unreserved id may come from any folder",
    WidgetIdentity.MayClaim("com.example.cpu", "com-example-cpu", () => null, stock)
    && WidgetIdentity.MayClaim("com.example.cpu", "whatever", () => null, stock));

// I7 · an EMPTY shipped set refuses every reserved id rather than accepting them. This is
// the failure direction when the stock folder cannot be read: stock widgets go missing and
// say so, instead of the name being free for anyone to take.
Check("I7 an unreadable shipped set refuses reserved ids, it does not open them",
    !WidgetIdentity.MayClaim("ws.stock.hue", "hue", () => ShippedHue, new List<WidgetIdentity.StockWidget>()));

Console.WriteLine("Duplicate ids (#94)");

// I8 · the tiebreak is gone, and its absence is the guard. Every version of it handed one
// folder another folder's origin: version let the challenger pick the winning number, and
// preferring the installer's own folder still let a hand-dropped `com-example-cpu/` take
// the id of a widget living under any other name — unzipping into the widgets directory is
// a documented install path, so that folder is not evidence of anything.
var contested = WidgetIdentity.AmbiguousIds(new[]
{
    ("com.example.cpu", "my-cpu-widget"),      // the incumbent, installed by folder drop
    ("com.example.cpu", "com-example-cpu"),    // the challenger, wearing the canonical name
    ("com.example.other", "com-example-other"),
});
Check("I8 an id claimed by two folders is refused, not awarded",
    contested.Contains("com.example.cpu"), string.Join(", ", contested));
Check("I8b ...and an id only one folder claims is untouched",
    !contested.Contains("com.example.other"));

// I9 · the same folder listed twice is not a contest — a rescan that sees one folder once
// per pass must not refuse the widget it just found.
Check("I9 one folder claiming its own id twice is not ambiguous",
    WidgetIdentity.AmbiguousIds(new[]
    {
        ("com.example.cpu", "com-example-cpu"),
        ("com.example.cpu", "com-example-cpu"),
    }).Count == 0);

// I9b · ids differing only in case are DIFFERENT widgets, matching the ordinal identity the
// rest of the library uses. Folding them together would refuse two innocent widgets.
Check("I9b ids differing only in case are not the same claim",
    WidgetIdentity.AmbiguousIds(new[] { ("com.example.cpu", "a"), ("com.example.CPU", "b") }).Count == 0);

Console.WriteLine("Host assignment (#93)");

// A reservation is not an assignment: it withholds an origin from everyone rather than
// granting it to someone. Probes about who is SERVED from what must not count them.
static Dictionary<string, string> Granted(Dictionary<string, string> assigned) =>
    assigned.Where(kv => !kv.Key.StartsWith(WidgetIdentity.ReservationPrefix, StringComparison.Ordinal))
            .ToDictionary(kv => kv.Key, kv => kv.Value, StringComparer.Ordinal);

// I10 · the attack. The map is empty — an upgrade, or a file this process could not read —
// and two DIFFERENT ids slug to the same host. Whoever is enumerated first used to take
// the clean origin, so a package could inherit the storage of a widget the user trusts.
var collide = WidgetIdentity.AssignHosts(
    new[] { "com.example.cpu", "com-example-cpu" }, new Dictionary<string, string>());
var clean = "com-example-cpu" + WidgetIdentity.HostSuffix;
Check("I10 with two claimants for one slug, NEITHER gets the clean host",
    Granted(collide).Values.All(h => h != clean), string.Join(", ", Granted(collide).Values));
Check("I10b ...and they are still told apart",
    collide["com.example.cpu"] != collide["com-example-cpu"]);

// I11 · order-independence, stated the only way that means anything: the same set in the
// opposite order produces the same answer.
var reversed = WidgetIdentity.AssignHosts(
    new[] { "com-example-cpu", "com.example.cpu" }, new Dictionary<string, string>());
Check("I11 enumeration order does not change any assignment",
    collide.Count == reversed.Count && collide.All(kv => reversed[kv.Key] == kv.Value),
    string.Join(", ", reversed.Select(kv => $"{kv.Key}={kv.Value}")));

// I12 · the cost of the rule, bounded. A slug with ONE claimant still gets the clean host,
// so the ordinary install is unaffected and no one's storage moves for nothing.
var alone = WidgetIdentity.AssignHosts(new[] { "com.example.cpu" }, new Dictionary<string, string>());
Check("I12 a sole claimant still gets the clean host", alone["com.example.cpu"] == clean, alone["com.example.cpu"]);

// I13 · the incumbent's protection: an id already in the map keeps its host, and nothing
// is re-minted for it. This is what makes the persisted map the defense it is meant to be.
var existing = new Dictionary<string, string> { ["com.example.cpu"] = clean };
var newcomer = WidgetIdentity.AssignHosts(new[] { "com.example.cpu", "com-example-cpu" }, existing);
Check("I13 an id already in the map is not reassigned", !newcomer.ContainsKey("com.example.cpu"));
Check("I13b ...and a newcomer cannot take the host it holds",
    newcomer["com-example-cpu"] != clean, newcomer["com-example-cpu"]);

// I14 · a host held by an id that is NOT in this scan is still off limits. The map outlives
// the installed set on purpose: uninstalling a widget must not release its origin to the
// next package that happens to slug the same way.
var retired = new Dictionary<string, string> { ["com.example.gone"] = clean };
var afterRetire = WidgetIdentity.AssignHosts(new[] { "com-example-cpu" }, retired);
Check("I14 a host held by an uninstalled id is not handed to a newcomer",
    afterRetire["com-example-cpu"] != clean, afterRetire["com-example-cpu"]);

// I15 · stability. The same installed set assigns the same hosts every scan — a host that
// changed between runs would silently orphan the widget's stored data.
var again = WidgetIdentity.AssignHosts(new[] { "com.example.cpu", "com-example-cpu" }, new Dictionary<string, string>());
Check("I15 the same installed set assigns the same hosts every time",
    collide.All(kv => again[kv.Key] == kv.Value));

// I16 · every assigned host is distinct, which is the property the whole mechanism exists
// for: one origin per widget, no sharing.
var many = WidgetIdentity.AssignHosts(
    new[] { "a.b", "a-b", "a.b.", ".a.b", "A.B", "x" }, new Dictionary<string, string>());
Check("I16 no two ids are ever assigned the same host",
    Granted(many).Values.Distinct(StringComparer.OrdinalIgnoreCase).Count() == Granted(many).Count,
    string.Join(", ", Granted(many).Values));

// I17 · an id that slugs to nothing at all still gets its own origin rather than sharing
// the fallback label with every other such id.
var degenerate = WidgetIdentity.AssignHosts(new[] { "...", "!!!" }, new Dictionary<string, string>());
Check("I17 ids that slug to nothing do not share an origin",
    degenerate["..."] != degenerate["!!!"], string.Join(", ", Granted(degenerate).Values));

// I18 · the last place order could still decide anything: two DIFFERENT ids that share a
// slug AND the four-byte discriminator, so the suffixed hosts collide too and one of them
// has to be bumped. Everything above is order-independent by construction — the host is a
// function of the id alone — which is why the ordinal sort looked like dead weight until
// this case was built. It is only reachable with a deliberate collision, so here is one:
// these two strings are case variants of the same widget id (both slug to
// "com-example-cpumonitor") whose SHA-256 prefixes are both ce5d41fd. Found by search, not
// by luck — 2^21 case variants of a 21-character id give a 32-bit birthday collision.
const string TwinA = "com.eXample.CpUmoNitor";
const string TwinB = "com.EXAmpLe.CPUmoNitor";
Check("I18 setup: the twins really do collide on slug AND discriminator",
    WidgetIdentity.Slug(TwinA) == WidgetIdentity.Slug(TwinB)
    && WidgetIdentity.ShortHash(TwinA) == WidgetIdentity.ShortHash(TwinB),
    $"{WidgetIdentity.Slug(TwinA)} / {WidgetIdentity.ShortHash(TwinA)}");
var twins = WidgetIdentity.AssignHosts(new[] { TwinA, TwinB }, new Dictionary<string, string>());
var twinsReversed = WidgetIdentity.AssignHosts(new[] { TwinB, TwinA }, new Dictionary<string, string>());
Check("I18 colliding discriminators still yield distinct origins",
    twins[TwinA] != twins[TwinB], string.Join(", ", Granted(twins).Values));
Check("I18b ...and which twin gets which does not depend on enumeration order",
    twins[TwinA] == twinsReversed[TwinA] && twins[TwinB] == twinsReversed[TwinB],
    $"{twins[TwinA]} vs {twinsReversed[TwinA]}");

// I19 · a clean host withheld from a collision must stay withheld FOREVER, not just for
// the scan that withheld it. Withholding it in the moment left an origin that no map entry
// mentioned — and that origin may already hold the trusted widget's data from before the
// map existed. Retire one collider, install a third id that slugs the same way, and it is
// the sole fresh claimant of an unrecorded clean host: it takes it, and the data with it.
// So the withholding is written down.
var round1 = WidgetIdentity.AssignHosts(
    new[] { "com.example.cpu", "com-example-cpu" }, new Dictionary<string, string>());
Check("I19 a withheld clean host is recorded as reserved, not merely skipped",
    round1.ContainsKey(WidgetIdentity.ReservationPrefix + clean)
    && round1[WidgetIdentity.ReservationPrefix + clean] == clean,
    string.Join(", ", round1.Keys));

// The map that scan would have persisted, with the collider then uninstalled — exactly
// the state the finding describes.
var afterCollision = new Dictionary<string, string>(StringComparer.Ordinal)
{
    ["com.example.cpu"] = round1["com.example.cpu"],
    [WidgetIdentity.ReservationPrefix + clean] = clean,
};
var thirdComer = WidgetIdentity.AssignHosts(new[] { "com_example_cpu" }, afterCollision);
Check("I19b a later sole claimant of that slug cannot pick the reserved host up",
    thirdComer["com_example_cpu"] != clean, thirdComer["com_example_cpu"]);

Console.WriteLine("Shipped set and serving (#93, #94)");

// I20 · a retirement enforced in one place and ignored in another. On an overwrite-style
// upgrade the SHIPPED directory can keep a folder the app no longer ships; the seeder has
// always treated its retirement list as authoritative for exactly that reason. Reading the
// shipped set without the same filter re-authorized `ws.stock.fans` from a hand-dropped
// `widgets/fans`.
var shippedRaw = new List<WidgetIdentity.StockWidget>
{
    new("hue", "ws.stock.hue", "FINGERPRINT-HUE"),
    new("fans", "ws.stock.fans", "FINGERPRINT-FANS"),
};
var shipped = WidgetIdentity.Shipped(shippedRaw, new[] { "fans" });
Check("I20 a stale shipped folder for a RETIRED widget authorizes nobody",
    !WidgetIdentity.MayClaim("ws.stock.fans", "fans", () => "FINGERPRINT-FANS", shipped),
    string.Join(", ", shipped.Select(w => w.FolderName)));
Check("I20b ...while the widgets still shipped are untouched",
    WidgetIdentity.MayClaim("ws.stock.hue", "hue", () => "FINGERPRINT-HUE", shipped));

// I20c · the other direction, which is easy to miss because it is not a leak. The install
// guard refuses a package that would land ON a stock folder; with the retired folder still
// in the set, it also refused an ordinary widget whose id merely slugs to "fans".
Check("I20c a retired folder no longer blocks an ordinary widget that slugs onto its name",
    !shipped.Any(w => string.Equals(w.FolderName, WidgetIdentity.InstallFolderName("fans"),
        StringComparison.OrdinalIgnoreCase)));

// I21 · a host map that could not be read is not a map with nothing in it. Widgets whose
// origin was minted blind this scan are withheld; widgets that already had an entry are
// served, because their origin was decided when the map could still be read.
var minted = new Dictionary<string, string>(StringComparer.Ordinal) { ["com.example.new"] = "x" + WidgetIdentity.HostSuffix };
Check("I21 a widget whose origin was minted without the map is not served",
    !WidgetIdentity.MayServe("com.example.new", minted, mapIsTrustworthy: false));
Check("I21b ...while one that already had an entry still is",
    WidgetIdentity.MayServe("com.example.old", minted, mapIsTrustworthy: false));
Check("I21c ...and a readable map withholds nothing",
    WidgetIdentity.MayServe("com.example.new", minted, mapIsTrustworthy: true));

// I22 · the fingerprint is the expensive half and the folder it hashes is chosen by an
// attacker: a hand-dropped folder claiming a stock id gets hashed in order to be REFUSED,
// so a large highly-compressible asset would buy a large read on startup and on every
// watcher rescan. A claim from a folder no stock widget lives in is refused whatever it
// contains, so it must never be hashed at all.
var hashed = 0;
WidgetIdentity.MayClaim("ws.stock.hue", "somewhere-else", () => { hashed++; return "x"; }, stock);
Check("I22 a claim from a non-stock folder is refused WITHOUT hashing it", hashed == 0, $"{hashed} hash(es)");
WidgetIdentity.MayClaim("ws.stock.hue", "hue", () => { hashed++; return "x"; }, stock);
Check("I22b ...and the folder that could legitimately hold it still is", hashed == 1, $"{hashed} hash(es)");

Console.WriteLine("Serving what the library lists (#94)");

// I23 · a mapping is what makes an origin exist, so a widget the library has REFUSED must
// lose its mapping. Only the dashboard used to clear stale hosts; the settings window
// mapped the current library over whatever was there, so a refused widget stayed served
// from the folder it was refused for and any other widget could iframe that origin.
var mappedNow = new[] { "app.wsw", "media.wsw", "hue.widgets.wsw", "clock.widgets.wsw" };
var fixedHosts = new[] { "app.wsw", "media.wsw" };
var stale = WidgetIdentity.StaleHosts(mappedNow, fixedHosts, new[] { "clock.widgets.wsw" });
Check("I23 a host the library no longer lists is stale",
    stale.Contains("hue.widgets.wsw"), string.Join(", ", stale));
Check("I23b ...while a host it still lists is not", !stale.Contains("clock.widgets.wsw"));
Check("I23c ...and the shell/media/background hosts are never swept",
    !stale.Contains("app.wsw") && !stale.Contains("media.wsw"), string.Join(", ", stale));

// I24 · validating the writable copy is not the same as serving it. A virtual host serves
// its folder continuously, so a fingerprint checked during a rescan says nothing about what
// the next request reads — watcher events are debounced 800 ms, and in that window a widget
// can iframe the stock origin with a cache-busting query and run whatever was just written
// into the seeded folder. The origin therefore points at the shipped copy, which the
// install path cannot write.
const string Shipped = "/opt/app/stock-widgets";
Check("I24 a stock widget is served from the SHIPPED folder, not the writable copy",
    WidgetIdentity.ServingFolder("ws.stock.hue", "/data/widgets/hue", Shipped)
        == System.IO.Path.Combine(Shipped, "hue"),
    WidgetIdentity.ServingFolder("ws.stock.hue", "/data/widgets/hue", Shipped));
Check("I24b ...and an ordinary widget is still served from where it was found",
    WidgetIdentity.ServingFolder("com.example.cpu", "/data/widgets/com-example-cpu", Shipped)
        == "/data/widgets/com-example-cpu");

// I25 · the canonical folder is where the INSTALLER writes, not proof of who owns an id.
// A widget installed by direct folder drop lives under whatever name the user chose; a
// package declaring the same id lands in the canonical folder, wins the duplicate tiebreak
// on provenance, and inherits that id's persisted origin — with the original widget's
// stored data. Nothing in that chain authenticated the package.
Check("I25 a package cannot take an id that lives in another folder",
    WidgetIdentity.WouldStealId("com.example.cpu",
        new[] { ("com.example.cpu", "my-cpu-widget") }));
Check("I25b ...while upgrading in place is untouched",
    !WidgetIdentity.WouldStealId("com.example.cpu",
        new[] { ("com.example.cpu", "com-example-cpu") }));
Check("I25c ...and an id nobody holds installs normally",
    !WidgetIdentity.WouldStealId("com.example.new",
        new[] { ("com.example.cpu", "my-cpu-widget") }));

Console.WriteLine(failures == 0 ? "ALL PASS" : $"{failures} FAILURES");
return failures == 0 ? 0 : 1;
