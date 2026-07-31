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
    Console.WriteLine($"  {(ok ? "PASS" : "FAIL")} {name}{(detail is null ? "" : " - " + detail)}");
    if (!ok) failures++;
}

// What the app ships, as the seeder sees it: folder name -> manifest id.
var stock = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
{
    ["hue"] = "ws.stock.hue",
    ["clock"] = "ws.stock.clock",
    ["deck"] = "ws.stock.deck",
};

Console.WriteLine("Reserved ids (#94)");

// I1 · the attack itself. A package declaring the stock Hue id extracts to Slug(id) —
// ws-stock-hue — because that is the only place InstallPackage writes. The seeded copy is
// in hue/. So the question the scan asks is exactly this one.
Check("I1 a package claiming a stock id cannot claim it from the folder it lands in",
    !WidgetIdentity.MayClaim("ws.stock.hue", WidgetIdentity.InstallFolderName("ws.stock.hue"), stock),
    WidgetIdentity.InstallFolderName("ws.stock.hue"));

// I2 · ...and the real stock widget still loads. A refusal that also refuses the thing it
// is protecting is not a fix, and this is the direction a too-broad rule breaks in.
Check("I2 the seeded stock copy still may",
    WidgetIdentity.MayClaim("ws.stock.hue", "hue", stock));

// I3 · a stock id from ANY other folder is refused, including one a user hand-copied to a
// plausible name. Folder names carry no authority; only the shipped set does.
Check("I3 a stock id from any other folder is refused",
    !WidgetIdentity.MayClaim("ws.stock.hue", "hue-copy", stock)
    && !WidgetIdentity.MayClaim("ws.stock.hue", "clock", stock));

// I4 · case. "WS.Stock.Hue" is the same reserved namespace, and a case-sensitive prefix
// test would wave it straight through to the clean origin.
Check("I4 the namespace check is case-insensitive",
    WidgetIdentity.IsReserved("WS.Stock.Hue") && WidgetIdentity.IsReserved("ws.STOCK.evil"));

// I5 · a reserved id the app ships NOTHING by belongs to nobody. Retiring a stock widget
// (fans, for its elevation requirement) must not turn its name into a vacancy.
Check("I5 a reserved id with no shipped widget is refused everywhere",
    !WidgetIdentity.MayClaim("ws.stock.fans", "fans", stock)
    && !WidgetIdentity.MayClaim("ws.stock.fans", "ws-stock-fans", stock));

// I6 · and the rule stops at the namespace: ordinary ids install from anywhere, which is
// the entire point of installing a widget.
Check("I6 an unreserved id may come from any folder",
    WidgetIdentity.MayClaim("com.example.cpu", "com-example-cpu", stock)
    && WidgetIdentity.MayClaim("com.example.cpu", "whatever", stock));

// I7 · an EMPTY shipped set refuses every reserved id rather than accepting them. This is
// the failure direction when the stock folder cannot be read: stock widgets go missing and
// say so, instead of the name being free for anyone to take.
Check("I7 an unreadable shipped set refuses reserved ids, it does not open them",
    !WidgetIdentity.MayClaim("ws.stock.hue", "hue", new Dictionary<string, string>()));

Console.WriteLine("Duplicate resolution (#94)");

// I8 · the tiebreak the finding was about. Version is gone; the folder the installer
// itself writes wins. Stated as the attack: a leftover cannot displace the installed copy
// by claiming a bigger number, because no number is consulted.
//
// The leftover is named "aged-cpu-copy" on purpose — it sorts BEFORE the canonical folder.
// A leftover that sorted after would pass this check under a plain name comparison too,
// proving nothing, and "an old copy pinned in front of every fresh install" is exactly the
// case the version tiebreak was introduced for. This is the one that has to hold without it.
Check("I8 the installer's own folder wins over an earlier-sorting leftover",
    WidgetIdentity.PreferCandidate("com.example.cpu", "com-example-cpu", "aged-cpu-copy"));
Check("I8b ...and does not lose to one that got there first",
    !WidgetIdentity.PreferCandidate("com.example.cpu", "aged-cpu-copy", "com-example-cpu"));

// I9 · two folders, neither canonical: ordinal name, so the answer does not depend on the
// order the directory happened to enumerate in.
Check("I9 neither canonical falls back to ordinal name, both directions",
    WidgetIdentity.PreferCandidate("com.example.cpu", "aaa", "bbb")
    && !WidgetIdentity.PreferCandidate("com.example.cpu", "bbb", "aaa"));

Console.WriteLine("Host assignment (#93)");

// I10 · the attack. The map is empty — an upgrade, or a file this process could not read —
// and two DIFFERENT ids slug to the same host. Whoever is enumerated first used to take
// the clean origin, so a package could inherit the storage of a widget the user trusts.
var collide = WidgetIdentity.AssignHosts(
    new[] { "com.example.cpu", "com-example-cpu" }, new Dictionary<string, string>());
var clean = "com-example-cpu" + WidgetIdentity.HostSuffix;
Check("I10 with two claimants for one slug, NEITHER gets the clean host",
    collide.Values.All(h => h != clean), string.Join(", ", collide.Values));
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
    many.Values.Distinct(StringComparer.OrdinalIgnoreCase).Count() == many.Count,
    string.Join(", ", many.Values));

// I17 · an id that slugs to nothing at all still gets its own origin rather than sharing
// the fallback label with every other such id.
var degenerate = WidgetIdentity.AssignHosts(new[] { "...", "!!!" }, new Dictionary<string, string>());
Check("I17 ids that slug to nothing do not share an origin",
    degenerate["..."] != degenerate["!!!"], string.Join(", ", degenerate.Values));

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
    twins[TwinA] != twins[TwinB], string.Join(", ", twins.Values));
Check("I18b ...and which twin gets which does not depend on enumeration order",
    twins[TwinA] == twinsReversed[TwinA] && twins[TwinB] == twinsReversed[TwinB],
    $"{twins[TwinA]} vs {twinsReversed[TwinA]}");

Console.WriteLine(failures == 0 ? "ALL PASS" : $"{failures} FAILURES");
return failures == 0 ? 0 : 1;
