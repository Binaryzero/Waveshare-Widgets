// Probes for the `secret` property pipeline (#15), run against the real
// SecretStore/SecretPolicy/LayoutSlot source. Exit code 0 = all pass.
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using WaveshareWidgets.Widgets;

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

// Clearing is an explicit MARKER, never an empty string: empty is also what an
// untouched masked field sends, and that has to keep the credential.
var cleared = LayoutWith(new JsonObject { ["apiToken"] = SecretStore.ClearMarker });
SecretPolicy.Seal(cleared, typed, Lookup);
Check("P5b the clear marker removes a STORED credential (Codex r1: empty kept it)",
    Slot(cleared).Settings?["apiToken"] is null, Value(cleared, "apiToken"));
Check("P5c the clear marker itself is never persisted",
    !JsonSerializer.Serialize(cleared).Contains(SecretStore.ClearMarker));
var clearedFresh = LayoutWith(new JsonObject { ["apiToken"] = SecretStore.ClearMarker });
SecretPolicy.Seal(clearedFresh, null, Lookup);
Check("P5d clearing with nothing stored also leaves the key absent",
    Slot(clearedFresh).Settings?["apiToken"] is null);

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
// paths do. Otherwise it stays addressable only by position: the dashboard shell mints an
// instanceId on its first on-panel edit, and the next Seal looks the value up under
// "|i:..." while it was indexed under "|w:0" — removing what Settings just preserved.
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

// ---- P21 · Codex r4: a credential that IS the clear marker stays storeable ----------
var r4Literal = LayoutWith(new JsonObject { ["apiToken"] = SecretStore.LiteralPrefix + SecretStore.ClearMarker });
SecretPolicy.Seal(r4Literal, null, Lookup);
Check("P21 an escaped credential equal to the clear marker is stored, not read as a clear",
    SecretStore.Unprotect(Value(r4Literal, "apiToken") ?? "") == SecretStore.ClearMarker,
    Value(r4Literal, "apiToken"));
var r4StillClears = LayoutWith(new JsonObject { ["apiToken"] = SecretStore.ClearMarker });
SecretPolicy.Seal(r4StillClears, typed, Lookup);
Check("P21b the UNescaped marker still means remove",
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
var planSrc = FindUpwards("src/WaveshareWidgets/Widgets/SecretStore.cs");
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
Check("P28b KNOWN GAP (#66): a demoted secret still reaches the widget as ciphertext",
    Value(revealed28, "apiToken") == demotedCipher, Value(revealed28, "apiToken"));
// The property that makes the gap tolerable, and that any fix must preserve: the stored
// value is INTACT, so the user can retype the field and it saves as ordinary text.
Check("P28c but the stored value is intact, so the situation self-heals on the next edit",
    SecretStore.Unprotect(Value(revealed28, "apiToken")) == Token);
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
// The "|w:0" alias itself still does its job, and this is the reason it is not collateral
// damage: a still-open editor holding the id-less slot it submitted, whose id the HOST
// minted, matches positionally and keeps its value. Nothing in it depends on guessing an
// identity — the host already assigned one and the client simply has not seen it yet.
var p32Idless = LayoutWith(new JsonObject { ["apiToken"] = "" }, instanceId: null);
SecretPolicy.Seal(p32Idless, p32Stored, Lookup);
Check("P32d a client that has not adopted the host's mint still matches positionally",
    Value(p32Idless, "apiToken") == Value(p32Stored, "apiToken"),
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

Console.WriteLine(failures == 0 ? "ALL PASS" : $"{failures} FAILURES");
return failures == 0 ? 0 : 1;

namespace WaveshareWidgets
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
        public static void Write(string path, string contents) => File.WriteAllText(path, contents);
    }
}
