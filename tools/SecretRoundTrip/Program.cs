// Probes for the `secret` property pipeline (#15), run against the real
// SecretStore/SecretPolicy/LayoutSlot source. Exit code 0 = all pass.
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Plinth.Widgets;

var failures = 0;
void Check(string name, bool ok, string? detail = null)
{
    Console.WriteLine($"  {(ok ? "PASS" : "FAIL")} {name}{(detail is null ? "" : " - " + detail)}");
    if (!ok) failures++;
}

// A reversible stand-in for DPAPI: CI runs on Linux, where ProtectedData throws. The
// bytes are transformed (not merely copied) so "encrypted" is observably not plaintext.
//
// It also AUTHENTICATES, because the code under test depends on that. Real DPAPI throws
// for any blob it did not produce, which is what lets CanUnprotect answer "did WE write
// this?" — the question the reveal-side scrub and Seal's idempotent-resave branch both
// ask. An earlier stand-in happily "decrypted" any untagged bytes, so every marker-shaped
// string looked like our own ciphertext and two probes drew the wrong conclusion from it.
// A stand-in that is more permissive than the real thing does not merely weaken a probe;
// it silently changes which branch is under test.
byte[] Magic = [0x57, 0x57];   // "WW"
byte[] Flip(byte[] input)
{
    var output = new byte[input.Length + Magic.Length];
    Magic.CopyTo(output, 0);
    for (var i = 0; i < input.Length; i++) output[i + Magic.Length] = (byte)(input[i] ^ 0x5A);
    return output;
}
SecretStore.EncryptOverride = Flip;
// A blob "sealed by another user/machine" must be BOTH well-formed (marker + valid
// base64, so it really is shaped like one of ours) and un-openable here. Real DPAPI
// throws for a foreign key; the stand-in throws for a tagged prefix, so the probe can
// tell a foreign envelope apart from legacy plaintext that merely starts with the
// marker — which is exactly the distinction Seal now makes.
byte[] TaggedDecrypt(byte[] b)
{
    if (b.Length >= 2 && b[0] == 0xFE && b[1] == 0xED)
        throw new CryptographicException("that key belongs to another user");
    // Not ours: no magic prefix. Real DPAPI raises exactly here for a blob it did not
    // produce, and several branches under test turn on that distinction.
    if (b.Length < Magic.Length || b[0] != Magic[0] || b[1] != Magic[1])
        throw new CryptographicException("not produced by this cipher");
    var output = new byte[b.Length - Magic.Length];
    for (var i = 0; i < output.Length; i++) output[i] = (byte)(b[i + Magic.Length] ^ 0x5A);
    return output;
}
SecretStore.DecryptOverride = TaggedDecrypt;
// marker + valid base64, first bytes tagged so decryption refuses it.
var ForeignEnvelope = "dpapi:v1:" + Convert.ToBase64String([0xFE, 0xED, 0x01, 0x02, 0x03]);

const string Token = "ghp_SUPERSECRET-abc123";
var manifest = new WidgetManifest
{
    Id = "test.widget",
    Name = "Test",
    Properties =
    [
        new WidgetProperty { Name = "apiToken", Label = "API token", Type = "secret" },
        new WidgetProperty { Name = "repo", Label = "Repo", Type = "text" },
    ],
};
WidgetManifest? Lookup(string id) => id == "test.widget" ? manifest : null;

static DashboardLayout LayoutWith(JsonObject settings, string? instanceId = "i1") => new()
{
    Pages = [new LayoutPage { Name = "P", Slots = [new LayoutSlot
    {
        WidgetId = "test.widget", InstanceId = instanceId, Size = "half", Settings = settings,
    }] }],
};
static LayoutSlot Slot(DashboardLayout l) => l.Pages[0].Slots[0];
// The editor's cleared-address projection, as Seal receives it. A clear is a NAME beside
// the layout now, never a sentinel inside a value — so a probe cannot express one by
// writing a magic string into a setting, which is the point.
static IReadOnlyDictionary<(int Page, int Slot), IReadOnlyList<string>> ClearedAt(
    int page, int slot, params string[] names) =>
    new Dictionary<(int, int), IReadOnlyList<string>> { [(page, slot)] = names };
static IReadOnlyDictionary<(int Page, int Slot), IReadOnlyList<string>> Cleared(params string[] names) =>
    ClearedAt(0, 0, names);
static string? Value(DashboardLayout l, string name) =>
    Slot(l).Settings?[name] is System.Text.Json.Nodes.JsonValue v && v.TryGetValue<string>(out var s) ? s : null;

// ---- P1 · a typed credential is encrypted before it can be written -------------------
var typed = LayoutWith(new JsonObject { ["apiToken"] = Token, ["repo"] = "owner/name" });
SecretPolicy.Seal(typed, null, Lookup);
var sealedValue = Value(typed, "apiToken");
Check("P1 a plaintext secret is sealed with the dpapi marker",
    SecretStore.HasMarker(sealedValue) && SecretStore.CanUnprotect(sealedValue), sealedValue);
Check("P1b the ciphertext contains no trace of the plaintext",
    sealedValue is not null && !sealedValue.Contains(Token) &&
    !Encoding.UTF8.GetString(Convert.FromBase64String(sealedValue["dpapi:v1:".Length..])).Contains(Token));
Check("P1c a non-secret property is left exactly as it was",
    Value(typed, "repo") == "owner/name");
Check("P1d the serialized layout that reaches disk holds no plaintext",
    !JsonSerializer.Serialize(typed).Contains(Token));

// ---- P2 · the dashboard gets the real value back -------------------------------------
var revealed = JsonSerializer.Deserialize<DashboardLayout>(JsonSerializer.Serialize(typed))!;
SecretPolicy.Reveal(revealed, Lookup);
Check("P2 Reveal returns the exact plaintext to the dashboard payload",
    Value(revealed, "apiToken") == Token, Value(revealed, "apiToken"));

// ---- P3 · the settings editor never receives a stored credential ---------------------
var masked = JsonSerializer.SerializeToNode(typed);
SecretPolicy.Mask(masked, Lookup);
var maskedSlot = masked!["pages"]![0]!["slots"]![0]!;
Check("P3 Mask blanks the secret for the editor",
    maskedSlot["settings"]!["apiToken"]!.GetValue<string>() == "");
Check("P3b the editor is told a value EXISTS via secretsSet",
    maskedSlot["secretsSet"] is JsonArray set && set.Count == 1 && set[0]!.GetValue<string>() == "apiToken");
Check("P3c no plaintext and no ciphertext reach the editor payload",
    !masked.ToJsonString().Contains(Token) && !masked.ToJsonString().Contains("dpapi:v1:"));
Check("P3d secretsSet is projection-only: it cannot round-trip into the model",
    JsonSerializer.Deserialize<DashboardLayout>(masked.ToJsonString()) is { } back &&
    !JsonSerializer.Serialize(back).Contains("secretsSet"));

// ---- P4 · saving an untouched masked field keeps the stored credential ---------------
var resaved = JsonSerializer.Deserialize<DashboardLayout>(masked.ToJsonString())!;
SecretPolicy.Seal(resaved, typed, Lookup);
Check("P4 a masked (empty) value saved back keeps the stored ciphertext",
    Value(resaved, "apiToken") == sealedValue, Value(resaved, "apiToken"));

// ---- P5 · retyping replaces it; clearing removes it ----------------------------------
var retyped = LayoutWith(new JsonObject { ["apiToken"] = "new-token-42" });
SecretPolicy.Seal(retyped, typed, Lookup);
var retypedSealed = Value(retyped, "apiToken");
SecretPolicy.Reveal(retyped, Lookup);
Check("P5 a retyped secret replaces the stored one",
    retypedSealed != sealedValue && Value(retyped, "apiToken") == "new-token-42");

// Clearing is a NAMED ADDRESS, never a value: empty is also what an untouched masked
// field sends, and that has to keep the credential. The value the editor sends alongside
// is a plain empty string, which is what makes any credential text storeable.
var cleared = LayoutWith(new JsonObject { ["apiToken"] = "" });
SecretPolicy.Seal(cleared, typed, SecretPlan.FromManifests(Lookup), Cleared("apiToken"));
Check("P5b a named clear removes a STORED credential (Codex r1: empty alone kept it)",
    Slot(cleared).Settings?["apiToken"] is null, Value(cleared, "apiToken"));
Check("P5c nothing sentinel-shaped is persisted, because none exists",
    !JsonSerializer.Serialize(cleared).Contains("__ww_secret"));
var clearedFresh = LayoutWith(new JsonObject { ["apiToken"] = "" });
SecretPolicy.Seal(clearedFresh, null, SecretPlan.FromManifests(Lookup), Cleared("apiToken"));
Check("P5d clearing with nothing stored also leaves the key absent",
    Slot(clearedFresh).Settings?["apiToken"] is null);
// The address is what carries the intent, so naming a DIFFERENT property must not touch
// this one — the failure a positional or slot-wide flag would have.
var clearedOther = LayoutWith(new JsonObject { ["apiToken"] = "" });
SecretPolicy.Seal(clearedOther, typed, SecretPlan.FromManifests(Lookup), Cleared("repo"));
Check("P5e naming another property leaves this one restored, not removed",
    SecretStore.CanUnprotect(Value(clearedOther, "apiToken")), Value(clearedOther, "apiToken") ?? "(removed)");

// ---- P6 · slots without an instanceId still find their own stored secret -------------
var positional = LayoutWith(new JsonObject { ["apiToken"] = Token }, instanceId: null);
SecretPolicy.Seal(positional, null, Lookup);
var positionalSealed = Value(positional, "apiToken");
Check("P6 sealing a legacy slot mints a stable instanceId so position stops mattering",
    !string.IsNullOrEmpty(Slot(positional).InstanceId), Slot(positional).InstanceId);
var positionalStored = LayoutWith(new JsonObject { ["apiToken"] = positionalSealed! }, instanceId: null);
var positionalMasked = LayoutWith(new JsonObject { ["apiToken"] = "" }, instanceId: null);
SecretPolicy.Seal(positionalMasked, positionalStored, Lookup);
Check("P6b a single un-edited instance still carries over by widgetId+position",
    Value(positionalMasked, "apiToken") == positionalSealed);

// ---- P7 · no DPAPI: fail SAFE, never plaintext ---------------------------------------
SecretStore.EncryptOverride = _ => throw new PlatformNotSupportedException("no DPAPI here");
var noCrypto = LayoutWith(new JsonObject { ["apiToken"] = "would-be-plaintext" });
SecretPolicy.Seal(noCrypto, typed, Lookup);
Check("P7 encryption unavailable: the previously stored ciphertext is kept",
    Value(noCrypto, "apiToken") == sealedValue);
var noCryptoFresh = LayoutWith(new JsonObject { ["apiToken"] = "would-be-plaintext" });
SecretPolicy.Seal(noCryptoFresh, null, Lookup);
Check("P7b encryption unavailable with nothing stored: the key is dropped, never plaintext",
    Slot(noCryptoFresh).Settings?["apiToken"] is null &&
    !JsonSerializer.Serialize(noCryptoFresh).Contains("would-be-plaintext"));
SecretStore.EncryptOverride = Flip;

// ---- P8 · an unreadable blob (other user/machine) degrades to unset ------------------
var foreign = LayoutWith(new JsonObject { ["apiToken"] = ForeignEnvelope });
SecretPolicy.Reveal(foreign, Lookup);
Check("P8 a secret from another user/machine reveals as empty, not as garbage",
    Value(foreign, "apiToken") == "");

// ---- P9 · sealing is idempotent (the dashboard re-saves its own layout) --------------
var again = JsonSerializer.Deserialize<DashboardLayout>(JsonSerializer.Serialize(typed))!;
SecretPolicy.Seal(again, typed, Lookup);
Check("P9 sealing an already-sealed layout changes nothing",
    Value(again, "apiToken") == sealedValue);

// ---- P10 · Codex r1: a `text` → `secret` upgrade ENCRYPTS the old plaintext ----------
// The stored layout still holds the credential in the clear (it predates the switch);
// the editor masks it, and the first save must seal it instead of discarding it.
var legacy = LayoutWith(new JsonObject { ["apiToken"] = "legacy-plaintext-token" });
var legacyMaskedNode = JsonSerializer.SerializeToNode(legacy);
SecretPolicy.Mask(legacyMaskedNode, Lookup);
Check("P10 legacy plaintext still reports as saved to the editor (it IS readable)",
    legacyMaskedNode!["pages"]![0]!["slots"]![0]!["secretsSet"] is JsonArray la && la.Count == 1);
var legacyResaved = JsonSerializer.Deserialize<DashboardLayout>(legacyMaskedNode.ToJsonString())!;
SecretPolicy.Seal(legacyResaved, legacy, Lookup);
var legacySealed = Value(legacyResaved, "apiToken");
SecretPolicy.Reveal(legacyResaved, Lookup);
Check("P10b the first save after the upgrade ENCRYPTS it instead of losing it",
    SecretStore.CanUnprotect(legacySealed) && Value(legacyResaved, "apiToken") == "legacy-plaintext-token",
    legacySealed);

// ---- P11 · Codex r1: swapping the widget in a slot must not inherit its secret -------
var otherManifest = new WidgetManifest
{
    Id = "other.widget", Name = "Other",
    Properties = [new WidgetProperty { Name = "apiToken", Label = "Token", Type = "secret" }],
};
WidgetManifest? Lookup2(string id) =>
    id == "test.widget" ? manifest : id == "other.widget" ? otherManifest : null;
var swapped = new DashboardLayout
{
    Pages = [new LayoutPage { Name = "P", Slots = [new LayoutSlot
    {
        // Same slot identity, different widget, settings reset by the picker.
        WidgetId = "other.widget", InstanceId = "i1", Size = "half",
        Settings = new JsonObject { ["apiToken"] = "" },
    }] }],
};
SecretPolicy.Seal(swapped, typed, Lookup2);
Check("P11 replacing the widget in a slot does NOT inherit the old widget's credential",
    Slot(swapped).Settings?["apiToken"] is null, Value(swapped, "apiToken"));

// ---- P12 · Codex r1: ambiguous legacy positions refuse carry-over --------------------
// Two instances of one widget, no instanceIds: after a move/delete the ordinals no
// longer identify anyone, so carry-over must NOT guess (that could hand instance A's
// credential to instance B).
var twoStored = new DashboardLayout
{
    Pages = [new LayoutPage { Name = "P", Slots =
    [
        new LayoutSlot { WidgetId = "test.widget", Size = "quarter", Settings = new JsonObject { ["apiToken"] = sealedValue! } },
        new LayoutSlot { WidgetId = "test.widget", Size = "quarter", Settings = new JsonObject { ["apiToken"] = "" } },
    ] }],
};
var oneLeft = new DashboardLayout
{
    Pages = [new LayoutPage { Name = "P", Slots =
    [
        new LayoutSlot { WidgetId = "test.widget", Size = "quarter", Settings = new JsonObject { ["apiToken"] = "" } },
    ] }],
};
SecretPolicy.Seal(oneLeft, twoStored, Lookup);
Check("P12 ambiguous legacy positions refuse carry-over instead of guessing an owner",
    oneLeft.Pages[0].Slots[0].Settings?["apiToken"] is null);

// ---- P13 · Codex r1: a foreign/corrupt blob is NOT reported as saved -----------------
var foreignStored = LayoutWith(new JsonObject { ["apiToken"] = "dpapi:v1:AAAABBBBCCCC" });
SecretStore.DecryptOverride = _ => throw new CryptographicException("key belongs to another user");
var foreignNode = JsonSerializer.SerializeToNode(foreignStored);
SecretPolicy.Mask(foreignNode, Lookup);
Check("P13 an unreadable blob is not marked saved (the user must re-enter it here)",
    foreignNode!["pages"]![0]!["slots"]![0]!["secretsSet"] is null);
SecretStore.DecryptOverride = TaggedDecrypt;

// ---- P14 · Codex r1: plaintext that merely LOOKS like an envelope is encrypted -------
var trap = LayoutWith(new JsonObject { ["apiToken"] = "dpapi:v1:this-is-actually-my-password" });
SecretPolicy.Seal(trap, null, Lookup);
var trapSealed = Value(trap, "apiToken");
SecretPolicy.Reveal(trap, Lookup);
Check("P14 a token that merely starts with the marker is still encrypted, not trusted",
    trapSealed != "dpapi:v1:this-is-actually-my-password" &&
    Value(trap, "apiToken") == "dpapi:v1:this-is-actually-my-password", trapSealed);

// ---- P15 · Codex r1: non-string junk never throws (it would kill the init payload) ---
var junk = LayoutWith(new JsonObject { ["apiToken"] = 42 });
var junkNode = JsonSerializer.SerializeToNode(junk);
var revealThrew = false;
var maskThrew = false;
var sealThrew = false;
try { SecretPolicy.Mask(junkNode, Lookup); } catch { maskThrew = true; }
try { SecretPolicy.Reveal(junk, Lookup); } catch { revealThrew = true; }
var junk2 = LayoutWith(new JsonObject { ["apiToken"] = new JsonArray { 1, 2 } });
try { SecretPolicy.Seal(junk2, typed, Lookup); } catch { sealThrew = true; }
Check("P15 a hand-edited non-string secret reads as unset instead of throwing",
    !revealThrew && !maskThrew && !sealThrew && Value(junk, "apiToken") == "");

// ---- P30 · #65 r5: the pipeline never DELETES a value it cannot represent -------------
// Mask/Seal handle strings. A list, number or object under a name something calls secret
// is owned by someone else — a shadowed duplicate id, or a property a newer manifest
// stopped declaring while the editor kept its stored value (settings.js preserves
// undeclared keys). Masking it turned it into a placeholder string, BuildStoredIndex
// could not index the original to restore it, and Seal's empty branch removed the key.
// An unrelated edit deleted the user's list.
var listSetting = new JsonObject { ["apiToken"] = new JsonArray { "a", "b" }, ["repo"] = "owner/name" };
var listLayout = LayoutWith(listSetting);
var listMasked = JsonSerializer.SerializeToNode(listLayout);
SecretPolicy.Mask(listMasked, Lookup);
var listMaskedSlot = listMasked!["pages"]![0]!["slots"]![0]!;
Check("P30 Mask REDACTS a non-string value — it may hold nested credential material",
    listMaskedSlot["settings"]!["apiToken"] is JsonValue,
    listMaskedSlot["settings"]!["apiToken"]?.ToJsonString());
Check("P30b nothing of the original survives into the editor payload",
    !listMasked.ToJsonString().Contains("\"a\"") || !listMasked.ToJsonString().Contains("apiToken"),
    listMaskedSlot["settings"]!.ToJsonString());

// The save round trip: the editor hands the redaction back, and the stored NODE — not a
// stringified shadow of it — is what gets restored. Redacting and restoring used to be
// incompatible: whichever was honoured, the other broke.
var listResaved = JsonSerializer.Deserialize<DashboardLayout>(listMasked.ToJsonString())!;
SecretPolicy.Seal(listResaved, listLayout, Lookup);
Check("P30c an unrelated save restores the array exactly, rather than deleting it",
    Slot(listResaved).Settings?["apiToken"] is JsonArray kept30 && kept30.Count == 2
        && kept30[0]!.GetValue<string>() == "a",
    Slot(listResaved).Settings?["apiToken"]?.ToJsonString() ?? "(removed)");
Check("P30d and the ordinary setting beside it still saves",
    Value(listResaved, "repo") == "owner/name");
// A genuine empty string with nothing stored is still an emptied field, so it is removed —
// the behaviour P5d depends on.
var trulyEmpty = LayoutWith(new JsonObject { ["apiToken"] = "" });
SecretPolicy.Seal(trulyEmpty, null, Lookup);
Check("P30e a genuine empty string with nothing stored is still removed",
    Slot(trulyEmpty).Settings?["apiToken"] is null);
// And a non-string with nothing stored is removed too — there is no value to protect, and
// leaving it would put the pipeline back to guessing from the incoming type.
var orphanArray = LayoutWith(new JsonObject { ["apiToken"] = new JsonArray { 1 } });
SecretPolicy.Seal(orphanArray, null, Lookup);
Check("P30f a non-string with nothing stored is removed, not guessed at",
    Slot(orphanArray).Settings?["apiToken"] is null,
    Slot(orphanArray).Settings?["apiToken"]?.ToJsonString());

// An ID-LESS legacy slot must come out of the restore STAMPED, exactly as the string
// paths do — a slot carrying a value only this pipeline can restore has to be addressable.
// LayoutStore.Load now stamps before anything reaches here, so this is the backstop rather
// than the mechanism; it stays because the branch would silently lose the value if the
// invariant ever lapsed.
var p30gList = LayoutWith(new JsonObject { ["apiToken"] = new JsonArray { "x" } }, instanceId: null);
var p30gMasked = JsonSerializer.SerializeToNode(p30gList);
SecretPolicy.Mask(p30gMasked, Lookup);
var p30gResaved = JsonSerializer.Deserialize<DashboardLayout>(p30gMasked!.ToJsonString())!;
SecretPolicy.Seal(p30gResaved, p30gList, Lookup);
Check("P30g restoring a non-string into an id-less slot mints a stable identity",
    !string.IsNullOrEmpty(Slot(p30gResaved).InstanceId), Slot(p30gResaved).InstanceId ?? "(none)");
Check("P30g2 and the value itself survived that save",
    Slot(p30gResaved).Settings?["apiToken"] is JsonArray g2 && g2.Count == 1,
    Slot(p30gResaved).Settings?["apiToken"]?.ToJsonString() ?? "(removed)");
// The point of the stamp: the NEXT save, now id-bearing on both sides, still finds it.
var p30gStored = JsonSerializer.Deserialize<DashboardLayout>(JsonSerializer.Serialize(p30gResaved))!;
var p30gAgain = JsonSerializer.Deserialize<DashboardLayout>(JsonSerializer.Serialize(p30gResaved))!;
Slot(p30gAgain).Settings!["apiToken"] = "";
SecretPolicy.Seal(p30gAgain, p30gStored, Lookup);
// The protection-failure path must keep a stored NON-STRING too. Its whole purpose is
// to avoid destroying anything when the replacement cannot be encrypted, and filtering
// the fallback through AsString sent a stored list down the remove path instead.
var noCryptoStored = LayoutWith(new JsonObject { ["apiToken"] = new JsonArray { "keepme" } });
var noCryptoTyped = LayoutWith(new JsonObject { ["apiToken"] = "a-new-plaintext-value" });
var savedEncrypt = SecretStore.EncryptOverride;
SecretStore.EncryptOverride = _ => throw new PlatformNotSupportedException("no DPAPI here");
var noCryptoResult = SecretPolicy.Seal(noCryptoTyped, noCryptoStored, Lookup);
SecretStore.EncryptOverride = savedEncrypt;
Check("P30h a failed encryption keeps the stored NON-STRING rather than removing it",
    Slot(noCryptoTyped).Settings?["apiToken"] is JsonArray h30 && h30.Count == 1
        && h30[0]!.GetValue<string>() == "keepme",
    Slot(noCryptoTyped).Settings?["apiToken"]?.ToJsonString() ?? "(removed)");
Check("P30h2 and the failure is still reported, so the save is not called clean",
    noCryptoResult.Failures.Count == 1);
Check("P30h3 the plaintext the user typed is NOT what got written",
    Value(noCryptoTyped, "apiToken") is null);

Check("P30g3 so a later id-keyed save still restores it rather than dropping it",
    Slot(p30gAgain).Settings?["apiToken"] is JsonArray g3 && g3.Count == 1,
    Slot(p30gAgain).Settings?["apiToken"]?.ToJsonString() ?? "(removed)");

// ---- P16 · Codex r2: an unreadable envelope is DROPPED, never re-wrapped -------------
// Re-encrypting a foreign blob would produce an envelope this machine CAN open, so
// Reveal would hand the widget the foreign ciphertext as if it were the credential and
// Mask would go back to calling it saved — exactly the state P13 exists to prevent.
// The blob must be one the cipher genuinely cannot open AND well-formed, or it would
// read as legacy plaintext (which Seal deliberately encrypts instead of dropping).
var r2Foreign = LayoutWith(new JsonObject { ["apiToken"] = ForeignEnvelope });
var foreignEdit = LayoutWith(new JsonObject { ["apiToken"] = "" });   // masked, untouched
SecretPolicy.Seal(foreignEdit, r2Foreign, Lookup);
Check("P16 an unopenable envelope is dropped on save, not sealed inside a new one",
    Slot(foreignEdit).Settings?["apiToken"] is null, Value(foreignEdit, "apiToken"));
Check("P16b nothing was re-wrapped: no envelope survives for Reveal to hand the widget",
    !JsonSerializer.Serialize(foreignEdit).Contains("dpapi:v1:"),
    JsonSerializer.Serialize(foreignEdit));

// ---- P17 · Codex r2: a legacy carry-over mints an id too, or it stays positional -----
// Without this the migrated slot keeps matching by position; adding a second instance of
// the same widget later makes the count ambiguous and its credential is dropped.
var p30gStored2 = LayoutWith(new JsonObject { ["apiToken"] = "legacy-plaintext" }, instanceId: null);
var legacyEdit2 = LayoutWith(new JsonObject { ["apiToken"] = "" }, instanceId: null);
SecretPolicy.Seal(legacyEdit2, p30gStored2, Lookup);
var mintedId = Slot(legacyEdit2).InstanceId;
Check("P17 migrating a legacy secret through the masked field also mints a stable id",
    !string.IsNullOrEmpty(mintedId) && SecretStore.CanUnprotect(Value(legacyEdit2, "apiToken")), mintedId);
// The whole point of the id: a SECOND instance of the same widget must not disturb it.
var withSibling = new DashboardLayout
{
    Pages = [new LayoutPage { Name = "P", Slots = [
        new LayoutSlot { WidgetId = "test.widget", InstanceId = mintedId, Size = "half", Settings = new JsonObject { ["apiToken"] = "" } },
        new LayoutSlot { WidgetId = "test.widget", InstanceId = "other", Size = "half", Settings = new JsonObject { ["apiToken"] = "" } },
    ] }],
};
SecretPolicy.Seal(withSibling, legacyEdit2, Lookup);
Check("P17b adding a second instance no longer strips the migrated slot's credential",
    SecretStore.Unprotect(withSibling.Pages[0].Slots[0].Settings?["apiToken"]?.GetValue<string>() ?? "") == "legacy-plaintext" &&
    withSibling.Pages[0].Slots[1].Settings?["apiToken"] is null);

// ---- P17c · two secrets on ONE slot both survive the id being minted mid-walk --------
var r2TwoManifest = new WidgetManifest
{
    Id = "test.two", Name = "Two",
    Properties = [
        new WidgetProperty { Name = "apiToken", Label = "A", Type = "secret" },
        new WidgetProperty { Name = "clientSecret", Label = "B", Type = "secret" },
    ],
};
WidgetManifest? LookupTwo(string id) => id == "test.two" ? r2TwoManifest : null;
DashboardLayout R2TwoLayout(JsonObject settings) => new()
{
    Pages = [new LayoutPage { Name = "P", Slots = [new LayoutSlot
    { WidgetId = "test.two", InstanceId = null, Size = "half", Settings = settings }] }],
};
var r2TwoStored = R2TwoLayout(new JsonObject { ["apiToken"] = "aaa", ["clientSecret"] = "bbb" });
var r2TwoEdit = R2TwoLayout(new JsonObject { ["apiToken"] = "", ["clientSecret"] = "" });
SecretPolicy.Seal(r2TwoEdit, r2TwoStored, LookupTwo);
var r2TwoSlot = r2TwoEdit.Pages[0].Slots[0];
Check("P17c minting an id mid-walk does not orphan the slot's SECOND secret",
    SecretStore.Unprotect(r2TwoSlot.Settings?["apiToken"]?.GetValue<string>() ?? "") == "aaa" &&
    SecretStore.Unprotect(r2TwoSlot.Settings?["clientSecret"]?.GetValue<string>() ?? "") == "bbb",
    r2TwoSlot.Settings?.ToJsonString());

// ---- P18 · Codex r2: a protection failure is REPORTED, not acknowledged as saved -----
SecretStore.EncryptOverride = _ => throw new CryptographicException("no DPAPI here");
var priorSealed = LayoutWith(new JsonObject { ["apiToken"] = Token });
SecretStore.EncryptOverride = Flip;
SecretPolicy.Seal(priorSealed, null, Lookup);
SecretStore.EncryptOverride = _ => throw new CryptographicException("no DPAPI here");
var retypeFails = LayoutWith(new JsonObject { ["apiToken"] = "brand-new-token" });
var reported = SecretPolicy.Seal(retypeFails, priorSealed, Lookup);
Check("P18 a secret that could not be protected is reported to the caller",
    reported.Failures.Count == 1 && reported.Failures[0].WidgetId == "test.widget" &&
    reported.Failures[0].Property == "apiToken",
    string.Join(",", reported.Failures.Select(f => f.WidgetId + "." + f.Property)));
Check("P18b the fail-safe still holds: the old ciphertext stays, the plaintext is not written",
    Value(retypeFails, "apiToken") == Value(priorSealed, "apiToken"));
var freshFails = LayoutWith(new JsonObject { ["apiToken"] = "brand-new-token" });
var reportedFresh = SecretPolicy.Seal(freshFails, null, Lookup);
Check("P18c a discarded FRESH secret is reported too (the user was told it saved)",
    reportedFresh.Failures.Count == 1 && Slot(freshFails).Settings?["apiToken"] is null);
SecretStore.EncryptOverride = Flip;
var cleanRun = LayoutWith(new JsonObject { ["apiToken"] = Token });
Check("P18d a clean save reports nothing", SecretPolicy.Seal(cleanRun, null, Lookup).Failures.Count == 0);

// ---- P19 · Codex r3: the mint lands on the HOST's copy, not the client's -------------
// Seal stamps an instanceId on its own deserialized layout, so the still-open editor
// keeps sending the slot WITHOUT one. On its second save the stored index is keyed by
// the minted id while the incoming slot keys positionally: the masked empty value finds
// nothing and deletes the credential the first save just encrypted.
var r3Client = LayoutWith(new JsonObject { ["apiToken"] = Token }, instanceId: null);
SecretPolicy.Seal(r3Client, null, Lookup);              // host mints on ITS copy...
var r3OnDisk = JsonSerializer.Deserialize<DashboardLayout>(JsonSerializer.Serialize(r3Client))!;
Check("P19 the first save encrypts and mints an id on disk",
    SecretStore.CanUnprotect(Value(r3OnDisk, "apiToken")) && !string.IsNullOrEmpty(Slot(r3OnDisk).InstanceId),
    Slot(r3OnDisk).InstanceId);
// ...while the editor still holds an id-less slot with a masked (empty) secret.
var r3SecondSave = LayoutWith(new JsonObject { ["apiToken"] = "" }, instanceId: null);
SecretPolicy.Seal(r3SecondSave, r3OnDisk, Lookup);
Check("P19b a second save from that stale editor KEEPS the credential",
    SecretStore.Unprotect(Value(r3SecondSave, "apiToken") ?? "") == Token,
    Value(r3SecondSave, "apiToken"));
// The alias must not resurrect the positional guess when the position is ambiguous.
var r3Ambiguous = new DashboardLayout
{
    Pages = [new LayoutPage { Name = "P", Slots = [
        new LayoutSlot { WidgetId = "test.widget", Size = "half", Settings = new JsonObject { ["apiToken"] = "" } },
        new LayoutSlot { WidgetId = "test.widget", Size = "half", Settings = new JsonObject { ["apiToken"] = "" } },
    ] }],
};
SecretPolicy.Seal(r3Ambiguous, r3OnDisk, Lookup);
Check("P19c but two id-less instances still refuse to guess which one owns it",
    r3Ambiguous.Pages[0].Slots.All(s => s.Settings?["apiToken"] is null));

// ---- P20 · Codex r4: marker-prefixed LEGACY PLAINTEXT survives the migration --------
// Round 3 dropped anything marker-prefixed that would not open. That also deleted a
// legacy `text` value that merely starts with the marker. Shape decides now: an
// envelope is marker + valid base64; plaintext is not.
var r4LegacyStored = LayoutWith(new JsonObject { ["apiToken"] = "dpapi:v1:!!!my-actual-token!!!" });
var r4LegacyEdit = LayoutWith(new JsonObject { ["apiToken"] = "" });
SecretPolicy.Seal(r4LegacyEdit, r4LegacyStored, Lookup);
Check("P20 marker-prefixed legacy plaintext is ENCRYPTED, not deleted as a foreign blob",
    SecretStore.Unprotect(Value(r4LegacyEdit, "apiToken") ?? "") == "dpapi:v1:!!!my-actual-token!!!",
    Value(r4LegacyEdit, "apiToken"));
Check("P20b a well-formed foreign envelope is still dropped",
    SecretStore.LooksLikeEnvelope("dpapi:v1:" + Convert.ToBase64String(Encoding.UTF8.GetBytes("x"))) &&
    !SecretStore.LooksLikeEnvelope("dpapi:v1:!!!not-base64!!!"));

// ---- P21 · Codex r4: a credential that reads like protocol stays storeable ----------
// There is no reserved namespace any longer. The strings below were the sentinel and its
// escape hatch, and they are now ordinary text like any other — which is the whole reason
// the projection replaced them. No escaping, at any producer, ever.
const string ExSentinel = "__ww_secret_cleared__";
const string ExEscape = "__ww_secret_lit_";
var r4Literal = LayoutWith(new JsonObject { ["apiToken"] = ExSentinel });
SecretPolicy.Seal(r4Literal, null, Lookup);
Check("P21 a credential equal to the old sentinel is stored verbatim, not read as a clear",
    SecretStore.Unprotect(Value(r4Literal, "apiToken") ?? "") == ExSentinel,
    Value(r4Literal, "apiToken"));
var r4Escape = LayoutWith(new JsonObject { ["apiToken"] = ExEscape + "foo" });
SecretPolicy.Seal(r4Escape, null, Lookup);
Check("P21b and one carrying the old escape prefix keeps every character of it",
    SecretStore.Unprotect(Value(r4Escape, "apiToken") ?? "") == ExEscape + "foo",
    Value(r4Escape, "apiToken"));
var r4StillClears = LayoutWith(new JsonObject { ["apiToken"] = "" });
SecretPolicy.Seal(r4StillClears, typed, SecretPlan.FromManifests(Lookup), Cleared("apiToken"));
Check("P21c while a NAMED clear still means remove",
    Slot(r4StillClears).Settings?["apiToken"] is null);

// ---- P22 · Codex r4: duplicate instanceIds refuse carry-over ------------------------
// shell.js heals duplicates, but the editor can save before the repair lands. Handing
// both colliding slots the same credential is worse than handing neither one.
var r4DupStored = new DashboardLayout
{
    Pages = [new LayoutPage { Name = "P", Slots = [
        new LayoutSlot { WidgetId = "test.widget", InstanceId = "dup", Size = "half", Settings = new JsonObject { ["apiToken"] = "first" } },
        new LayoutSlot { WidgetId = "test.widget", InstanceId = "dup", Size = "half", Settings = new JsonObject { ["apiToken"] = "second" } },
    ] }],
};
var r4DupEdit = new DashboardLayout
{
    Pages = [new LayoutPage { Name = "P", Slots = [
        new LayoutSlot { WidgetId = "test.widget", InstanceId = "dup", Size = "half", Settings = new JsonObject { ["apiToken"] = "" } },
        new LayoutSlot { WidgetId = "test.widget", InstanceId = "dup", Size = "half", Settings = new JsonObject { ["apiToken"] = "" } },
    ] }],
};
SecretPolicy.Seal(r4DupEdit, r4DupStored, Lookup);
Check("P22 duplicate instanceIds carry nothing over instead of cloning one credential",
    r4DupEdit.Pages[0].Slots.All(sl => sl.Settings?["apiToken"] is null));

// ---- P23 · Codex r4: minted ids come back so the client can adopt them ---------------
var r4Mint = LayoutWith(new JsonObject { ["apiToken"] = Token }, instanceId: null);
var r4Result = SecretPolicy.Seal(r4Mint, null, Lookup);
Check("P23 a minted id is reported with the position the CLIENT used",
    r4Result.Minted.Count == 1 && r4Result.Minted[0].Page == 0 && r4Result.Minted[0].Slot == 0 &&
    r4Result.Minted[0].WidgetId == "test.widget" && r4Result.Minted[0].InstanceId == Slot(r4Mint).InstanceId,
    string.Join(",", r4Result.Minted.Select(m => $"{m.Page}/{m.Slot}={m.InstanceId}")));
// Adopting it is what makes the count-change case survive: the editor now sends the id,
// so adding a second instance can no longer strand the first (the r3 alias could not).
var r4Adopted = new DashboardLayout
{
    Pages = [new LayoutPage { Name = "P", Slots = [
        new LayoutSlot { WidgetId = "test.widget", InstanceId = r4Result.Minted[0].InstanceId, Size = "half", Settings = new JsonObject { ["apiToken"] = "" } },
        new LayoutSlot { WidgetId = "test.widget", Size = "half", Settings = new JsonObject { ["apiToken"] = "" } },
    ] }],
};
SecretPolicy.Seal(r4Adopted, r4Mint, Lookup);
Check("P23b after adopting the id, adding a second instance keeps the first credential",
    SecretStore.Unprotect(r4Adopted.Pages[0].Slots[0].Settings?["apiToken"]?.GetValue<string>() ?? "") == Token &&
    r4Adopted.Pages[0].Slots[1].Settings?["apiToken"] is null);
Check("P23c a save that mints nothing reports nothing",
    SecretPolicy.Seal(LayoutWith(new JsonObject { ["apiToken"] = Token }), null, Lookup).Minted.Count == 0);

// ---- P24 · Codex r5: an EMPTY colliding slot still poisons the shared identity ------
// P22 used two populated duplicates. If only one has a value, the empty twin used to
// return before registering its key, so the index kept the survivor and BOTH incoming
// slots inherited it — the unset instance silently gaining someone else's credential.
var r5DupStored = new DashboardLayout
{
    Pages = [new LayoutPage { Name = "P", Slots = [
        new LayoutSlot { WidgetId = "test.widget", InstanceId = "dup", Size = "half", Settings = new JsonObject { ["apiToken"] = "only-one" } },
        new LayoutSlot { WidgetId = "test.widget", InstanceId = "dup", Size = "half", Settings = new JsonObject() },
    ] }],
};
var r5DupEdit = new DashboardLayout
{
    Pages = [new LayoutPage { Name = "P", Slots = [
        new LayoutSlot { WidgetId = "test.widget", InstanceId = "dup", Size = "half", Settings = new JsonObject { ["apiToken"] = "" } },
        new LayoutSlot { WidgetId = "test.widget", InstanceId = "dup", Size = "half", Settings = new JsonObject { ["apiToken"] = "" } },
    ] }],
};
SecretPolicy.Seal(r5DupEdit, r5DupStored, Lookup);
Check("P24 a duplicate id poisons the key even when the colliding slot's secret is unset",
    r5DupEdit.Pages[0].Slots.All(sl => sl.Settings?["apiToken"] is null),
    string.Join(" | ", r5DupEdit.Pages[0].Slots.Select(sl => sl.Settings?["apiToken"]?.ToString() ?? "(absent)")));

// ---- P25 · Codex r5: a failed REPLACEMENT must not destroy legacy plaintext ---------
// The migration branch already preserves a pre-existing plaintext when protection
// fails; the replacement branch required a decryptable envelope, so it deleted the
// credential that was still working.
var r5LegacyStored = LayoutWith(new JsonObject { ["apiToken"] = "still-working-plaintext" });
SecretStore.EncryptOverride = _ => throw new CryptographicException("no DPAPI here");
var r5Replace = LayoutWith(new JsonObject { ["apiToken"] = "the-new-one" });
var r5Result = SecretPolicy.Seal(r5Replace, r5LegacyStored, Lookup);
SecretStore.EncryptOverride = Flip;
Check("P25 a failed replacement keeps the legacy plaintext that still worked",
    Value(r5Replace, "apiToken") == "still-working-plaintext", Value(r5Replace, "apiToken"));
Check("P25b and the failure is still reported, so the save is not called clean",
    r5Result.Failures.Count == 1);

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

// ---- P34 · the plan is asked PER SLOT, and the widget-level question is unreachable ---
// A TEXT assertion, and the only kind available: the refactor's real guarantee is enforced
// by the COMPILER — a caller cannot ask the widget-level question because the method is
// private — and a compile-time guarantee has no runtime mutation to catch. What this pins is
// the modifier itself, because that is the one edit that would silently reopen the shape.
//
// Why it matters: every intent today derives from the manifest, so a slot and its siblings
// get identical answers and the distinction is invisible. It stops being invisible the moment
// an intent depends on a slot's own VALUE — two instances of one widget can be in different
// states, and a per-widget answer treats them as interchangeable. PR #147 was withdrawn over
// four separate consequences of exactly that (#148).
var planSrc = FindUpwards("src/Plinth/Widgets/SecretStore.cs");
if (planSrc is null)
{
    Check("P34 setup: SecretStore.cs was found", false);
}
else
{
    var planText = File.ReadAllText(planSrc);
    Check("P34 the widget-level lookup is private, so nothing can be written against it",
        planText.Contains("private IReadOnlyDictionary<string, SecretIntent> ForWidget("));
    Check("P34b and the public question takes a slot",
        planText.Contains("public IReadOnlyDictionary<string, SecretIntent> For(LayoutSlot? slot)") &&
        planText.Contains("public IReadOnlyDictionary<string, SecretIntent> For(JsonNode? slotNode)"));
}

// ---- P26 · #61 r2: a manifest lookup that FORGETS a widget destroys its secret -------
// Pins the hazard behind SettingsWindow's masked-manifest snapshot. Seal identifies
// secret fields through the manifest; if the widget is no longer in the lookup, Seal
// cannot tell "" from an emptied secret and simply writes the masked blank through.
//
// That is not hypothetical: the settings window rebuilt its snapshot from the live
// library whenever the widgets folder changed, so removing or refusing a credentialed
// widget while Settings was open armed exactly this on the next save. The fix is that
// the snapshot MERGES rather than replaces — a manifest that masked the layout stays
// reachable until the layout is remasked. This probe is why that rule exists.
var r2Stored = LayoutWith(new JsonObject { ["apiToken"] = Token });
SecretPolicy.Seal(r2Stored, null, Lookup);
var r2Sealed = Value(r2Stored, "apiToken");
Check("P26 setup: the credential is stored encrypted", r2Sealed is not null && r2Sealed != Token);

// The editor's masked copy: the credential blanked, exactly what Mask produces.
var r2Masked = LayoutWith(new JsonObject { ["apiToken"] = "" });
SecretPolicy.Seal(r2Masked, r2Stored, _ => null);   // lookup has forgotten the widget
Check("P26 a forgotten manifest lets a masked save wipe the stored credential",
    Value(r2Masked, "apiToken") != r2Sealed,
    "if this ever PASSES as equal, Seal grew its own protection and this probe is obsolete");

// ...and with the manifest retained — what MergeManifestSnapshot guarantees — the same
// masked save is correctly understood as "untouched" and the ciphertext survives.
var r2Kept = LayoutWith(new JsonObject { ["apiToken"] = "" });
SecretPolicy.Seal(r2Kept, r2Stored, Lookup);
Check("P26b retaining the manifest keeps the credential through a masked save",
    Value(r2Kept, "apiToken") == r2Sealed, Value(r2Kept, "apiToken"));

// ---- P27 · #61 r5: refusing a widget must not publish the credential it refused ------
// The install boundary (#57) removes a widget that declares a credential as plaintext.
// But the layout may ALREADY hold that credential — written before the rule existed, or
// by hand — and a refused widget has no manifest in the library, so the lookup returns
// null, Mask walks straight past the slot, and settings-init posts the plaintext to the
// editor. The refusal creates the exposure it exists to prevent.
var refusedManifest = new WidgetManifest
{
    Id = "test.widget",
    Name = "Refused",
    Properties = [new WidgetProperty { Name = "apiToken", Label = "API token", Type = "text" }],
};
Check("P27 setup: this manifest is refused by the install rule",
    !refusedManifest.CredentialsAreTyped(out _));

// What the layout holds: the credential in the clear, because nothing ever encrypted it.
var refusedStored = LayoutWith(new JsonObject { ["apiToken"] = Token });

// The old behaviour, kept in the probe so it can still fail: with no manifest, Mask has
// nothing to walk and the plaintext goes straight out to the editor.
var unmasked = JsonSerializer.SerializeToNode(refusedStored);
SecretPolicy.Mask(unmasked, _ => null);
Check("P27b without redaction metadata the plaintext IS in the editor payload",
    unmasked!.ToJsonString().Contains(Token),
    "if this stops holding, Mask learned to redact unknown widgets and P27c proves less");

// The refusal's credential names, carried into the plan directly. No manifest is
// fabricated to say it any more: the names ARE the classification, per address, as
// ProtectWithoutReveal. See P35 for what that buys over the stand-in.
var refusedNames = refusedManifest.CredentialPropertyNames();
IReadOnlyList<string>? RefusedCredentials(string id) => id == "test.widget" ? refusedNames : null;
// No manifest at all — the library dropped the widget, which is the whole situation.
SecretPlan RefusedPlan() => SecretPlan.FromManifests(_ => null, RefusedCredentials);
var refusedMasked = JsonSerializer.SerializeToNode(refusedStored);
SecretPolicy.Mask(refusedMasked, RefusedPlan());
Check("P27c the refusal's names keep its credential out of the editor payload",
    !refusedMasked!.ToJsonString().Contains(Token), refusedMasked.ToJsonString());
Check("P27d and the editor is still told a value exists",
    refusedMasked["pages"]![0]!["slots"]![0]!["secretsSet"] is JsonArray s27 && s27.Count == 1);

// Redacting must not cost the user their data: the masked blank saved back has to restore
// the stored value — and, since it was legacy plaintext, encrypt it on the way past.
var refusedResave = JsonSerializer.Deserialize<DashboardLayout>(refusedMasked.ToJsonString())!;
SecretPolicy.Seal(refusedResave, refusedStored, RefusedPlan());
var refusedAfter = Value(refusedResave, "apiToken");
Check("P27e saving the masked layout keeps the credential rather than blanking it",
    SecretStore.Unprotect(refusedAfter) == Token, refusedAfter);
Check("P27f and it is now encrypted at rest, which the refusal alone never achieved",
    refusedAfter != Token && SecretStore.HasMarker(refusedAfter));

// ---- P28 · #66: a demoted secret is handed to the widget as ciphertext ----------------
// This pins a KNOWN GAP rather than a fix. When a manifest retypes a property
// `secret` -> `text`, the stored envelope is not walked by Reveal and reaches the widget
// verbatim. Three fixes were attempted in PR #65 and every one was worse than the bug —
// the constraints are written up in issue #66. Asserting the current behaviour keeps the
// gap honest: whoever changes it has to change this probe deliberately, and will find the
// issue from here.
var demotedStored = LayoutWith(new JsonObject { ["apiToken"] = Token, ["repo"] = "owner/name" });
SecretPolicy.Seal(demotedStored, null, Lookup);
var demotedCipher = Value(demotedStored, "apiToken");
Check("P28 setup: the credential is stored encrypted",
    demotedCipher is not null && SecretStore.HasMarker(demotedCipher));

var demotedManifest = new WidgetManifest
{
    Id = "test.widget",
    Name = "Test",
    Properties =
    [
        new WidgetProperty { Name = "apiToken", Label = "API token", Type = "text" },
        new WidgetProperty { Name = "repo", Label = "Repo", Type = "text" },
    ],
};
WidgetManifest? DemotedLookup(string id) => id == "test.widget" ? demotedManifest : null;

var revealed28 = JsonSerializer.Deserialize<DashboardLayout>(JsonSerializer.Serialize(demotedStored))!;
SecretPolicy.Reveal(revealed28, DemotedLookup);
// FIXED (#66, #105). This asserted the exposure as current behaviour until
// RestoreIfUntouched landed; the issue called that out as the worst part of the gap — "a
// probe that blesses a regression is worse than no probe" — so it is turned around here
// rather than deleted, and P28c below still pins the property that made the gap tolerable.
Check("P28b a demoted secret no longer reaches the widget as ciphertext",
    Value(revealed28, "apiToken") == "", Value(revealed28, "apiToken"));
Check("P28b2 and nothing envelope-shaped is left anywhere in the payload",
    !JsonSerializer.Serialize(revealed28).Contains("dpapi:v1:"), JsonSerializer.Serialize(revealed28));
// The property the gap had and the fix must not lose: the STORED value is untouched, so
// the credential is still there to be re-promoted or restored. Blanking is a payload
// decision, never a disk one.
Check("P28c the stored value is intact — this blanked a copy, not the credential",
    SecretStore.Unprotect(Value(demotedStored, "apiToken")) == Token,
    Value(demotedStored, "apiToken"));
// ...and the round trip proves it: the shell posts the blank back and Seal puts it back.
var demotedSaved = JsonSerializer.Deserialize<DashboardLayout>(JsonSerializer.Serialize(revealed28))!;
SecretPolicy.Seal(demotedSaved, demotedStored, DemotedLookup);
Check("P28c2 the blank round-trips: an untouched demoted field keeps its stored value",
    Value(demotedSaved, "apiToken") == demotedCipher, Value(demotedSaved, "apiToken"));
Check("P28c3 and it is NOT re-encrypted — the manifest calls this property ordinary now",
    SecretStore.Unprotect(Value(demotedSaved, "apiToken")) == Token,
    Value(demotedSaved, "apiToken"));
Check("P28d an ordinary setting beside it is untouched",
    Value(revealed28, "repo") == "owner/name", Value(revealed28, "repo"));

// Reveal's real job is unaffected by any of the above.
var revealed28e = JsonSerializer.Deserialize<DashboardLayout>(JsonSerializer.Serialize(demotedStored))!;
SecretPolicy.Reveal(revealed28e, Lookup);
Check("P28e a properly declared secret still reveals to its plaintext",
    Value(revealed28e, "apiToken") == Token, Value(revealed28e, "apiToken"));

// A secret whose PLAINTEXT is itself a valid envelope must survive its own reveal. Any
// future scrub has to skip names the manifest already declares secret, or it blanks this
// one line after decrypting it correctly (#66).
const string MarkerShaped = "dpapi:v1:YWJj";
var wrapped = LayoutWith(new JsonObject { ["apiToken"] = MarkerShaped });
SecretPolicy.Seal(wrapped, null, Lookup);
var wrappedRevealed = JsonSerializer.Deserialize<DashboardLayout>(JsonSerializer.Serialize(wrapped))!;
SecretPolicy.Reveal(wrappedRevealed, Lookup);
Check("P28f a secret whose plaintext is marker-shaped survives its own reveal",
    Value(wrappedRevealed, "apiToken") == MarkerShaped, Value(wrappedRevealed, "apiToken"));

var foreign28 = LayoutWith(new JsonObject { ["apiToken"] = ForeignEnvelope });
SecretPolicy.Reveal(foreign28, Lookup);
Check("P28g an unopenable envelope reads as empty under a secret property",
    Value(foreign28, "apiToken") == "", Value(foreign28, "apiToken"));

// An uninstalled widget's ciphertext must survive a reveal untouched and stay recoverable.
// Nothing blanks it today; the probe exists so a future scrub cannot quietly start.
var orphan = LayoutWith(new JsonObject { ["apiToken"] = Token });
SecretPolicy.Seal(orphan, null, Lookup);
var orphanCipher = Value(orphan, "apiToken");
var orphanRevealed = JsonSerializer.Deserialize<DashboardLayout>(JsonSerializer.Serialize(orphan))!;
SecretPolicy.Reveal(orphanRevealed, _ => null);
Check("P28h an uninstalled widget's ciphertext is left intact",
    Value(orphanRevealed, "apiToken") == orphanCipher, Value(orphanRevealed, "apiToken"));
var recovered = JsonSerializer.Deserialize<DashboardLayout>(JsonSerializer.Serialize(orphanRevealed))!;
SecretPolicy.Reveal(recovered, Lookup);
Check("P28h2 and a later reinstall still reveals the original credential",
    Value(recovered, "apiToken") == Token, Value(recovered, "apiToken"));

// ---- P31 · #68: an id-less slot does NOT carry over once the client mints an id -------
// This documents a REFUSAL and the cost of it, not a fix. shell.js's persistLayout mints
// an instanceId for any legacy slot on its first on-panel edit, so the next save arrives
// id-BEARING while layout.json still holds the value id-LESS, the id-keyed lookup misses,
// and an edit unrelated to the credential deletes it. That is #68, and it is real.
//
// It is left standing because no retry can serve it safely. P32/P32b below are the same
// situation byte for byte — stored id-less with a credential, incoming id-bearing, one
// instance on each side — and there they mean a DELETED instance handing its credential
// to a replacement tile. Two rounds of review found that hazard from two directions. A
// lookup cannot separate the cases without the client saying which slot it minted the id
// for, so the ambiguity resolves against carry-over: retyping a credential is
// recoverable, transmitting an old one to a new endpoint is not.
DashboardLayout StoredIdless(JsonNode? value) =>
    LayoutWith(new JsonObject { ["apiToken"] = value }, instanceId: null);
var p31Stored = LayoutWith(new JsonObject { ["apiToken"] = Token }, instanceId: null);
SecretPolicy.Seal(p31Stored, null, Lookup);
Slot(p31Stored).InstanceId = null;
var p31Sealed = Value(p31Stored, "apiToken");
var p31Incoming = LayoutWith(new JsonObject { ["apiToken"] = "" }, instanceId: "s-minted-by-shell");
SecretPolicy.Seal(p31Incoming, p31Stored, Lookup);
Check("P31 a client-minted instanceId does NOT inherit an id-less stored credential",
    Slot(p31Incoming).Settings?["apiToken"] is null,
    Slot(p31Incoming).Settings?["apiToken"]?.ToJsonString() ?? "(removed)");
Check("P31b nothing leaks either: no envelope survives for Reveal to hand the widget",
    !JsonSerializer.Serialize(p31Incoming).Contains("dpapi:v1:"),
    JsonSerializer.Serialize(p31Incoming));
var p31List = StoredIdless(new JsonArray { "row-secret" });
var p31ListIncoming = LayoutWith(new JsonObject { ["apiToken"] = "" }, instanceId: "s-minted-2");
SecretPolicy.Seal(p31ListIncoming, p31List, Lookup);
Check("P31c a stored NON-STRING is refused across the same transition",
    Slot(p31ListIncoming).Settings?["apiToken"] is null,
    Slot(p31ListIncoming).Settings?["apiToken"]?.ToJsonString() ?? "(removed)");

// Ambiguity refuses for the older reason too. Two incoming instances of the widget
// against one id-less stored credential: position cannot say which instance owns it, so
// nobody inherits and the user re-enters — the answer SlotKey gives by returning null.
var p31Ambiguous = new DashboardLayout
{
    Pages = [new LayoutPage { Name = "P", Slots = [
        new LayoutSlot { WidgetId = "test.widget", InstanceId = "s-minted-3", Size = "half",
            Settings = new JsonObject { ["apiToken"] = "" } },
        new LayoutSlot { WidgetId = "test.widget", InstanceId = "s-minted-4", Size = "half",
            Settings = new JsonObject { ["apiToken"] = "" } },
    ] }],
};
SecretPolicy.Seal(p31Ambiguous, p31Stored, Lookup);
Check("P31d two incoming instances make position ambiguous: neither inherits",
    p31Ambiguous.Pages[0].Slots.All(s => s.Settings?["apiToken"] is null),
    string.Join(" | ", p31Ambiguous.Pages[0].Slots
        .Select(s => s.Settings?["apiToken"]?.ToJsonString() ?? "(removed)")));
// A DIFFERENT widget in the slot must not inherit either, id or no id: the positional
// retry is keyed on the incoming slot's own widgetId, so there is nothing to find.
var p31Other = new DashboardLayout
{
    Pages = [new LayoutPage { Name = "P", Slots = [new LayoutSlot
    {
        WidgetId = "other.widget", InstanceId = "s-minted-5", Size = "half",
        Settings = new JsonObject { ["apiToken"] = "" },
    }] }],
};
SecretPolicy.Seal(p31Other, p31Stored, id => id == "other.widget" ? otherManifest : Lookup(id));
Check("P31e swapping the widget in the slot inherits nothing across the transition",
    p31Other.Pages[0].Slots[0].Settings?["apiToken"] is null,
    p31Other.Pages[0].Slots[0].Settings?["apiToken"]?.ToJsonString() ?? "(removed)");

// ---- P31f · the protection-failure fallback owes an id like every other restore ------
// It restores a stored value exactly as the untouched paths do, leaving the slot holding
// something only this pipeline can put back. Without the stamp the slot stays positional,
// and the transition above then deletes it on the next save.
var p31fEdit = LayoutWith(
    new JsonObject { ["apiToken"] = "a-replacement-we-cannot-encrypt" }, instanceId: null);
var savedEncrypt31 = SecretStore.EncryptOverride;
SecretStore.EncryptOverride = _ => throw new PlatformNotSupportedException("no DPAPI here");
var p31fResult = SecretPolicy.Seal(p31fEdit, p31Stored, Lookup);
SecretStore.EncryptOverride = savedEncrypt31;
Check("P31f a failed encryption keeps the stored value (P7) …",
    Value(p31fEdit, "apiToken") == p31Sealed, Value(p31fEdit, "apiToken") ?? "(removed)");
Check("P31g … and stamps the slot, so what it restored is addressable by id",
    !string.IsNullOrEmpty(Slot(p31fEdit).InstanceId), Slot(p31fEdit).InstanceId ?? "(none)");
Check("P31h the minted id is reported back to the client that submitted the layout",
    p31fResult.Minted.Count == 1 && p31fResult.Minted[0].InstanceId == Slot(p31fEdit).InstanceId
        && p31fResult.Minted[0].Page == 0 && p31fResult.Minted[0].Slot == 0);
Check("P31h2 and the save is still reported as not clean",
    p31fResult.Failures.Count == 1);
var p31iStored = JsonSerializer.Deserialize<DashboardLayout>(JsonSerializer.Serialize(p31fEdit))!;
var p31iAgain = JsonSerializer.Deserialize<DashboardLayout>(JsonSerializer.Serialize(p31fEdit))!;
Slot(p31iAgain).Settings!["apiToken"] = "";
// Captured BEFORE the save: the id has to be one the fallback carried in, not one this
// save mints on its way past. Asserting it afterwards proves nothing — the untouched
// branch stamps the slot itself, so the probe passed with the fallback's stamp removed.
var p31iCarried = Slot(p31iAgain).InstanceId;
SecretPolicy.Seal(p31iAgain, p31iStored, Lookup);
Check("P31i so a later ID-KEYED save restores it rather than dropping it",
    Value(p31iAgain, "apiToken") == p31Sealed && !string.IsNullOrEmpty(p31iCarried),
    $"id={p31iCarried ?? "(none)"} value={Value(p31iAgain, "apiToken") ?? "(removed)"}");

// ---- P32 · cross-instance isolation: a replacement tile inherits nothing -------------
// Both review rounds on #68. Delete the sole credentialed instance in the editor, add a
// fresh one of the same widget, save. Both counts are still one and the new instanceId
// misses, so any positional retry hands the deleted instance's credential to a tile the
// user believes is unconfigured — which then transmits an old token to whatever endpoint
// the new tile points at.
//
// Round one raised it for an id-BEARING stored slot; I gated the retry on provenance,
// which fixed only that half. Round two raised the same thing for an id-LESS one, where
// no provenance exists to gate on. Both cases are covered here because they are the same
// case, and because whatever eventually closes #68 has to keep passing them.
var p32Stored = LayoutWith(new JsonObject { ["apiToken"] = Token }, instanceId: "the-deleted-one");
SecretPolicy.Seal(p32Stored, null, Lookup);
var p32Replacement = LayoutWith(new JsonObject { ["apiToken"] = "" }, instanceId: "a-brand-new-tile");
SecretPolicy.Seal(p32Replacement, p32Stored, Lookup);
Check("P32 a replacement instance does NOT inherit the deleted instance's credential",
    Slot(p32Replacement).Settings?["apiToken"] is null,
    Slot(p32Replacement).Settings?["apiToken"]?.ToJsonString() ?? "(removed)");
// Same refusal on the protection-failure path, which reaches the lookup by its own route.
var p32Typed = LayoutWith(new JsonObject { ["apiToken"] = "typed-into-the-new-tile" },
    instanceId: "a-brand-new-tile");
var savedEncrypt32 = SecretStore.EncryptOverride;
SecretStore.EncryptOverride = _ => throw new PlatformNotSupportedException("no DPAPI here");
SecretPolicy.Seal(p32Typed, p32Stored, Lookup);
SecretStore.EncryptOverride = savedEncrypt32;
Check("P32b nor when a failed encryption sends it looking for a previous value",
    Slot(p32Typed).Settings?["apiToken"] is null,
    Slot(p32Typed).Settings?["apiToken"]?.ToJsonString() ?? "(removed)");
// Round two's case: the deleted instance was a LEGACY id-less slot, so there is no
// provenance to distinguish it from the #68 transition. This is the probe that ended the
// retry — a gate cannot pass it and P31 at the same time.
var p32Legacy = LayoutWith(new JsonObject { ["apiToken"] = Token }, instanceId: null);
SecretPolicy.Seal(p32Legacy, null, Lookup);
Slot(p32Legacy).InstanceId = null;
var p32LegacyReplacement = LayoutWith(
    new JsonObject { ["apiToken"] = "" }, instanceId: "a-brand-new-tile");
SecretPolicy.Seal(p32LegacyReplacement, p32Legacy, Lookup);
Check("P32c replacing a LEGACY id-less instance inherits nothing either",
    Slot(p32LegacyReplacement).Settings?["apiToken"] is null,
    Slot(p32LegacyReplacement).Settings?["apiToken"]?.ToJsonString() ?? "(removed)");
Check("P32c2 and no envelope survives for Reveal to hand the replacement widget",
    !JsonSerializer.Serialize(p32LegacyReplacement).Contains("dpapi:v1:"),
    JsonSerializer.Serialize(p32LegacyReplacement));
// The "|w:0" alias used to cover a still-open editor holding the id-less slot it
// submitted, whose id the HOST had since minted. That alias is gone with the rest of the
// positional key, and so is what created the case: Seal only stamps a slot that arrives
// without an id, and LayoutStore.Load leaves none (see the L series). An id-less slot now
// gets the same answer as any other unidentifiable one.
var p32Idless = LayoutWith(new JsonObject { ["apiToken"] = "" }, instanceId: null);
SecretPolicy.Seal(p32Idless, p32Stored, Lookup);
Check("P32d an id-less client slot matches nothing — no positional fallback remains",
    string.IsNullOrEmpty(Value(p32Idless, "apiToken")),
    Value(p32Idless, "apiToken") ?? "(removed)");

// ---- P31j · census: every branch that writes a value stamps the slot -----------------
// The omission fixed in #68 was the second time a branch was written beside Stamp without
// calling it, so this names each one. A sixth branch added without a stamp fails here,
// rather than in the field two saves later when the value it wrote is deleted.
void Census(string branch, DashboardLayout? storedFor, JsonNode? incoming, bool breakCrypto = false)
{
    var layout = LayoutWith(new JsonObject { ["apiToken"] = incoming }, instanceId: null);
    var restore = SecretStore.EncryptOverride;
    if (breakCrypto)
        SecretStore.EncryptOverride = _ => throw new PlatformNotSupportedException("no DPAPI here");
    SecretPolicy.Seal(layout, storedFor, Lookup);
    SecretStore.EncryptOverride = restore;
    var held = Slot(layout).Settings?["apiToken"];
    Check($"P31j {branch} leaves a value AND a stable id",
        held is not null && !string.IsNullOrEmpty(Slot(layout).InstanceId),
        $"id={Slot(layout).InstanceId ?? "(none)"} value={held?.ToJsonString() ?? "(removed)"}");
}
Census("encrypting a freshly typed secret", null, Token);
Census("restoring a stored envelope", p31Stored, "");
Census("migrating legacy plaintext", StoredIdless("legacy-plaintext-token"), "");
Census("restoring a stored non-string", StoredIdless(new JsonArray { "x" }), "");
Census("keeping the prior value when encryption fails", p31Stored, "replacement", breakCrypto: true);

// ---- P33 · a plan is resolved once and frozen for the whole operation ----------------
// Seal walks TWICE: once over the stored layout to index it, once over the incoming one.
// The plan caches per widget id so both walks see the same classification. Without that
// freeze, a manifest edit landing between the two walks makes the second decide the
// property is ordinary `text` — so nothing seals it and the plaintext the user just typed
// goes straight to layout.json. WidgetLibrary rescans on a file watcher, so "between two
// walks" is a window that exists rather than a thought experiment.
var p33Calls = 0;
WidgetManifest? FlakyLookup(string id)
{
    p33Calls++;
    return new WidgetManifest
    {
        Id = "test.widget", Name = "Test",
        Properties =
        [
            // `secret` on the first resolution, ordinary text on every one after it.
            new WidgetProperty
            {
                Name = "apiToken", Label = "API token",
                Type = p33Calls == 1 ? "secret" : "text",
            },
        ],
    };
}
var p33Stored = LayoutWith(new JsonObject { ["apiToken"] = "" });
var p33Layout = LayoutWith(new JsonObject { ["apiToken"] = "typed-right-now" });
SecretPolicy.Seal(p33Layout, p33Stored, FlakyLookup);
Check("P33 a manifest changing mid-save cannot leak the plaintext past the second walk",
    SecretStore.CanUnprotect(Value(p33Layout, "apiToken")), Value(p33Layout, "apiToken"));
Check("P33b the classification was resolved exactly once for the widget",
    p33Calls == 1, p33Calls.ToString());

// ---- P35 · #67/#104: protected WITHOUT being revealed ---------------------------------
// P27 above proves the editor side, and that half already worked through the fabricated
// stand-in manifest. What a manifest could never say is "and nothing may read this back":
// a stand-in could only declare `secret`, so the value was blanked in the editor and then
// decrypted straight into the dashboard payload. `shell.js` hands every one of a slot's
// settings to that slot's iframe — including keys no manifest declares — so in the
// duplicate-id case (#104) the reader is a widget whose own manifest never mentioned the
// property. The user typed that credential for the copy that was refused.

var refusedSlot = Slot(LayoutWith(new JsonObject()));
Check("P35 a refusal classifies the address ProtectWithoutReveal, not Protect",
    RefusedPlan().For(refusedSlot).TryGetValue("apiToken", out var p35Intent)
        && p35Intent == SecretIntent.ProtectWithoutReveal,
    p35Intent.ToString());

// The load-bearing case, and the one a naive "skip the address" reveal gets wrong: a
// refused widget's credential is normally legacy PLAINTEXT — the refusal is what noticed
// it — so there is nothing to decline to decrypt. Skipping leaves it in the payload.
var p35Legacy = LayoutWith(new JsonObject { ["apiToken"] = Token });
SecretPolicy.Reveal(p35Legacy, RefusedPlan());
Check("P35b legacy plaintext is BLANKED on the way to the shell, not merely left undecrypted",
    Value(p35Legacy, "apiToken") == "", Value(p35Legacy, "apiToken"));

// Withholding must not cost the value: the shell round-trips this exact layout back
// through save-layout, so the blank has to restore — and, being plaintext, encrypt.
var p35Saved = JsonSerializer.Deserialize<DashboardLayout>(JsonSerializer.Serialize(p35Legacy))!;
SecretPolicy.Seal(p35Saved, LayoutWith(new JsonObject { ["apiToken"] = Token }), RefusedPlan());
var p35Restored = Value(p35Saved, "apiToken");
Check("P35c the withheld blank round-trips: the save restores the credential",
    SecretStore.Unprotect(p35Restored) == Token, p35Restored);
Check("P35d and encrypts it — withholding never replaces encrypting",
    p35Restored != Token && SecretStore.HasMarker(p35Restored), p35Restored);

// Once it is our ciphertext there is nothing left to blank, and leaving it is what keeps
// the restore above a one-time dependency rather than a permanent one.
var p35Sealed = LayoutWith(new JsonObject { ["apiToken"] = p35Restored });
SecretPolicy.Reveal(p35Sealed, RefusedPlan());
Check("P35e our own ciphertext is left in place, never decrypted into the payload",
    Value(p35Sealed, "apiToken") == p35Restored, Value(p35Sealed, "apiToken"));
Check("P35f which is the point: nothing the iframe receives is the credential",
    !JsonSerializer.Serialize(p35Sealed).Contains(Token), JsonSerializer.Serialize(p35Sealed));

// Shape does not answer "did WE write this?" — a user can type `dpapi:v1:…` into a text
// field — so anything that does not actually decrypt is withheld. That is not a new loss:
// Reveal already blanks a foreign envelope for an ordinary `secret`, because Unprotect
// returns null for it. The two plans must agree.
var p35Foreign = LayoutWith(new JsonObject { ["apiToken"] = ForeignEnvelope });
var p35ForeignProtect = LayoutWith(new JsonObject { ["apiToken"] = ForeignEnvelope });
SecretPolicy.Reveal(p35Foreign, RefusedPlan());
SecretPolicy.Reveal(p35ForeignProtect, Lookup);
Check("P35g a blob from another machine is withheld — CanUnprotect, not LooksLikeEnvelope",
    Value(p35Foreign, "apiToken") == "", Value(p35Foreign, "apiToken"));
Check("P35h and that is exactly what an ordinary secret already did, so nothing regressed",
    Value(p35Foreign, "apiToken") == Value(p35ForeignProtect, "apiToken"));

// ---- P35i · the duplicate-id attack (#104) -------------------------------------------
// The loaded copy of the id declares the refused copy's credential name as a `secret` of
// its own. Under any union where Protect can win, that one line of manifest is the whole
// exploit: the host decrypts a credential the user typed for a different widget straight
// into the attacker's iframe. ProtectWithoutReveal is the ceiling for this reason alone.
var shadowManifest = new WidgetManifest
{
    Id = "test.widget",
    Name = "Loaded copy",
    Properties =
    [
        new WidgetProperty { Name = "apiToken", Label = "API token", Type = "secret" },
        new WidgetProperty { Name = "clientSecret", Label = "Client secret", Type = "secret" },
    ],
};
SecretPlan ShadowPlan() =>
    SecretPlan.FromManifests(id => id == "test.widget" ? shadowManifest : null, RefusedCredentials);
Check("P35i a same-id manifest declaring the name `secret` does not win the union",
    ShadowPlan().For(refusedSlot)["apiToken"] == SecretIntent.ProtectWithoutReveal,
    ShadowPlan().For(refusedSlot)["apiToken"].ToString());

// Both values sealed the ordinary way first, so this is about the reveal and nothing else.
var p35Shadow = LayoutWith(new JsonObject { ["apiToken"] = Token, ["clientSecret"] = "cs-live" });
SecretPolicy.Seal(p35Shadow, null, ShadowPlan());
Check("P35j setup: both are encrypted at rest",
    SecretStore.CanUnprotect(Value(p35Shadow, "apiToken"))
        && SecretStore.CanUnprotect(Value(p35Shadow, "clientSecret")));
SecretPolicy.Reveal(p35Shadow, ShadowPlan());
Check("P35k the loaded widget never receives the refused copy's credential",
    !JsonSerializer.Serialize(p35Shadow).Contains(Token), JsonSerializer.Serialize(p35Shadow));
Check("P35l but its OWN secret is still revealed — the union is per address, not per widget",
    Value(p35Shadow, "clientSecret") == "cs-live", Value(p35Shadow, "clientSecret"));
// The settings surface too: its preview replica hosts real widget iframes, which is the
// path #104 was actually filed for.
var p35ShadowNode = JsonSerializer.SerializeToNode(
    LayoutWith(new JsonObject { ["apiToken"] = Token, ["clientSecret"] = "cs-live" }));
SecretPolicy.Mask(p35ShadowNode, ShadowPlan());
Check("P35m and the editor payload holds neither of them",
    !p35ShadowNode!.ToJsonString().Contains(Token) && !p35ShadowNode.ToJsonString().Contains("cs-live"),
    p35ShadowNode.ToJsonString());

// ---- P35n · a folder edit that retypes a property AND refuses the manifest ------------
// Previously C13 in tools/CredentialRule, asserted against the fabricated merge. The
// window is holding a snapshot that still calls `feedUrl` a `text`, so only the refusal's
// names protect it; a credential typed into that field before the rescan would otherwise
// reach layout.json in the clear. The plan says it directly instead of upgrading a
// property inside a copied manifest.
var staleManifest = new WidgetManifest
{
    Id = "test.widget",
    Name = "Stale",
    Properties =
    [
        new WidgetProperty { Name = "feedUrl", Label = "Feed", Type = "text" },
        new WidgetProperty { Name = "clientSecret", Label = "Client secret", Type = "secret" },
    ],
};
string[] retypedNames = ["feedUrl", "apiToken"];
var retypedIntents = SecretPlan.FromManifests(
    id => id == "test.widget" ? staleManifest : null,
    id => id == "test.widget" ? retypedNames : null).For(refusedSlot);
Check("P35n a property the stale manifest still calls `text` is protected by the refusal",
    retypedIntents.TryGetValue("feedUrl", out var p35Feed) && p35Feed == SecretIntent.ProtectWithoutReveal,
    p35Feed.ToString());
Check("P35o a name no manifest declares at all is planned too",
    retypedIntents.TryGetValue("apiToken", out var p35Api) && p35Api == SecretIntent.ProtectWithoutReveal);
Check("P35p while the manifest's own secret keeps its reveal — the refusal names neither",
    retypedIntents.TryGetValue("clientSecret", out var p35Cs) && p35Cs == SecretIntent.Protect,
    p35Cs.ToString());
Check("P35q and nothing else is dragged onto the pipeline", retypedIntents.Count == 3, retypedIntents.Count.ToString());

// ---- P35r · the intent rules themselves ----------------------------------------------
// A third intent is coming (#66's RestoreIfUntouched) and it is LESS protective than
// either member here — it does not encrypt at all. A union with a default arm would have
// guessed at where it sits; these walk the real enum so it has to be placed deliberately.
var intents = Enum.GetValues<SecretIntent>();
var (idempotent, commutative, closed) = (true, true, true);
foreach (var a in intents)
{
    if (SecretIntents.MostProtective(a, a) != a) idempotent = false;
    foreach (var b in intents)
    {
        if (SecretIntents.MostProtective(a, b) != SecretIntents.MostProtective(b, a)) commutative = false;
        var winner = SecretIntents.MostProtective(a, b);
        if (winner != a && winner != b) closed = false;
    }
}
// The table is the HUMAN statement of the ordering; MostProtective is the code. P35x fails
// the moment an intent exists without a row here, which is the only thing in this file that
// actually forces a new member to be placed deliberately — the three invariants below are
// satisfied by any sane function and would not have noticed. (I claimed otherwise when this
// section landed; adding a member and running the suite showed nothing failed.)
//
// It matters because the next intent is WEAKER, not stronger. MostProtective falls back to
// Protect for any pair it does not recognise, which is right for a member above Protect and
// wrong for one below it — the failure would be silent, and it would be encryption applied
// to a value that must be stored verbatim.
var rank = new Dictionary<SecretIntent, int>
{
    [SecretIntent.RestoreIfUntouched] = 0,
    [SecretIntent.Protect] = 1,
    [SecretIntent.ProtectWithoutReveal] = 2,
};
Check("P35x every intent has a stated position in the protection ordering",
    intents.All(rank.ContainsKey),
    string.Join(", ", intents.Where(i => !rank.ContainsKey(i))));
var tableAgrees = intents.All(a => intents.All(b =>
    !rank.ContainsKey(a) || !rank.ContainsKey(b) ||
    SecretIntents.MostProtective(a, b) == (rank[a] >= rank[b] ? a : b)));
Check("P35x2 and the code agrees with the table for every pair", tableAgrees);

Check("P35r MostProtective is idempotent for every intent, including ones added later", idempotent);
Check("P35s and commutative, so the order the two sources are read in cannot decide it", commutative);
Check("P35t and it always returns one of its inputs rather than inventing a third", closed);
Check("P35u ProtectWithoutReveal beats Protect, whichever side declares it",
    SecretIntents.MostProtective(SecretIntent.Protect, SecretIntent.ProtectWithoutReveal)
        == SecretIntent.ProtectWithoutReveal
    && SecretIntents.MostProtective(SecretIntent.ProtectWithoutReveal, SecretIntent.Protect)
        == SecretIntent.ProtectWithoutReveal);
Check("P35v nothing may be revealed that is not also masked and encrypted",
    intents.All(i => !SecretIntents.Reveals(i) || SecretIntents.Protects(i)),
    string.Join(", ", intents.Where(i => SecretIntents.Reveals(i) && !SecretIntents.Protects(i))));
Check("P35w and ProtectWithoutReveal is on the masking side of that line — it is not a bypass",
    SecretIntents.Protects(SecretIntent.ProtectWithoutReveal)
        && !SecretIntents.Reveals(SecretIntent.ProtectWithoutReveal));

// ---- P36 · #66/#105/#120: RestoreIfUntouched ------------------------------------------
// The intent is planned for EVERY ordinary declared property, because nothing anywhere
// records that a property used to be `secret` — a manifest states the present tense only.
// So the plan means "might be one of ours" and the VALUE decides. Every probe below is a
// way that broad planning could destroy an ordinary setting if the value check were wrong.

static DashboardLayout TwoInstances(JsonObject a, JsonObject b, string? idA = "i1", string? idB = "i2") => new()
{
    Pages = [new LayoutPage { Name = "P", Slots = [
        new LayoutSlot { WidgetId = "test.widget", InstanceId = idA, Size = "half", Settings = a },
        new LayoutSlot { WidgetId = "test.widget", InstanceId = idB, Size = "half", Settings = b },
    ] }],
};
static string? ValueAt(DashboardLayout l, int slot, string name) =>
    l.Pages[0].Slots[slot].Settings?[name] is JsonValue v && v.TryGetValue<string>(out var s) ? s : null;

var p36Plan = SecretPlan.FromManifests(DemotedLookup).For(Slot(LayoutWith(new JsonObject())));
Check("P36 a declared ordinary property is planned RestoreIfUntouched",
    p36Plan.TryGetValue("apiToken", out var p36i) && p36i == SecretIntent.RestoreIfUntouched,
    p36i.ToString());
Check("P36b a property the manifest still calls `secret` is NOT — it would be blanked one "
    + "line after being decrypted correctly",
    SecretPlan.FromManifests(Lookup).For(Slot(LayoutWith(new JsonObject())))["apiToken"]
        == SecretIntent.Protect);

// A `list` is excluded for the reason CredentialPropertyNames excludes it: this pipeline
// walks top-level properties, so Mask would put a placeholder STRING where the array is and
// Seal, finding no stored string, would take the whole list with it. The value check would
// also spare it — an array is not a decryptable string — but relying on that would make the
// exclusion look removable, and a credential inside a row is #62's problem, not this one.
var listManifest = new WidgetManifest
{
    Id = "test.widget",
    Name = "Test",
    Properties = [new WidgetProperty { Name = "endpoints", Label = "Endpoints", Type = "list" }],
};
Check("P36b2 a list property is not planned at all",
    SecretPlan.FromManifests(id => id == "test.widget" ? listManifest : null)
        .For(Slot(LayoutWith(new JsonObject()))).Count == 0);

// ---- P36c · an id-LESS slot is never blanked -----------------------------------------
// shell.js mints an instanceId on the first unrelated on-panel edit while the stored copy
// is still id-less, and SlotKey deliberately refuses that mismatch (#68). Blanking such a
// slot would turn a documented identity change into a destructive one: the restore misses
// and the blank reaches disk. Before this intent existed the envelope simply survived.
// Built from an already-sealed value rather than by sealing here: Seal STAMPS an id onto
// any slot it leaves holding a credential, precisely so the next save matches by id. The
// slot under test is the legacy one that predates that stamping.
var idlessCipher = demotedCipher;
var idless = LayoutWith(new JsonObject { ["apiToken"] = idlessCipher }, instanceId: null);
Check("P36c setup: an id-less slot holds one of our envelopes",
    SecretStore.CanUnprotect(idlessCipher) && string.IsNullOrEmpty(Slot(idless).InstanceId));
var idlessRevealed = JsonSerializer.Deserialize<DashboardLayout>(JsonSerializer.Serialize(idless))!;
SecretPolicy.Reveal(idlessRevealed, DemotedLookup);
Check("P36c2 an id-less slot's demoted envelope is NOT blanked — it could not be restored",
    Value(idlessRevealed, "apiToken") == idlessCipher, Value(idlessRevealed, "apiToken"));
// The whole sequence: the shell mints an id on the copy it holds and saves it back.
var idlessMinted = JsonSerializer.Deserialize<DashboardLayout>(JsonSerializer.Serialize(idlessRevealed))!;
Slot(idlessMinted).InstanceId = "s-minted-by-shell";
SecretPolicy.Seal(idlessMinted, idless, DemotedLookup);
Check("P36c3 ...so a shell-minted id does not destroy it",
    Value(idlessMinted, "apiToken") == idlessCipher, Value(idlessMinted, "apiToken"));

// ---- P36d · two instances of one widget can be in different states -------------------
// The intent is per widget id because the retype is, but one instance can still hold the
// envelope while the other has already been retyped to ordinary text. Blanking on the
// intent alone withheld the second one's perfectly displayable value from everybody.
// The cipher is placed directly. Sealing the pair here would encrypt BOTH — `Lookup` calls
// the property `secret` — and the sibling under test is the one that has already been
// retyped, so its value must never have been through the cipher.
var mixed = TwoInstances(
    new JsonObject { ["apiToken"] = demotedCipher },
    new JsonObject { ["apiToken"] = "plain-text-now" });
SecretPolicy.Reveal(mixed, DemotedLookup);
Check("P36d the instance holding an envelope is blanked",
    ValueAt(mixed, 0, "apiToken") == "", ValueAt(mixed, 0, "apiToken"));
Check("P36e ...while a sibling instance holding ordinary text keeps it",
    ValueAt(mixed, 1, "apiToken") == "plain-text-now", ValueAt(mixed, 1, "apiToken"));

// ---- P36f · decryptability, not shape -------------------------------------------------
// `dpapi:v1:YWJj` is a string a user can type into a text field. Blanking on shape would
// eat it, and the user would watch their own input vanish.
var typedShape = LayoutWith(new JsonObject { ["apiToken"] = MarkerShaped });
SecretPolicy.Reveal(typedShape, DemotedLookup);
Check("P36f a user-typed marker-shaped value in a demoted field is left alone",
    Value(typedShape, "apiToken") == MarkerShaped, Value(typedShape, "apiToken"));

// ---- P36g · #120, the settings-preview twin -------------------------------------------
// Same trigger, different exit: the replica hosts real widget iframes, so a demoted
// envelope in the editor payload is handed to widget code exactly as the dashboard's is.
var p36Node = JsonSerializer.SerializeToNode(demotedStored);
SecretPolicy.Mask(p36Node, SecretPlan.FromManifests(DemotedLookup));
Check("P36g the editor payload holds no envelope for a demoted property",
    !p36Node!.ToJsonString().Contains("dpapi:v1:"), p36Node.ToJsonString());
Check("P36g2 and the editor is told WHICH field is holding a blank it did not type",
    p36Node["pages"]![0]!["slots"]![0]!["secretsRestorable"] is JsonArray r36
        && r36.Count == 1 && r36[0]!.GetValue<string>() == "apiToken",
    p36Node["pages"]![0]!["slots"]![0]!["secretsRestorable"]?.ToJsonString() ?? "(absent)");
Check("P36g3 an ordinary setting beside it is neither blanked nor listed",
    p36Node["pages"]![0]!["slots"]![0]!["settings"]!["repo"]!.GetValue<string>() == "owner/name");
Check("P36g4 the marker is projection-only and cannot reach layout.json",
    JsonSerializer.Deserialize<DashboardLayout>(p36Node.ToJsonString()) is { } rt
        && !JsonSerializer.Serialize(rt).Contains("secretsRestorable"));

// ---- P36h · the three write cases ------------------------------------------------------
// Read semantics blanked it; write semantics must not follow. The manifest calls this
// property ordinary now, so what the user types is saved as typed.
var p36Typed = JsonSerializer.Deserialize<DashboardLayout>(JsonSerializer.Serialize(demotedStored))!;
Slot(p36Typed).Settings!["apiToken"] = "typed-by-hand";
SecretPolicy.Seal(p36Typed, demotedStored, DemotedLookup);
Check("P36h new text is saved VERBATIM, not encrypted — that is what `text` means",
    Value(p36Typed, "apiToken") == "typed-by-hand", Value(p36Typed, "apiToken"));

var p36Cleared = JsonSerializer.Deserialize<DashboardLayout>(JsonSerializer.Serialize(demotedStored))!;
Slot(p36Cleared).Settings!["apiToken"] = "";
SecretPolicy.Seal(p36Cleared, demotedStored, SecretPlan.FromManifests(DemotedLookup), Cleared("apiToken"));
Check("P36h2 a named clear removes it, so the field CAN be emptied",
    Slot(p36Cleared).Settings?["apiToken"] is null,
    Value(p36Cleared, "apiToken") ?? "(removed)");

// ---- P36i · the uneditable-field failure, from the other side -------------------------
// An id-less slot is never blanked (P36c), so a blank arriving from one is the USER's.
// Restoring it would make the field impossible to empty — the exact failure PR #65 hit
// three times. The restore is gated on the same predicate that decides the blanking.
var p36UserBlank = LayoutWith(new JsonObject { ["apiToken"] = "" }, instanceId: null);
SecretPolicy.Seal(p36UserBlank, idless, DemotedLookup);
Check("P36i a blank we did not cause is the user's clear, and survives the save",
    Value(p36UserBlank, "apiToken") == "", Value(p36UserBlank, "apiToken") ?? "(removed)");

// ---- P36j · the blast radius of planning every ordinary property ----------------------
// This is the one that matters if the value check is ever weakened: EVERY text setting in
// every layout now carries this intent, so an ordinary value must be untouched end to end.
var p36Ordinary = LayoutWith(new JsonObject { ["repo"] = "owner/name" });
SecretPolicy.Reveal(p36Ordinary, DemotedLookup);
Check("P36j an ordinary setting is not blanked on reveal", Value(p36Ordinary, "repo") == "owner/name");
var p36Emptied = LayoutWith(new JsonObject { ["repo"] = "" });
SecretPolicy.Seal(p36Emptied, LayoutWith(new JsonObject { ["repo"] = "owner/name" }), DemotedLookup);
Check("P36j2 and emptying one saves as empty rather than being restored",
    Value(p36Emptied, "repo") == "", Value(p36Emptied, "repo") ?? "(removed)");
var p36Absent = LayoutWith(new JsonObject());
SecretPolicy.Seal(p36Absent, LayoutWith(new JsonObject { ["repo"] = "owner/name" }), DemotedLookup);
Check("P36j3 and an absent one is not conjured back into existence",
    Slot(p36Absent).Settings?["repo"] is null, Value(p36Absent, "repo") ?? "(absent)");

// ---- P37 · a non-empty instance id is not on its own proof of addressability ----------
// BuildStoredIndex POISONS a key two stored slots both resolve to: handing one credential
// to both twins is worse than losing it, so nobody inherits. Blanking on the strength of
// the id alone therefore blanks both copies and then finds nothing to restore, and the
// empty strings reach layout.json. Reachable rather than theoretical — shell.js detects
// duplicate instance ids and heals them, and the heal is itself a save.
var twins = TwoInstances(
    new JsonObject { ["apiToken"] = demotedCipher },
    new JsonObject { ["apiToken"] = demotedCipher },
    "same", "same");
SecretPolicy.Reveal(twins, DemotedLookup);
Check("P37 neither twin is blanked, because neither could be restored",
    ValueAt(twins, 0, "apiToken") == demotedCipher && ValueAt(twins, 1, "apiToken") == demotedCipher,
    ValueAt(twins, 0, "apiToken") + " | " + ValueAt(twins, 1, "apiToken"));
// The full sequence: the shell heals one id and saves. Nothing was blanked, so there is
// nothing the poisoned index has to give back.
var healed = JsonSerializer.Deserialize<DashboardLayout>(JsonSerializer.Serialize(twins))!;
healed.Pages[0].Slots[1].InstanceId = "healed";
SecretPolicy.Seal(healed, twins, DemotedLookup);
Check("P37b ...so the heal-and-save keeps both credentials",
    SecretStore.Unprotect(ValueAt(healed, 0, "apiToken")) == Token
        && SecretStore.Unprotect(ValueAt(healed, 1, "apiToken")) == Token,
    ValueAt(healed, 0, "apiToken") + " | " + ValueAt(healed, 1, "apiToken"));
// ProtectWithoutReveal blanks legacy PLAINTEXT, so it has the same exposure and takes the
// same answer: the value keeps reaching the frame until the duplicate is healed, which is
// the pre-existing state rather than a new one. A destroyed credential is not recoverable;
// a leak into an already-broken layout is.
var twinPlain = TwoInstances(
    new JsonObject { ["apiToken"] = Token }, new JsonObject { ["apiToken"] = Token }, "same", "same");
SecretPolicy.Reveal(twinPlain, RefusedPlan());
Check("P37c a refused widget's twinned plaintext is withheld from nothing, not destroyed",
    ValueAt(twinPlain, 0, "apiToken") == Token && ValueAt(twinPlain, 1, "apiToken") == Token,
    ValueAt(twinPlain, 0, "apiToken") + " | " + ValueAt(twinPlain, 1, "apiToken"));
// The editor projection asks the same question against JSON rather than the model.
var twinNode = JsonSerializer.SerializeToNode(twins);
SecretPolicy.Mask(twinNode, SecretPlan.FromManifests(DemotedLookup));
Check("P37d Mask agrees with Reveal about which slots are addressable",
    !twinNode!.ToJsonString().Contains("secretsRestorable"), twinNode.ToJsonString());

// ---- P37k · the shell's heal is GLOBAL, so ambiguity must be too ----------------------
// shell.js builds ONE `seenIds` set of effective tags and re-mints any repeat, then calls
// persistLayout(). It does not consider widgetId, so two DIFFERENT widgets sharing an
// explicit instanceId collide there — while a widget-scoped check here calls both unique
// and blanks them. BuildStoredIndex does not catch it either: its keys DO carry the widget
// id, so nothing is poisoned and the restore simply looks under an id that no longer
// exists. Same automatic credential loss, one layer out from the duplicate-key case.
var crossWidget = new DashboardLayout
{
    Pages = [new LayoutPage { Name = "P", Slots = [
        new LayoutSlot { WidgetId = "test.widget", InstanceId = "shared", Size = "half",
            Settings = new JsonObject { ["apiToken"] = demotedCipher } },
        new LayoutSlot { WidgetId = "other.widget", InstanceId = "shared", Size = "half",
            Settings = new JsonObject { ["apiToken"] = demotedCipher } },
    ] }],
};
var otherDemoted = new WidgetManifest
{
    Id = "other.widget", Name = "Other",
    Properties = [new WidgetProperty { Name = "apiToken", Label = "API token", Type = "text" }],
};
SecretPolicy.Reveal(crossWidget, SecretPlan.FromManifests(
    id => id == "test.widget" ? demotedManifest : id == "other.widget" ? otherDemoted : null));
Check("P37k two widgets sharing one instanceId are both left alone — the shell re-mints "
    + "one of them and the restore would look under an id that never stored anything",
    ValueAt(crossWidget, 0, "apiToken") == demotedCipher
        && ValueAt(crossWidget, 1, "apiToken") == demotedCipher,
    ValueAt(crossWidget, 0, "apiToken") + " | " + ValueAt(crossWidget, 1, "apiToken"));

// The other half of the shell's rule: an explicit id can collide with a POSITIONAL tag.
// A slot with no instanceId runs as "p0s0", so an explicit "p0s0" elsewhere collides and
// the shell re-mints on that too.
var positionalClash = new DashboardLayout
{
    Pages = [new LayoutPage { Name = "P", Slots = [
        new LayoutSlot { WidgetId = "test.widget", InstanceId = null, Size = "half",
            Settings = new JsonObject { ["apiToken"] = demotedCipher } },
        new LayoutSlot { WidgetId = "test.widget", InstanceId = "p0s0", Size = "half",
            Settings = new JsonObject { ["apiToken"] = demotedCipher } },
    ] }],
};
SecretPolicy.Reveal(positionalClash, DemotedLookup);
Check("P37k2 an explicit id colliding with a positional tag is ambiguous too",
    ValueAt(positionalClash, 1, "apiToken") == demotedCipher,
    ValueAt(positionalClash, 1, "apiToken"));

// Seal has TWO layouts, and the ambiguity lives in the stored one while the slot being
// walked belongs to the submitted one. A reference test across those graphs is not merely
// wrong, it is CONSTANTLY false — the guard reads as "never ambiguous" and stops guarding
// without failing anything. Here Mask correctly refused to blank (twinned), so the empty
// the user just typed is THEIRS; misreading it as a host blank restores the envelope over
// it and the field can never be emptied.
// CROSS-widget, deliberately: two slots of the SAME widget sharing an id resolve to one
// SlotKey and BuildStoredIndex poisons it, so the restore misses anyway and the bug hides.
// Different widget ids make the keys distinct, nothing is poisoned, and the guard is the
// only thing standing between the user's empty and the old envelope. My first fixture used
// one widget and passed with the fix reverted.
static DashboardLayout TwoWidgets(JsonObject a, JsonObject b) => new()
{
    Pages = [new LayoutPage { Name = "P", Slots = [
        new LayoutSlot { WidgetId = "test.widget", InstanceId = "same", Size = "half", Settings = a },
        new LayoutSlot { WidgetId = "other.widget", InstanceId = "same", Size = "half", Settings = b },
    ] }],
};
var twinStored = TwoWidgets(
    new JsonObject { ["apiToken"] = demotedCipher },
    new JsonObject { ["apiToken"] = demotedCipher });
var twinEmptied = TwoWidgets(
    new JsonObject { ["apiToken"] = "" },
    new JsonObject { ["apiToken"] = demotedCipher });
SecretPolicy.Seal(twinEmptied, twinStored, SecretPlan.FromManifests(
    id => id == "test.widget" ? demotedManifest : id == "other.widget" ? otherDemoted : null));
Check("P37k3 a twinned slot's empty is the USER's — nothing was blanked there to restore",
    ValueAt(twinEmptied, 0, "apiToken") == "", ValueAt(twinEmptied, 0, "apiToken") ?? "(removed)");

// ---- P37e · a former secret retyped to a NON-STRING type ------------------------------
// `secret` -> `number` / `switch` is as ordinary a manifest edit as `secret` -> `text`, and
// the editor then emits a number or a boolean. AsString reports null for those exactly as
// it does for an absent key, so reading emptiness off the string alone treats a deliberate
// replacement as an untouched blank and restores the ciphertext over it.
var numeric = LayoutWith(new JsonObject { ["apiToken"] = 42 });
SecretPolicy.Seal(numeric, demotedStored, DemotedLookup);
// Compared as JSON TEXT, never through a typed accessor: GetValue<int>() THROWS when the
// node is a string, so the regression this probe exists for would crash the suite instead
// of failing it — and a crash prints no FAIL line, which reads exactly like a pass.
Check("P37e a number the user just chose is kept, not replaced by the old ciphertext",
    Slot(numeric).Settings?["apiToken"]?.ToJsonString() == "42",
    Slot(numeric).Settings?["apiToken"]?.ToJsonString() ?? "(absent)");
var boolean = LayoutWith(new JsonObject { ["apiToken"] = false });
SecretPolicy.Seal(boolean, demotedStored, DemotedLookup);
Check("P37f and so is a boolean — `false` is a value, not an absence",
    Slot(boolean).Settings?["apiToken"]?.ToJsonString() == "false",
    Slot(boolean).Settings?["apiToken"]?.ToJsonString() ?? "(absent)");

// ---- P37f2 · Reveal REPORTS what it blanked, or the panel cannot offer a Clear --------
// Mask names its blanked addresses in the payload; Reveal could not, because the model
// carries no projection. So the on-panel editor saw a demoted field arrive empty and had
// no way to tell it from one that was always empty — no Clear, and an emptied field read
// back as untouched (#153). Reveal returns the addresses now and DashboardWindow stamps
// them onto the node it sends.
var reportLayout = LayoutWith(new JsonObject { ["apiToken"] = demotedCipher, ["repo"] = "owner/name" });
var revealReport = SecretPolicy.Reveal(reportLayout, SecretPlan.FromManifests(DemotedLookup));
Check("P37f2 Reveal reports the address it blanked",
    revealReport.TryGetValue((0, 0), out var revealBlanked) && revealBlanked.Contains("apiToken"),
    string.Join(", ", revealReport.SelectMany(kv => kv.Value)));
Check("P37f3 and reports nothing for a property it left alone",
    !revealReport.SelectMany(kv => kv.Value).Contains("repo"));
// Nothing blanked, nothing revealReport — the panel must not grow affordances for fields the
// host never touched.
var nothingBlanked = LayoutWith(new JsonObject { ["repo"] = "owner/name" });
Check("P37f4 a reveal that blanked nothing reports nothing",
    SecretPolicy.Reveal(nothingBlanked, SecretPlan.FromManifests(DemotedLookup)).Count == 0);
// The stamp puts it where Mask puts its own, and the model still cannot carry it.
var stampNode = JsonSerializer.SerializeToNode(reportLayout)!;
SecretPolicy.StampMarkers(stampNode, SecretPolicy.RestorableMarkerKey, revealReport);
Check("P37f5 stamping writes the marker onto the node the panel receives",
    stampNode["pages"]![0]!["slots"]![0]![SecretPolicy.RestorableMarkerKey] is JsonArray st
        && st.Count == 1 && st[0]!.GetValue<string>() == "apiToken",
    stampNode["pages"]![0]!["slots"]![0]![SecretPolicy.RestorableMarkerKey]?.ToJsonString() ?? "(absent)");
Check("P37f6 and the model still drops it, so it cannot reach layout.json",
    !JsonSerializer.Serialize(JsonSerializer.Deserialize<DashboardLayout>(stampNode.ToJsonString()))
        .Contains(SecretPolicy.RestorableMarkerKey));

// ---- P37g · the pathologies the sentinel had, asserted GONE --------------------------
// Every case below cost a review round on PR #152, and each one existed only because the
// protocol rode inside the value. There is nothing to escape now, nothing to compare
// against, and no producer that has to remember a rule — so these assert that the old
// magic strings are ordinary text, permanently and in both directions.
var wasSentinel = LayoutWith(new JsonObject { ["repo"] = ExSentinel });
SecretPolicy.Seal(wasSentinel, null, DemotedLookup);
Check("P37g an ordinary value equal to the old sentinel is stored verbatim",
    Value(wasSentinel, "repo") == ExSentinel, Value(wasSentinel, "repo") ?? "(REMOVED)");
// Survival across TWO saves is the property that matters: the sentinel bugs were invisible
// to a single save, and the escape prefix eroded one layer per save rather than vanishing.
var sentinelAgain = LayoutWith(new JsonObject { ["repo"] = ExSentinel });
SecretPolicy.Seal(sentinelAgain, wasSentinel, DemotedLookup);
Check("P37g2 and on the save after that", Value(sentinelAgain, "repo") == ExSentinel,
    Value(sentinelAgain, "repo") ?? "(REMOVED)");
var wasEscape = LayoutWith(new JsonObject { ["repo"] = ExEscape + "foo" });
SecretPolicy.Seal(wasEscape, null, DemotedLookup);
var escapeAgain = LayoutWith(new JsonObject { ["repo"] = ExEscape + "foo" });
SecretPolicy.Seal(escapeAgain, wasEscape, DemotedLookup);
Check("P37h a value carrying the old escape prefix keeps every character, twice over",
    Value(wasEscape, "repo") == ExEscape + "foo" && Value(escapeAgain, "repo") == ExEscape + "foo",
    (Value(wasEscape, "repo") ?? "?") + " | " + (Value(escapeAgain, "repo") ?? "?"));

// ---- P37i · a clear says WHICH address, so none of the old ambiguities can arise -------
// The stale-editor case: type into a demoted field, save, then clear it without reopening.
// The stored value is ordinary text by then. Under every value-based rule this was either
// ignored or stored the sentinel; a named address does not care what is stored.
var afterRetype = LayoutWith(new JsonObject { ["apiToken"] = "typed-and-saved" });
var staleClear = LayoutWith(new JsonObject { ["apiToken"] = "" });
SecretPolicy.Seal(staleClear, afterRetype, SecretPlan.FromManifests(DemotedLookup), Cleared("apiToken"));
Check("P37i a clear still clears once the stored value is ordinary text",
    Slot(staleClear).Settings?["apiToken"] is null, Value(staleClear, "apiToken") ?? "(removed)");
// ...and the case that made a value-based rule impossible: the user typed the sentinel AS
// their value, saved, then cleared. Incoming and stored agree; the intent is still stated.
var sentinelStored = LayoutWith(new JsonObject { ["repo"] = ExSentinel });
var clearAfterSentinel = LayoutWith(new JsonObject { ["repo"] = "" });
SecretPolicy.Seal(clearAfterSentinel, sentinelStored, SecretPlan.FromManifests(DemotedLookup), Cleared("repo"));
Check("P37i2 and a clear of a field whose stored value IS the old sentinel still clears",
    Slot(clearAfterSentinel).Settings?["repo"] is null,
    Value(clearAfterSentinel, "repo") ?? "(removed)");
// The mirror: an untouched field is untouched, however its value reads.
var untouchedSentinel = LayoutWith(new JsonObject { ["repo"] = ExSentinel });
SecretPolicy.Seal(untouchedSentinel, sentinelStored, DemotedLookup);
Check("P37i3 while an untouched field carrying the same text is left alone",
    Value(untouchedSentinel, "repo") == ExSentinel, Value(untouchedSentinel, "repo") ?? "(REMOVED)");

// ---- P37j · the projection is addressed, and cannot reach disk ------------------------
// Wrong slot, wrong page, wrong property: each must be inert. A clear applied one slot over
// is a credential deleted from a widget the user never touched.
var p37jSlots = TwoInstances(
    new JsonObject { ["apiToken"] = Token }, new JsonObject { ["apiToken"] = Token });
SecretPolicy.Seal(p37jSlots, null, Lookup);
var p37jStored = JsonSerializer.Deserialize<DashboardLayout>(JsonSerializer.Serialize(p37jSlots))!;
var clearSecond = JsonSerializer.Deserialize<DashboardLayout>(JsonSerializer.Serialize(p37jSlots))!;
clearSecond.Pages[0].Slots[1].Settings!["apiToken"] = "";
SecretPolicy.Seal(clearSecond, p37jStored, SecretPlan.FromManifests(Lookup), ClearedAt(0, 1, "apiToken"));
Check("P37j the named slot is cleared", clearSecond.Pages[0].Slots[1].Settings?["apiToken"] is null);
Check("P37j2 and its sibling is untouched",
    SecretStore.CanUnprotect(ValueAt(clearSecond, 0, "apiToken")), ValueAt(clearSecond, 0, "apiToken"));
var wrongPage = JsonSerializer.Deserialize<DashboardLayout>(JsonSerializer.Serialize(p37jSlots))!;
wrongPage.Pages[0].Slots[1].Settings!["apiToken"] = "";
SecretPolicy.Seal(wrongPage, p37jStored, SecretPlan.FromManifests(Lookup), ClearedAt(9, 1, "apiToken"));
Check("P37j3 a clear addressed to a page that does not exist changes nothing",
    SecretStore.CanUnprotect(ValueAt(wrongPage, 1, "apiToken")), ValueAt(wrongPage, 1, "apiToken"));

// The marker travels editor-to-host only, and the model has no member for it — so it
// cannot be read off a layout, and cannot be written to one.
var markerNode = JsonSerializer.SerializeToNode(LayoutWith(new JsonObject { ["apiToken"] = Token }))!;
markerNode["pages"]![0]!["slots"]![0]![SecretPolicy.ClearedMarkerKey] = new JsonArray("apiToken");
var readBack = SecretPolicy.ReadClearedMarkers(markerNode);
Check("P37k4 ReadClearedMarkers finds the projection on the raw node",
    readBack.TryGetValue((0, 0), out var names0) && names0.Count == 1 && names0[0] == "apiToken");
Check("P37k5 and the model drops it, so it can never reach layout.json",
    !JsonSerializer.Serialize(JsonSerializer.Deserialize<DashboardLayout>(markerNode.ToJsonString()))
        .Contains(SecretPolicy.ClearedMarkerKey));
// Placeholder slots are removed from the model right after deserializing, so the
// projection has to be indexed over the survivors or every marker past a blank slot lands
// on its neighbour — a clear applied to the wrong property.
var withBlank = new JsonObject
{
    ["pages"] = new JsonArray(new JsonObject
    {
        ["name"] = "P",
        ["slots"] = new JsonArray(
            new JsonObject { ["widgetId"] = "", ["settings"] = new JsonObject() },
            new JsonObject
            {
                ["widgetId"] = "test.widget",
                ["settings"] = new JsonObject(),
                [SecretPolicy.ClearedMarkerKey] = new JsonArray("apiToken"),
            }),
    }),
};
var blankRead = SecretPolicy.ReadClearedMarkers(withBlank);
Check("P37k6 the projection is indexed over slots that SURVIVE the placeholder filter",
    blankRead.ContainsKey((0, 0)) && !blankRead.ContainsKey((0, 1)),
    string.Join(", ", blankRead.Keys.Select(k => $"({k.Page},{k.Slot})")));

// ---- N · an unrelated tile must not cost a tile its credential -----------------------
// This series was written against the positional |w:0 key, whose claimant count decided
// whether an id-less tile could reach its stored value. #272 and #275 were both mis-tuned
// counts: adding a SECOND tile of the widget flipped the count 1 -> 2, stranded the
// untouched tile's value behind a null key, and took its masked blank for a deliberate
// empty — removing a credential the user never touched, on a clean save.
//
// The key is gone (see SlotKey), so there is no count left to mis-tune. The SEQUENCES stay,
// because they are the ones that actually shipped broken and they must keep working — but
// they now run on FROZEN tiles, which is what LayoutStore.Load guarantees every real
// payload carries (see the L series). That is the honest form of this regression test: the
// user-visible behaviour it protects is unchanged, and it no longer depends on a count.

// N1 · stored: ONE id-less credentialed tile. Incoming: that same untouched tile (masked
// blank) plus a freshly added, id-BEARING second tile of the same widget.
var nStored = LayoutWith(new JsonObject { ["apiToken"] = Token }, instanceId: null);
SecretPolicy.Seal(nStored, null, Lookup);
Slot(nStored).InstanceId = null;   // as the tile sat on disk before identities existed
LayoutStore.MintMissingIds(nStored);   // ...and as Load leaves it now
var nSealed = Value(nStored, "apiToken");
var nIncoming = TwoInstances(new JsonObject { ["apiToken"] = "" },
                             new JsonObject { ["apiToken"] = "" },
                             Slot(nStored).InstanceId, "iNew");
SecretPolicy.Seal(nIncoming, nStored, Lookup);
Check("N1 adding a second tile of a widget does not destroy the first's stored credential",
    ValueAt(nIncoming, 0, "apiToken") == nSealed, ValueAt(nIncoming, 0, "apiToken"));
Check("N1b ...and the newly added tile inherits nothing",
    string.IsNullOrEmpty(ValueAt(nIncoming, 1, "apiToken")), ValueAt(nIncoming, 1, "apiToken"));

// N2 · the #68 danger twin, which must still be REFUSED: the sole credentialed tile is
// deleted and a fresh one added. It inherits nothing because it is a different identity —
// which is now the only answer available, rather than one a claimant count had to reach.
var nTwin = LayoutWith(new JsonObject { ["apiToken"] = "" }, instanceId: "iFresh");
SecretPolicy.Seal(nTwin, nStored, Lookup);
Check("N2 a fresh tile replacing a deleted credentialed one still inherits NOTHING (#68)",
    string.IsNullOrEmpty(Value(nTwin, "apiToken")), Value(nTwin, "apiToken"));

// N3 · two id-less tiles of one widget. Once ambiguous-and-refused; now simply
// unaddressable, and refused for that reason. Same outcome, one fewer rule to get wrong.
var nAmbiguous = TwoInstances(new JsonObject { ["apiToken"] = "" },
                              new JsonObject { ["apiToken"] = "" }, null, null);
SecretPolicy.Seal(nAmbiguous, nStored, Lookup);
Check("N3 two id-less tiles of one widget are ambiguous — neither inherits",
    string.IsNullOrEmpty(ValueAt(nAmbiguous, 0, "apiToken"))
    && string.IsNullOrEmpty(ValueAt(nAmbiguous, 1, "apiToken")));

// N4 · a once-legacy tile beside an id-bearing sibling: both keep their own credential,
// both through their own identity. The legacy half used to restore positionally and now
// restores by the id Load froze onto it — the same user-visible outcome, one address space.
var nMixedStored = TwoInstances(new JsonObject { ["apiToken"] = Token },
                                new JsonObject { ["apiToken"] = Token }, null, "iKeep");
SecretPolicy.Seal(nMixedStored, null, Lookup);
nMixedStored.Pages[0].Slots[0].InstanceId = null;   // as it sat on disk...
LayoutStore.MintMissingIds(nMixedStored);           // ...and as Load leaves it
var nMixedIncoming = TwoInstances(new JsonObject { ["apiToken"] = "" },
                                  new JsonObject { ["apiToken"] = "" },
                                  nMixedStored.Pages[0].Slots[0].InstanceId, "iKeep");
SecretPolicy.Seal(nMixedIncoming, nMixedStored, Lookup);
Check("N4 a legacy tile and an id-bearing sibling both keep their own credential",
    ValueAt(nMixedIncoming, 0, "apiToken") == ValueAt(nMixedStored, 0, "apiToken")
    && ValueAt(nMixedIncoming, 1, "apiToken") == ValueAt(nMixedStored, 1, "apiToken"),
    (ValueAt(nMixedIncoming, 0, "apiToken") ?? "(removed)") + " | " +
    (ValueAt(nMixedIncoming, 1, "apiToken") ?? "(removed)"));

// N5 · #275's scenario, through what used to be the ALIAS half of the path: the host
// stamps the sole tile on a masked save, and before the client adopts that id (the
// mintedIds ack is in flight) the user adds a second tile and saves again. The alias
// published the stored value under |w:0 so the not-yet-adopted client could still find it.
//
// Both the alias and the trigger are gone. Seal only stamps a slot that arrives WITHOUT an
// id, and after Load's freeze none does — so there is no unadopted mint to serve. The
// assertion flips accordingly: an id-less incoming slot inherits nothing, from anywhere.
// N5c/N5d below are the halves that never depended on the alias and are unchanged.
var nAliasStored = LayoutWith(new JsonObject { ["apiToken"] = Token }, instanceId: null);
SecretPolicy.Seal(nAliasStored, null, Lookup);   // Seal stamps: stored is now id-BEARING
Check("N5 setup: the host stamped the stored tile",
    !string.IsNullOrEmpty(Slot(nAliasStored).InstanceId));
var nAliasSealed = Value(nAliasStored, "apiToken");
// The client has not adopted the mint, so it still sends the tile id-LESS — beside a
// freshly added, id-bearing sibling.
var nAliasIncoming = TwoInstances(new JsonObject { ["apiToken"] = "" },
                                  new JsonObject { ["apiToken"] = "" }, null, "iNewSibling");
SecretPolicy.Seal(nAliasIncoming, nAliasStored, Lookup);
Check("N5 an id-less incoming slot inherits nothing — there is no alias left to serve it",
    string.IsNullOrEmpty(ValueAt(nAliasIncoming, 0, "apiToken")),
    ValueAt(nAliasIncoming, 0, "apiToken") ?? "(removed)");
Check("N5b ...and neither does the sibling",
    string.IsNullOrEmpty(ValueAt(nAliasIncoming, 1, "apiToken")));
// N5e · and the sequence #275 actually protects, on the tiles Load guarantees: the client
// HAS the id, adds a sibling, saves — and the credential is still there. Same user-visible
// outcome as the old N5, reached by identity instead of by a counted alias.
var nAdoptedPair = TwoInstances(new JsonObject { ["apiToken"] = "" },
                                new JsonObject { ["apiToken"] = "" },
                                Slot(nAliasStored).InstanceId, "iNewSibling2");
SecretPolicy.Seal(nAdoptedPair, nAliasStored, Lookup);
Check("N5e adding a sibling beside an ADOPTED id costs it nothing (#275's outcome)",
    ValueAt(nAdoptedPair, 0, "apiToken") == nAliasSealed,
    ValueAt(nAdoptedPair, 0, "apiToken") ?? "(removed)");

// N5c · an id-less newcomer standing beside an adopted id must NOT be able to take its
// credential — #68 itself, and what P23b catches. This used to be a gate ON the alias; it
// is now simply what having no identity means.
var nAdopted = TwoInstances(new JsonObject { ["apiToken"] = "" },
                            new JsonObject { ["apiToken"] = "" },
                            Slot(nAliasStored).InstanceId, null);
SecretPolicy.Seal(nAdopted, nAliasStored, Lookup);
Check("N5c an adopted id keeps its credential…",
    ValueAt(nAdopted, 0, "apiToken") == nAliasSealed, ValueAt(nAdopted, 0, "apiToken") ?? "(removed)");
Check("N5d …and an id-less NEWCOMER beside it inherits nothing (#68)",
    string.IsNullOrEmpty(ValueAt(nAdopted, 1, "apiToken")),
    ValueAt(nAdopted, 1, "apiToken") ?? "(removed)");

// ---- R · the retained attic (#226) ---------------------------------------------------
// A removed slot's def moves to layout.retained, addressed ONLY by widgetId|i:instanceId.
// Seal must re-seal a freshly retired plaintext (the shell held it revealed), restore a
// masked blank by identity — from the stored PAGES twin on the first save and from the
// stored ATTIC on every save after — keep ciphertext idempotently, and never let a
// retired value travel positionally. The legacy loss is asserted as the accepted outcome.

static RetainedSlot Retire(JsonObject settings, string? instanceId = "iR",
    string? retiredAt = "2026-08-25T12:00:00Z") => new()
{
    Def = new LayoutSlot
    {
        WidgetId = "test.widget", InstanceId = instanceId, Size = "half", Settings = settings,
    },
    RetiredAt = retiredAt,
    OriginPage = "P",
};
static DashboardLayout EmptyPages() => new() { Pages = [new LayoutPage { Name = "P", Slots = [] }] };
static DashboardLayout WithRetained(DashboardLayout l, params RetainedSlot[] retained)
{
    l.Retained = [.. retained];
    return l;
}
static string? RetainedValue(DashboardLayout l, int i, string name) =>
    l.Retained?[i].Def?.Settings?[name] is JsonValue v && v.TryGetValue<string>(out var s) ? s : null;
string SealOf(string plain)
{
    var l = LayoutWith(new JsonObject { ["apiToken"] = plain });
    SecretPolicy.Seal(l, null, Lookup);
    return Value(l, "apiToken")!;
}

// R1 · on-panel retire: the shell held the value REVEALED, so the attic entry arrives
// with plaintext — Seal must re-seal it or that plaintext hits disk verbatim.
var rFresh = WithRetained(EmptyPages(), Retire(new JsonObject { ["apiToken"] = Token }, "iA"));
SecretPolicy.Seal(rFresh, null, Lookup);
Check("R1 a freshly retired def's plaintext is re-sealed in the attic",
    SecretStore.CanUnprotect(RetainedValue(rFresh, 0, "apiToken")), RetainedValue(rFresh, 0, "apiToken"));
Check("R1b ...and the serialized layout holds no plaintext",
    !JsonSerializer.Serialize(rFresh).Contains(Token));

// R2 · settings-form retire: the editor held the value MASKED (blank); the first save
// restores the ciphertext from the stored layout's still-live twin, matched by identity.
var rStoredLive = LayoutWith(new JsonObject { ["apiToken"] = Token }, instanceId: "iB");
SecretPolicy.Seal(rStoredLive, null, Lookup);
var rSealedB = Value(rStoredLive, "apiToken");
var rMaskedRetire = WithRetained(EmptyPages(), Retire(new JsonObject { ["apiToken"] = "" }, "iB"));
SecretPolicy.Seal(rMaskedRetire, rStoredLive, Lookup);
Check("R2 a masked retire restores the ciphertext from the stored LIVE twin by identity",
    RetainedValue(rMaskedRetire, 0, "apiToken") == rSealedB, RetainedValue(rMaskedRetire, 0, "apiToken"));

// R3 · an attic entry round-tripping as ciphertext is kept idempotently.
var rIdem = WithRetained(EmptyPages(), Retire(new JsonObject { ["apiToken"] = rSealedB! }, "iB"));
SecretPolicy.Seal(rIdem, rMaskedRetire, Lookup);
Check("R3 an already-retired ciphertext round-trips idempotently",
    RetainedValue(rIdem, 0, "apiToken") == rSealedB);

// R4 · the load-bearing case for indexing the stored ATTIC: the settings editor's copy
// of a retired def stays blank after its first save (the host sealed its own copy), so
// the SECOND save's blank must restore from the stored retained entry — the pages twin
// is long gone by then.
var rStoredAttic = WithRetained(EmptyPages(), Retire(new JsonObject { ["apiToken"] = rSealedB! }, "iB"));
var rBlankAgain = WithRetained(EmptyPages(), Retire(new JsonObject { ["apiToken"] = "" }, "iB"));
SecretPolicy.Seal(rBlankAgain, rStoredAttic, Lookup);
Check("R4 a masked retained secret restores from the stored ATTIC across saves",
    RetainedValue(rBlankAgain, 0, "apiToken") == rSealedB, RetainedValue(rBlankAgain, 0, "apiToken"));

// R5 · the accepted legacy loss (#68), pinned so a "fix" cannot land silently: the
// stored tile is id-less (never edited on-panel), the retire minted a fresh id, and no
// carry-over may bridge them — a positional retry that recovered this case would also
// hand a DELETED instance's credential to a look-alike fresh tile.
var rLegacyStored = LayoutWith(new JsonObject { ["apiToken"] = rSealedB! }, instanceId: null);
var rLegacyRetire = WithRetained(EmptyPages(), Retire(new JsonObject { ["apiToken"] = "" }, "iMinted"));
SecretPolicy.Seal(rLegacyRetire, rLegacyStored, Lookup);
Check("R5 legacy loss: an id-less stored tile's secret does NOT follow a masked retire",
    RetainedValue(rLegacyRetire, 0, "apiToken") is null, RetainedValue(rLegacyRetire, 0, "apiToken"));

// R6 · one instanceId seated in BOTH stored pages and stored retained (corruption / a
// save race the retire paths guard against) poisons the key: neither side inherits, the
// user re-enters. A refusal, never a leak.
var rTwinStored = LayoutWith(new JsonObject { ["apiToken"] = rSealedB! }, instanceId: "iT");
rTwinStored.Retained = [Retire(new JsonObject { ["apiToken"] = rSealedB! }, "iT")];
var rTwinIncoming = LayoutWith(new JsonObject { ["apiToken"] = "" }, instanceId: "iT");
SecretPolicy.Seal(rTwinIncoming, rTwinStored, Lookup);
Check("R6 a pages-and-retained twin poisons the key — a refusal, not a leak",
    string.IsNullOrEmpty(Value(rTwinIncoming, "apiToken")), Value(rTwinIncoming, "apiToken"));

// R7 · a retired value must never reach a LIVE tile. The positional alias this once
// guarded is gone, so the case now holds for the stronger reason — the live tile has no
// identity to look anything up by — but the shape is kept: it is the one that would come
// back first if any positional retry were ever reintroduced.
var sealedLiveA = SealOf("tok-live-A");
var sealedRetiredB = SealOf("tok-retired-B");
var rgStored = LayoutWith(new JsonObject(), instanceId: null);
rgStored.Retained = [Retire(new JsonObject { ["apiToken"] = sealedRetiredB }, "iG")];
var rgIncoming = LayoutWith(new JsonObject { ["apiToken"] = "" }, instanceId: null);
SecretPolicy.Seal(rgIncoming, rgStored, Lookup);
Check("R7 a retired value NEVER reaches a live tile of the same widget (#68)",
    string.IsNullOrEmpty(Value(rgIncoming, "apiToken")), Value(rgIncoming, "apiToken"));
// ...while a live tile that HAS its own stored value keeps exactly that one beside an
// attic twin of the same widget — on the frozen identities Load guarantees, since that is
// what the live tile is in any real layout.
var rg2Stored = LayoutWith(new JsonObject { ["apiToken"] = sealedLiveA }, instanceId: null);
LayoutStore.MintMissingIds(rg2Stored);
rg2Stored.Retained = [Retire(new JsonObject { ["apiToken"] = sealedRetiredB }, "iG")];
var rg2Incoming = LayoutWith(new JsonObject { ["apiToken"] = "" },
    instanceId: Slot(rg2Stored).InstanceId);
SecretPolicy.Seal(rg2Incoming, rg2Stored, Lookup);
Check("R7b a live tile restores its OWN stored value beside an attic twin",
    Value(rg2Incoming, "apiToken") == sealedLiveA, Value(rg2Incoming, "apiToken"));

// R8 · Clear THEN Remove. The destroy intent travels inside the retired def, where the
// positional cleared channel cannot reach it — a retired slot has no (page, slot). Read by
// identity instead, or the blank the Clear left behind reads as "untouched" and Seal
// restores the very credential the user destroyed, into the attic, ready to reconnect on
// restore. The stored tile is still LIVE here, which is exactly what makes the resurrection
// available.
var rClearStored = LayoutWith(new JsonObject { ["apiToken"] = rSealedB! }, instanceId: "iC");
var rClearRetire = WithRetained(EmptyPages(), Retire(new JsonObject { ["apiToken"] = "" }, "iC"));
var rClearNode = JsonSerializer.SerializeToNode(rClearRetire)!;
rClearNode["retained"]![0]!["def"]![SecretPolicy.ClearedMarkerKey] = new JsonArray("apiToken");
var rClearMarkers = SecretPolicy.ReadRetainedClearedMarkers(rClearNode);
Check("R8 setup: a retained def's cleared marker is read by IDENTITY, not position",
    rClearMarkers.ContainsKey("test.widget|i:iC"),
    string.Join(", ", rClearMarkers.Keys));
SecretPolicy.Seal(rClearRetire, rClearStored, SecretPlan.FromManifests(Lookup), null, rClearMarkers);
Check("R8b a Clear followed by a Remove DESTROYS the credential rather than resurrecting it",
    RetainedValue(rClearRetire, 0, "apiToken") is null, RetainedValue(rClearRetire, 0, "apiToken"));

// On the on-panel path the retired def carries revealed PLAINTEXT, and a clear must drop
// that too — the pages path does, and re-sealing it into the attic would be the same
// resurrection wearing a different value.
var rClearPlain = WithRetained(EmptyPages(), Retire(new JsonObject { ["apiToken"] = Token }, "iD"));
var rClearPlainNode = JsonSerializer.SerializeToNode(rClearPlain)!;
rClearPlainNode["retained"]![0]!["def"]![SecretPolicy.ClearedMarkerKey] = new JsonArray("apiToken");
SecretPolicy.Seal(rClearPlain, null, SecretPlan.FromManifests(Lookup), null,
    SecretPolicy.ReadRetainedClearedMarkers(rClearPlainNode));
Check("R8c ...and a cleared PLAINTEXT retire leaves neither a value nor the plaintext",
    RetainedValue(rClearPlain, 0, "apiToken") is null
    && !JsonSerializer.Serialize(rClearPlain).Contains(Token),
    RetainedValue(rClearPlain, 0, "apiToken"));

// An unmarked retire is untouched by any of this — R2 already pins that it RESTORES, and
// the two must not be confused: the marker is the only thing separating them.
Check("R8d the marker is projection-only and cannot reach layout.json",
    !JsonSerializer.Serialize(JsonSerializer.Deserialize<DashboardLayout>(rClearNode.ToJsonString())!)
        .Contains(SecretPolicy.ClearedMarkerKey));
Check("R8e an id-less retained def has no identity to mark, and is skipped rather than throwing",
    SecretPolicy.ReadRetainedClearedMarkers(
        JsonNode.Parse("{\"retained\":[{\"def\":{\"widgetId\":\"w\",\"secretsCleared\":[\"k\"]}}]}")).Count == 0);

// ---- C · the attic bound, destroy-on-evict inputs, and the disk union ----------------

var capLayout = EmptyPages();
capLayout.Retained = [];
for (var capI = 1; capI <= 10; capI++)
    capLayout.Retained.Add(Retire(new JsonObject(), "i" + capI.ToString("d2"),
        "2026-08-25T00:" + capI.ToString("d2") + ":00Z"));
var capEvicted = LayoutStore.CapRetained(capLayout);
Check($"C1 the cap evicts the OLDEST beyond {LayoutStore.MaxRetainedPerWidget}",
    capEvicted.Count == 2 && capLayout.Retained.Count == LayoutStore.MaxRetainedPerWidget
    && capEvicted[0].Def.InstanceId == "i01" && capEvicted[1].Def.InstanceId == "i02",
    string.Join(", ", capEvicted.Select(e => e.Def?.InstanceId)));
Check("C1b the survivors are the newest",
    capLayout.Retained.All(r => string.CompareOrdinal(r.RetiredAt, "2026-08-25T00:02:00Z") > 0));

// A corrupt "def": null entry is skipped, not thrown on — one damaged attic entry must
// not take down every save.
var capNull = EmptyPages();
capNull.Retained = [new RetainedSlot { Def = null! }, Retire(new JsonObject(), "iOK")];
var capNullEvicted = LayoutStore.CapRetained(capNull);
Check("C2 a corrupt def:null attic entry cannot take down the cap pass",
    capNullEvicted.Count == 0 && capNull.Retained.Count == 2);

// The liveness guard on destroy-on-evict: an evicted instanceId still referenced by a
// surviving tile is never forgotten (#188 — purge only what the app really removed).
var capForgetEvicted = new List<RetainedSlot> { Retire(new JsonObject(), "iX") };
var capSurviveLive = LayoutWith(new JsonObject(), instanceId: "iX");
Check("C3 evict never forgets an instance a LIVE tile still uses",
    LayoutStore.InstancesToForget(capForgetEvicted, capSurviveLive).Count == 0);
var capForget = LayoutStore.InstancesToForget(capForgetEvicted, EmptyPages());
Check("C3b ...and names exactly the evicted instance when nothing references it",
    capForget.Count == 1 && capForget[0] == ("test.widget", "iX"));

// A save carries only the window that sent it, and a window can be STALE: its pages may
// have dropped a tile the other window still shows and will save straight back. Judging
// liveness from the incoming layout alone destroys that tile's derived credentials while
// it is still on the panel — so the layout being overwritten counts as live too.
Check("C3c evict never forgets an instance the DISK still has live",
    LayoutStore.InstancesToForget(
        capForgetEvicted, EmptyPages(), LayoutWith(new JsonObject(), instanceId: "iX")).Count == 0);
// ...but the disk's ATTIC must not protect anything: folding it in would shield the very
// entries eviction exists to remove, and nothing would ever be forgotten.
var capDiskAttic = WithRetained(EmptyPages(), Retire(new JsonObject(), "iX"));
Check("C3d ...while the disk's own attic protects nothing",
    LayoutStore.InstancesToForget(capForgetEvicted, EmptyPages(), capDiskAttic).Count == 1);

// The disk union: a save whose attic is stale (the other window retired since) keeps
// the disk's entries — except one whose identity is LIVE in the saving window's pages,
// which must not be seated in both pages and retained.
var uDisk = EmptyPages();
uDisk.Retained = [Retire(new JsonObject(), "iKeep"), Retire(new JsonObject(), "iLive")];
var uEdited = LayoutWith(new JsonObject(), instanceId: "iLive");
LayoutStore.MergeRetainedFromDisk(uEdited, uDisk);
Check("C4 the union keeps a disk attic entry a stale save omitted",
    uEdited.Retained is { Count: 1 } && uEdited.Retained[0].Def.InstanceId == "iKeep",
    string.Join(", ", (uEdited.Retained ?? []).Select(r => r.Def?.InstanceId)));
Check("C4b ...but never seats an id in both pages and retained",
    (uEdited.Retained ?? []).All(r => r.Def?.InstanceId != "iLive"));
LayoutStore.MergeRetainedFromDisk(uEdited, uDisk);
Check("C4c the union is idempotent",
    uEdited.Retained is { Count: 1 });

// ---- M · managing the attic: Restore and Clear (#226) --------------------------------
// Restore is HOST-performed because Reveal never walks retained: a client-side move would
// hand the widget dpapi:v1 ciphertext as its credential. It must be ONE mutation (a
// pages-and-retained twin poisons the key, per R6), must keep the instanceId (that is
// what reconnects the derived bucket), and must not let a stale column anchor outrank a
// tile the user can see. Clear destroys for real, under eviction's own liveness rule.

static DashboardLayout PagesNamed(params string[] names) => new()
{
    Pages = [.. names.Select(n => new LayoutPage { Name = n, Slots = [] })],
};
static LayoutSlot? SlotOn(DashboardLayout l, int page, int i) =>
    l.Pages[page].Slots is { } s && s.Count > i ? s[i] : null;

// M1 · the move itself: def onto the named page, entry out of the attic, id intact.
var mSealed = SealOf("tok-restore");
var mLayout = WithRetained(PagesNamed("P", "Q"),
    Retire(new JsonObject { ["apiToken"] = mSealed }, "iM1"));
var mOutcome = LayoutStore.RestoreRetained(mLayout, "test.widget", "iM1", 1, out var mDef);
Check("M1 restore moves the def onto the named page and empties the attic in one call",
    mOutcome == LayoutStore.RestoreOutcome.Ok && mLayout.Retained is { Count: 0 }
    && mLayout.Pages[0].Slots.Count == 0 && mLayout.Pages[1].Slots.Count == 1
    && SlotOn(mLayout, 1, 0)?.InstanceId == "iM1",
    mOutcome.ToString());
Check("M1b the sealed value rides across verbatim — the host never re-seals to move it",
    SlotOn(mLayout, 1, 0)?.Settings?["apiToken"]?.GetValue<string>() == mSealed
    && ReferenceEquals(mDef, SlotOn(mLayout, 1, 0)));

// M2/M3 · refusals leave the layout exactly as it was. Out of range is refused rather
// than clamped: the client names a page it is looking at.
var mBad = WithRetained(PagesNamed("P"), Retire(new JsonObject(), "iM2"));
Check("M2 an out-of-range page is refused, not clamped, and nothing moves",
    LayoutStore.RestoreRetained(mBad, "test.widget", "iM2", 3, out _) == LayoutStore.RestoreOutcome.BadPage
    && mBad.Retained is { Count: 1 } && mBad.Pages[0].Slots.Count == 0);
Check("M2b ...and so is a negative index",
    LayoutStore.RestoreRetained(mBad, "test.widget", "iM2", -1, out _) == LayoutStore.RestoreOutcome.BadPage
    && mBad.Retained is { Count: 1 });
// An index alone is not an identity: the settings editor can reorder its pages locally,
// so an in-range index can name a DIFFERENT page on disk and the tile would land where
// nobody was looking.
Check("M2c an in-range index whose page is not the one the client named is refused too",
    LayoutStore.RestoreRetained(mBad, "test.widget", "iM2", 0, out _, "Renamed")
        == LayoutStore.RestoreOutcome.BadPage
    && mBad.Retained is { Count: 1 } && mBad.Pages[0].Slots.Count == 0);
Check("M2d ...and the matching name goes through",
    LayoutStore.RestoreRetained(mBad, "test.widget", "iM2", 0, out _, "P")
        == LayoutStore.RestoreOutcome.Ok && mBad.Pages[0].Slots.Count == 1);
// Page names are free text with no uniqueness rule, so a name two pages share proves
// nothing about which one the client meant — and a reorder is exactly the case this guard
// is for. Ambiguity is refused rather than resolved by the index it was meant to check.
var mDupName = WithRetained(PagesNamed("Home", "Home"), Retire(new JsonObject(), "iM2e"));
Check("M2e a page name two pages share is not an identity, so it is refused",
    LayoutStore.RestoreRetained(mDupName, "test.widget", "iM2e", 0, out _, "Home")
        == LayoutStore.RestoreOutcome.BadPage
    && mDupName.Retained is { Count: 1 } && mDupName.Pages[0].Slots.Count == 0);
Check("M2f ...while the same layout restores fine when the client names no page",
    LayoutStore.RestoreRetained(mDupName, "test.widget", "iM2e", 1, out _)
        == LayoutStore.RestoreOutcome.Ok && mDupName.Pages[1].Slots.Count == 1);
var mMiss = WithRetained(PagesNamed("P"), Retire(new JsonObject(), "iM3"));
Check("M3 an identity the attic no longer holds is NotFound, and nothing moves",
    LayoutStore.RestoreRetained(mMiss, "test.widget", "iGone", 0, out _) == LayoutStore.RestoreOutcome.NotFound
    && mMiss.Retained is { Count: 1 } && mMiss.Pages[0].Slots.Count == 0);

// M4 · a live tile already holding the id means two slots would share one identity —
// the restored copy re-mints (and forfeits the bucket, which is the live tile's).
var mCollide = LayoutWith(new JsonObject(), instanceId: "iM4");
mCollide.Retained = [Retire(new JsonObject { ["apiToken"] = mSealed }, "iM4")];
LayoutStore.RestoreRetained(mCollide, "test.widget", "iM4", 0, out var mCollided);
Check("M4 a collision with a LIVE tile re-mints the restored id",
    mCollided?.InstanceId is { Length: > 1 } && mCollided.InstanceId != "iM4"
    && mCollide.Pages[0].Slots.Count == 2
    && mCollide.Pages[0].Slots[0].InstanceId == "iM4",
    mCollided?.InstanceId);
Check("M4b ...and only then — an uncontested id is kept, or the bucket would be orphaned",
    SlotOn(mLayout, 1, 0)?.InstanceId == "iM1");
// Collision is a GLOBAL instanceId question. The shell's duplicate healing builds one
// seenIds set over every page with no widget id in it, so a different widget holding the
// same id collides there and the second is re-minted after the fact — detaching whichever
// tile it picks from its widget-local storage and its bucket. Keying this by widget is the
// same mistake SecretStore.AmbiguousSlots documents having made once already.
var mOther = new DashboardLayout
{
    Pages = [new LayoutPage { Name = "P", Slots = [new LayoutSlot
    {
        WidgetId = "other.widget", InstanceId = "iM4x", Size = "half",
    }] }],
    Retained = [Retire(new JsonObject { ["apiToken"] = mSealed }, "iM4x")],
};
LayoutStore.RestoreRetained(mOther, "test.widget", "iM4x", 0, out var mOtherDef);
Check("M4e a DIFFERENT widget holding the id is still a collision, and re-mints",
    mOtherDef?.InstanceId is { Length: > 1 } && mOtherDef.InstanceId != "iM4x",
    mOtherDef?.InstanceId);
Check("M4f ...and the widget that already had the id keeps it",
    mOther.Pages[0].Slots[0].InstanceId == "iM4x");

// A duplicate-identity attic must not survive the restore: leaving a twin behind seats
// the id in both pages and retained, which poisons the key and blanks the credential on
// the very next masked save (R6).
var mDup = WithRetained(PagesNamed("P"),
    Retire(new JsonObject { ["apiToken"] = mSealed }, "iM5"),
    Retire(new JsonObject { ["apiToken"] = mSealed }, "iM5"));
LayoutStore.RestoreRetained(mDup, "test.widget", "iM5", 0, out _);
Check("M4c a duplicate-identity attic leaves NO twin behind — the poison state is unreachable",
    mDup.Retained is { Count: 0 } && mDup.Pages[0].Slots.Count == 1,
    (mDup.Retained?.Count ?? -1) + "/" + mDup.Pages[0].Slots.Count);
var mDupIncoming = LayoutWith(new JsonObject { ["apiToken"] = "" }, instanceId: "iM5");
SecretPolicy.Seal(mDupIncoming, mDup, Lookup);
Check("M4d ...so the first masked save after that restore keeps the credential",
    Value(mDupIncoming, "apiToken") == mSealed, Value(mDupIncoming, "apiToken"));

// The column anchor is origin-page-local. Off that page it pins the tile at an arbitrary
// column, and because the shell seats every anchor before any unanchored slot, a stale
// one can take a column from a tile the user is looking at.
var mCol = PagesNamed("P", "Q");
mCol.Retained =
[
    new RetainedSlot
    {
        Def = new LayoutSlot { WidgetId = "test.widget", InstanceId = "iM6", Size = "half", Col = 3 },
        RetiredAt = "2026-08-25T12:00:00Z",
        OriginPage = "P",
    },
];
LayoutStore.RestoreRetained(mCol, "test.widget", "iM6", 1, out var mColDef);
Check("M5 a stale column anchor is dropped when the tile lands off its origin page",
    mColDef?.Col is null, mColDef?.Col?.ToString());
var mColHome = PagesNamed("P");
mColHome.Retained =
[
    new RetainedSlot
    {
        Def = new LayoutSlot { WidgetId = "test.widget", InstanceId = "iM7", Size = "half", Col = 3 },
        RetiredAt = "2026-08-25T12:00:00Z",
        OriginPage = "P",
    },
];
LayoutStore.RestoreRetained(mColHome, "test.widget", "iM7", 0, out var mColHomeDef);
Check("M5b ...and kept on the page it was retired from, so it lands back where it was",
    mColHomeDef?.Col == 3);

// M6 · Clear, under eviction's liveness rule: a surviving reference blocks the forget.
var mClearLive = LayoutWith(new JsonObject(), instanceId: "iM8");
mClearLive.Retained = [Retire(new JsonObject(), "iM8")];
Check("M6 clear never forgets a bucket a LIVE tile still uses",
    LayoutStore.ClearRetained(mClearLive, "test.widget", "iM8", out var mLiveForget)
    && mLiveForget.Count == 0 && mClearLive.Retained is { Count: 0 });
var mClearAlone = WithRetained(EmptyPages(), Retire(new JsonObject(), "iM9"));
Check("M6b ...and names exactly that instance when nothing references it",
    LayoutStore.ClearRetained(mClearAlone, "test.widget", "iM9", out var mAloneForget)
    && mAloneForget.Count == 1 && mAloneForget[0] == ("test.widget", "iM9")
    && mClearAlone.Retained is { Count: 0 });
// A duplicate the user cannot see would leave the row on screen AND, sitting in the
// survivors' attic, talk the liveness guard out of the forget: the Clear would destroy
// nothing at all.
var mClearDup = WithRetained(EmptyPages(), Retire(new JsonObject(), "iMa"), Retire(new JsonObject(), "iMa"));
Check("M6c a duplicate attic entry cannot silently suppress the destroy",
    LayoutStore.ClearRetained(mClearDup, "test.widget", "iMa", out var mDupForget)
    && mDupForget.Count == 1 && mClearDup.Retained is { Count: 0 });
Check("M6d clearing an identity the attic does not hold changes nothing",
    !LayoutStore.ClearRetained(mClearAlone, "test.widget", "iGone", out var mNoneForget)
    && mNoneForget.Count == 0);

// M7 · the ack the settings editor receives. Mask reads layoutNode["pages"], so the
// wrapper must be pages-shaped or it silently returns having masked nothing — and the
// ciphertext-bearing def would enter the editor's model, the exact state the
// host-performed restore exists to prevent.
var mAckNode = JsonSerializer.SerializeToNode(new DashboardLayout
{
    Pages = [new LayoutPage { Name = "ack", Slots = [SlotOn(mLayout, 1, 0)!] }],
})!;
SecretPolicy.Mask(mAckNode, SecretPlan.FromManifests(Lookup));
var mAckSlot = mAckNode["pages"]![0]!["slots"]![0]!;
Check("M7 the restore ack is masked over a pages-shaped wrapper, so no ciphertext reaches the editor",
    mAckSlot["settings"]!["apiToken"]!.GetValue<string>() == ""
    && !mAckNode.ToJsonString().Contains(mSealed),
    mAckSlot["settings"]!["apiToken"]!.ToJsonString());
Check("M7b ...and it reports the secret as saved, so the card reads 'encrypted (hidden)'",
    mAckSlot[SecretPolicy.SetMarkerKey] is JsonArray mSet && mSet.Count == 1
    && mSet[0]!.GetValue<string>() == "apiToken");
// A one-slot wrapper can never look ambiguous — but only because RestoreRetained has
// already re-minted any id that collided with a live tile, in the same handler call.
Check("M7c the wrapper's lone slot is unambiguous, so the mask blanks rather than withholding",
    mAckSlot[SecretPolicy.RestorableMarkerKey] is null);
// The plan matters as much as the wrapper. A retained def of a REFUSED widget carries
// plaintext whose only classification lives in the window's redaction snapshot; a
// manifest-only plan walks straight past it and posts it to the editor — the refusal
// creating the exposure it exists to prevent. The ack must use the window's MaskedPlan.
static JsonNode AckWrapper(string widgetId, string value) => JsonNode.Parse(
    "{\"pages\":[{\"name\":\"ack\",\"slots\":[{\"widgetId\":\"" + widgetId
    + "\",\"instanceId\":\"iMr\",\"settings\":{\"apiToken\":\"" + value + "\"}}]}]}")!;
var mRefusedNaive = AckWrapper("refused.widget", Token);
SecretPolicy.Mask(mRefusedNaive, SecretPlan.FromManifests(Lookup));
Check("M7d a manifest-only plan leaves a refused widget's plaintext residue in the ack",
    mRefusedNaive.ToJsonString().Contains(Token));
var mRefusedPlan = AckWrapper("refused.widget", Token);
SecretPolicy.Mask(mRefusedPlan, SecretPlan.FromManifests(
    Lookup, id => id == "refused.widget" ? new[] { "apiToken" } : null));
Check("M7e ...and the window's redaction-carrying plan blanks it, which is why the ack must use that one",
    !mRefusedPlan.ToJsonString().Contains(Token));

// M8 · restore constraint (b) — a stale `secretsCleared` projection riding inside a
// retained def would clear the secret on the slot's first save back on a page. It cannot:
// LayoutSlot has no member for it, so the marker dies at deserialization and the host
// restores from the MODEL, never from a client's node.
var mProjNode = JsonNode.Parse(
    "{\"pages\":[{\"name\":\"P\",\"slots\":[]}],\"retained\":[{\"def\":{\"widgetId\":\"test.widget\","
    + "\"instanceId\":\"iMb\",\"secretsCleared\":[\"apiToken\"],\"settings\":{\"apiToken\":\""
    + mSealed + "\"}}}]}")!;
var mProj = JsonSerializer.Deserialize<DashboardLayout>(mProjNode.ToJsonString())!;
LayoutStore.RestoreRetained(mProj, "test.widget", "iMb", 0, out _);
Check("M8 a secretsCleared projection smuggled into an attic def cannot survive to clear the restored secret",
    !JsonSerializer.Serialize(mProj).Contains(SecretPolicy.ClearedMarkerKey));
var mProjIncoming = LayoutWith(new JsonObject { ["apiToken"] = "" }, instanceId: "iMb");
SecretPolicy.Seal(mProjIncoming, mProj, Lookup);
Check("M8b ...so the first save after the restore restores the credential from stored PAGES",
    Value(mProjIncoming, "apiToken") == mSealed, Value(mProjIncoming, "apiToken"));

// M9 · the restore/stale-save interleave, driven end to end rather than asserted. A
// restore has just landed, so the DISK has the tile live in pages and nothing in the
// attic. The other window is stale: its pages never had the tile, its attic still lists
// the entry, and that widget is at the cap — so its save's CapRetained evicts the
// just-restored entry, which carries its ORIGINAL retire timestamp and is the oldest.
// Nothing in the payload names the tile, so only the layout being OVERWRITTEN can say it
// is live — and it is, running in front of the user.
var mRaceDisk = LayoutWith(new JsonObject { ["apiToken"] = mSealed }, instanceId: "iMc");
var mRaceStale = EmptyPages();
mRaceStale.Retained = [Retire(new JsonObject(), "iMc", "2026-08-25T00:00:00Z")];
for (var mRaceI = 1; mRaceI <= LayoutStore.MaxRetainedPerWidget; mRaceI++)
    mRaceStale.Retained.Add(Retire(new JsonObject(), "iR" + mRaceI.ToString("d2"),
        "2026-08-26T00:" + mRaceI.ToString("d2") + ":00Z"));
var mRaceEvicted = LayoutStore.CapRetained(mRaceStale);
Check("M9 setup: the stale save's cap evicts exactly the just-restored entry",
    mRaceEvicted.Count == 1 && mRaceEvicted[0].Def.InstanceId == "iMc",
    string.Join(", ", mRaceEvicted.Select(e => e.Def?.InstanceId)));
Check("M9b ...and its bucket survives, because the disk it is overwriting has that tile live",
    LayoutStore.InstancesToForget(mRaceEvicted, mRaceStale, mRaceDisk).Count == 0);
Check("M9c ...which is load-bearing: judged on the payload alone it WOULD have been destroyed",
    LayoutStore.InstancesToForget(mRaceEvicted, mRaceStale).Count == 1);

// M10 · the in-flight save an explicit Delete cannot notify. The panel serializes its
// whole model — attic included — on every drag, so a payload built BEFORE the Delete can
// be processed after it; the cross-window notice reaches a client that has already sent.
// The union cannot tell that copy from a legitimate one, and the def's sealed bytes still
// decrypt, so without the destroyed-set Delete is undone by an unrelated drag.
var mDeleted = WithRetained(EmptyPages(), Retire(new JsonObject { ["apiToken"] = mSealed }, "iMd"));
LayoutStore.MergeRetainedFromDisk(mDeleted, EmptyPages());
Check("M10 setup: an ordinary stale attic entry survives the union untouched",
    mDeleted.Retained is { Count: 1 });
LayoutStore.MarkDestroyed("test.widget", "iMd");
var mStale = WithRetained(EmptyPages(), Retire(new JsonObject { ["apiToken"] = mSealed }, "iMd"));
LayoutStore.MergeRetainedFromDisk(mStale, EmptyPages());
Check("M10b ...but one an explicit Delete destroyed is dropped from the payload",
    mStale.Retained is { Count: 0 },
    string.Join(", ", (mStale.Retained ?? []).Select(r => r.Def?.InstanceId)));
Check("M10c ...and its sealed bytes leave with it, rather than riding the save back to disk",
    !JsonSerializer.Serialize(mStale).Contains(mSealed));
// Scoped to the identity, not the widget: another tile of the same widget is untouched.
var mSibling = WithRetained(EmptyPages(), Retire(new JsonObject(), "iMe"));
LayoutStore.MergeRetainedFromDisk(mSibling, EmptyPages());
Check("M10d a sibling instance of the same widget is not swept up",
    mSibling.Retained is { Count: 1 });

// ---- E · duplicating a configured tile (#226) ---------------------------------------
// A duplicate is a plain client-side add: same settings MINUS every credential, a FRESH
// instanceId, no host operation at all. Nothing in the pipeline changes for it — which is
// the claim worth pinning, because it rests entirely on the clone being id-BEARING. An
// id-less clone would carry no identity at all, and with the positional |w:0 key retired
// there is nothing for it to fall back to: E3 below is that loss, kept as the reason the
// mint in duplicateSlot is not optional.

var eSealed = SealOf("tok-source");

// E1 · the ordinary case: an id-bearing source keeps its own stored value, and the clone
// starts life with nothing.
var eStored = LayoutWith(new JsonObject { ["apiToken"] = eSealed }, instanceId: "iSrc");
var eIncoming = TwoInstances(
    new JsonObject { ["apiToken"] = "" }, new JsonObject(), "iSrc", "iClone");
SecretPolicy.Seal(eIncoming, eStored, Lookup);
Check("E1 duplicating a tile leaves the source's stored credential alone",
    ValueAt(eIncoming, 0, "apiToken") == eSealed, ValueAt(eIncoming, 0, "apiToken"));
Check("E1b ...and the clone starts with no credential of its own",
    ValueAt(eIncoming, 1, "apiToken") is null, ValueAt(eIncoming, 1, "apiToken"));

// E2 · a LEGACY id-less source. This case USED to be carried by the positional |w:0 key,
// and now it is not: identity is the only address. The credential is not lost in practice
// because the premise cannot occur — Load froze that slot before any client saw it (see L1
// and L3). What is asserted here is the pipeline's own rule, with the premise forced.
var eLegacyStored = LayoutWith(new JsonObject { ["apiToken"] = eSealed }, instanceId: null);
var eLegacy = TwoInstances(
    new JsonObject { ["apiToken"] = "" }, new JsonObject(), null, "iClone");
SecretPolicy.Seal(eLegacy, eLegacyStored, Lookup);
Check("E2 an id-less source has no identity, so it carries nothing over",
    ValueAt(eLegacy, 0, "apiToken") is null, ValueAt(eLegacy, 0, "apiToken"));
Check("E2b ...and the clone inherits nothing either (#68)",
    ValueAt(eLegacy, 1, "apiToken") is null, ValueAt(eLegacy, 1, "apiToken"));
// E2c · the same duplicate, with the source frozen as Load would have left it: the tile
// the user duplicated keeps its token, by identity. This is the case E2 used to be.
var eFrozenStored = LayoutWith(new JsonObject { ["apiToken"] = eSealed }, instanceId: null);
LayoutStore.MintMissingIds(eFrozenStored);
var eFrozen = TwoInstances(
    new JsonObject { ["apiToken"] = "" }, new JsonObject(),
    Slot(eFrozenStored).InstanceId, "iClone");
SecretPolicy.Seal(eFrozen, eFrozenStored, Lookup);
Check("E2c a FROZEN source keeps its credential across the duplicate",
    ValueAt(eFrozen, 0, "apiToken") == eSealed, ValueAt(eFrozen, 0, "apiToken"));
Check("E2d ...and the clone still inherits nothing (#68)",
    ValueAt(eFrozen, 1, "apiToken") is null, ValueAt(eFrozen, 1, "apiToken"));

// E3 · and this is WHY the clone must be minted. Drop the fresh id — the shape a future
// "simplification" of the duplicate path would produce — and the source's credential is
// destroyed by the duplicate, silently. This probe is the reason the mint is not optional.
var eIdless = TwoInstances(
    new JsonObject { ["apiToken"] = "" }, new JsonObject(), null, null);
SecretPolicy.Seal(eIdless, eLegacyStored, Lookup);
Check("E3 an ID-LESS clone would destroy the source's credential — the mint is load-bearing",
    ValueAt(eIdless, 0, "apiToken") is null, ValueAt(eIdless, 0, "apiToken"));

// E4 · two clones beside an id-less source. The claimant COUNT no longer decides anything
// — there is no positional key left to claim — so this now asserts the same refusal as E2,
// and the count-gating that #272 and #275 tuned is gone with the key it gated.
var eTwice = new DashboardLayout
{
    Pages = [new LayoutPage { Name = "P", Slots = [
        new LayoutSlot { WidgetId = "test.widget", InstanceId = null, Size = "half",
            Settings = new JsonObject { ["apiToken"] = "" } },
        new LayoutSlot { WidgetId = "test.widget", InstanceId = "iC1", Size = "half",
            Settings = new JsonObject() },
        new LayoutSlot { WidgetId = "test.widget", InstanceId = "iC2", Size = "half",
            Settings = new JsonObject() },
    ] }],
};
SecretPolicy.Seal(eTwice, eLegacyStored, Lookup);
Check("E4 a second clone changes nothing — an id-less source carries nothing either way",
    ValueAt(eTwice, 0, "apiToken") is null, ValueAt(eTwice, 0, "apiToken"));

// ---- L · Load freezes identities, which is what retired the positional key (#68) ----
// SlotKey no longer has a `|w:0` fallback. That deletion is only safe because an id-less
// slot cannot reach it, and THIS is where that is proven — against the real Load, through
// the real file, rather than argued from call sites.
Console.WriteLine("\n-- L: Load freezes identities (#68)");

var lPath = AppPaths.LayoutFile;
var lSealed = SealOf("tok-onload");
File.WriteAllText(lPath, System.Text.Json.JsonSerializer.Serialize(
    WithRetained(
        new DashboardLayout { Pages = [new LayoutPage { Name = "P", Slots = [
            new LayoutSlot { WidgetId = "test.widget", InstanceId = null, Size = "half",
                Settings = new JsonObject { ["apiToken"] = lSealed } },
        ] }] },
        Retire(new JsonObject(), null))));

var lLoaded = LayoutStore.Load();
Check("L1 a hand-written id-less slot is frozen by Load itself",
    !string.IsNullOrEmpty(lLoaded.Pages[0].Slots[0].InstanceId),
    lLoaded.Pages[0].Slots[0].InstanceId);
Check("L1b ...adopting the positional tag its widget runs under",
    lLoaded.Pages[0].Slots[0].InstanceId == "p0s0", lLoaded.Pages[0].Slots[0].InstanceId);
Check("L1c ...with its sealed credential untouched",
    ValueAt(lLoaded, 0, "apiToken") == lSealed, ValueAt(lLoaded, 0, "apiToken"));
Check("L1d ...and the attic frozen too",
    !string.IsNullOrEmpty(lLoaded.Retained?[0].Def?.InstanceId),
    lLoaded.Retained?[0].Def?.InstanceId);

// L2 · and it PERSISTED. A heal that only fixed the in-memory copy would leave the next
// reader — the other window, the next save handler — looking at id-less slots again.
var lReread = LayoutStore.Load();
Check("L2 the freeze reached disk, so every later reader sees it too",
    lReread.Pages[0].Slots[0].InstanceId == lLoaded.Pages[0].Slots[0].InstanceId
    && !string.IsNullOrEmpty(lReread.Pages[0].Slots[0].InstanceId),
    lReread.Pages[0].Slots[0].InstanceId);

// L3 · the whole point, end to end: the layout Load hands out carries identities, so the
// payload a client builds from it does too, so SlotKey never meets an id-less slot and
// the credential survives an ordinary edit — the carry-over the `|w:0` key used to do.
var lEdit = LayoutWith(new JsonObject { ["apiToken"] = "" },
    instanceId: lReread.Pages[0].Slots[0].InstanceId);
SecretPolicy.Seal(lEdit, lReread, Lookup);
Check("L3 an ordinary edit of a once-legacy tile keeps its credential, by IDENTITY",
    ValueAt(lEdit, 0, "apiToken") == lSealed, ValueAt(lEdit, 0, "apiToken"));

// ---- I · the eager instance-id mint (#226, #68) ------------------------------------
// A legacy slot predates instance ids. Left alone it acquires one from shell.js on its
// first UNRELATED on-panel edit, from a layout whose credentials are blanked — and the
// save carrying that new id cannot find what the old identity stored. The host stamps the
// identity first, on the SEALED model, so the two copies never disagree about who a slot
// is.
Console.WriteLine("\n-- I: eager instance-id mint (#226, #68)");

var iSealed = SealOf("tok-legacy");

// I0 · the defect, reproduced. This is what happens TODAY when the shell mints first: the
// stored copy is still id-less, the incoming copy carries the shell's fresh id, SlotKey
// refuses the mismatch it is right to refuse (#68), and the masked blank the shell
// round-trips lands on disk as if the user had cleared the field. If this check ever
// starts failing, the mint below has stopped being the thing that prevents it.
var iStoredLegacy = LayoutWith(new JsonObject { ["apiToken"] = iSealed }, instanceId: null);
var iShellMinted = LayoutWith(new JsonObject { ["apiToken"] = "" }, instanceId: "iShellMint");
SecretPolicy.Seal(iShellMinted, iStoredLegacy, Lookup);
Check("I0 a shell-side mint against an id-less STORED slot destroys the credential",
    ValueAt(iShellMinted, 0, "apiToken") is null, ValueAt(iShellMinted, 0, "apiToken"));

// I1 · the fix. Freeze the identity on the stored copy FIRST — sealed, in place — and the
// same edit now matches by |i: on both sides.
var iStoredMinted = LayoutWith(new JsonObject { ["apiToken"] = iSealed }, instanceId: null);
Check("I1 the pass stamps an id-less slot", LayoutStore.MintMissingIds(iStoredMinted));
var iFrozenId = Slot(iStoredMinted).InstanceId;
// The tag its widget is ALREADY running under, not a fresh one. shell.js stamps an
// id-less slot's iframe `#ww-slot=p{page}s{slot}`, and that tag backs the widget's
// `uniqueId` global and therefore its storage namespace — so a random id would freeze
// the identity and orphan the widget's stored state in the same stroke. The shell's own
// edit-time mint adopts rec.tag for exactly this reason.
Check("I1b ...the POSITIONAL tag its widget already runs under, not a fresh one",
    iFrozenId == "p0s0", iFrozenId);
Check("I1c ...and the SEALED envelope beside it is untouched — no Reveal/blank round-trip",
    ValueAt(iStoredMinted, 0, "apiToken") == iSealed, ValueAt(iStoredMinted, 0, "apiToken"));

var iAdopted = LayoutWith(new JsonObject { ["apiToken"] = "" }, instanceId: iFrozenId);
SecretPolicy.Seal(iAdopted, iStoredMinted, Lookup);
Check("I1d ...so the edit that used to destroy the credential now carries it over",
    ValueAt(iAdopted, 0, "apiToken") == iSealed, ValueAt(iAdopted, 0, "apiToken"));

// I2 · idempotent. The pass runs on every start; the second one must be a no-op, or a
// restart would re-key every slot and orphan every ww-secure bucket in the process.
Check("I2 a second pass mints nothing", !LayoutStore.MintMissingIds(iStoredMinted));
Check("I2b ...and leaves the id it already stamped alone",
    Slot(iStoredMinted).InstanceId == iFrozenId, Slot(iStoredMinted).InstanceId);

// I3 · an id-BEARING slot is never re-keyed. Same reason: its bucket is under that id.
var iKeep = LayoutWith(new JsonObject { ["apiToken"] = iSealed }, instanceId: "iKeepMe");
Check("I3 an id-bearing slot is not touched", !LayoutStore.MintMissingIds(iKeep));
Check("I3b ...and keeps its id verbatim", Slot(iKeep).InstanceId == "iKeepMe");

// I4 · a slot with no widget id is debris — both save handlers drop it — so giving it an
// identity would only make the debris addressable.
var iDebris = new DashboardLayout
{
    Pages = [new LayoutPage { Name = "P", Slots = [
        new LayoutSlot { WidgetId = "", InstanceId = null, Size = "half", Settings = new JsonObject() },
    ] }],
};
Check("I4 a slot with no widget id is not minted", !LayoutStore.MintMissingIds(iDebris));
Check("I4b ...and stays id-less", string.IsNullOrEmpty(Slot(iDebris).InstanceId));

// I5 · the attic too. A retired def is addressed by identity ALONE, so an id-less entry is
// one the gallery lists but neither Restore nor Delete can name.
var iAttic = WithRetained(EmptyPages(), Retire(new JsonObject { ["apiToken"] = iSealed }, null));
Check("I5 an id-less retained def is minted", LayoutStore.MintMissingIds(iAttic));
Check("I5b ...so it becomes addressable at all",
    !string.IsNullOrEmpty(iAttic.Retained![0].Def!.InstanceId), iAttic.Retained![0].Def!.InstanceId);
Check("I5c ...with its sealed bytes still in the def",
    RetainedValue(iAttic, 0, "apiToken") == iSealed, RetainedValue(iAttic, 0, "apiToken"));

// I6 · live and retired share ONE id namespace — RestoreRetained re-mints against exactly
// this collision — so a pass that reserved only the pages could hand a live tile a retired
// tile's key, and the restore would then find the live slot sitting on its identity.
var iBoth = WithRetained(
    TwoInstances(new JsonObject(), new JsonObject(), null, "iLive"),
    Retire(new JsonObject(), "iRetired"));
Check("I6 the pass mints across a layout holding both", LayoutStore.MintMissingIds(iBoth));
var iFresh = iBoth.Pages[0].Slots[0].InstanceId;
Check("I6b the new id collides with neither the live nor the retired one",
    iFresh is { Length: > 0 } && iFresh != "iLive" && iFresh != "iRetired", iFresh);
Check("I6c ...and the ids that already existed are unchanged",
    iBoth.Pages[0].Slots[1].InstanceId == "iLive"
    && iBoth.Retained![0].Def!.InstanceId == "iRetired");

// I6d · ...and when the positional tag is already spoken for by an explicit id — legal,
// and the collision SecretStore.AmbiguousSlots calls out by name — the mint falls back to
// a fresh one rather than handing two slots a single identity.
var iSquatted = new DashboardLayout
{
    Pages = [new LayoutPage { Name = "P", Slots = [
        // Explicitly named "p0s1" — which is the tag the id-less slot BELOW it, at position
        // (0,1), would otherwise adopt.
        new LayoutSlot { WidgetId = "test.widget", InstanceId = "p0s1", Size = "half", Settings = new JsonObject() },
        new LayoutSlot { WidgetId = "test.widget", InstanceId = null, Size = "half", Settings = new JsonObject() },
    ] }],
};
Check("I6d the pass mints past a squatted positional tag", LayoutStore.MintMissingIds(iSquatted));
Check("I6e ...with something OTHER than the taken tag",
    iSquatted.Pages[0].Slots[1].InstanceId is { Length: > 0 } squatted && squatted != "p0s1",
    iSquatted.Pages[0].Slots[1].InstanceId);

// I7 · two id-less slots of ONE widget — the case the positional key has always refused
// (SlotKey returns null at two claimants). After the pass they are distinct identities, so
// the ambiguity that made both unaddressable is gone rather than merely refused.
var iPair = TwoInstances(new JsonObject(), new JsonObject(), null, null);
Check("I7 both id-less siblings are minted", LayoutStore.MintMissingIds(iPair));
Check("I7b ...as their own positions, so they are told apart",
    iPair.Pages[0].Slots[0].InstanceId == "p0s0" && iPair.Pages[0].Slots[1].InstanceId == "p0s1",
    iPair.Pages[0].Slots[0].InstanceId + " / " + iPair.Pages[0].Slots[1].InstanceId);

// I8 · a null layout is not a crash. This runs at startup, before anything else has had a
// chance to establish that the file was readable.
Check("I8 a null layout is handled", !LayoutStore.MintMissingIds(null));

// ---- G · the layout generation (#281) ---------------------------------------------
// Two windows hold the whole of layout.json and each writes it back whole, so the host
// needs to tell a fresh payload from one built before a write it has since committed.
// The rule is "BEHIND *and* moved by somebody ELSE", and both halves are asserted here
// because dropping either breaks something the other cannot catch: without behind-ness
// nothing is ever refused, and without the writer ordinary panel editing is refused.
//
// Absolute generation values are deliberately never asserted — earlier cases in this file
// write layout.json too, and a probe that depended on the counter starting at a particular
// number would be asserting the order of the file rather than the rule.
Console.WriteLine("\n-- G: layout generation (#281)");

var gLayout = new DashboardLayout { Pages = [new LayoutPage { Name = "P", Slots = [] }] };
var gStart = LayoutStore.Generation;

// G1 · a payload built from the CURRENT version is fresh, whoever sent it. This is also
// the startup case: generation 0 against generation 0, so the first save always lands.
Check("G1 a current payload is fresh (panel)",
    !LayoutStore.IsStale(gStart, LayoutStore.PanelWriter));
Check("G1b a current payload is fresh (settings)",
    !LayoutStore.IsStale(gStart, LayoutStore.SettingsWriter));

// G2 · the panel is routinely behind ITSELF — it posts its whole model on every drag and
// resize, and the next payload is out long before the previous ack lands. That is not
// staleness: its own in-memory state already holds what it just saved. Refusing here would
// make the panel uneditable, which is why the writer clause exists at all.
Check("G2 a panel save lands", LayoutStore.Save(gLayout, LayoutStore.PanelWriter));
Check("G2b ...and bumps the generation by exactly one",
    LayoutStore.Generation == gStart + 1, LayoutStore.Generation.ToString());
Check("G2c the panel's own behind payload is NOT stale",
    !LayoutStore.IsStale(gStart, LayoutStore.PanelWriter));

// G3 · the OTHER window's write is what makes it stale. This is the cross-window half of
// every member of the family in #281.
Check("G3 a settings save lands", LayoutStore.Save(gLayout, LayoutStore.SettingsWriter));
Check("G3b the panel's behind payload is now stale",
    LayoutStore.IsStale(gStart, LayoutStore.PanelWriter));
Check("G3c ...while the settings window's own is not",
    !LayoutStore.IsStale(gStart, LayoutStore.SettingsWriter));

// G4 · the case the first draft of this design got wrong, and the reason the writer is
// the PAYLOAD SOURCE rather than the requesting window. A Restore or a Clear is performed
// by the HOST on a window's request. Attributing it to that window would exempt the
// window's own in-flight payload — which still carries the attic entry the Clear just
// destroyed, because the client drops the row only on the ack — and the entry would come
// back with DPAPI bytes that still decrypt. Every host write is therefore attributed to
// no window, so the requester is stale against its own request.
var gBeforeHost = LayoutStore.Generation;
Check("G4 a host-performed write lands", LayoutStore.Save(gLayout));
Check("G4b the requesting panel is stale against the host write it asked for",
    LayoutStore.IsStale(gBeforeHost, LayoutStore.PanelWriter));
Check("G4c ...and so is the settings window",
    LayoutStore.IsStale(gBeforeHost, LayoutStore.SettingsWriter));

// G5 · a payload carrying NO generation is accepted. Host and clients ship in one binary
// so it should not arise; if it does, the answer is the behaviour that predates this rule
// (last writer wins), never a window that can no longer save at all.
Check("G5 a payload with no generation is accepted",
    !LayoutStore.IsStale(null, LayoutStore.PanelWriter));

// G6 · a FAILED write must not bump. LayoutStore.Save swallows its exception — ordinary
// editing triggers it on both surfaces and throwing there would take something visible
// down — so the bump lives inside the success branch. Bumping anyway would lock the other
// window out of a file whose content it still matches byte for byte.
var gBeforeFail = LayoutStore.Generation;
Plinth.DurableStore.FailNextWrite = true;
Check("G6 a failed write reports failure",
    !LayoutStore.Save(gLayout, LayoutStore.SettingsWriter));
Check("G6b ...and does not bump the generation",
    LayoutStore.Generation == gBeforeFail, LayoutStore.Generation.ToString());
Check("G6c ...so the other window's payload is still fresh",
    !LayoutStore.IsStale(gBeforeFail, LayoutStore.PanelWriter));

Console.WriteLine(failures == 0 ? "ALL PASS" : $"{failures} FAILURES");
return failures == 0 ? 0 : 1;

namespace Plinth
{
    // Stand-ins for the app-side helpers SecretStore logs through; the probe only needs
    // them to exist (and stay quiet unless something interesting happens).
    internal static class Log
    {
        public static void Info(string message) { }
        public static void Warn(string message) => Console.WriteLine($"    [log] {message}");
        public static void Error(string message) => Console.WriteLine($"    [log] {message}");
    }

    internal static class AppPaths
    {
        // The probe never touches disk: every case builds layouts in memory.
        public static string LayoutFile => Path.Combine(Path.GetTempPath(), "ww-secret-probe-layout.json");
        public static string BackgroundsDir => Path.GetTempPath();
    }

    internal static class DurableStore
    {
        /// <summary>Makes the NEXT write throw, so a probe can assert what a failed write
        /// leaves behind. The real one fails for reasons a probe cannot arrange (a locked
        /// file, a full disk) and swallows the exception inside LayoutStore.Save, so
        /// without a seam here the failure branch is unreachable and the "a failed write
        /// must not bump the generation" rule could only be asserted by reading it.</summary>
        public static bool FailNextWrite;

        public static void Write(string path, string contents)
        {
            if (FailNextWrite)
            {
                FailNextWrite = false;
                throw new IOException("probe: forced write failure");
            }
            File.WriteAllText(path, contents);
        }
    }
}
