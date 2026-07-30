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
// The MEMBERS matter as much as the array. `fields: [1]` makes field["key"] throw (you
// cannot index a JsonValue) and a numeric `key` throws from GetValue<string>(). Either
// one escaped to Rescan's outer catch, which skips the widget WITHOUT recording a
// rejection — so it vanished from the palette AND from the banner that exists to explain
// exactly that. The original C3d only covered a non-array `fields`, and its name claimed
// the general case; a probe whose name overstates its coverage stops the next reader
// looking, which is how this survived (#63 item 3).
var listScalarMember = ManifestWith(new WidgetProperty
{
    Name = "hosts",
    Type = "list",
    Fields = JsonNode.Parse("""[1]"""),
});
var listNumericKey = ManifestWith(new WidgetProperty
{
    Name = "hosts",
    Type = "list",
    Fields = JsonNode.Parse("""[{"key":5,"type":"text"}]"""),
});
var listNullMember = ManifestWith(new WidgetProperty
{
    Name = "hosts",
    Type = "list",
    Fields = JsonNode.Parse("""[null,{"key":"label"}]"""),
});
var survived = true;
try
{
    listNoFields.CredentialsAreTyped(out _);
    listOddFields.CredentialsAreTyped(out _);
    listScalarMember.CredentialsAreTyped(out _);
    listNumericKey.CredentialsAreTyped(out _);
    listNullMember.CredentialsAreTyped(out _);
}
catch (Exception ex) { survived = false; Console.WriteLine("    threw: " + ex.GetType().Name + ": " + ex.Message); }
Check("C3d no malformed `fields` shape throws — array, member or key", survived);
// A malformed MEMBER is refused, not skipped. Skipping it here only moved the crash:
// the array still installs and still reaches settings.js and shell.js, which read
// field.key/field.type on every entry — a null throws during list rendering, a scalar
// writes settings under an `undefined` key. Silently dropping the member would repeat
// #24, where quietly stripped list keys made whole settings panels vanish in the field.
Check("C3e a scalar member is refused, with a reason naming the property",
    !listScalarMember.CredentialsAreTyped(out var c3eError) && c3eError.Contains("hosts"), c3eError);
Check("C3e2 a non-string key is refused too — rows are stored under it",
    !listNumericKey.CredentialsAreTyped(out var c3e2Error) && c3e2Error.Contains("key"), c3e2Error);
Check("C3e3 a null member is refused", !listNullMember.CredentialsAreTyped(out _));
// A `fields` that is not an array at all stays TOLERATED: nothing iterates it, so it
// cannot break the editor, and refusing over a key nobody reads is the install-stricter-
// than-build divergence round seven removed.
Check("C3e4 a non-array `fields` is still tolerated — nothing iterates it",
    listOddFields.CredentialsAreTyped(out _) && listNoFields.CredentialsAreTyped(out _));
// The credential rule must still fire for a well-formed list beside all of that.
var listMixed = ManifestWith(new WidgetProperty
{
    Name = "endpoints",
    Type = "list",
    Fields = JsonNode.Parse("""[{"key":"label"},{"key":"apiKey"}]"""),
});
Check("C3f a real credential key is still caught",
    !listMixed.CredentialsAreTyped(out var c3fError) && c3fError.Contains("apiKey"), c3fError);

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

// ---- C8 · an authorization header holds the whole credential -------------------------
// `authorizationHeader` typed as text carries "Bearer eyJ…" verbatim into layout.json.
// None of the credential words matched it: "auth" alone is far too broad (authMode,
// authType), so the spellings are named explicitly.
foreach (var name in new[] { "authorizationHeader", "authHeader", "authorization", "auth_header" })
    Check($"C8 '{name}' is recognised as a credential", CredentialNames.LooksLikeCredential(name));
// The neighbours that must stay innocent, or every widget configuring auth breaks.
foreach (var name in new[] { "authMode", "authType", "authScheme", "headerName", "authorizationType" })
    Check($"C8b '{name}' is left alone", !CredentialNames.LooksLikeCredential(name));

// ---- C9 · the refusal must not publish what it refused -------------------------------
// A refused widget leaves the library, so nothing downstream knows which of its stored
// settings are credentials — SecretPolicy skips the slot and the settings window posts
// the plaintext apiToken to the editor untouched. CredentialPropertyNames is the metadata
// that keeps those slots on the pipeline; the round-trip itself is probed in
// tools/SecretRoundTrip (P27).
var refused = ManifestWith(
    new WidgetProperty { Name = "apiToken", Type = "text" },
    new WidgetProperty { Name = "clientSecret", Type = "secret" },
    new WidgetProperty { Name = "feedUrl", Type = "text" },
    new WidgetProperty { Name = "pollSeconds", Type = "number" });
var redact = refused.CredentialPropertyNames();
Check("C9 the refused plaintext credential is named for redaction",
    redact.Contains("apiToken"), string.Join(", ", redact));
Check("C9b a properly-typed secret in the same manifest is named too — it is still not the editor's",
    redact.Contains("clientSecret"), string.Join(", ", redact));
Check("C9c ordinary settings are NOT redacted, or the user's config vanishes from the editor",
    !redact.Contains("feedUrl") && !redact.Contains("pollSeconds"), string.Join(", ", redact));

// Lists are deliberately excluded: Mask would replace the array with a placeholder and
// Seal, finding no stored STRING to restore, would delete the whole list. Redacting it
// would destroy the user's data to protect it.
var refusedList = ManifestWith(new WidgetProperty
{
    Name = "endpoints",
    Type = "list",
    Fields = JsonNode.Parse("""[{"key":"apiKey","type":"text"}]"""),
});
Check("C9d a list property is left off the redaction set", refusedList.CredentialPropertyNames().Count == 0,
    string.Join(", ", refusedList.CredentialPropertyNames()));
// The stand-in manifest is what actually re-enters the pipeline, so it has to declare
// every name as `secret` — any other type and SecretPolicy walks straight past it.
var standIn = WidgetManifest.RedactionOnly("com.example.refused", "Refused", redact);
Check("C9e the stand-in declares every redacted name as a secret",
    standIn.Properties.Count == redact.Count && standIn.Properties.All(p => p.Type == "secret"),
    string.Join(", ", standIn.Properties.Select(p => $"{p.Name}:{p.Type}")));
Check("C9f and it keeps the widget's identity, or the lookup never finds it",
    standIn.Id == "com.example.refused");
// A duplicate name would make Mask walk the same field twice; harmless today, but the
// set is the contract.
var dupes = ManifestWith(
    new WidgetProperty { Name = "apiToken", Type = "text" },
    new WidgetProperty { Name = "apiToken", Type = "secret" });
Check("C9g repeated names collapse", dupes.CredentialPropertyNames().Count == 1);

// ---- C10 · a nameless property is inert, not a landmine ------------------------------
// `"name": null` is legal JSON against a non-nullable property — the deserializer does not
// enforce the annotation. The null then reaches every consumer that assumed otherwise; in
// the settings window it was keyed into a Dictionary and threw ArgumentNullException from
// inside an invoked UI delegate, taking the window down. Normalizing at the source is what
// stops each consumer having to remember.
var nulled = JsonSerializer.Deserialize<WidgetProperty>("""{"name":null,"type":"text"}""")!;
Check("C10 a null name deserializes to the empty name, never to null", nulled.Name == "", nulled.Name ?? "(null)");
Check("C10b assigning null directly is normalized too",
    new WidgetProperty { Name = null! }.Name == "");
var namelessManifest = ManifestWith(
    new WidgetProperty { Name = null!, Type = "text" },
    new WidgetProperty { Name = "apiToken", Type = "secret" });
Check("C10c a nameless property does not break the credential check",
    namelessManifest.CredentialsAreTyped(out var c10Error), c10Error);
Check("C10d and is left out of the redaction set — nothing can address it",
    namelessManifest.CredentialPropertyNames() is ["apiToken"],
    string.Join(", ", namelessManifest.CredentialPropertyNames()));

// ---- C11 · property names are ORDINAL, like the settings keys they address ------------
// SecretPolicy.SecretNames is an ordinal set and settings are JSON object keys, so
// `apiToken` and `ApiToken` are two different settings. Anything that folds them together
// loses one of the two — and the one it loses is a credential.
var caseDistinct = ManifestWith(
    new WidgetProperty { Name = "apiToken", Type = "secret" },
    new WidgetProperty { Name = "ApiToken", Type = "secret" });
Check("C11 two names differing only in case are two properties, not one",
    caseDistinct.CredentialPropertyNames().Count == 2,
    string.Join(", ", caseDistinct.CredentialPropertyNames()));

// ---- C12 · `fields` belongs to lists, and only to lists -------------------------------
// The Node validator reads `fields` only for `type: "list"`, and only list editors consume
// those definitions. Scanning it on every property refused a widget over dormant metadata
// nothing reads — a property demoted from `list` to `text` that kept its old field list.
// That is the build-passes/install-refuses divergence this PR exists to prevent, aimed the
// other way, and it is worse than the reverse: the widget simply disappears.
var dormantFields = ManifestWith(new WidgetProperty
{
    Name = "endpoint",
    Type = "text",
    Fields = JsonNode.Parse("""[{"key":"apiKey","type":"text"}]"""),
});
Check("C12 a non-list property's leftover fields do not refuse the widget",
    dormantFields.CredentialsAreTyped(out var c12Error), c12Error);
Check("C12b but a real list is still scanned", !listWithSecret.CredentialsAreTyped(out _));

// ---- C13 · a refused widget already in the snapshot is MERGED, not replaced -----------
// A folder edit can retype a property AND refuse the manifest in the same breath. The
// settings window is holding the old entry, so a stand-in cannot replace it (that blanks
// every other secret it declares) and cannot be skipped either (the stale entry still
// calls the retyped property `text`, and Seal writes the credential out in the clear).
var wasLoaded = ManifestWith(
    new WidgetProperty { Name = "feedUrl", Label = "Feed", Type = "text" },
    new WidgetProperty { Name = "clientSecret", Label = "Client secret", Type = "secret" });
var merged = wasLoaded.WithSecretsForced(["feedUrl", "apiToken"]);
Check("C13 a retyped property is upgraded to secret in place",
    merged.Properties.Single(p => p.Name == "feedUrl").Type == "secret");
Check("C13b its label survives the upgrade — this manifest still renders the editor",
    merged.Properties.Single(p => p.Name == "feedUrl").Label == "Feed");
Check("C13c a name the old manifest never had is added",
    merged.Properties.Any(p => p.Name == "apiToken" && p.Type == "secret"));
Check("C13d and every other secret it already declared survives",
    merged.Properties.Any(p => p.Name == "clientSecret" && p.Type == "secret"));
Check("C13e the manifest's identity is preserved, or the lookup stops finding it",
    merged.Id == wasLoaded.Id && merged.Properties.Count == 3);
Check("C13f the original is not mutated — the snapshot decides what to keep",
    wasLoaded.Properties.Single(p => p.Name == "feedUrl").Type == "text");

// ---- C14 · a SHADOWED refusal must not force names onto a different widget ------------
// Two folders, same id, ordinally equal: one refused, one loaded. The refusal's redaction
// names have to survive (that is the #63 P1) but they describe the REFUSED copy. Forcing
// them onto the loaded manifest is destructive where the loaded copy declares that name as
// something Mask/Seal cannot round-trip: Mask writes a placeholder, BuildStoredIndex
// cannot index a non-string to restore, and Seal's empty branch REMOVES the property.
var loadedCopy = ManifestWith(
    new WidgetProperty { Name = "endpoints", Label = "Endpoints", Type = "list" },
    new WidgetProperty { Name = "pollSeconds", Type = "number" });
var added = loadedCopy.WithSecretsAdded(["endpoints", "pollSeconds", "apiToken"]);
Check("C14 a list the loaded widget declares is left alone, not forced to secret",
    added.Properties.Single(p => p.Name == "endpoints").Type == "list",
    added.Properties.Single(p => p.Name == "endpoints").Type);
Check("C14b nor is any other declared property",
    added.Properties.Single(p => p.Name == "pollSeconds").Type == "number");
Check("C14c but a name the loaded widget never declares IS added as a secret — that is the leak",
    added.Properties.Any(p => p.Name == "apiToken" && p.Type == "secret"));
Check("C14d and its label survives, so the entry still renders",
    added.Properties.Single(p => p.Name == "endpoints").Label == "Endpoints");
// The forcing variant still forces — it is right when the entry IS this widget's own older
// manifest (a property retyped by the same folder edit that refused it).
Check("C14e WithSecretsForced still overrides a declared property, for the same-widget case",
    loadedCopy.WithSecretsForced(["endpoints"]).Properties.Single(p => p.Name == "endpoints").Type == "secret");

// ---- C4 · the identity checks still work --------------------------------------------
// CredentialsAreTyped is deliberately separate from IsValid (iCUE widgets have no
// properties at IsValid time), so confirm neither swallowed the other's job.
var noId = new WidgetManifest { Id = "", Name = "Test" };
Check("C4 IsValid still rejects a manifest with no id", !noId.IsValid(out _));
Check("C4b a credential manifest passes IsValid — the two checks are independent",
    plaintextToken.IsValid(out _));

Console.WriteLine(failures == 0 ? "ALL PASS" : $"{failures} FAILURES");
return failures == 0 ? 1 - 1 : 1;
