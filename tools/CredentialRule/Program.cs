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

// ---- C5 · the declared type is canonicalized ----------------------------------------
// SecretPolicy matches the type with OrdinalIgnoreCase, but settings.js compares
// `pr.type === 'secret'` exactly. A manifest declaring "Secret" was therefore encrypted
// at rest AND rendered as an ordinary text field — which drops it from the replica's
// redaction list and lets a freshly typed credential into the preview. Normalizing on
// the way in is what makes the two agree.
var shouty = new WidgetProperty { Name = "apiToken", Type = "SECRET" };
Check("C5 an upper-case type is normalized to the canonical spelling",
    shouty.Type == "secret", shouty.Type);
Check("C5b whitespace and mixed case too",
    new WidgetProperty { Type = "  Secret " }.Type == "secret");
Check("C5c an empty type still falls back to text",
    new WidgetProperty { Type = "" }.Type == "text" && new WidgetProperty { Type = null! }.Type == "text");
Check("C5d a 'Secret' credential is accepted, not refused — it is valid, just shouty",
    ManifestWith(shouty).CredentialsAreTyped(out _));
// Round-tripping the manifest must hand the client the canonical value, since that is
// the whole point: the editor's exact-match comparison has to see 'secret'.
var roundTripped = JsonSerializer.Deserialize<WidgetProperty>(
    """{"name":"apiToken","type":"Secret"}""")!;
Check("C5e deserializing a manifest normalizes it, so the editor sees 'secret'",
    roundTripped.Type == "secret", roundTripped.Type);

// ---- C6 · a secret must not ship a default ------------------------------------------
// Defaults are merged AFTER SecretPolicy.Reveal, so a default on a secret is delivered
// to the widget and the preview as plaintext, never having been protected. The Node
// validator has refused this since #15; the install path did not.
var defaulted = ManifestWith(new WidgetProperty
{
    Name = "apiToken",
    Type = "secret",
    Default = JsonValue.Create("hunter2"),
});
Check("C6 a secret carrying a default is refused", !defaulted.CredentialsAreTyped(out var c6Error), c6Error);
Check("C6b the refusal explains why a default is never protected",
    c6Error.Contains("apiToken") && c6Error.Contains("plaintext"), c6Error);
var emptyDefault = ManifestWith(new WidgetProperty
{
    Name = "apiToken",
    Type = "secret",
    Default = JsonValue.Create(""),
});
Check("C6c an empty default is harmless and accepted", emptyDefault.CredentialsAreTyped(out var c6cError), c6cError);
Check("C6d no default at all is accepted",
    ManifestWith(new WidgetProperty { Name = "apiToken", Type = "secret" }).CredentialsAreTyped(out _));
// A default on an ordinary property is normal and must stay allowed.
Check("C6e a non-secret property may still ship a default",
    ManifestWith(new WidgetProperty { Name = "label", Type = "text", Default = JsonValue.Create("Living room") })
        .CredentialsAreTyped(out _));

// ---- C7 · metadata ABOUT a credential is not a credential ----------------------------
// An OAuth widget legitimately exposes tokenEndpoint (a public URL), tokenExpiry (a
// duration) and accessTokenType ("Bearer"). Flagging those refused the whole widget
// unless the author declared a public URL as `secret`, which would be a lie about what
// the field holds. The exemption is a TAIL match and deliberately narrow.
foreach (var metadata in new[] { "tokenEndpoint", "tokenExpiry", "accessTokenType", "secretScope", "apiKeyFormat" })
    Check($"C7 metadata name '{metadata}' is not treated as a credential",
        !CredentialNames.LooksLikeCredential(metadata));
// The boundary in the other direction is what keeps the exemption honest: these end in
// words that CAN hold the secret, so they must still be refused.
foreach (var real in new[] { "tokenValue", "secretUrl", "apiToken", "apiKeyName" })
    Check($"C7b '{real}' still counts as a credential", CredentialNames.LooksLikeCredential(real));
// The webhook rule is independent of the exemption — a webhook endpoint IS the secret.
Check("C7c webhookEndpoint stays flagged despite ending in a metadata word",
    CredentialNames.LooksLikeCredential("webhookEndpoint"));
Check("C7d and a refused metadata property no longer blocks the install",
    ManifestWith(new WidgetProperty { Name = "tokenEndpoint", Type = "text" }).CredentialsAreTyped(out _));

// ---- C4 · the identity checks still work --------------------------------------------
// CredentialsAreTyped is deliberately separate from IsValid (iCUE widgets have no
// properties at IsValid time), so confirm neither swallowed the other's job.
var noId = new WidgetManifest { Id = "", Name = "Test" };
Check("C4 IsValid still rejects a manifest with no id", !noId.IsValid(out _));
Check("C4b a credential manifest passes IsValid — the two checks are independent",
    plaintextToken.IsValid(out _));

Console.WriteLine(failures == 0 ? "ALL PASS" : $"{failures} FAILURES");
return failures == 0 ? 1 - 1 : 1;
