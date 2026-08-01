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
using WaveshareWidgets.App;

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

Console.WriteLine(failures == 0 ? "ALL PASS" : $"{failures} FAILURES");
return failures == 0 ? 0 : 1;
