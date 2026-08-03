using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace WaveshareWidgets.Widgets;

/// <summary>
/// A protected store for credentials a widget DERIVES at runtime (issue #175).
///
/// <para>The gap this closes: a widget's long-lived credential is protected and the
/// short-lived one it buys with it was not. A <c>secret</c> property is DPAPI-sealed at
/// rest (#15) so that reading the WebView profile off disk yields nothing usable — but an
/// OAuth widget exchanges that secret for a bearer token, and the only persistence a
/// widget had was <c>localStorage</c>, a plaintext file in that same profile. Writing the
/// bearer there hands back exactly what DPAPI withholds: a working credential, valid for
/// as long as the server says, obtainable without decrypting anything. Every OAuth widget
/// so far has had to keep its token MEMORY-ONLY and re-authenticate on every app start,
/// which is a workaround for a missing capability rather than a design.</para>
///
/// <para>SCOPED PER WIDGET ID, deliberately — the same boundary a widget's virtual host
/// already draws (<see cref="WidgetLibrary"/>), so this store is exactly as shareable as
/// the <c>localStorage</c> it replaces: two instances of one widget see the same entries,
/// two different widgets never see each other's. The id is supplied by the SHELL from the
/// slot that sent the message, never by the message itself; a widget naming its own scope
/// would be no scope at all.</para>
///
/// <para>SEALED WITH THE SAME ENVELOPE as <c>secret</c> properties, via
/// <see cref="SecretStore"/>, so there is one protection story rather than two — and so
/// the cipher seam that lets a CI probe exercise seal→reveal without DPAPI covers this
/// too. When sealing is unavailable a write FAILS and stores nothing; there is no
/// plaintext fallback, because a store that silently degrades to plaintext is worse than
/// no store at all — the widget believes it is protected and the caller cannot tell.</para>
/// </summary>
public static class WidgetSecrets
{
    /// <summary>Largest single value, UTF-8 bytes. A JWT with a fat claim set runs 1–2 KiB,
    /// so this is roomy for what the store is for while keeping the file bounded — and it
    /// is a CAP rather than a guess about the future: a widget storing more than this is
    /// using it for something other than a credential.</summary>
    public const int MaxValueBytes = 8 * 1024;

    /// <summary>Keys one widget may hold. Bounded because the file is read whole, and
    /// because a widget with more than a handful of derived credentials is not the case
    /// this exists for.</summary>
    public const int MaxKeysPerWidget = 16;

    /// <summary>Longest key. Keys are JSON member names, not paths.</summary>
    public const int MaxKeyLength = 64;

    /// <summary>What a write did. Distinguished rather than collapsed into a bool because
    /// the widget's fallback differs per case: <c>Unavailable</c> means keep it in memory
    /// and carry on, while <c>TooLarge</c> or <c>BadKey</c> is the widget's own bug and
    /// retrying will not help.</summary>
    public enum WriteResult
    {
        Ok,
        BadKey,
        BadScope,
        TooLarge,
        TooManyKeys,
        /// <summary>Sealing is not available on this machine, so nothing was written.
        /// NEVER a plaintext fallback — see the class remarks.</summary>
        Unavailable,
    }

    /// <summary>The name a refusal travels under, as the widget sees it in
    /// <c>ww-secure-result.error</c>.
    ///
    /// <para>Spelled out rather than derived from the member name, because
    /// <c>ToString().ToLowerInvariant()</c> yields <c>toolarge</c> while the documented
    /// contract is <c>too-large</c> — and, more to the point, because a member RENAME
    /// would then silently change a wire protocol widgets branch on. This is the whole
    /// vocabulary; the probe asserts it stays that and that no member is missing from it.
    /// </para>
    ///
    /// <para><see cref="WriteResult.Ok"/> maps to the empty string: success carries no
    /// error and the reply omits the member entirely.</para>
    /// </summary>
    public static string WireName(WriteResult result) => result switch
    {
        WriteResult.Ok => "",
        WriteResult.BadKey => "bad-key",
        WriteResult.BadScope => "bad-scope",
        WriteResult.TooLarge => "too-large",
        WriteResult.TooManyKeys => "too-many-keys",
        WriteResult.Unavailable => "unavailable",
        // Total on purpose: a member added without a name here reads as "" and the
        // probe's exhaustiveness check fails, rather than this throwing on the one
        // machine where the new case happens to come up.
        _ => "",
    };

    /// <summary>A key a widget may use: letters, digits, dot, dash, underscore, bounded.
    ///
    /// Keys are object members in a JSON file and never touch the filesystem, so this is
    /// not a traversal guard — it is a bounded, boring alphabet so that no later change
    /// (a key becoming a filename, a key reaching a log) has to re-ask the question. The
    /// same reasoning the Stream Deck UUID rule records: the cheap restriction removes
    /// the failure mode instead of testing for it.</summary>
    public static bool IsValidKey(string? key)
    {
        if (string.IsNullOrEmpty(key) || key.Length > MaxKeyLength) return false;
        foreach (var c in key)
        {
            var ok = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')
                || c == '.' || c == '-' || c == '_';
            if (!ok) return false;
        }
        return true;
    }

    /// <summary>A scope the store will accept. Same alphabet as a key plus the reverse-DNS
    /// dots widget ids use. Blank is refused outright: an unidentified caller would share
    /// one bucket with every other unidentified caller, which is the opposite of scoping.
    /// </summary>
    public static bool IsValidScope(string? widgetId) => IsValidKey(widgetId);

    /// <summary>Is protection actually working here? Answered by sealing and unsealing a
    /// probe value rather than by testing the platform, because "DPAPI exists" and "this
    /// process can use it" are different questions and only the second one matters.
    /// </summary>
    public static bool Available()
    {
        try
        {
            if (!SecretStore.TryProtect("ww-secure-probe", out var sealed_)) return false;
            return SecretStore.Unprotect(sealed_) == "ww-secure-probe";
        }
        catch (Exception)
        {
            return false;
        }
    }

    // ---- the document ---------------------------------------------------------------
    // { "version": 1, "widgets": { "<widgetId>": { "<key>": "dpapi:v1:..." } } }

    private const string WidgetsMember = "widgets";

    /// <summary>Parse, tolerating anything. A store that throws on a damaged file takes
    /// the widget's credentials with it and gives the field no way back; an unreadable
    /// document is treated as an empty one, which loses the stored values and nothing
    /// else — the widget re-authenticates, which is exactly what it did before this
    /// existed.</summary>
    public static JsonObject Load(string? json)
    {
        try
        {
            if (!string.IsNullOrWhiteSpace(json) && JsonNode.Parse(json) is JsonObject root
                && root[WidgetsMember] is JsonObject)
                return root;
        }
        catch (JsonException)
        {
            // fall through to a fresh document
        }
        return new JsonObject { ["version"] = 1, [WidgetsMember] = new JsonObject() };
    }

    public static string Serialize(JsonObject doc) =>
        doc.ToJsonString(new JsonSerializerOptions { WriteIndented = true });

    /// <summary>The plaintext a widget stored, or null for absent, out-of-scope, or an
    /// envelope this user/machine cannot open — which is the same answer as far as the
    /// caller is concerned, because in all three cases it has to go and get a new one.
    /// </summary>
    public static string? Get(JsonObject doc, string? widgetId, string? key)
    {
        if (!IsValidScope(widgetId) || !IsValidKey(key)) return null;
        if (doc[WidgetsMember] is not JsonObject widgets) return null;
        if (widgets[widgetId!] is not JsonObject bucket) return null;
        if (bucket[key!] is not JsonValue value) return null;
        var stored = value.GetValue<string?>();
        if (string.IsNullOrEmpty(stored)) return null;
        try { return SecretStore.Unprotect(stored); }
        catch (Exception) { return null; }
    }

    /// <summary>Seal a value into the document. Returns what happened and mutates
    /// <paramref name="doc"/> only on success — a refused write must not leave a
    /// half-changed document behind for the caller to persist.</summary>
    public static WriteResult Set(JsonObject doc, string? widgetId, string? key, string? value)
    {
        if (!IsValidScope(widgetId)) return WriteResult.BadScope;
        if (!IsValidKey(key)) return WriteResult.BadKey;
        var plain = value ?? "";
        if (Encoding.UTF8.GetByteCount(plain) > MaxValueBytes) return WriteResult.TooLarge;
        if (doc[WidgetsMember] is not JsonObject widgets)
        {
            widgets = new JsonObject();
            doc[WidgetsMember] = widgets;
        }
        var bucket = widgets[widgetId!] as JsonObject;
        // The cap counts keys that would EXIST after the write, so overwriting one of the
        // existing keys is always allowed. Counting before the distinction is what would
        // make a widget at the limit unable to refresh the very token it already holds.
        if (bucket is not null && bucket[key!] is null && bucket.Count >= MaxKeysPerWidget)
            return WriteResult.TooManyKeys;
        if (!TrySeal(plain, out var stored)) return WriteResult.Unavailable;
        if (bucket is null)
        {
            bucket = new JsonObject();
            widgets[widgetId!] = bucket;
        }
        bucket[key!] = stored;
        return WriteResult.Ok;
    }

    /// <summary>Remove one key. Removing the last key removes the widget's bucket too, so
    /// an uninstalled widget does not leave an empty shell behind in the file.</summary>
    public static bool Delete(JsonObject doc, string? widgetId, string? key)
    {
        if (!IsValidScope(widgetId) || !IsValidKey(key)) return false;
        if (doc[WidgetsMember] is not JsonObject widgets) return false;
        if (widgets[widgetId!] is not JsonObject bucket) return false;
        if (!bucket.Remove(key!)) return false;
        if (bucket.Count == 0) widgets.Remove(widgetId!);
        return true;
    }

    /// <summary>Drop everything a widget stored. For uninstall: a package that is gone
    /// should not leave working credentials on disk, and the id is reusable by whatever
    /// is installed next.</summary>
    public static bool Forget(JsonObject doc, string? widgetId)
    {
        if (!IsValidScope(widgetId)) return false;
        if (doc[WidgetsMember] is not JsonObject widgets) return false;
        return widgets.Remove(widgetId!);
    }

    private static bool TrySeal(string plain, out string stored)
    {
        try { return SecretStore.TryProtect(plain, out stored); }
        catch (Exception)
        {
            stored = "";
            return false;
        }
    }
}
