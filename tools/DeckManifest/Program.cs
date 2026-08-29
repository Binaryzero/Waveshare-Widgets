// Issue #122 — a malformed Device.Size turned the whole profile into "no Stream Deck".
//
// System.Text.Json's TryGetProperty THROWS on a non-object element. ReadProfile catches
// everything and returns null, and DashboardWindow reports the deck unavailable — so a
// profile carrying `"Size": "5x3"` produced an EMPTY deck instead of falling through to
// grid inference from the occupied keys.
//
// An empty Control Deck is this project's recurring field failure (#43, #49, #78), so a
// path that produces one silently is worth removing on its own account. The issue asks for
// the defect to be reproduced rather than assumed, which is what D1 does: it parses the
// exact shape from the report and shows the OLD code throwing on it.
using System.Text.Json;
using Plinth.App;

var failures = 0;
void Check(string name, bool ok, string? detail = null)
{
    Console.WriteLine($"  {(ok ? "PASS" : "FAIL")} {name}{(detail is null ? "" : " - " + detail)}");
    if (!ok) failures++;
}
static JsonElement Parse(string json) => JsonDocument.Parse(json).RootElement.Clone();

// Every call goes through this. The failure being fixed is an EXCEPTION, so a probe that
// called ReadDeviceSize directly would die on the regression instead of reporting it — no
// output at all, which reads as broken infrastructure rather than as this check failing.
// `null` means "threw", which is never a correct answer here.
static (int? Cols, int? Rows)? Size(string json)
{
    try { return DeckManifest.ReadDeviceSize(Parse(json)); }
    catch (Exception) { return null; }
}

Console.WriteLine("The reported shape");

// D1 · reproduce first. TryGetProperty on a string element throws, and that throw is what
// travelled out to "profile unavailable" — asserted here so the probe is anchored to the
// real mechanism rather than to a guess about it.
var bad = Parse("""{"Device":{"Size":"5x3"}}""");
var threw = false;
try
{
    var device = bad.GetProperty("Device");
    var size = device.GetProperty("Size");
    size.TryGetProperty("Columns", out _);
}
catch (InvalidOperationException) { threw = true; }
Check("D1 setup: TryGetProperty on a non-object really does throw", threw);

// D2 · and the reader survives it, answering "not stated" so the caller can infer the grid.
Check("D2 a string Size is not stated, rather than fatal", Size("""{"Device":{"Size":"5x3"}}""") == (null, null));

Console.WriteLine("Other shapes a third-party file can take");

Check("D3 an array Size", Size("""{"Device":{"Size":[5,3]}}""") == (null, null));
Check("D3b a number Size", Size("""{"Device":{"Size":15}}""") == (null, null));
Check("D3c a null Size", Size("""{"Device":{"Size":null}}""") == (null, null));
Check("D3d a bool Size", Size("""{"Device":{"Size":true}}""") == (null, null));
// Device itself is the same hazard one level up, and the issue flags it explicitly.
Check("D4 a string Device", Size("""{"Device":"streamdeck"}""") == (null, null));
Check("D4b an array Device", Size("""{"Device":[]}""") == (null, null));
Check("D4c no Device at all", Size("""{"Name":"p"}""") == (null, null));
Check("D4d the manifest itself is not an object", Size("[]") == (null, null));

// D5 · string-typed NUMBERS are the near-miss: "5" parses as an int with TryGetInt32 only
// for a Number element, so the ValueKind check is what keeps a quoted value out.
Check("D5 quoted numbers are not accepted",
    Size("""{"Device":{"Size":{"Columns":"5","Rows":"3"}}}""") == (null, null));

Console.WriteLine("The ordinary case still works");

// D6 · the direction that matters as much as the finding: a rule strict enough to refuse
// real profiles would take the deck away from everyone, which is the symptom being fixed.
Check("D6 a normal Size reads",
    Size("""{"Device":{"Size":{"Columns":5,"Rows":3}}}""") == (5, 3));
Check("D6b the Cols/Height spellings read",
    Size("""{"Device":{"Size":{"Cols":8,"Height":4}}}""") == (8, 4));
Check("D6c Width/Rows read",
    Size("""{"Device":{"Size":{"Width":3,"Rows":2}}}""") == (3, 2));
// A partial answer is still an answer for one axis; the caller requires both before it uses
// either, so half-known must not become half-invented.
Check("D6d one axis present, one absent",
    Size("""{"Device":{"Size":{"Columns":5}}}""") == (5, null));
Check("D7 out-of-range values are refused, not clamped",
    Size("""{"Device":{"Size":{"Columns":0,"Rows":99}}}""") == (null, null));

Console.WriteLine("Device model");

// The model decides everything downstream, and getting it wrong is not a cosmetic
// failure: a deck the bridge does not recognize is skipped, discovery comes back empty
// and the widget shows "Stream Deck app is not running or cannot be found" while a
// working deck sits on the machine. That happened. So did the correction after it —
// recognizing the model but assuming it was window-backed, which would have published a
// grid whose keys silently do nothing. Both are decided here, so both are driven here.

static string? Model(string json)
{
    try { return DeckManifest.ReadDeviceModel(Parse(json)); }
    catch (Exception) { return null; }
}

// M1 · the two real models, read out of the shape a real manifest has.
Check("M1 Elgato's own on-screen deck reads",
    Model("""{"Device":{"Model":"UI Stream Deck"}}""") == "UI Stream Deck");
Check("M1b the deck iCUE creates reads",
    Model("""{"Device":{"Model":"VSD2/WiFi"}}""") == "VSD2/WiFi");

// M2 · same shape hazards as Size, one level down. A model that throws is a profile
// skipped in silence, which is the failure mode this whole area is built against.
Check("M2 a non-object Device is not a model", Model("""{"Device":"x"}""") is null);
Check("M2b a non-string Model is not a model", Model("""{"Device":{"Model":42}}""") is null);
Check("M2c an absent Model is not a model", Model("""{"Device":{"Size":{"Columns":5}}}""") is null);
Check("M2d an empty Model is not a model", Model("""{"Device":{"Model":"   "}}""") is null);
Check("M2e a non-object manifest is not a model", Model("[]") is null);

// M3 · both recognized, and — the part that matters — recognized as DIFFERENT KINDS.
// A single "is this mirrorable" predicate is what let the network deck be treated as a
// window deck; that these two answers disagree for VSD2/WiFi is the fix.
Check("M3 both models are known", DeckManifest.IsKnownModel("UI Stream Deck")
    && DeckManifest.IsKnownModel("VSD2/WiFi"));
Check("M3b Elgato's deck is a local window: capture and clicks are possible",
    DeckManifest.IsLocalWindowModel("UI Stream Deck")
    && !DeckManifest.IsNetworkModel("UI Stream Deck"));
Check("M3c iCUE's deck is a NETWORK device: neither capture nor clicks are possible",
    DeckManifest.IsNetworkModel("VSD2/WiFi")
    && !DeckManifest.IsLocalWindowModel("VSD2/WiFi"));
Check("M3d the two sets do not overlap",
    !DeckManifest.LocalWindowModels.Intersect(DeckManifest.NetworkModels, StringComparer.OrdinalIgnoreCase).Any());
Check("M3e KnownModels is exactly the union",
    DeckManifest.KnownModels.OrderBy(m => m, StringComparer.Ordinal).SequenceEqual(
        DeckManifest.LocalWindowModels.Concat(DeckManifest.NetworkModels)
                    .OrderBy(m => m, StringComparer.Ordinal), StringComparer.Ordinal));

// M4 · written by other software and carried through JSON, so case and stray whitespace
// must not be the reason a real deck is refused — that refusal is the original bug.
Check("M4 case does not matter", DeckManifest.IsKnownModel("vsd2/wifi")
    && DeckManifest.IsLocalWindowModel("ui stream deck"));
Check("M4b surrounding whitespace does not matter", DeckManifest.IsNetworkModel("  VSD2/WiFi "));
Check("M4c ...and it is trimmed off what the reader returns",
    Model("""{"Device":{"Model":"  VSD2/WiFi  "}}""") == "VSD2/WiFi");

// M5 · the other direction. Matching loosely would mirror some unrelated device, and for
// a physical deck that means capturing and CLICKING a window that is not a deck at all.
Check("M5 an unrelated model is not known", !DeckManifest.IsKnownModel("20GAA9901")
    && !DeckManifest.IsKnownModel("GRETSCH"));
Check("M5b a near-miss is not known", !DeckManifest.IsKnownModel("AI Stream Deck"));
Check("M5c a prefix is not a match", !DeckManifest.IsKnownModel("VSD2"));
Check("M5d a superstring is not a match", !DeckManifest.IsKnownModel("VSD2/WiFi/Extra"));
Check("M5e a substring host is not a match", !DeckManifest.IsKnownModel("My UI Stream Deck v2"));
Check("M5f empty and null are not known",
    !DeckManifest.IsKnownModel("") && !DeckManifest.IsKnownModel(null)
    && !DeckManifest.IsLocalWindowModel(null) && !DeckManifest.IsNetworkModel(null));

Console.WriteLine("Wired up");

// M6 · a TEXT check, and labelled as one, in the style of tools/StreamDeckPaths. The
// predicates above answer correctly; none of it proves the bridge ASKS them, and the
// bridge needs Windows, an Elgato installation and a live profile to drive. The specific
// regression being guarded is a return to a hardcoded model comparison.
var bridge = FindUpwards("src/Plinth/App/StreamDeckBridge.cs");
if (bridge is null)
{
    Check("M6 setup: StreamDeckBridge.cs was found", false);
}
else
{
    var code = File.ReadAllText(bridge);
    Check("M6 discovery asks the reader for the model, not TryGetProperty by hand",
        code.Contains("DeckManifest.ReadDeviceModel(root)"));
    Check("M6b discovery filters on the shared list",
        code.Contains("DeckManifest.IsKnownModel(model)"));
    Check("M6c no model literal is compared against in the bridge",
        !code.Contains("\"UI Stream Deck\"") && !code.Contains("\"VSD2/WiFi\""),
        "model strings belong in DeckManifest, where the probes above can reach them");
    Check("M6d the profile carries whether it can be captured and clicked",
        code.Contains("DeckManifest.IsLocalWindowModel(model)"));
    // The regression this ordering exists to prevent is invisible in the UI: a working
    // mirror quietly becomes a static one because some other profile was edited later.
    Check("M6e an unnamed pick prefers a window-backed deck over a merely newer one",
        code.Contains("OrderByDescending(p => DeckManifest.IsLocalWindowModel(p.Model))"));
}

static string? FindUpwards(string relative)
{
    var dir = new DirectoryInfo(AppContext.BaseDirectory);
    while (dir is not null)
    {
        var candidate = Path.Combine(dir.FullName, relative.Replace('/', Path.DirectorySeparatorChar));
        if (File.Exists(candidate)) return candidate;
        dir = dir.Parent;
    }
    return null;
}

Console.WriteLine(failures == 0 ? "ALL PASS" : $"{failures} FAILURES");
return failures == 0 ? 0 : 1;
