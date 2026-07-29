// Probes for the `secret` property pipeline (#15), run against the real
// SecretStore/SecretPolicy/LayoutSlot source. Exit code 0 = all pass.
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
SecretStore.DecryptOverride = Flip;

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
static string? Value(DashboardLayout l, string name) => Slot(l).Settings?[name]?.GetValue<string>();

// ---- P1 · a typed credential is encrypted before it can be written -------------------
var typed = LayoutWith(new JsonObject { ["apiToken"] = Token, ["repo"] = "owner/name" });
SecretPolicy.Seal(typed, null, Lookup);
var sealedValue = Value(typed, "apiToken");
Check("P1 a plaintext secret is sealed with the dpapi marker",
    SecretStore.IsProtected(sealedValue), sealedValue);
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

// A cleared field is an explicit empty string with NO stored predecessor for the key.
var cleared = LayoutWith(new JsonObject { ["apiToken"] = "" });
SecretPolicy.Seal(cleared, null, Lookup);
Check("P5b clearing with nothing stored drops the key (widget sees an unset secret)",
    Slot(cleared).Settings?["apiToken"] is null);

// ---- P6 · slots without an instanceId still find their own stored secret -------------
var positional = LayoutWith(new JsonObject { ["apiToken"] = Token }, instanceId: null);
SecretPolicy.Seal(positional, null, Lookup);
var positionalSealed = Value(positional, "apiToken");
var positionalMasked = LayoutWith(new JsonObject { ["apiToken"] = "" }, instanceId: null);
SecretPolicy.Seal(positionalMasked, positional, Lookup);
Check("P6 un-edited (instanceId-less) layouts carry secrets over by widgetId+ordinal",
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
var foreign = LayoutWith(new JsonObject { ["apiToken"] = "dpapi:v1:!!!not-base64!!!" });
SecretPolicy.Reveal(foreign, Lookup);
Check("P8 a secret from another user/machine reveals as empty, not as garbage",
    Value(foreign, "apiToken") == "");

// ---- P9 · sealing is idempotent (the dashboard re-saves its own layout) --------------
var again = JsonSerializer.Deserialize<DashboardLayout>(JsonSerializer.Serialize(typed))!;
SecretPolicy.Seal(again, typed, Lookup);
Check("P9 sealing an already-sealed layout changes nothing",
    Value(again, "apiToken") == sealedValue);

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
