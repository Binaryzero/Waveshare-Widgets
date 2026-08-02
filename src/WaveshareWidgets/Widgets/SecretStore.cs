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
/// <summary>What the pipeline may do with the value at one address.</summary>
public enum SecretIntent
{
    /// <summary>A property the manifest declares `secret`: blanked for the editor,
    /// encrypted on its way to disk, decrypted for the dashboard.</summary>
    Protect,

    /// <summary>A refused widget's credential (#67, #104): masked and encrypted exactly
    /// like <see cref="Protect"/>, never decrypted into a payload.
    ///
    /// Encrypting matters as much as withholding. A refused widget's credential is
    /// typically legacy plaintext — the refusal is what noticed it — so an intent that
    /// only declined to reveal would leave it readable on disk forever. `P27e`/`P27f`
    /// pin that: after one save "it is now encrypted at rest, which the refusal alone
    /// never achieved."
    ///
    /// Withholding is safe because nothing legitimate is waiting for the value. Either
    /// the widget is not loaded at all, or — the duplicate-id case — the copy that
    /// loaded does not declare the property, so its own settings do not include it. The
    /// only reader the reveal would have created is a same-id widget receiving a
    /// credential the user typed for a different one.</summary>
    ProtectWithoutReveal,
}

/// <summary>Which values the secret pipeline acts on, and what it may do with each.
///
/// This replaces asking a manifest "is this property typed `secret`?" at every step. The
/// question the pipeline actually needs answered is per-VALUE and carries an intent —
/// three open issues are each a case a manifest cannot express: a credential inside a
/// list row (#62), a property demoted to `text` whose stored value is still ciphertext
/// and must be restored without acquiring write-side secret semantics (#66), and two
/// folders declaring the same widget id where one entry cannot represent both (#67).
/// Naming the value directly is what makes those tractable; see docs/SECRET-ADDRESSING.md
/// for the design and for why the per-slot key arrives with the identity protocol rather
/// than before it.
///
/// A plan is resolved ONCE per operation and caches per widget id, so a single Mask, Seal
/// or Reveal sees one consistent classification even if the library rescans underneath it.
/// Build one at the call site rather than holding it across operations.
///
/// THE QUESTION IS ASKED PER SLOT. Every answer today comes from the widget's manifest, so
/// siblings get identical intents and the distinction is invisible — which is precisely why
/// it has to be established before it matters. An intent built on the widget-level question
/// treats two instances of one widget as interchangeable, and they are not: one can hold a
/// credential while the other has already been retyped to ordinary text, one can be
/// addressable while the other is not. A PR that assumed otherwise was withdrawn (#148)
/// after review found four separate consequences, and the design has now recorded the same
/// ordering failure three times. The widget-level lookup is private so it cannot be the
/// shape anything is written against again.</summary>
public sealed class SecretPlan
{
    private static readonly IReadOnlyDictionary<string, SecretIntent> Nothing =
        new Dictionary<string, SecretIntent>(StringComparer.Ordinal);

    private readonly Func<string, IReadOnlyDictionary<string, SecretIntent>> _classify;
    private readonly Dictionary<string, IReadOnlyDictionary<string, SecretIntent>> _cache =
        new(StringComparer.Ordinal);

    private SecretPlan(Func<string, IReadOnlyDictionary<string, SecretIntent>> classify) =>
        _classify = classify;

    /// <summary>Whatever the manifest calls `secret` is protected, and nothing else is
    /// touched. For callers with no refusals to account for — the probes, and anything
    /// classifying a layout that never meets the library.</summary>
    public static SecretPlan FromManifests(Func<string, WidgetManifest?> lookup) =>
        new(id => Classify(lookup(id), null));

    /// <summary>The plan the two windows build: manifest secrets plus the credential
    /// names of every widget the library REFUSED under this id.
    ///
    /// A refusal is not a manifest and must not be turned into one. The names arrive
    /// straight from <c>RejectedWidget.RedactNames</c> as
    /// <see cref="SecretIntent.ProtectWithoutReveal"/>, which is the point of the intent:
    /// the host can say "this address holds a credential and nothing may read it back"
    /// without fabricating a widget that says so. Fabricating one is what PR #65 tried
    /// three ways, and every merge rule was wrong in some direction because a per-widget
    /// artifact cannot describe two widgets sharing an id.
    ///
    /// <paramref name="refusedCredentials"/> is keyed by widget id and may return null for
    /// ids with no refusal, which is the overwhelmingly common answer.</summary>
    public static SecretPlan FromManifests(
        Func<string, WidgetManifest?> lookup,
        Func<string, IReadOnlyList<string>?> refusedCredentials) =>
        new(id => Classify(lookup(id), refusedCredentials(id)));

    /// <summary>The intents that apply to THIS SLOT's properties, keyed by property name.
    /// </summary>
    /// <remarks>
    /// The question is per SLOT, not per widget id. Today every answer is derived from the
    /// widget's manifest, so a slot and its siblings get identical intents and this is a
    /// rename — deliberately, so the vehicle lands before anything rides on it and a probe
    /// failure in the next change is about the intent rather than the plumbing under it.
    /// </remarks>
    public IReadOnlyDictionary<string, SecretIntent> For(LayoutSlot? slot) =>
        ForWidget(slot?.WidgetId);

    /// <inheritdoc cref="For(LayoutSlot)"/>
    /// <remarks>The editor projection is JSON rather than the model. Same question, same
    /// answer; only the shape of the slot differs.</remarks>
    public IReadOnlyDictionary<string, SecretIntent> For(JsonNode? slotNode) =>
        ForWidget(slotNode?["widgetId"] is JsonValue v && v.TryGetValue<string>(out var id) ? id : null);

    /// <summary>Resolution by widget id — an IMPLEMENTATION DETAIL, deliberately private.
    /// </summary>
    /// <remarks>
    /// The compiler is a better guard than a probe here. A caller able to ask the
    /// widget-level question would keep getting a per-widget answer to a per-slot question,
    /// silently and correctly-looking, which is how two instances of one widget in different
    /// states came to be treated as interchangeable. Unreachable means the next intent cannot
    /// regress to that shape by accident.
    ///
    /// Ordinal, like every other identity comparison in this pipeline — `Rescan` resolves
    /// duplicate ids ordinally, so a consumer that disagreed would silently classify a
    /// different widget's properties.
    /// </remarks>
    private IReadOnlyDictionary<string, SecretIntent> ForWidget(string? widgetId)
    {
        if (string.IsNullOrEmpty(widgetId))
            return Nothing;
        if (!_cache.TryGetValue(widgetId, out var intents))
            _cache[widgetId] = intents = _classify(widgetId);
        return intents;
    }

    private static IReadOnlyDictionary<string, SecretIntent> Classify(
        WidgetManifest? manifest, IReadOnlyList<string>? refusedCredentials)
    {
        var intents = new Dictionary<string, SecretIntent>(StringComparer.Ordinal);
        foreach (var prop in manifest?.Properties ?? [])
        {
            if (!string.IsNullOrEmpty(prop.Name) &&
                string.Equals(prop.Type, "secret", StringComparison.OrdinalIgnoreCase))
                Merge(intents, prop.Name, SecretIntent.Protect);
        }
        // A refusal's names come SECOND but do not simply overwrite: `Merge` is what makes
        // the collision rule the documented one rather than an accident of ordering.
        foreach (var name in refusedCredentials ?? [])
        {
            if (!string.IsNullOrEmpty(name))
                Merge(intents, name, SecretIntent.ProtectWithoutReveal);
        }
        return intents;
    }

    /// <summary>Adds an intent for a name, resolving a collision the safe way. See
    /// <see cref="SecretIntents.MostProtective"/> for why the direction is not a
    /// preference.</summary>
    private static void Merge(
        Dictionary<string, SecretIntent> intents, string name, SecretIntent intent) =>
        intents[name] = intents.TryGetValue(name, out var existing)
            ? SecretIntents.MostProtective(existing, intent)
            : intent;
}

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
    /// <summary>Shorthand for "protect exactly what these manifests declare" — the plan
    /// every caller wanted before intents existed. Kept because it is genuinely the common
    /// case, not to spare callers the migration: anything needing a non-default intent
    /// builds its own <see cref="SecretPlan"/>.</summary>
    public static void Reveal(DashboardLayout layout, Func<string, WidgetManifest?> lookup) =>
        Reveal(layout, SecretPlan.FromManifests(lookup));

    /// <inheritdoc cref="Reveal(DashboardLayout, Func{string, WidgetManifest})"/>
    public static void Mask(JsonNode? layoutNode, Func<string, WidgetManifest?> lookup) =>
        Mask(layoutNode, SecretPlan.FromManifests(lookup));

    /// <inheritdoc cref="Reveal(DashboardLayout, Func{string, WidgetManifest})"/>
    public static SecretSealResult Seal(
        DashboardLayout layout, DashboardLayout? stored, Func<string, WidgetManifest?> lookup) =>
        Seal(layout, stored, SecretPlan.FromManifests(lookup));

    public static void Reveal(DashboardLayout layout, SecretPlan plan)
    {
        Walk(layout, plan, (slot, name, intent) =>
        {
            if (!SecretIntents.Protects(intent))
                return;
            var stored = AsString(slot.Settings?[name]);
            if (!SecretIntents.Reveals(intent))
            {
                Withhold(slot, name, stored);
                return;
            }
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

    /// <summary>The <see cref="SecretIntent.ProtectWithoutReveal"/> half of Reveal.
    ///
    /// Declining to DECRYPT is not enough, and that is the whole subtlety of #104. The
    /// credential a widget was refused over is normally legacy plaintext, so there is
    /// nothing to decline: skipping the address leaves the plaintext sitting in the
    /// payload, `shell.js` hands every one of a slot's settings to that slot's iframe
    /// including keys no manifest declares, and in the duplicate-id case the iframe is
    /// the same-id widget that loaded. So the value is actively blanked.
    ///
    /// Blanked, not removed, and only when we cannot prove we wrote it:
    ///
    /// <list type="bullet">
    /// <item>Ciphertext this machine produced is left alone. It is not a credential to
    ///   anything without the user's DPAPI key, and leaving it means the round-trip below
    ///   has nothing to depend on.</item>
    /// <item>Everything else is blanked — plaintext, junk, and a blob from another
    ///   machine. `CanUnprotect`, not `LooksLikeEnvelope`: `dpapi:v1:YWJj` is a string a
    ///   user can type, so shape does not answer "did WE write this?" and a credential
    ///   that happened to match the shape would be handed out.</item>
    /// </list>
    ///
    /// The blank round-trips safely because the shell posts this exact layout back through
    /// save-layout, and `Seal` restores the stored node for an address that came back
    /// empty — then encrypts it, since it was plaintext. That restore is why Seal MUST
    /// walk the same plan Reveal did; the two call sites in `DashboardWindow` build from
    /// one snapshot for exactly that reason. The narrow residue: if the slot's identity is
    /// ambiguous, Seal refuses the carry-over and the credential is lost rather than
    /// misdelivered — the posture this pipeline already takes everywhere, and the user
    /// retypes it into a widget they have to fix anyway.</summary>
    private static void Withhold(LayoutSlot slot, string name, string? stored)
    {
        if (slot.Settings?[name] is null || SecretStore.CanUnprotect(stored))
            return;
        slot.Settings[name] = "";
    }

    /// <summary>Blanks every secret and records which ones are set AND readable here.
    /// Mutates the JSON projection (not the model) because <c>secretsSet</c> is
    /// projection-only.</summary>
    public static void Mask(JsonNode? layoutNode, SecretPlan plan)
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
                var secrets = plan.For(slot);
                if (secrets.Count == 0)
                    continue;
                var set = new JsonArray();
                foreach (var (name, intent) in secrets)
                {
                    if (!SecretIntents.Protects(intent))
                        continue;
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
        DashboardLayout layout, DashboardLayout? stored, SecretPlan plan)
    {
        var incomingCounts = CountWidgets(layout);
        var previous = BuildStoredIndex(stored, plan, incomingCounts, out var storedCounts);
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

        Walk(layout, plan, (slot, name, intent) =>
        {
            if (!SecretIntents.Protects(intent))
                return;
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

        // Looks up what is stored for this slot. Identity only — there is deliberately NO
        // positional retry when the id-keyed lookup misses, and that is the whole content
        // of this comment, because two review rounds argued otherwise and both were right.
        //
        // The tempting case is real (#68). shell.js's persistLayout mints an instanceId for
        // any id-less slot on its first on-panel edit, so a legacy slot's next save arrives
        // id-BEARING while layout.json still holds the value id-LESS. The lookup misses and
        // an edit that had nothing to do with the credential deletes it.
        //
        // The reason a retry cannot fix it: the payload contains no evidence that would
        // separate that case from its dangerous twin. Open a legacy layout holding one
        // credentialed widget, delete it, add a fresh instance of the same widget, save.
        // Stored is id-less with a credential, incoming is id-bearing, both counts are one
        // — byte for byte the same situation. A retry that serves the first necessarily
        // hands the deleted instance's credential to a tile the user believes is
        // unconfigured, which then transmits an old token to whatever endpoint the new
        // tile points at. Losing a credential is recoverable by retyping it; sending one
        // somewhere new is not, so the ambiguity resolves against the retry.
        //
        // Closing #68 properly needs the client to say which slot it minted an id FOR,
        // which is the same host/client identity channel #70 needs. Until that exists,
        // a legacy slot loses its secret on first on-panel edit and the user re-enters it
        // — the answer SlotKey already gives wherever identity cannot be established.
        bool TryPrevious(string? key, LayoutSlot slot, string name, out JsonNode? found)
        {
            found = null;
            return key is not null && previous.TryGetValue((key, name), out found);
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
    private static Dictionary<(string Slot, string Name), JsonNode?> BuildStoredIndex(
        DashboardLayout? stored, SecretPlan plan,
        Dictionary<string, int> incomingCounts, out Dictionary<string, int> counts)
    {
        counts = CountWidgets(stored);
        var index = new Dictionary<(string, string), JsonNode?>();
        if (stored is null)
            return index;
        var storedCounts = counts;
        // Two stored slots resolving the same key means the layout has duplicate
        // instanceIds (shell.js detects and heals those, but the editor can save before
        // the repair lands). Silently keeping the last would hand BOTH colliding
        // incoming slots the same credential, so the key is poisoned instead: nobody
        // inherits, and the user re-enters — the same refusal ambiguous positions get.
        var poisoned = new HashSet<(string, string)>();
        var seen = new HashSet<(string, string)>();
        Walk(stored, plan, (slot, name, intent) =>
        {
            if (!SecretIntents.Protects(intent))
                return;
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
                    index.TryAdd((slot.WidgetId + "|w:0", name), storedNode.DeepClone());
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

    /// <summary>Visits every planned (slot, property) pair of a layout, with the intent
    /// that applies. The visitor runs once per planned property, whether or not the slot
    /// carries a value — an absent value is itself a case several branches handle.</summary>
    private static void Walk(DashboardLayout layout, SecretPlan plan,
        Action<LayoutSlot, string, SecretIntent> visit)
    {
        foreach (var page in layout.Pages ?? [])
        {
            foreach (var slot in page.Slots ?? [])
            {
                if (string.IsNullOrEmpty(slot.WidgetId))
                    continue;
                var planned = plan.For(slot);
                if (planned.Count == 0)
                    continue;
                slot.Settings ??= new JsonObject();
                foreach (var (name, intent) in planned)
                    visit(slot, name, intent);
            }
        }
    }
}
