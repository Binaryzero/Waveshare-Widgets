// Probes for the install-time credential rule (#57), run against the real
// CredentialNames/WidgetManifest source. Exit code 0 = all pass.
//
// C1 is the one that matters most: it reads the SAME fixture the Node validator's
// --self-test reads, so the two implementations of the rule cannot disagree without CI
// noticing. Everything after it covers turning a flagged name into an actual refusal.
using System.Text.Json;
using System.Text.Json.Nodes;
using WaveshareWidgets.Widgets;

var failures = 0;
void Check(string name, bool ok, string? detail = null)
{
    Console.WriteLine($"  {(ok ? "PASS" : "FAIL")} {name}{(detail is null ? "" : " - " + detail)}");
    if (!ok) failures++;
}

// The fixture lives next to the Node validator that also reads it — one file, so a new
// case is added once and both sides are held to it.
var fixturePath = Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "credential-names.json");
if (!File.Exists(fixturePath))
{
    Console.Error.WriteLine($"fixture not found at {Path.GetFullPath(fixturePath)}");
    return 1;
}
var fixture = JsonNode.Parse(File.ReadAllText(fixturePath))!;
var credentialNames = fixture["credential"]!.AsArray().Select(n => n!.GetValue<string>()).ToList();
var innocentNames = fixture["innocent"]!.AsArray().Select(n => n!.GetValue<string>()).ToList();

// ---- C1 · the C# rule agrees with the shared fixture --------------------------------
var missed = credentialNames.Where(n => !CredentialNames.LooksLikeCredential(n)).ToList();
var falsePositives = innocentNames.Where(CredentialNames.LooksLikeCredential).ToList();
Check($"C1 every credential spelling in the fixture is flagged ({credentialNames.Count})",
    missed.Count == 0, missed.Count == 0 ? null : "missed: " + string.Join(", ", missed));
Check($"C1b no innocent name in the fixture is flagged ({innocentNames.Count})",
    falsePositives.Count == 0, falsePositives.Count == 0 ? null : "flagged: " + string.Join(", ", falsePositives));

// The fixture is only a guard if it is actually populated — an empty or truncated file
// would make C1/C1b pass vacuously, which is the failure mode of every fixture-driven
// test. These bounds are deliberately loose; they exist to catch "the file got emptied".
Check("C1c the fixture is substantial enough to mean something",
    credentialNames.Count >= 30 && innocentNames.Count >= 30,
    $"{credentialNames.Count} credential / {innocentNames.Count} innocent");

// ---- C2 · a flagged name becomes a refusal ------------------------------------------
static WidgetManifest ManifestWith(params WidgetProperty[] props) =>
    new() { Id = "com.example.test", Name = "Test", Properties = [.. props] };

var plaintextToken = ManifestWith(new WidgetProperty { Name = "apiToken", Label = "API token", Type = "text" });
Check("C2 a credential declared as text is refused",
    !plaintextToken.CredentialsAreTyped(out var c2Error), c2Error);
Check("C2b the refusal names the offending property, not just the widget",
    c2Error.Contains("apiToken"), c2Error);

var typedToken = ManifestWith(new WidgetProperty { Name = "apiToken", Label = "API token", Type = "secret" });
Check("C2c the same credential declared as secret is accepted",
    typedToken.CredentialsAreTyped(out _));

// A refusal must not fire on ordinary settings, or every third-party widget breaks.
var ordinary = ManifestWith(
    new WidgetProperty { Name = "feedUrl", Type = "text" },
    new WidgetProperty { Name = "userKeyboardLayout", Type = "select" },
    new WidgetProperty { Name = "pollSeconds", Type = "number" });
Check("C2d ordinary settings are left alone", ordinary.CredentialsAreTyped(out var c2dError), c2dError);

// `secret` is the only accepting type — number/select/color would all reach layout.json
// in the clear just as text does.
var numericToken = ManifestWith(new WidgetProperty { Name = "accessKey", Type = "number" });
Check("C2e a credential typed as something OTHER than text is still refused",
    !numericToken.CredentialsAreTyped(out _));

// ---- C3 · list fields, which are never encrypted ------------------------------------
// SecretPolicy walks top-level properties only, so there is no safe type for a
// credential inside a list row — the refusal has to reach into `fields`.
var listWithSecret = ManifestWith(new WidgetProperty
{
    Name = "endpoints",
    Type = "list",
    Fields = JsonNode.Parse("""[{"key":"label","type":"text"},{"key":"apiKey","type":"text"}]"""),
});
Check("C3 a credential-looking list FIELD is refused",
    !listWithSecret.CredentialsAreTyped(out var c3Error), c3Error);
Check("C3b the refusal names the field and its parent property",
    c3Error.Contains("apiKey") && c3Error.Contains("endpoints"), c3Error);

var listClean = ManifestWith(new WidgetProperty
{
    Name = "hosts",
    Type = "list",
    Fields = JsonNode.Parse("""[{"key":"label","type":"text"},{"key":"host","type":"text"}]"""),
});
Check("C3c an ordinary list is left alone", listClean.CredentialsAreTyped(out var c3cError), c3cError);

// A list whose `fields` is absent or not an array must not throw — third-party
// manifests are not obliged to be well-formed, and a crash here would take out Rescan
// for every widget, not just the malformed one.
var listNoFields = ManifestWith(new WidgetProperty { Name = "hosts", Type = "list" });
var listOddFields = ManifestWith(new WidgetProperty
{
    Name = "hosts",
    Type = "list",
    Fields = JsonNode.Parse("""{"not":"an array"}"""),
});
var survived = true;
try { listNoFields.CredentialsAreTyped(out _); listOddFields.CredentialsAreTyped(out _); }
catch (Exception ex) { survived = false; Console.WriteLine("    threw: " + ex.Message); }
Check("C3d a malformed list property does not throw", survived);

// ---- C4 · the identity checks still work --------------------------------------------
// CredentialsAreTyped is deliberately separate from IsValid (iCUE widgets have no
// properties at IsValid time), so confirm neither swallowed the other's job.
var noId = new WidgetManifest { Id = "", Name = "Test" };
Check("C4 IsValid still rejects a manifest with no id", !noId.IsValid(out _));
Check("C4b a credential manifest passes IsValid — the two checks are independent",
    plaintextToken.IsValid(out _));

Console.WriteLine(failures == 0 ? "ALL PASS" : $"{failures} FAILURES");
return failures == 0 ? 1 - 1 : 1;
