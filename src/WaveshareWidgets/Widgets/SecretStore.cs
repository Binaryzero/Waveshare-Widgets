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

    /// <summary>Escape hatch so the sentinel above doesn't make one string unstoreable.
    /// Credentials are arbitrary text, and a token that happens to BE the clear marker
    /// would otherwise be read as "remove this" and silently discarded. Editors prefix
    /// any typed value starting with the reserved <c>__ww_secret_</c> namespace with
    /// this; the host strips exactly one prefix and treats the rest as plaintext.</summary>
    public const string LiteralPrefix = "__ww_secret_lit_";

    /// <summary>Cheap syntactic check: does this look like one of our envelopes? Only
    /// meaningful together with <see cref="CanUnprotect"/> — see the class remarks.</summary>
    public static bool HasMarker(string? value) =>
        value is not null && value.StartsWith(Marker, StringComparison.Ordinal);

    /// <summary>Marker AND a well-formed base64 payload — i.e. shaped like something we
    /// wrote, even if THIS user/machine cannot open it. Distinguishes a credential
    /// sealed elsewhere (drop it; re-encrypting would double-wrap a foreign ciphertext)
    /// from legacy plaintext that merely starts with the marker (encrypt it). Neither is
    /// certain from the bytes alone, but a token that begins with "dpapi:v1:" AND
    /// continues in valid base64 is vanishingly rare next to a real foreign blob.</summary>
    public static bool LooksLikeEnvelope(string? value)
    {
        if (!HasMarker(value))
            return false;
        var payload = value![Marker.Length..];
        return payload.Length > 0 && Convert.TryFromBase64String(payload, new byte[payload.Length], out _);
    }

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

/// <summary>An instanceId minted during a save, addressed by the position the CLIENT
/// used. The mint happens on the host's copy, so a still-open editor keeps an id-less
/// slot; handing the id back lets it adopt the identity before its next save.</summary>
/// <param name="Page">Page index in the layout the client submitted.</param>
/// <param name="Slot">Slot index within that page.</param>
/// <param name="WidgetId">Widget at that position, so the client can refuse a stale match.</param>
/// <param name="InstanceId">The freshly minted identity.</param>
public sealed record SecretSlotIdentity(int Page, int Slot, string WidgetId, string InstanceId);

/// <summary>What a save did beyond writing the file.</summary>
/// <param name="Failures">Secrets that could not be protected — the save is not clean.</param>
/// <param name="Minted">Instance ids stamped onto id-less slots during this save.</param>
public sealed record SecretSealResult(
    IReadOnlyList<SecretSealFailure> Failures, IReadOnlyList<SecretSlotIdentity> Minted);

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

    /// <summary>Decrypts every secret in place — for the dashboard's init payload only.
    ///
    /// KNOWN GAP (issue #66): a property retyped `secret` → `text` still holds ciphertext,
    /// and this walks only what the CURRENT manifest calls secret — so the widget receives
    /// the literal "dpapi:v1:…" string. Blanking it here looks like a two-line fix and is
    /// not: the shell round-trips this exact layout back through save-layout, so a blank
    /// written here reaches disk unless the save path is taught to restore it, and teaching
    /// it through the manifest classification also imposes secret WRITE semantics, which
    /// makes the demoted field permanently uneditable. The real fix needs per-address
    /// restore with slot identity — the same machinery #62 needs — and is tracked there
    /// rather than guessed at here. Leaving it alone at least self-heals: the user retypes
    /// the value and it saves as ordinary text, which is what the manifest now says.</summary>
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
            if (SecretStore.LooksLikeEnvelope(stored))
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
                    // EVERYTHING is redacted, including a non-string. A list or object
                    // under a `secret` name may hold nested credential material, so
                    // leaving it in the editor payload to avoid losing it was trading a
                    // disclosure for a deletion. BuildStoredIndex carries the raw node
                    // now, so Seal can put a non-string back and neither trade is needed.
                    var value = AsString(node);
                    // "Saved" must mean "usable": a blob from another machine/user
                    // decrypts to nothing, so reporting it as saved would hide the very
                    // thing the user has to do (re-enter it). Legacy plaintext counts as
                    // set — it is readable, and the next save encrypts it.
                    var usable = !string.IsNullOrEmpty(value) &&
                        (SecretStore.LooksLikeEnvelope(value) ? SecretStore.CanUnprotect(value) : true);
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
    /// <returns>The secrets whose protection FAILED (nothing plaintext was written for
    /// them, but the save is not what the user asked for — callers must say so instead of
    /// acknowledging a clean save), plus any instance ids minted here, which the caller
    /// must hand back to the client that submitted the layout.</returns>
    public static SecretSealResult Seal(
        DashboardLayout layout, DashboardLayout? stored, Func<string, WidgetManifest?> lookup)
    {
        var incomingCounts = CountWidgets(layout);
        var previous = BuildStoredIndex(
            stored, lookup, incomingCounts, out var storedCounts, out var aliased);
        var failures = new List<SecretSealFailure>();
        var minted = new List<SecretSlotIdentity>();
        // Position in the layout AS SUBMITTED, so the client can find the same slot.
        var address = new Dictionary<LayoutSlot, (int Page, int Slot)>(ReferenceEqualityComparer.Instance);
        for (var p = 0; p < (layout.Pages?.Count ?? 0); p++)
            for (var i = 0; i < (layout.Pages![p].Slots?.Count ?? 0); i++)
                address[layout.Pages[p].Slots![i]] = (p, i);
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
            // A typed credential that lives in the reserved namespace arrives escaped, so
            // it can never be mistaken for the clear marker. Unwrap exactly one prefix
            // and carry on: the value below is the user's real plaintext.
            if (value is not null && value.StartsWith(SecretStore.LiteralPrefix, StringComparison.Ordinal))
                value = value[SecretStore.LiteralPrefix.Length..];

            // Already a real envelope (idempotent re-save of a sealed layout).
            if (SecretStore.CanUnprotect(value))
                return;

            if (string.IsNullOrEmpty(value))
            {
                // Untouched masked field (or non-string junk): keep what is stored.
                if (!TryPrevious(key, slot, name, out var keptNode))
                {
                    slot.Settings!.Remove(name);
                    return;
                }
                // A stored NON-STRING is restored exactly as it was. It was redacted for
                // the editor like any other secret, so the blank coming back means
                // "untouched" — and none of the cipher branches below can express it.
                if (keptNode is not JsonValue keptValue || !keptValue.TryGetValue<string>(out var kept))
                {
                    slot.Settings![name] = keptNode?.DeepClone();
                    // Stamp for the same reason the string paths do: a slot that carries a
                    // value only this pipeline can restore must be addressable by id, not
                    // by position. Without it an id-less legacy slot stays id-less, the
                    // shell mints an id on its first on-panel edit, and the next Seal looks
                    // the value up under "|i:…" while it was indexed under "|w:0" — so the
                    // value Settings just preserved is removed one save later.
                    Stamp(slot);
                    return;
                }
                if (SecretStore.CanUnprotect(kept))
                {
                    slot.Settings![name] = kept;
                    Stamp(slot);
                    return;
                }
                if (SecretStore.LooksLikeEnvelope(kept))
                {
                    // An envelope this user/machine cannot open — a layout copied from
                    // another PC or another Windows account. Re-encrypting it would wrap
                    // the FOREIGN ciphertext in an envelope we can open, so Reveal would
                    // hand the widget that ciphertext as if it were the credential and
                    // the editor would go back to reporting it saved. Drop it: Mask
                    // already shows it as "not set", and the user re-enters it.
                    //
                    // Shape, not just the prefix: legacy plaintext that happens to start
                    // with "dpapi:v1:" is NOT base64 after the marker, so the documented
                    // `text` → `secret` migration still encrypts it below instead of
                    // deleting a perfectly good credential.
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
            // Keep whatever was stored — a sealed envelope OR legacy plaintext. Requiring
            // a decryptable envelope here would delete a still-working plaintext credential
            // just because its replacement could not be encrypted, which is the same loss
            // the migration branch above deliberately avoids.
            // Whatever was stored, of WHATEVER type. My first pass filtered this through
            // AsString, which rejected a stored list/object and sent it down the remove
            // path — destroying the old value because its string REPLACEMENT could not be
            // encrypted, in the one branch whose whole purpose is not to destroy anything.
            // BuildStoredIndex never indexes an empty string, so a hit here is always a
            // value worth keeping.
            if (TryPrevious(key, slot, name, out var priorNode) && priorNode is not null)
            {
                slot.Settings![name] = priorNode.DeepClone();
                // Stamp here too. This branch restores a value exactly as the untouched
                // paths do, so it leaves the slot in the same state and owes the same
                // identity — an id-less slot restored without one is deleted by the very
                // transition below on the next save. Missed once here and once on the
                // non-string restore, which is why every restore now stamps.
                Stamp(slot);
            }
            else
                slot.Settings!.Remove(name);
            failures.Add(new SecretSealFailure(slot.WidgetId, name));
        });

        return new SecretSealResult(failures, minted);

        // Looks up what is stored for this slot, tolerating the ONE-WAY transition from a
        // positional identity to a freshly minted one.
        //
        // BuildStoredIndex already covers stored-has-id -> incoming-has-none: the client
        // that triggered a previous save still holds the slot without the id the host
        // minted, so those are indexed both ways. The reverse cannot be pre-indexed,
        // because the id does not exist until the client mints it — and shell.js's
        // persistLayout mints one on the first on-panel edit of any legacy slot. Without
        // this retry the stored value is indexed under "|w:0", the incoming slot resolves
        // to "|i:p…", the lookup misses, and the credential is deleted by an edit that had
        // nothing to do with it.
        //
        // Gated by the SAME unambiguity test SlotKey applies: exactly one instance of this
        // widget on each side. With several, a positional retry would hand one instance
        // another's credential, which is the hazard SlotKey returns null to prevent.
        //
        // And gated on PROVENANCE, or it inherits from the wrong instance. "|w:0" holds
        // two different things: a genuinely id-less stored slot, and the ALIAS
        // BuildStoredIndex adds for an id-bearing one. Only the first is a slot whose
        // identity the client is about to invent. Delete the sole credentialed instance in
        // the editor, add a fresh one of the same widget, save: both counts are still one,
        // the new id misses, and retrying against the alias hands the deleted instance's
        // credential to a tile the user believes is unconfigured. Two different instance
        // ids are two different instances — that refuses, and the user re-enters.
        //
        // The same refusal costs a credential when shell.js re-mints an id to heal a
        // DUPLICATE: stored and incoming ids differ for what is really one instance. That
        // path round-trips the decrypted value and re-encrypts it, so nothing is lost in
        // practice, and where identity genuinely cannot be established this pipeline
        // already prefers re-entry over a guess.
        bool TryPrevious(string? key, LayoutSlot slot, string name, out JsonNode? found)
        {
            found = null;
            if (key is not null && previous.TryGetValue((key, name), out found))
                return true;
            if (string.IsNullOrEmpty(slot.InstanceId) || string.IsNullOrEmpty(slot.WidgetId))
                return false;
            storedCounts.TryGetValue(slot.WidgetId, out var before);
            incomingCounts.TryGetValue(slot.WidgetId, out var after);
            if (before != 1 || after != 1)
                return false;
            var positional = (slot.WidgetId + "|w:0", name);
            if (aliased.Contains(positional))
                return false;
            return previous.TryGetValue(positional, out found);
        }

        // A slot that stores a credential gets a stable identity, so the next save
        // matches it by id instead of by its position on the page.
        void Stamp(LayoutSlot slot)
        {
            if (!string.IsNullOrEmpty(slot.InstanceId))
                return;
            slot.InstanceId = "s" + Guid.NewGuid().ToString("n")[..12];
            if (address.TryGetValue(slot, out var at))
                minted.Add(new SecretSlotIdentity(at.Page, at.Slot, slot.WidgetId, slot.InstanceId));
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
    /// The index carries the raw NODE, not a string. A layout can hold a list, object or
    /// number under a name the manifest calls `secret` — legacy data, a hand edit, or a
    /// property whose meaning changed — and Mask must still redact it (it may contain
    /// nested credential material) while Seal must still put it back. Indexing only
    /// strings made those two requirements incompatible: whichever one was honoured, the
    /// other broke. Storing the node satisfies both.
    /// <param name="aliased">The "|w:0" keys that are an ALIAS for an id-bearing stored
    /// slot rather than a genuinely id-less one. A caller matching by position needs to
    /// tell the two apart: an alias belongs to an instance that already has an identity,
    /// so a slot arriving with a DIFFERENT one is a different instance.</param>
    private static Dictionary<(string Slot, string Name), JsonNode?> BuildStoredIndex(
        DashboardLayout? stored, Func<string, WidgetManifest?> lookup,
        Dictionary<string, int> incomingCounts, out Dictionary<string, int> counts,
        out HashSet<(string Slot, string Name)> aliased)
    {
        counts = CountWidgets(stored);
        var index = new Dictionary<(string, string), JsonNode?>();
        aliased = new HashSet<(string, string)>();
        if (stored is null)
            return index;
        var aliasedKeys = aliased;
        var storedCounts = counts;
        // Two stored slots resolving the same key means the layout has duplicate
        // instanceIds (shell.js detects and heals those, but the editor can save before
        // the repair lands). Silently keeping the last would hand BOTH colliding
        // incoming slots the same credential, so the key is poisoned instead: nobody
        // inherits, and the user re-enters — the same refusal ambiguous positions get.
        var poisoned = new HashSet<(string, string)>();
        var seen = new HashSet<(string, string)>();
        Walk(stored, lookup, (slot, name) =>
        {
            var key = SlotKey(slot, storedCounts, incomingCounts);
            // Register the identity BEFORE the value check: a colliding slot whose secret
            // is unset still proves the key is ambiguous. Returning early would leave the
            // twin's credential in the index for BOTH slots to inherit.
            if (key is not null && !seen.Add((key, name)))
                poisoned.Add((key, name));
            var storedNode = slot.Settings?[name];
            // A genuinely empty string is "unset" and carries nothing. Anything else —
            // including a non-string — is a value worth being able to restore.
            if (storedNode is null || (AsString(storedNode) is { Length: 0 }))
                return;
            if (key is not null)
            {
                if (!index.TryAdd((key, name), storedNode.DeepClone()))
                    poisoned.Add((key, name));
            }
            // A slot whose id was minted by a PREVIOUS Seal is also reachable
            // positionally, because the client that triggered that save still holds the
            // slot WITHOUT an id — the mint happened on the host's own copy. Its next
            // save would otherwise look like a slot with no stored secret, and the
            // masked empty value would delete the credential. Same unambiguity gate as
            // any positional match, so at most one incoming slot can claim it.
            if (!string.IsNullOrEmpty(slot.InstanceId))
            {
                storedCounts.TryGetValue(slot.WidgetId, out var before);
                incomingCounts.TryGetValue(slot.WidgetId, out var after);
                if (before == 1 && after == 1)
                {
                    // Recorded as an alias whether or not the add wins: either way this
                    // position is spoken for by a slot that already has an identity.
                    index.TryAdd((slot.WidgetId + "|w:0", name), storedNode.DeepClone());
                    aliasedKeys.Add((slot.WidgetId + "|w:0", name));
                }
            }
        });
        foreach (var key in poisoned)
            index.Remove(key);
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
