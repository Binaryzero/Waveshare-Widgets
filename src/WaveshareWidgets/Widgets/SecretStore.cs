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
/// The ciphertext is stored as "<c>dpapi:v1:BASE64</c>". The marker is what makes the
/// pipeline idempotent: sealing skips already-protected values, and a value that never
/// got protected (older layout, DPAPI unavailable) is still recognizable as plaintext
/// instead of being double-encrypted or decrypted into garbage.
/// </summary>
public static class SecretStore
{
    private const string Marker = "dpapi:v1:";

    /// <summary>Placeholder the settings editor and its preview see instead of a stored
    /// secret. Plaintext never travels to the editor at all; the editor learns only that
    /// a value EXISTS (per-slot <c>secretsSet</c>) so it can show a "saved" state.</summary>
    public const string EditorPlaceholder = "";

    public static bool IsProtected(string? value) =>
        value is not null && value.StartsWith(Marker, StringComparison.Ordinal);

    /// <summary>Cipher seam. DPAPI exists only on Windows, so the CI probe
    /// (tools/SecretRoundTrip, which compiles this file) substitutes a reversible stand-in
    /// to exercise the seal→reveal contract, and clears it to exercise the
    /// no-DPAPI fail-safe. Never assigned in the shipping app.</summary>
    internal static Func<byte[], byte[]>? EncryptOverride;
    internal static Func<byte[], byte[]>? DecryptOverride;

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
    public static string? Unprotect(string stored)
    {
        if (!IsProtected(stored))
            return null;
        try
        {
            var bytes = Convert.FromBase64String(stored[Marker.Length..]);
            return Encoding.UTF8.GetString(Decrypt(bytes));
        }
        catch (Exception ex)
        {
            Log.Warn($"Could not read a protected secret (wrong user/machine, or corrupt): {ex.Message}");
            return null;
        }
    }
}

/// <summary>
/// Applies <see cref="SecretStore"/> across a whole layout, using each widget's manifest
/// to decide which settings are secrets. Three directions, one per consumer:
///
///   <list type="bullet">
///   <item>Reveal — decrypt for the dashboard, whose widget iframes need real values.</item>
///   <item>Mask — blank for the settings editor (plus a <c>secretsSet</c> hint), so the
///     editor surface never holds a credential.</item>
///   <item>Seal — encrypt on the way to disk, restoring the stored ciphertext for any
///     masked value the editor sent back untouched.</item>
///   </list>
/// </summary>
public static class SecretPolicy
{
    /// <summary>Transient projection key listing the secret property names that have a
    /// stored value. <see cref="LayoutSlot"/> deliberately has no matching member, so it
    /// is dropped on deserialize and can never reach layout.json.</summary>
    public const string SetMarkerKey = "secretsSet";

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
        Walk(layout, lookup, (slot, name, secrets) =>
        {
            if (slot.Settings?[name]?.GetValue<string>() is { } stored && SecretStore.IsProtected(stored))
                slot.Settings[name] = SecretStore.Unprotect(stored) ?? "";
        });
    }

    /// <summary>Blanks every secret and records which ones were set. Mutates the JSON
    /// projection (not the model) because <c>secretsSet</c> is projection-only.</summary>
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
                var widgetId = slot?["widgetId"]?.GetValue<string>();
                if (widgetId is null || slot is null)
                    continue;
                var secrets = SecretNames(lookup(widgetId));
                if (secrets.Count == 0)
                    continue;
                var set = new JsonArray();
                foreach (var name in secrets)
                {
                    var value = slot["settings"]?[name];
                    if (value is null)
                        continue;
                    if (!string.IsNullOrEmpty(value.GetValue<string>()))
                        set.Add(name);
                    slot["settings"]![name] = SecretStore.EditorPlaceholder;
                }
                if (set.Count > 0)
                    slot[SetMarkerKey] = set;
            }
        }
    }

    /// <summary>
    /// Encrypts secrets on their way to disk. An incoming value that is empty (the
    /// editor's masked placeholder, sent back untouched) keeps whatever
    /// <paramref name="stored"/> holds for the same slot — so saving from the editor
    /// never wipes a credential the user didn't retype. A non-empty plaintext value is
    /// encrypted; an already-protected value passes through untouched (the dashboard
    /// round-trips its own decrypted layout, and re-protecting is harmless but pointless).
    /// </summary>
    public static void Seal(DashboardLayout layout, DashboardLayout? stored, Func<string, WidgetManifest?> lookup)
    {
        var previous = BuildStoredIndex(stored, lookup);
        var counters = new Dictionary<string, int>(StringComparer.Ordinal);
        Walk(layout, lookup, (slot, name, secrets) =>
        {
            // Slots are keyed for carry-over by instanceId when present, else by
            // widgetId + ordinal — the same identity rule the shell uses, so an
            // un-edited layout still finds its own previous secrets.
            var key = SlotKey(slot, counters);
            var incoming = slot.Settings?[name];
            var value = incoming?.GetValue<string>();

            if (SecretStore.IsProtected(value))
                return; // already sealed
            if (string.IsNullOrEmpty(value))
            {
                // Blank: restore the stored ciphertext, or drop the key entirely so the
                // widget sees an unset secret instead of an empty-string credential.
                if (previous.TryGetValue((key, name), out var kept))
                    slot.Settings![name] = kept;
                else if (incoming is not null)
                    slot.Settings!.Remove(name);
                return;
            }
            if (SecretStore.TryProtect(value!, out var sealed_))
                slot.Settings![name] = sealed_;
            else if (previous.TryGetValue((key, name), out var kept))
                slot.Settings![name] = kept; // encryption unavailable: never persist plaintext
            else
                slot.Settings!.Remove(name);
        });
    }

    private static Dictionary<(string Slot, string Name), string> BuildStoredIndex(
        DashboardLayout? stored, Func<string, WidgetManifest?> lookup)
    {
        var index = new Dictionary<(string, string), string>();
        if (stored is null)
            return index;
        var counters = new Dictionary<string, int>(StringComparer.Ordinal);
        Walk(stored, lookup, (slot, name, secrets) =>
        {
            var key = SlotKey(slot, counters);
            if (slot.Settings?[name]?.GetValue<string>() is { } value && SecretStore.IsProtected(value))
                index[(key, name)] = value;
        });
        return index;
    }

    private static string SlotKey(LayoutSlot slot, Dictionary<string, int> counters)
    {
        if (!string.IsNullOrEmpty(slot.InstanceId))
            return "i:" + slot.InstanceId;
        counters.TryGetValue(slot.WidgetId, out var n);
        counters[slot.WidgetId] = n + 1;
        return "w:" + slot.WidgetId + "#" + n;
    }

    /// <summary>Visits every (slot, secret-property-name) pair of a layout. The visitor
    /// runs once per declared secret, whether or not the slot carries a value.</summary>
    private static void Walk(DashboardLayout layout, Func<string, WidgetManifest?> lookup,
        Action<LayoutSlot, string, HashSet<string>> visit)
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
                    visit(slot, name, secrets);
            }
        }
    }
}
