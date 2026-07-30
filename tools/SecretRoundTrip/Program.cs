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
static byte[] Flip(byte[] input)
{
    var output = new byte[input.Length];
    for (var i = 0; i < input.Length; i++) output[i] = (byte)(input[i] ^ 0x5A);
    return output;
}
SecretStore.EncryptOverride = Flip;
// A blob "sealed by another user/machine" must be BOTH well-formed (marker + valid
// base64, so it really is shaped like one of ours) and un-openable here. Real DPAPI
// throws for a foreign key; the stand-in throws for a tagged prefix, so the probe can
// tell a foreign envelope apart from legacy plaintext that merely starts with the
// marker — which is exactly the distinction Seal now makes.
static byte[] TaggedDecrypt(byte[] b) =>
    b.Length >= 2 && b[0] == 0xFE && b[1] == 0xED
        ? throw new CryptographicException("that key belongs to another user")
        : Flip(b);
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
var legacyStored2 = LayoutWith(new JsonObject { ["apiToken"] = "legacy-plaintext" }, instanceId: null);
var legacyEdit2 = LayoutWith(new JsonObject { ["apiToken"] = "" }, instanceId: null);
SecretPolicy.Seal(legacyEdit2, legacyStored2, Lookup);
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

// With the stand-in manifest the library now carries for every refusal.
var standIn = WidgetManifest.RedactionOnly(
    refusedManifest.Id, refusedManifest.Name, refusedManifest.CredentialPropertyNames());
WidgetManifest? RedactedLookup(string id) => id == "test.widget" ? standIn : null;
var refusedMasked = JsonSerializer.SerializeToNode(refusedStored);
SecretPolicy.Mask(refusedMasked, RedactedLookup);
Check("P27c the stand-in keeps the refused widget's credential out of the editor payload",
    !refusedMasked!.ToJsonString().Contains(Token), refusedMasked.ToJsonString());
Check("P27d and the editor is still told a value exists",
    refusedMasked["pages"]![0]!["slots"]![0]!["secretsSet"] is JsonArray s27 && s27.Count == 1);

// Redacting must not cost the user their data: the masked blank saved back has to restore
// the stored value — and, since it was legacy plaintext, encrypt it on the way past.
var refusedResave = JsonSerializer.Deserialize<DashboardLayout>(refusedMasked.ToJsonString())!;
SecretPolicy.Seal(refusedResave, refusedStored, RedactedLookup);
var refusedAfter = Value(refusedResave, "apiToken");
Check("P27e saving the masked layout keeps the credential rather than blanking it",
    SecretStore.Unprotect(refusedAfter) == Token, refusedAfter);
Check("P27f and it is now encrypted at rest, which the refusal alone never achieved",
    refusedAfter != Token && SecretStore.HasMarker(refusedAfter));

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
