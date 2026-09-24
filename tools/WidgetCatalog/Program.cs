// Update indicators (issue #227).
//
// W1      the first run is a baseline: nothing is new, nothing is flagged
// W2-W3   a widget that arrives later is New for two weeks, and placing it ends that for good
// W4      a placed tile whose widget changed its settings is flagged; a relabel is not a change
// W5-W6   opening a flagged tile clears it; a flag for a removed tile goes
// W7      a damaged state file is a baseline, not "everything is new"
// W8      ...and so is valid JSON holding nulls, which used to throw on every start
// W9      a placement made on the panel ends "New" too (source guard: DashboardWindow)
// W10     property names holding the old delimiters cannot make two shapes compare equal
// W11     a second comparison in the same run (an in-app install) is not a baseline
// W12     a settings-window save marks placed only when it lands; an install compares again
// W13     a flag stays with the widget it was raised for: a tile that now holds another
//         widget under the same instance id is not flagged
using Plinth.Widgets;

var failures = 0;
void Check(string name, bool ok, string? detail = null)
{
    Console.WriteLine($"  {(ok ? "PASS" : "FAIL")} {name}{(detail is null ? "" : " - " + detail)}");
    if (!ok) failures++;
}
static WidgetManifest M(string id, params (string Name, string Type)[] props) => new()
{
    Id = id, Name = id,
    Properties = [.. props.Select(p => new WidgetProperty { Name = p.Name, Label = p.Name + " label", Type = p.Type })],
};

var dir = Directory.CreateTempSubdirectory("widgetcatalog-");
var path = Path.Combine(dir.FullName, "widget-catalog.json");
var t0 = new DateTime(2026, 9, 1, 12, 0, 0, DateTimeKind.Utc);
var clock = M("ws.stock.clock", ("format", "select"));
var cpu = M("ws.stock.cpu", ("label", "text"));
(string, string) Shape(WidgetManifest m) => (m.Id, WidgetCatalogState.ShapeOf(m));
(string, string?)[] Tiles(params (string W, string I)[] t) => t.Select(x => (x.W, (string?)x.I)).ToArray();

// ---- W1 · baseline -----------------------------------------------------------------------
var s1 = new WidgetCatalogState(path);
s1.Refresh([Shape(clock), Shape(cpu)], Tiles(("ws.stock.clock", "c1")), t0);
Check("W1 the first run marks nothing new", !s1.IsNew("ws.stock.clock", t0) && !s1.IsNew("ws.stock.cpu", t0));
Check("W1b ...and flags nothing", s1.Review.Count == 0);

// ---- W2-W3 · a widget that arrives in a later update ------------------------------------
var hue = M("ws.stock.hue", ("bridge", "text"));
var s2 = new WidgetCatalogState(path);
s2.Refresh([Shape(clock), Shape(cpu), Shape(hue)], Tiles(("ws.stock.clock", "c1")), t0.AddDays(1));
Check("W2 a widget new in this update is New", s2.IsNew("ws.stock.hue", t0.AddDays(2)));
Check("W2b ...for two weeks, then not", !s2.IsNew("ws.stock.hue", t0.AddDays(1) + WidgetCatalogState.NewFor));
s2.MarkPlaced(["ws.stock.hue"]);
var s3 = new WidgetCatalogState(path);
Check("W3 placing it ends New, and that survives a restart", !s3.IsNew("ws.stock.hue", t0.AddDays(2)));
var sonos = M("ws.stock.sonos", ("room", "text"));
s3.Refresh([Shape(clock), Shape(cpu), Shape(hue), Shape(sonos)], Tiles(("ws.stock.sonos", "s1")), t0.AddDays(2));
Check("W3b a widget already placed when it is first seen is not New", !s3.IsNew("ws.stock.sonos", t0.AddDays(3)));

// ---- W4 · settings changed in an update -------------------------------------------------
var clock2 = M("ws.stock.clock", ("format", "select"), ("seconds", "switch"));
var cpuRelabelled = new WidgetManifest { Id = "ws.stock.cpu", Name = "CPU",
    Properties = [new WidgetProperty { Name = "label", Label = "A new label", Type = "text", Help = "new help" }] };
var s4 = new WidgetCatalogState(path);
s4.Refresh([Shape(clock2), Shape(cpuRelabelled), Shape(hue), Shape(sonos)],
    Tiles(("ws.stock.clock", "c1"), ("ws.stock.clock", "c2"), ("ws.stock.cpu", "u1")), t0.AddDays(3));
Check("W4 each placed tile of a widget whose settings changed is flagged",
    s4.Review.OrderBy(x => x).SequenceEqual(["c1", "c2"]), string.Join(",", s4.Review));
Check("W4b a new label or help text is not a settings change", !s4.Review.Contains("u1"));
Check("W4c property order does not matter",
    WidgetCatalogState.ShapeOf(M("x", ("a", "text"), ("b", "switch"))) == WidgetCatalogState.ShapeOf(M("x", ("b", "switch"), ("a", "text"))));

// ---- W5-W6 · clearing -------------------------------------------------------------------
s4.MarkReviewed("c1");
var s5 = new WidgetCatalogState(path);
Check("W5 opening a flagged tile clears it, and that survives a restart", s5.Review.SequenceEqual(["c2"]), string.Join(",", s5.Review));
s5.Refresh([Shape(clock2), Shape(cpuRelabelled), Shape(hue), Shape(sonos)], Tiles(("ws.stock.cpu", "u1")), t0.AddDays(4));
Check("W6 a flag for a tile that was removed goes", s5.Review.Count == 0, string.Join(",", s5.Review));

// ---- W7 · a damaged file ----------------------------------------------------------------
File.WriteAllText(path, "{ not json");
var s7 = new WidgetCatalogState(path);
s7.Refresh([Shape(clock), Shape(cpu), Shape(hue)], Tiles(), t0.AddDays(5));
Check("W7 a damaged state file is a baseline, not every widget announced as new",
    !s7.IsNew("ws.stock.clock", t0.AddDays(5)) && !s7.IsNew("ws.stock.hue", t0.AddDays(5)));

// ---- W8 · valid JSON, invalid model ----------------------------------------------------
foreach (var (label, json) in new[]
{
    ("a null widget entry", "{\"Widgets\":{\"ws.stock.clock\":null},\"Review\":[]}"),
    ("a null shape", "{\"Widgets\":{\"ws.stock.clock\":{\"FirstSeen\":null,\"Shape\":null,\"Placed\":false}},\"Review\":[]}"),
    ("a null review id", "{\"Widgets\":{},\"Review\":[null]}"),
    ("a review mark without its widget", "{\"Widgets\":{},\"Review\":[{\"InstanceId\":\"c1\"}]}"),
    ("a review list in the earlier bare-id form", "{\"Widgets\":{},\"Review\":[\"c1\"]}"),
})
{
    File.WriteAllText(path, json);
    Exception? thrown = null;
    WidgetCatalogState? s8 = null;
    try
    {
        s8 = new WidgetCatalogState(path);
        s8.Refresh([Shape(clock), Shape(hue)], Tiles(("ws.stock.clock", "c1")), t0.AddDays(6));
    }
    catch (Exception ex) { thrown = ex; }
    Check($"W8 {label} is read as a baseline, not a crash on every start",
        thrown is null && s8 is not null && !s8.IsNew("ws.stock.hue", t0.AddDays(6)) && s8.Review.Count == 0,
        thrown?.GetType().Name);
}
var s8b = new WidgetCatalogState(path);
Check("W8b ...and the rewritten file reads back cleanly", s8b.Review.Count == 0 && !s8b.IsNew("ws.stock.clock", t0.AddDays(6)));

// ---- W9 · the panel's save path --------------------------------------------------------
var dash = FindUpwards("src/Plinth/App/DashboardWindow.cs");
var dashCode = dash is null ? "" : File.ReadAllText(dash);
Check("W9 a save from the on-panel editor marks its widgets placed",
    System.Text.RegularExpressions.Regex.IsMatch(dashCode,
        @"var landed = LayoutStore\.Save\(edited, LayoutStore\.PanelWriter\);[\s\S]{0,900}if \(landed\)\s*WidgetCatalogState\.Shared\?\.MarkPlaced\("));

// ---- W10 · shapes are structural -------------------------------------------------------
var joinedA = M("x", ("alpha:text|beta", "text"));
var joinedB = M("x", ("alpha", "text"), ("beta", "text"));
Check("W10 one property named \"alpha:text|beta\" is not the same shape as \"alpha\" + \"beta\"",
    WidgetCatalogState.ShapeOf(joinedA) != WidgetCatalogState.ShapeOf(joinedB),
    WidgetCatalogState.ShapeOf(joinedA) + " vs " + WidgetCatalogState.ShapeOf(joinedB));
Check("W10b ...nor is a name/type split moved across the delimiter",
    WidgetCatalogState.ShapeOf(M("x", ("a:b", "text"))) != WidgetCatalogState.ShapeOf(M("x", ("a", "b:text"))));

// ---- W11 · only the first comparison is a baseline ---------------------------------------
var fresh = Path.Combine(dir.FullName, "fresh.json");
var s11 = new WidgetCatalogState(fresh);
s11.Refresh([Shape(clock), Shape(cpu)], Tiles(), t0);
Check("W11 setup: the first comparison is a baseline", !s11.IsNew("ws.stock.clock", t0));
var installedLater = M("ws.third.party", ("x", "text"));
s11.Refresh([Shape(clock), Shape(cpu), Shape(installedLater)], Tiles(), t0.AddMinutes(5));
Check("W11 a widget installed in the same run after that is New", s11.IsNew("ws.third.party", t0.AddMinutes(5)));

// ---- W12 · the settings window's save and install paths --------------------------------
var settingsWin = FindUpwards("src/Plinth/App/SettingsWindow.cs");
var setCode = settingsWin is null ? "" : File.ReadAllText(settingsWin);
Check("W12 a settings save marks its widgets placed only when the write lands",
    System.Text.RegularExpressions.Regex.IsMatch(setCode,
        @"var landed = LayoutStore\.Save\(layout, LayoutStore\.SettingsWriter\);[\s\S]{0,400}if \(landed\)\s*WidgetCatalogState\.Shared\?\.MarkPlaced\("));
Check("W12b an in-app install compares the catalog again before the editor is refreshed",
    System.Text.RegularExpressions.Regex.IsMatch(setCode,
        @"_library\.InstallPackage\([\s\S]{0,2500}catalog\.Refresh\([\s\S]{0,600}PostInit\(\);"));

// ---- W13 · a widget swapped under the same instance id -----------------------------------
var swapPath = Path.Combine(dir.FullName, "swap.json");
var s13 = new WidgetCatalogState(swapPath);
s13.Refresh([Shape(clock), Shape(cpu)], Tiles(("ws.stock.clock", "c1")), t0);
s13.Refresh([Shape(clock2), Shape(cpu)], Tiles(("ws.stock.clock", "c1")), t0.AddDays(1));
Check("W13 setup: the clock tile is flagged, for the clock",
    s13.ReviewTiles.Any(m => m.InstanceId == "c1" && m.WidgetId == "ws.stock.clock"));
var s13b = new WidgetCatalogState(swapPath);
s13b.Refresh([Shape(clock2), Shape(cpu)], Tiles(("ws.stock.cpu", "c1")), t0.AddDays(2));
Check("W13 once that instance holds another widget, whose settings did not change, the flag goes",
    s13b.Review.Count == 0, string.Join(",", s13b.Review));
Check("W13b the settings window is sent each flag with its widget, so it can tell the same",
    System.Text.RegularExpressions.Regex.IsMatch(setCode, @"\[""reviewTiles""\] = JsonSerializer\.SerializeToNode\(WidgetCatalogState\.Shared\?\.ReviewTiles"));

try { dir.Delete(recursive: true); } catch { }
Console.WriteLine(failures > 0 ? $"{failures} FAILURES" : "ALL PASS");
return failures > 0 ? 1 : 0;

static string? FindUpwards(string relative)
{
    var d = new DirectoryInfo(AppContext.BaseDirectory);
    while (d is not null)
    {
        var candidate = Path.Combine(d.FullName, relative.Replace('/', Path.DirectorySeparatorChar));
        if (File.Exists(candidate)) return candidate;
        d = d.Parent;
    }
    return null;
}
