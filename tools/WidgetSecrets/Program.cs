// The widget-derived credential store (issue #175, re-scoped per instance in #226).
//
// A `secret` PROPERTY is DPAPI-sealed at rest, so a stolen layout.json carries no usable
// credential. The token a widget BUYS with that secret had nowhere to go but
// localStorage — a plaintext file in the same WebView profile — which hands back exactly
// what the sealing withholds: a working credential, obtainable without decrypting
// anything. Every OAuth widget so far has had to keep its bearer memory-only.
//
// Since #226 the store is nested `widgetId -> instanceId -> key`: two TILES of one widget
// no longer share a bucket, so a cloned or replaced tile never inherits the credential of
// the one before it, while the widget id still bounds an uninstall (one move drops every
// instance). W2 and W7 carry the new instance axis; the seal, no-plaintext and vocabulary
// decisions are unchanged.
//
// What this probe guards is everything about that store that is a pure decision:
//
//   W1  a value survives seal -> reveal, through the same envelope `secret` uses
//   W2  scopes are isolated on BOTH axes — neither another widget nor another instance
//   W3  keys and scopes (widget AND instance) are validated, and the alphabet is bounded
//   W4  the caps hold (per instance now), and an overwrite at the limit is still allowed
//   W5  an UNAVAILABLE cipher writes nothing — never a plaintext fallback
//   W6  a damaged OR older-version document degrades to empty rather than throwing
//   W7  delete, forgetInstance and forget remove what they say, and nothing else
//   W8  a refusal travels under the name the API reference documents, exhaustively
//
// W5 is the one that matters most. A store that silently degrades to plaintext when
// sealing fails is worse than no store: the widget believes it is protected, the value is
// on disk in the clear, and nothing anywhere says so.
using System.Security.Cryptography;
using System.Text.Json.Nodes;
using Plinth.Widgets;

var failures = 0;
void Check(string name, bool ok, string? detail = null)
{
    Console.WriteLine($"  {(ok ? "PASS" : "FAIL")} {name}{(detail is null ? "" : " - " + detail)}");
    if (!ok) failures++;
}

// ---- the cipher stand-in ------------------------------------------------------------
// Identical in shape to tools/SecretRoundTrip's: DPAPI exists only on Windows, and the
// seam is what lets the real seal->reveal contract run here rather than a mock of it.
byte[] Magic = [0x57, 0x57];   // "WW"
byte[] Flip(byte[] input)
{
    var output = new byte[input.Length + Magic.Length];
    Magic.CopyTo(output, 0);
    for (var i = 0; i < input.Length; i++) output[i + Magic.Length] = (byte)(input[i] ^ 0x5A);
    return output;
}
byte[] Unflip(byte[] b)
{
    if (b.Length < Magic.Length || b[0] != Magic[0] || b[1] != Magic[1])
        throw new CryptographicException("not produced by this cipher");
    var output = new byte[b.Length - Magic.Length];
    for (var i = 0; i < output.Length; i++) output[i] = (byte)(b[i + Magic.Length] ^ 0x5A);
    return output;
}
SecretStore.EncryptOverride = Flip;
SecretStore.DecryptOverride = Unflip;

var fresh = () => WidgetSecrets.Load(null);

// ---- W1: the round trip, through the same envelope ----------------------------------

var doc = fresh();
Check("W1 setup: sealing is available with the stand-in cipher", WidgetSecrets.Available());
Check("W1 a value seals and reveals",
    WidgetSecrets.Set(doc, "ws.stock.rest", "i1", "bearer", "tok-abc") == WidgetSecrets.WriteResult.Ok
    && WidgetSecrets.Get(doc, "ws.stock.rest", "i1", "bearer") == "tok-abc");

// The point of reusing SecretStore: what lands on disk is the SAME envelope a `secret`
// property gets, so there is one protection story to reason about rather than two — and
// the plaintext is nowhere in the serialized document.
var onDisk = WidgetSecrets.Serialize(doc);
Check("W1b what is written is the same dpapi envelope a secret property gets",
    onDisk.Contains("dpapi:v1:", StringComparison.Ordinal));
Check("W1c ...and the plaintext appears nowhere in the file",
    !onDisk.Contains("tok-abc", StringComparison.Ordinal), onDisk.Replace("\n", " "));
// The on-disk shape is the v2 nesting, not the v1 flat one: the instance id is a real
// level, which is what lets two tiles of one widget hold different values.
Check("W1d the document is written at schema version 2",
    onDisk.Contains("\"version\": 2", StringComparison.Ordinal), onDisk.Replace("\n", " "));
Check("W1e ...nested widgetId -> instanceId -> key",
    onDisk.Contains("\"ws.stock.rest\"", StringComparison.Ordinal)
    && onDisk.Contains("\"i1\"", StringComparison.Ordinal)
    && onDisk.Contains("\"bearer\"", StringComparison.Ordinal));

// A document round-trips through text without losing anything.
Check("W1f the document survives a save/load cycle",
    WidgetSecrets.Get(WidgetSecrets.Load(onDisk), "ws.stock.rest", "i1", "bearer") == "tok-abc");

Check("W1g an absent key reads as null, not as an error",
    WidgetSecrets.Get(doc, "ws.stock.rest", "i1", "nothing-here") is null);

// ---- W2: scopes are isolated, on BOTH axes ------------------------------------------
//
// The whole security claim. A widget's virtual host already gives it its own origin (the
// widget axis); #226 adds that two TILES of one widget are isolated too (the instance
// axis), so a cloned or replaced tile never reads the credential of the one before it.
// Both lines have to hold, or the store leaks across exactly the boundary it draws.

WidgetSecrets.Set(doc, "ws.stock.ghqueue", "i1", "bearer", "tok-github");
Check("W2 two widgets do not see each other's values",
    WidgetSecrets.Get(doc, "ws.stock.rest", "i1", "bearer") == "tok-abc"
    && WidgetSecrets.Get(doc, "ws.stock.ghqueue", "i1", "bearer") == "tok-github");
Check("W2b a widget that stored nothing reads nothing",
    WidgetSecrets.Get(doc, "ws.stock.clock", "i1", "bearer") is null);

// The instance axis: the SAME widget id under a DIFFERENT instance id is a different
// bucket, and a token written to one is not readable from the other.
WidgetSecrets.Set(doc, "ws.stock.rest", "i2", "bearer", "tok-second-tile");
Check("W2c two instances of one widget do not see each other's values",
    WidgetSecrets.Get(doc, "ws.stock.rest", "i1", "bearer") == "tok-abc"
    && WidgetSecrets.Get(doc, "ws.stock.rest", "i2", "bearer") == "tok-second-tile");
Check("W2d an instance that stored nothing reads nothing, even under a widget with other instances",
    WidgetSecrets.Get(doc, "ws.stock.rest", "i-absent", "bearer") is null);
Check("W2e deleting one instance's key leaves the sibling instance and the other widget alone",
    WidgetSecrets.Delete(doc, "ws.stock.rest", "i1", "bearer")
    && WidgetSecrets.Get(doc, "ws.stock.rest", "i1", "bearer") is null
    && WidgetSecrets.Get(doc, "ws.stock.rest", "i2", "bearer") == "tok-second-tile"
    && WidgetSecrets.Get(doc, "ws.stock.ghqueue", "i1", "bearer") == "tok-github");

// ---- W3: keys and scopes ------------------------------------------------------------

string[] goodKeys = ["bearer", "oauth.token", "a-b_c", "T0KEN", new string('k', 64)];
Check("W3 ordinary keys are accepted",
    goodKeys.All(WidgetSecrets.IsValidKey),
    string.Join(", ", goodKeys.Where(k => !WidgetSecrets.IsValidKey(k))));

// Keys are JSON members and never touch the filesystem, so this is not a traversal
// guard — it is a bounded, boring alphabet so that no later change has to re-ask.
string[] badKeys = [
    "", "   ", "../escape", "a/b", "a\\b", "a:b", "with space", "quote\"", "nul\0byte",
    "unicode-é", new string('k', 65),
];
Check("W3b anything outside the alphabet is refused",
    badKeys.All(k => !WidgetSecrets.IsValidKey(k)),
    string.Join(" | ", badKeys.Where(WidgetSecrets.IsValidKey)));
Check("W3c a null key is refused rather than throwing", !WidgetSecrets.IsValidKey(null));

Check("W3d a blank widget scope is refused — unidentified callers would share one bucket",
    !WidgetSecrets.IsValidScope(null) && !WidgetSecrets.IsValidScope("")
    && !WidgetSecrets.IsValidScope("   "));
Check("W3e reverse-DNS widget ids are accepted",
    WidgetSecrets.IsValidScope("ws.stock.rest") && WidgetSecrets.IsValidScope("com.example.my-widget"));

// The instance id is validated by the same bounded alphabet: the shell-minted 'i…-…' ids
// and the frozen positional tags ('p0s1') pass; blank is refused for the same reason a
// blank widget scope is, because an id-less tile would share one bucket with every other.
Check("W3f instance ids are validated like keys — minted and positional tags pass, blank is refused",
    WidgetSecrets.IsValidInstance("i-lz9k2-4") && WidgetSecrets.IsValidInstance("p0s1")
    && !WidgetSecrets.IsValidInstance(null) && !WidgetSecrets.IsValidInstance("")
    && !WidgetSecrets.IsValidInstance("bad instance"));

var reject = fresh();
Check("W3g a bad key is refused at the WRITE, with a reason",
    WidgetSecrets.Set(reject, "ws.stock.rest", "i1", "../escape", "v") == WidgetSecrets.WriteResult.BadKey);
Check("W3h ...and a bad widget scope likewise",
    WidgetSecrets.Set(reject, "", "i1", "bearer", "v") == WidgetSecrets.WriteResult.BadScope);
// A bad INSTANCE is BadScope too, not a fourth outcome: the instance id is part of the
// scope, and a widget's fallback for "no valid scope" is the same either way.
Check("W3i ...and a bad instance scope is BadScope, not a new refusal",
    WidgetSecrets.Set(reject, "ws.stock.rest", "", "bearer", "v") == WidgetSecrets.WriteResult.BadScope
    && WidgetSecrets.Set(reject, "ws.stock.rest", "bad inst", "bearer", "v") == WidgetSecrets.WriteResult.BadScope);
Check("W3j a refused write leaves NOTHING behind",
    WidgetSecrets.Serialize(reject) == WidgetSecrets.Serialize(fresh()),
    WidgetSecrets.Serialize(reject).Replace("\n", " "));

// ---- W4: the caps -------------------------------------------------------------------

var caps = fresh();
var big = new string('x', WidgetSecrets.MaxValueBytes);
Check("W4 a value at exactly the cap is accepted",
    WidgetSecrets.Set(caps, "w", "i1", "k", big) == WidgetSecrets.WriteResult.Ok);
Check("W4b one byte over is refused",
    WidgetSecrets.Set(caps, "w", "i1", "k2", big + "x") == WidgetSecrets.WriteResult.TooLarge);
// The cap is BYTES, not characters: a multi-byte character counts for what it costs, or
// the bound is not the bound for anyone outside ASCII.
Check("W4c the cap counts UTF-8 BYTES, not characters",
    WidgetSecrets.Set(caps, "w", "i1", "k3", new string('é', WidgetSecrets.MaxValueBytes / 2 + 1))
        == WidgetSecrets.WriteResult.TooLarge);

var many = fresh();
for (var i = 0; i < WidgetSecrets.MaxKeysPerInstance; i++) WidgetSecrets.Set(many, "w", "i1", "k" + i, "v");
Check("W4d the key cap holds",
    WidgetSecrets.Set(many, "w", "i1", "one-too-many", "v") == WidgetSecrets.WriteResult.TooManyKeys);
// Counting keys that would EXIST after the write, not before it: an instance at the limit
// must still be able to refresh the very token it already holds, and a naive count is
// what would lock it out of its own entry.
Check("W4e ...but overwriting an EXISTING key at the limit still works",
    WidgetSecrets.Set(many, "w", "i1", "k0", "refreshed") == WidgetSecrets.WriteResult.Ok
    && WidgetSecrets.Get(many, "w", "i1", "k0") == "refreshed");
// The cap is per INSTANCE now (#226): a second tile of the same widget has its own budget,
// and so does a different widget. Filling one instance never starves another.
Check("W4f the cap is per instance — a second instance of the same widget has its own budget",
    WidgetSecrets.Set(many, "w", "i2", "k", "v") == WidgetSecrets.WriteResult.Ok);
Check("W4g ...and per widget likewise",
    WidgetSecrets.Set(many, "other", "i1", "k", "v") == WidgetSecrets.WriteResult.Ok);

// ---- W5: no plaintext fallback, ever -------------------------------------------------
//
// The most important case in this file. If sealing fails and the store writes the value
// anyway, the widget believes it is protected while the credential sits on disk in the
// clear — strictly worse than having no store, because nothing says so.

var noCipher = fresh();
var savedEncrypt = SecretStore.EncryptOverride;
SecretStore.EncryptOverride = _ => throw new PlatformNotSupportedException("no DPAPI here");
Check("W5 setup: sealing reports itself unavailable", !WidgetSecrets.Available());
var result = WidgetSecrets.Set(noCipher, "ws.stock.rest", "i1", "bearer", "tok-plaintext");
Check("W5 a write with no cipher reports Unavailable", result == WidgetSecrets.WriteResult.Unavailable,
    result.ToString());
var afterFailed = WidgetSecrets.Serialize(noCipher);
Check("W5b ...and the plaintext is NOT on disk",
    !afterFailed.Contains("tok-plaintext", StringComparison.Ordinal), afterFailed.Replace("\n", " "));
Check("W5c ...and the document is untouched, not half-written",
    afterFailed == WidgetSecrets.Serialize(fresh()));
SecretStore.EncryptOverride = savedEncrypt;

// The mirror: a value sealed by ANOTHER user or machine cannot be opened here, and the
// caller is told nothing rather than being handed a broken string. Same answer as absent,
// because the widget's response is the same — go and get a new one. Written in the v2
// nested shape, so it is the shape traversal, not a version drop, that reaches the value.
var foreign = WidgetSecrets.Load(
    "{\"version\":2,\"widgets\":{\"ws.stock.rest\":{\"i1\":{\"bearer\":\"dpapi:v1:"
    + Convert.ToBase64String([0xFE, 0xED, 0x01]) + "\"}}}}");
Check("W5d an envelope this machine cannot open reads as null, not as garbage",
    WidgetSecrets.Get(foreign, "ws.stock.rest", "i1", "bearer") is null);

// ---- W6: a damaged or older document -------------------------------------------------
//
// A store that throws on a corrupt file takes the credentials with it AND gives the field
// no way back. Degrading to empty loses the stored values and nothing else — the widget
// re-authenticates, which is what it did before this existed.

string[] junk = ["", "   ", "not json at all", "[1,2,3]", "{}", "{\"widgets\":42}", "null"];
var survived = junk.All(j =>
{
    try { var d = WidgetSecrets.Load(j); return WidgetSecrets.Get(d, "w", "i1", "k") is null; }
    catch (Exception) { return false; }
});
Check("W6 a damaged or foreign document degrades to empty rather than throwing", survived);
Check("W6b ...and is writable again immediately",
    WidgetSecrets.Set(WidgetSecrets.Load("not json"), "w", "i1", "k", "v") == WidgetSecrets.WriteResult.Ok);

// A well-formed v1 document (keys straight under the widget id, the #175 shape) is not
// read through the v2 nesting — it loads empty. Nothing shipped ever wrote v1, and
// grafting a v2 instance bucket beside v1 string keys would corrupt the file on the next
// write; treating it as empty re-derives the token, which is the pre-store behaviour.
var v1 = WidgetSecrets.Load("{\"version\":1,\"widgets\":{\"w\":{\"k\":\"dpapi:v1:AAAA\"}}}");
Check("W6c a v1 document degrades to empty rather than being read through the v2 shape",
    WidgetSecrets.Get(v1, "w", "i1", "k") is null
    && WidgetSecrets.Set(v1, "w", "i1", "k", "v") == WidgetSecrets.WriteResult.Ok);

// ---- W7: delete, forgetInstance and forget ------------------------------------------

var gone = fresh();
WidgetSecrets.Set(gone, "w1", "i1", "a", "1");
WidgetSecrets.Set(gone, "w1", "i1", "b", "2");
WidgetSecrets.Set(gone, "w1", "i2", "a", "3");   // a second tile of w1
WidgetSecrets.Set(gone, "w2", "i1", "a", "4");
Check("W7 delete removes one key and leaves the sibling",
    WidgetSecrets.Delete(gone, "w1", "i1", "a")
    && WidgetSecrets.Get(gone, "w1", "i1", "a") is null
    && WidgetSecrets.Get(gone, "w1", "i1", "b") == "2");
Check("W7b deleting something absent says so rather than throwing",
    !WidgetSecrets.Delete(gone, "w1", "i1", "a") && !WidgetSecrets.Delete(gone, "nobody", "i1", "a")
    && !WidgetSecrets.Delete(gone, "w1", "i-absent", "a"));

// forgetInstance: the per-tile destroy behind Clear and evict-on-cap (#226). Drops ONE
// instance's whole bucket, leaving the widget's other instances and every other widget
// untouched.
Check("W7c forgetInstance drops one instance and nothing else",
    WidgetSecrets.ForgetInstance(gone, "w1", "i1")
    && WidgetSecrets.Get(gone, "w1", "i1", "b") is null
    && WidgetSecrets.Get(gone, "w1", "i2", "a") == "3"
    && WidgetSecrets.Get(gone, "w2", "i1", "a") == "4");
Check("W7d forgetInstance on an absent instance says so rather than throwing",
    !WidgetSecrets.ForgetInstance(gone, "w1", "i-absent") && !WidgetSecrets.ForgetInstance(gone, "nobody", "i1"));

// forget: the whole-WIDGET destroy behind uninstall (#188). Drops every instance at once,
// which is exactly why the store stays nested under the widget id — uninstall knows only
// that the package went, not which tiles held it.
Check("W7e forget drops the whole widget — all instances — and nothing else",
    WidgetSecrets.Forget(gone, "w1")
    && WidgetSecrets.Get(gone, "w1", "i2", "a") is null
    && WidgetSecrets.Get(gone, "w2", "i1", "a") == "4");

// An emptied instance is removed, and an emptied widget with it, so neither a spent tile
// nor an uninstalled widget leaves a shell behind and the file does not grow one entry
// per instance ever placed.
var emptied = fresh();
WidgetSecrets.Set(emptied, "w", "i1", "only", "v");
WidgetSecrets.Delete(emptied, "w", "i1", "only");
Check("W7f removing the last key removes the instance bucket AND the now-empty widget node",
    !WidgetSecrets.Serialize(emptied).Contains("\"w\"", StringComparison.Ordinal)
    && !WidgetSecrets.Serialize(emptied).Contains("\"i1\"", StringComparison.Ordinal),
    WidgetSecrets.Serialize(emptied).Replace("\n", " "));
// ...but a widget with a SECOND live instance keeps its node when one instance empties —
// this is the "purge when no live instance remains" property, falling out of the nesting
// rather than needing a liveness check.
var oneLeft = fresh();
WidgetSecrets.Set(oneLeft, "w", "i1", "only", "v");
WidgetSecrets.Set(oneLeft, "w", "i2", "keep", "v");
WidgetSecrets.Delete(oneLeft, "w", "i1", "only");
Check("W7g emptying one instance leaves a widget that still has another",
    WidgetSecrets.Get(oneLeft, "w", "i2", "keep") == "v"
    && !WidgetSecrets.Serialize(oneLeft).Contains("\"i1\"", StringComparison.Ordinal));

// ---- W8: the refusal vocabulary a widget branches on --------------------------------
// docs/PLINTH-API-REFERENCE.md names these five in the ww-secure-result row, and a
// widget's whole fallback hangs on telling `unavailable` (keep it in memory, protection
// is off on this machine) from the rest (fix the widget). The host used to derive them
// from the enum member, which yields `toolarge` where the contract says `too-large` — so
// four of the five documented names were never emitted and no branch on them could fire.
// Pinned here rather than left to inspection, because it is a WIRE protocol: it now
// survives a member rename, and a member ADDED without a name fails W8c instead of
// reaching a widget as "". The instance re-scope (#226) adds no new refusal name: a bad
// instance is BadScope, so the vocabulary is unchanged.
var documented = new Dictionary<WidgetSecrets.WriteResult, string>
{
    [WidgetSecrets.WriteResult.BadKey] = "bad-key",
    [WidgetSecrets.WriteResult.BadScope] = "bad-scope",
    [WidgetSecrets.WriteResult.TooLarge] = "too-large",
    [WidgetSecrets.WriteResult.TooManyKeys] = "too-many-keys",
    [WidgetSecrets.WriteResult.Unavailable] = "unavailable",
};
foreach (var (refusal, name) in documented)
    Check($"W8 {refusal} travels as '{name}'", WidgetSecrets.WireName(refusal) == name);
Check("W8b success carries no error name",
    WidgetSecrets.WireName(WidgetSecrets.WriteResult.Ok) == "");
// Exhaustive: every member is either Ok or documented above. A new refusal added to the
// enum without being named here lands in neither set and fails, which is the point —
// silently reaching a widget as an empty string is what this is here to prevent.
var unnamed = Enum.GetValues<WidgetSecrets.WriteResult>()
    .Where(r => r != WidgetSecrets.WriteResult.Ok && !documented.ContainsKey(r))
    .ToList();
Check("W8c every refusal the enum can produce has a documented name",
    unnamed.Count == 0, unnamed.Count == 0 ? "" : string.Join(", ", unnamed));
// ...and the names stay distinct, since a widget switches on them.
Check("W8d the names are distinct",
    documented.Values.Distinct(StringComparer.Ordinal).Count() == documented.Count);
// The real refusals reach WireName as themselves — this is the path the host takes, not
// a hand-built enum value: an over-long write really does answer 'too-large', and a bad
// widget OR instance scope both answer 'bad-scope'.
Check("W8e a refused write's own result names itself",
    WidgetSecrets.WireName(WidgetSecrets.Set(fresh(), "w", "i1", "k", new string('x', WidgetSecrets.MaxValueBytes + 1)))
        == "too-large"
    && WidgetSecrets.WireName(WidgetSecrets.Set(fresh(), "w", "i1", "bad key", "v")) == "bad-key"
    && WidgetSecrets.WireName(WidgetSecrets.Set(fresh(), "", "i1", "k", "v")) == "bad-scope"
    && WidgetSecrets.WireName(WidgetSecrets.Set(fresh(), "w", "", "k", "v")) == "bad-scope");

Console.WriteLine(failures > 0 ? $"{failures} FAILURES" : "ALL PASS");
return failures > 0 ? 1 : 0;

namespace Plinth
{
    // Stand-ins for the app-side helpers SecretStore's dependency closure logs and
    // persists through. The same shape tools/SecretRoundTrip uses: the probe needs them
    // to exist, and nothing here touches disk.
    internal static class Log
    {
        public static void Info(string message) { }
        public static void Warn(string message) => Console.WriteLine($"    [log] {message}");
        public static void Error(string message) => Console.WriteLine($"    [log] {message}");
    }

    internal static class AppPaths
    {
        public static string LayoutFile => Path.Combine(Path.GetTempPath(), "ww-secrets-probe-layout.json");
        public static string BackgroundsDir => Path.GetTempPath();
    }

    internal static class DurableStore
    {
        public static void Write(string path, string contents) => File.WriteAllText(path, contents);
    }
}
