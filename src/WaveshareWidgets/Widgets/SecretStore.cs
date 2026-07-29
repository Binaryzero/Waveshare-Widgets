using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;

namespace WaveshareWidgets.Widgets;

/// <summary>
/// DPAPI protection for widget settings declared <c>type: "secret"</c> (bearer tokens,
/// PATs, client secrets, private ICS URLs). Values are encrypted with the CurrentUser
/// scope before they reach layout.json, so a stolen or synced layout file carries no
/// usable credential — plaintext exists only in memory and in the widget iframe that
/// declared the property.
///
/// The ciphertext is stored as "<c>dpapi:v1:BASE64</c>". The marker is a HINT, never
/// proof: a user's own token could legitimately start with those characters, so
/// "is this already sealed?" is answered by actually decrypting it
/// (<see cref="CanUnprotect"/>). Anything that fails that test is treated as plaintext
/// and gets encrypted, which is both the safe default and the legacy-migration path.
/// </summary>
public static class SecretStore
{
    private const string Marker = "dpapi:v1:";

    /// <summary>Placeholder the settings editor and its preview see instead of a stored
    /// secret. Plaintext never travels to the editor at all; the editor learns only that
    /// a value EXISTS (per-slot <c>secretsSet</c>) so it can show a "saved" state.</summary>
    public const string EditorPlaceholder = "";

    /// <summary>Sent by the editor when the user pressed Clear. An empty value can't
    /// carry that meaning: it is also what an untouched masked field sends back, which
    /// must KEEP the stored credential. The two intents need different words.</summary>
    public const string ClearMarker = "__ww_secret_cleared__";

    /// <summary>Cheap syntactic check: does this look like one of our envelopes? Only
    /// meaningful together with <see cref="CanUnprotect"/> — see the class remarks.</summary>
    public static bool HasMarker(string? value) =>
        value is not null && value.StartsWith(Marker, StringComparison.Ordinal);

    /// <summary>True when the value really is an envelope this user/machine can open.
    /// The authoritative "already sealed" test.</summary>
    public static bool CanUnprotect(string? value) => value is not null && Unprotect(value, quiet: true) is not null;

    /// <summary>Cipher seam. DPAPI exists only on Windows, so the CI probe
    /// (tools/SecretRoundTrip, which compiles this file) substitutes a reversible stand-in
    /// to exercise the seal→reveal contract, and clears it to exercise the
    /// no-DPAPI fail-safe. Never assigned in the shipping app.</summary>
    // CS0649: nothing in the SHIPPING assembly assigns these, which is the point — only
    // the probe, which compiles this same file into its own assembly, ever does.
#pragma warning disable CS0649
    internal static Func<byte[], byte[]>? EncryptOverride;
    internal static Func<byte[], byte[]>? DecryptOverride;
#pragma warning restore CS0649

    private static byte[] Encrypt(byte[] plain) => EncryptOverride is { } f
        ? f(plain)
        : ProtectedData.Protect(plain, null, DataProtectionScope.CurrentUser);

    private static byte[] Decrypt(byte[] blob) => DecryptOverride is { } f
        ? f(blob)
        : ProtectedData.Unprotect(blob, null, DataProtectionScope.CurrentUser);

    /// <summary>Encrypts a plaintext secret. Returns false (with nothing written) when
    /// DPAPI is unavailable — callers keep the previously stored value rather than
    /// letting a credential fall back to plaintext on disk.</summary>
    public static bool TryProtect(string plaintext, out string stored)
    {
        try
        {
            var bytes = Encrypt(Encoding.UTF8.GetBytes(plaintext));
            stored = Marker + Convert.ToBase64String(bytes);
            return true;
        }
        catch (Exception ex)
        {
            Log.Warn($"Could not protect a secret setting; the previous value is kept: {ex.Message}");
            stored = "";
            return false;
        }
    }

    /// <summary>Decrypts a stored secret. Returns null when the value isn't ours, the
    /// blob is corrupt, or it was written by a different user/machine — the widget then
    /// sees an unset secret and renders its "not configured" state, which is the honest
    /// outcome (DPAPI keys don't travel).</summary>
    public static string? Unprotect(string stored) => Unprotect(stored, quiet: false);

    private static string? Unprotect(string stored, bool quiet)
    {
        if (!HasMarker(stored))
            return null;
        try
        {
            var bytes = Convert.FromBase64String(stored[Marker.Length..]);
            return Encoding.UTF8.GetString(Decrypt(bytes));
        }
        catch (Exception ex)
        {
            // Probing ("can this be opened?") must stay silent: the loud path is a real
            // read of a value we expected to work.
            if (!quiet)
                Log.Warn($"Could not read a protected secret (wrong user/machine, or corrupt): {ex.Message}");
            return null;
        }
    }
}

/// <summary>A secret the save could not protect. The credential the user typed is NOT on
/// disk (plaintext is never a fallback), so the save must not be reported as clean.</summary>
/// <param name="WidgetId">Widget whose slot holds the secret.</param>
/// <param name="Property">The secret property's name.</param>
public sealed record SecretSealFailure(string WidgetId, string Property);

/// <summary>
/// Applies <see cref="SecretStore"/> across a whole layout, using each widget's manifest
/// to decide which settings are secrets. Three directions, one per consumer:
///
///   <list type="bullet">
///   <item>Reveal — decrypt for the dashboard, whose widget iframes need real values.</item>
///   <item>Mask — blank for the settings editor (plus a <c>secretsSet</c> hint listing
///     only the secrets this machine can actually read), so the editor surface never
///     holds a credential.</item>
///   <item>Seal — encrypt on the way to disk, restoring the stored value for a masked
///     field the editor sent back untouched and honoring an explicit clear.</item>
///   </list>
/// </summary>
public static class SecretPolicy
{
    /// <summary>Transient projection key listing the secret property names that have a
    /// stored, readable value. <see cref="LayoutSlot"/> deliberately has no matching
    /// member, so it is dropped on deserialize and can never reach layout.json.</summary>
    public const string SetMarkerKey = "secretsSet";

    /// <summary>A hand-edited layout can hold a number/object/array where a secret
    /// belongs. <c>GetValue&lt;string&gt;()</c> would THROW on those, and this code runs
    /// inside the dashboard's init payload — one bad value would leave the shell with no
    /// layout at all. Non-strings read as "unset" instead.</summary>
    private static string? AsString(JsonNode? node)
    {
        if (node is not JsonValue value)
            return null;
        return value.TryGetValue<string>(out var text) ? text : null;
    }

    private static HashSet<string> SecretNames(WidgetManifest? manifest)
    {
        var names = new HashSet<string>(StringComparer.Ordinal);
        foreach (var prop in manifest?.Properties ?? [])
        {
            if (!string.IsNullOrEmpty(prop.Name) &&
                string.Equals(prop.Type, "secret", StringComparison.OrdinalIgnoreCase))
                names.Add(prop.Name);
        }
        return names;
    }

    /// <summary>Decrypts every secret in place — for the dashboard's init payload only.</summary>
    public static void Reveal(DashboardLayout layout, Func<string, WidgetManifest?> lookup)
    {
        Walk(layout, lookup, (slot, name) =>
        {
            var stored = AsString(slot.Settings?[name]);
            if (stored is null)
            {
                // Non-string junk (hand-edited layout) reads as unset, never as a crash.
                if (slot.Settings?[name] is not null)
                    slot.Settings[name] = "";
                return;
            }
            if (SecretStore.HasMarker(stored))
                slot.Settings![name] = SecretStore.Unprotect(stored) ?? "";
            // Legacy plaintext (a property that used to be `text`) already reads as
            // itself; it gets encrypted the next time the layout is saved.
        });
    }

    /// <summary>Blanks every secret and records which ones are set AND readable here.
    /// Mutates the JSON projection (not the model) because <c>secretsSet</c> is
    /// projection-only.</summary>
    public static void Mask(JsonNode? layoutNode, Func<string, WidgetManifest?> lookup)
    {
        if (layoutNode?["pages"] is not JsonArray pages)
            return;
        foreach (var page in pages)
        {
            if (page?["slots"] is not JsonArray slots)
                continue;
            foreach (var slot in slots)
            {
                var widgetId = AsString(slot?["widgetId"]);
                if (widgetId is null || slot is null)
                    continue;
                var secrets = SecretNames(lookup(widgetId));
                if (secrets.Count == 0)
                    continue;
                var set = new JsonArray();
                foreach (var name in secrets)
                {
                    var node = slot["settings"]?[name];
                    if (node is null)
                        continue;
                    var value = AsString(node);
                    // "Saved" must mean "usable": a blob from another machine/user
                    // decrypts to nothing, so reporting it as saved would hide the very
                    // thing the user has to do (re-enter it). Legacy plaintext counts as
                    // set — it is readable, and the next save encrypts it.
                    var usable = !string.IsNullOrEmpty(value) &&
                        (SecretStore.HasMarker(value) ? SecretStore.CanUnprotect(value) : true);
                    if (usable)
                        set.Add(name);
                    slot["settings"]![name] = SecretStore.EditorPlaceholder;
                }
                if (set.Count > 0)
                    slot[SetMarkerKey] = set;
            }
        }
    }

    /// <summary>
    /// Encrypts secrets on their way to disk.
    ///
    /// <list type="bullet">
    /// <item>The editor's clear marker removes the stored credential.</item>
    /// <item>An empty/absent value keeps what <paramref name="stored"/> holds — that is
    ///   the masked field the user never retyped — encrypting it if it was still legacy
    ///   plaintext (the documented `text` → `secret` migration).</item>
    /// <item>A value that really decrypts is already sealed and passes through.</item>
    /// <item>Anything else is plaintext and gets encrypted — including a token that
    ///   merely LOOKS like an envelope.</item>
    /// </list>
    /// Carry-over identity is keyed by widget id + instance id, so replacing a widget in
    /// a slot can never hand it the previous widget's credential; layouts predating
    /// instance ids fall back to position, but only when that is unambiguous, and any
    /// slot that ends up holding a sealed secret gets a stable id minted here so the
    /// fallback is one-shot.
    /// </summary>
    /// <returns>The secrets whose protection FAILED. Nothing plaintext was written for
    /// them, but the save is not what the user asked for — callers must say so instead
    /// of acknowledging a clean save.</returns>
    public static IReadOnlyList<SecretSealFailure> Seal(
        DashboardLayout layout, DashboardLayout? stored, Func<string, WidgetManifest?> lookup)
    {
        var previous = BuildStoredIndex(stored, lookup, out var storedCounts);
        var incomingCounts = CountWidgets(layout);
        var failures = new List<SecretSealFailure>();
        // Minting an instance id below CHANGES a slot's key, so a widget with two secrets
        // would look up its second one under the brand-new id and find nothing. Resolve
        // each slot's key once, before anything can mint.
        var keyOf = new Dictionary<LayoutSlot, string?>(ReferenceEqualityComparer.Instance);

        Walk(layout, lookup, (slot, name) =>
        {
            if (!keyOf.TryGetValue(slot, out var key))
                keyOf[slot] = key = SlotKey(slot, storedCounts, incomingCounts);
            var node = slot.Settings?[name];
            var value = AsString(node);

            // Explicit clear: drop the key so the widget sees an unset secret and the
            // ciphertext is gone from disk.
            if (value == SecretStore.ClearMarker)
            {
                slot.Settings!.Remove(name);
                return;
            }

            // Already a real envelope (idempotent re-save of a sealed layout).
            if (SecretStore.CanUnprotect(value))
                return;

            if (string.IsNullOrEmpty(value))
            {
                // Untouched masked field (or non-string junk): keep what is stored.
                if (key is null || !previous.TryGetValue((key, name), out var kept))
                {
                    if (node is not null)
                        slot.Settings!.Remove(name);
                    return;
                }
                if (SecretStore.CanUnprotect(kept))
                {
                    slot.Settings![name] = kept;
                    Stamp(slot);
                    return;
                }
                if (SecretStore.HasMarker(kept))
                {
                    // An envelope this user/machine cannot open — a layout copied from
                    // another PC or another Windows account. Re-encrypting it would wrap
                    // the FOREIGN ciphertext in an envelope we can open, so Reveal would
                    // hand the widget that ciphertext as if it were the credential and
                    // the editor would go back to reporting it saved. Drop it: Mask
                    // already shows it as "not set", and the user re-enters it.
                    slot.Settings!.Remove(name);
                    return;
                }
                // Legacy plaintext from a `text` → `secret` upgrade: encrypt it now.
                if (SecretStore.TryProtect(kept, out var sealedLegacy))
                {
                    slot.Settings![name] = sealedLegacy;
                    Stamp(slot);
                }
                else
                {
                    // Keeping it leaves layout.json exactly as it already was; dropping
                    // it would destroy the credential over a transient DPAPI failure.
                    slot.Settings![name] = kept;
                    failures.Add(new SecretSealFailure(slot.WidgetId, name));
                }
                return;
            }

            // Plaintext (typed now, a legacy `text` value, or something that merely
            // starts with the marker): encrypt it.
            if (SecretStore.TryProtect(value!, out var sealedValue))
            {
                slot.Settings![name] = sealedValue;
                Stamp(slot);
                return;
            }
            // Protection unavailable. Never write the plaintext: keep a readable previous
            // value so the widget keeps working, else drop the key. Either way the user
            // asked for something that did NOT happen, so this is reported.
            var fallback = key is not null && previous.TryGetValue((key, name), out var prior)
                && SecretStore.CanUnprotect(prior) ? prior : null;
            if (fallback is not null)
                slot.Settings![name] = fallback;
            else
                slot.Settings!.Remove(name);
            failures.Add(new SecretSealFailure(slot.WidgetId, name));
        });

        return failures;

        // A slot that stores a credential gets a stable identity, so the next save
        // matches it by id instead of by its position on the page.
        static void Stamp(LayoutSlot slot)
        {
            if (string.IsNullOrEmpty(slot.InstanceId))
                slot.InstanceId = "s" + Guid.NewGuid().ToString("n")[..12];
        }
    }

    private static Dictionary<string, int> CountWidgets(DashboardLayout? layout)
    {
        var counts = new Dictionary<string, int>(StringComparer.Ordinal);
        foreach (var page in layout?.Pages ?? [])
            foreach (var slot in page.Slots ?? [])
                if (!string.IsNullOrEmpty(slot.WidgetId))
                    counts[slot.WidgetId] = counts.TryGetValue(slot.WidgetId, out var n) ? n + 1 : 1;
        return counts;
    }

    /// <summary>Indexes stored secret values — protected AND legacy plaintext, since a
    /// `text` → `secret` upgrade must be encrypted on the next save, not discarded.</summary>
    private static Dictionary<(string Slot, string Name), string> BuildStoredIndex(
        DashboardLayout? stored, Func<string, WidgetManifest?> lookup, out Dictionary<string, int> counts)
    {
        counts = CountWidgets(stored);
        var index = new Dictionary<(string, string), string>();
        if (stored is null)
            return index;
        var storedCounts = counts;
        Walk(stored, lookup, (slot, name) =>
        {
            var key = SlotKey(slot, storedCounts, storedCounts);
            var value = AsString(slot.Settings?[name]);
            if (key is not null && !string.IsNullOrEmpty(value))
                index[(key, name)] = value!;
        });
        return index;
    }

    /// <summary>Carry-over identity: widget id + instance id, else widget id + position
    /// when that is unambiguous on both sides. Returns null when position can't be
    /// trusted (several instances of one widget, counts changed by a move/delete) —
    /// carrying over then risks handing one instance another's credential, so the user
    /// re-enters it instead.</summary>
    private static string? SlotKey(LayoutSlot slot,
        Dictionary<string, int> storedCounts, Dictionary<string, int> incomingCounts)
    {
        if (!string.IsNullOrEmpty(slot.InstanceId))
            return slot.WidgetId + "|i:" + slot.InstanceId;
        storedCounts.TryGetValue(slot.WidgetId, out var before);
        incomingCounts.TryGetValue(slot.WidgetId, out var after);
        if (before == 1 && after == 1)
            return slot.WidgetId + "|w:0";
        return null;
    }

    /// <summary>Visits every (slot, secret-property-name) pair of a layout. The visitor
    /// runs once per declared secret, whether or not the slot carries a value.</summary>
    private static void Walk(DashboardLayout layout, Func<string, WidgetManifest?> lookup,
        Action<LayoutSlot, string> visit)
    {
        foreach (var page in layout.Pages ?? [])
        {
            foreach (var slot in page.Slots ?? [])
            {
                if (string.IsNullOrEmpty(slot.WidgetId))
                    continue;
                var secrets = SecretNames(lookup(slot.WidgetId));
                if (secrets.Count == 0)
                    continue;
                slot.Settings ??= new JsonObject();
                foreach (var name in secrets)
                    visit(slot, name);
            }
        }
    }
}
