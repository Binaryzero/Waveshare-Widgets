using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;

namespace Plinth.Widgets;

public sealed class DashboardLayout
{
    [JsonPropertyName("pages")] public List<LayoutPage> Pages { get; set; } = [];

    /// <summary>Dashboard-wide default background, shown on pages that don't override it.</summary>
    [JsonPropertyName("background")] public BackgroundSpec? Background { get; set; }

    /// <summary>Global theme seeds; null means the stock dark look.</summary>
    [JsonPropertyName("theme")] public ThemeSpec? Theme { get; set; }

    /// <summary>Retained "attic" (#226): verbatim deep-copies of slots removed in the settings
    /// window, kept so a later change can restore them. Bounded
    /// (<see cref="LayoutStore.MaxRetainedPerWidget"/> per widget id, oldest evicted
    /// host-side on save). Nullable with NO initializer so a layout that never retired
    /// anything round-trips byte-identically (the serializer omits null members).
    /// Populated by settings.js removeSlotAt; unioned with disk and capped host-side in the
    /// settings window's save handler.</summary>
    [JsonPropertyName("retained")] public List<RetainedSlot>? Retained { get; set; }
}

/// <summary>
/// The three colors a user picks plus a panel-opacity level; everything else in the
/// design-token palette is derived from these by <c>PaletteEngine</c>.
/// </summary>
public sealed class ThemeSpec
{
    [JsonPropertyName("accent")] public string? Accent { get; set; }
    [JsonPropertyName("background")] public string? Background { get; set; }
    [JsonPropertyName("text")] public string? Text { get; set; }

    /// <summary>Widget panel opacity, 0.15–1.0. A tile at the default `theme` background
    /// (and the older `glass`) renders at this level; solid forces 1; transparent forces 0.</summary>
    [JsonPropertyName("panelAlpha")] public double PanelAlpha { get; set; } = 0.92;
}

public sealed class LayoutPage
{
    [JsonPropertyName("name")] public string Name { get; set; } = "";
    [JsonPropertyName("slots")] public List<LayoutSlot> Slots { get; set; } = [];

    /// <summary>Optional per-page background; when null the dashboard default applies.</summary>
    [JsonPropertyName("background")] public BackgroundSpec? Background { get; set; }
}

/// <summary>
/// A dashboard/page background layer (iCUE-style wallpaper). Static (color, gradient,
/// image) or animated (video, or an animated GIF/WebP via the image type). Image/video
/// files live in <see cref="AppPaths.BackgroundsDir"/> and are referenced by file name.
/// </summary>
public sealed class BackgroundSpec
{
    /// <summary>"none" | "color" | "gradient" | "image" | "video".</summary>
    [JsonPropertyName("type")] public string Type { get; set; } = "none";

    /// <summary>Solid fill, or the first stop of a gradient. Hex like "#101418".</summary>
    [JsonPropertyName("color")] public string? Color { get; set; }

    /// <summary>Second gradient stop (gradient type only).</summary>
    [JsonPropertyName("color2")] public string? Color2 { get; set; }

    /// <summary>Gradient angle in degrees (gradient type only).</summary>
    [JsonPropertyName("angle")] public int Angle { get; set; } = 135;

    /// <summary>File name (in BackgroundsDir) for image/video types.</summary>
    [JsonPropertyName("source")] public string? Source { get; set; }

    /// <summary>"cover" | "contain" | "stretch" | "tile" | "center" (image/video types).</summary>
    [JsonPropertyName("fit")] public string Fit { get; set; } = "cover";

    /// <summary>Darkening overlay over the wallpaper, 0–100 %, for widget readability.</summary>
    [JsonPropertyName("dim")] public int Dim { get; set; }

    /// <summary>Gaussian blur applied to the wallpaper, 0–40 px.</summary>
    [JsonPropertyName("blur")] public int Blur { get; set; }
}

/// <summary>Per-instance theme-seed overrides (a partial <see cref="ThemeSpec"/>:
/// null keys follow the dashboard theme).</summary>
public sealed class SlotStyle
{
    [JsonPropertyName("accent")] public string? Accent { get; set; }
    [JsonPropertyName("background")] public string? Background { get; set; }
    [JsonPropertyName("text")] public string? Text { get; set; }
    [JsonPropertyName("panelAlpha")] public double? PanelAlpha { get; set; }
}

public sealed class LayoutSlot
{
    [JsonPropertyName("widgetId")] public string WidgetId { get; set; } = "";

    /// <summary>Immutable per-instance identity backing widget-local storage keys and the
    /// per-instance credential scope (the iCUE `uniqueId`).
    ///
    /// <para>ALWAYS present on a layout this process has read: <see cref="Load"/> stamps
    /// any slot that lacks one, adopting the positional tag the instance is already running
    /// under so stored widget state survives the freeze (#289), and gives a slot that
    /// repeats an earlier slot's id one of its own. It was previously null on layouts never
    /// edited, and identity then fell back to grid position — the
    /// last way a credential could be addressed positionally, which #68 forbids and which
    /// this field's guarantee is what removed.</para>
    ///
    /// <para>Nullable in the model only because the JSON on disk may predate that pass, and
    /// because a client is free to post a slot without one. Neither survives contact with
    /// Load; nothing downstream should reintroduce a positional fallback for the case.</para></summary>
    [JsonPropertyName("instanceId")] public string? InstanceId { get; set; }

    /// <summary>Hide this widget while a fullscreen game is in the foreground —
    /// its grid cell is preserved, so it returns exactly where it was.</summary>

    /// <summary>Per-instance theme-seed overrides from the settings window's Appearance section.
    /// Non-null keys replace the dashboard theme's seeds for this widget only; the
    /// full palette is re-derived from the merged seeds (contrast repair included).</summary>
    [JsonPropertyName("style")] public SlotStyle? Style { get; set; }

    /// <summary>Width: quarter (320px), half (640px), three-quarter (960px) or full
    /// (1280px) — optionally suffixed "-upper"/"-lower" for the top or bottom 200px
    /// band instead of the full 400px height (e.g. "half-upper").</summary>
    [JsonPropertyName("size")] public string Size { get; set; } = "quarter";

    /// <summary>Column anchor (1–4) set when the widget was drag-dropped onto a free
    /// cell: it renders AT that column instead of flowing left with first-fit. Null =
    /// flow placement (every layout before anchors existed). An anchor that no longer
    /// fits falls back to flow in the shell rather than hiding the widget.</summary>
    [JsonPropertyName("col")] public int? Col { get; set; }

    /// <summary>Per-instance overrides of the widget's declared property defaults.</summary>
    [JsonPropertyName("settings")] public JsonObject? Settings { get; set; }
}

/// <summary>One retired slot in the attic (#226). <c>Def</c> is a verbatim deep-copy of
/// the removed <see cref="LayoutSlot"/> (id-bearing: <see cref="LayoutStore.Load"/> stamps
/// every stored slot, and the settings editor stamps any it added before retiring it), so
/// every SecretStore function operates on it unchanged and a later restore can deep-copy it
/// back into a page. Addressed ONLY by identity (<c>widgetId|i:instanceId</c>, the same
/// form SlotKey derives for an id-bearing live slot) — never by grid position (#68).</summary>
public sealed class RetainedSlot
{
    [JsonPropertyName("def")] public LayoutSlot Def { get; set; } = new();

    /// <summary>ISO-8601 UTC, editor-minted. A string rather than DateTimeOffset so a
    /// malformed value cannot throw on Load and cost the whole file (Load's catch
    /// regenerates the default layout). Sorts lexically == chronologically for
    /// evict-oldest absent clock skew; a backward clock set can mis-order — which is a
    /// mis-ordered eviction of tiles that are not live, never a loss of a live one.
    /// </summary>
    [JsonPropertyName("retiredAt")] public string? RetiredAt { get; set; }

    /// <summary>The page NAME the slot was removed from. Advisory, for a later restore's
    /// "put it back where it was" default — names can be renamed or deleted, so restore
    /// treats a miss as "any page".</summary>
    [JsonPropertyName("originPage")] public string? OriginPage { get; set; }
}

/// <summary>Loads/saves layout.json and creates the first-run default layout.</summary>
public static class LayoutStore
{
    /// <summary>Retained tiles kept per widget id before the oldest is evicted (#226).
    /// A bound rather than a guess: the attic exists so a removed credentialed tile can
    /// come back, not as an unbounded archive of every layout ever tried.</summary>
    public const int MaxRetainedPerWidget = 8;

    /// <summary>Non-destructive attic reconcile, run host-side on every save: keep every
    /// on-disk retained entry the incoming payload omits, EXCEPT one whose identity is
    /// live in the incoming pages (last-writer-wins on a genuine live/retired conflict,
    /// and never seats one instanceId in both pages and retained — the twin state the
    /// stored-index poison would otherwise punish). This is what stops a stale save from
    /// a second window silently shrinking the on-disk attic and skipping the
    /// destroy-on-evict path.</summary>
    public static void MergeRetainedFromDisk(DashboardLayout edited, DashboardLayout? disk)
    {
        // Before anything else, and before the early return below: a Delete that emptied
        // the attic leaves disk.Retained empty, and this method would then never look at
        // the incoming list at all.
        DropDestroyed(edited);
        if (disk?.Retained is null || disk.Retained.Count == 0) return;
        var live = new HashSet<string>(StringComparer.Ordinal);
        foreach (var p in edited.Pages ?? [])
            foreach (var s in p.Slots ?? [])
                if (Key(s) is { } k) live.Add(k);
        edited.Retained ??= [];
        var have = new HashSet<string>(StringComparer.Ordinal);
        foreach (var r in edited.Retained)
            if (Key(r?.Def) is { } k) have.Add(k);
        foreach (var d in disk.Retained)
        {
            if (d is null || Key(d.Def) is not { } k || have.Contains(k) || live.Contains(k)) continue;
            edited.Retained.Add(d);
            have.Add(k);
        }
    }

    /// <summary>The payload key the settings editor names its Deletes under (#226): a
    /// top-level list of <c>{ widgetId, instanceId }</c>. Read off the raw node like the
    /// secret markers; <see cref="DashboardLayout"/> has no member for it, so it never
    /// reaches layout.json.</summary>
    public const string RetainedDeletedKey = "retainedDeleted";

    /// <summary>At most this many Deletes in one payload. Far above any real attic
    /// (<see cref="MaxRetainedPerWidget"/> per widget), and a bound on what a malformed
    /// payload can make a save walk.</summary>
    public const int MaxRetainedDeletes = 512;

    /// <summary>The identities the settings editor deleted from its removed-widgets list
    /// since its last save (#226). Entries that are not an object with two non-empty
    /// strings are skipped rather than failing the save. More than
    /// <see cref="MaxRetainedDeletes"/> distinct ones throws, failing the save before
    /// anything is destroyed or written: reading only the first few would have the merge
    /// put the rest back while the editor, told the save worked, forgot them.</summary>
    public static IReadOnlyList<(string WidgetId, string InstanceId)> ReadRetainedDeletes(JsonNode? layoutNode)
    {
        var result = new List<(string, string)>();
        if (layoutNode?[RetainedDeletedKey] is not JsonArray list) return result;
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var item in list)
        {
            if (item is not JsonObject o) continue;
            var w = o["widgetId"] is JsonValue wv && wv.TryGetValue<string>(out var ws) ? ws : null;
            var i = o["instanceId"] is JsonValue iv && iv.TryGetValue<string>(out var id) ? id : null;
            if (string.IsNullOrEmpty(w) || string.IsNullOrEmpty(i) || !seen.Add(w + "|i:" + i)) continue;
            if (result.Count >= MaxRetainedDeletes)
                throw new InvalidDataException(
                    $"More than {MaxRetainedDeletes} removed widgets were deleted in one save, so nothing was saved. Reload, and delete them in smaller batches.");
            result.Add((w, i));
        }
        return result;
    }

    /// <summary>Applies the settings editor's Deletes to a save (#226), AFTER
    /// <see cref="MergeRetainedFromDisk"/>: the merge keeps every on-disk entry a payload
    /// omits, which is right for an entry the editor never knew about and exactly wrong
    /// for one it deleted, so the deleted identities come back out here, twins included.
    /// Returns what this save drops from disk under those identities, for the caller to
    /// destroy their derived credentials under <see cref="InstancesToForget"/>'s liveness
    /// rule: the attic entries, and also a tile still on a disk PAGE, which is what an
    /// identity the editor removed and deleted in one session is. Wrapped as an attic entry,
    /// because that is the shape the rule takes.</summary>
    public static IReadOnlyList<RetainedSlot> DropDeletedRetained(
        DashboardLayout edited, DashboardLayout? disk,
        IReadOnlyCollection<(string WidgetId, string InstanceId)> deleted)
    {
        if (deleted.Count == 0) return [];
        var keys = new HashSet<string>(StringComparer.Ordinal);
        foreach (var (w, i) in deleted) keys.Add(w + "|i:" + i);
        edited.Retained?.RemoveAll(r => Key(r?.Def) is { } k && keys.Contains(k));
        var dropped = new List<RetainedSlot>();
        foreach (var d in disk?.Retained ?? [])
            if (d is not null && Key(d.Def) is { } k && keys.Contains(k))
                dropped.Add(d);
        foreach (var p in disk?.Pages ?? [])
            foreach (var s in p?.Slots ?? [])
                if (Key(s) is { } k && keys.Contains(k))
                    dropped.Add(new RetainedSlot { Def = s });
        return dropped;
    }

    /// <summary>Trim the attic to <see cref="MaxRetainedPerWidget"/> per widget id,
    /// evicting OLDEST by <see cref="RetainedSlot.RetiredAt"/> (tiebreak InstanceId,
    /// ordinal — so re-running over the same list evicts the same entries). Returns the
    /// evicted entries so the caller can destroy their derived credentials. Entries with
    /// a null or id-less def are skipped, so one corrupt <c>"def": null</c> cannot take
    /// down every save.</summary>
    public static IReadOnlyList<RetainedSlot> CapRetained(DashboardLayout layout)
    {
        var evicted = new List<RetainedSlot>();
        if (layout.Retained is null) return evicted;
        foreach (var group in layout.Retained
                     .Where(r => r?.Def is { WidgetId.Length: > 0 })
                     .GroupBy(r => r.Def.WidgetId, StringComparer.Ordinal))
        {
            var surplus = group.Count() - MaxRetainedPerWidget;
            if (surplus <= 0) continue;
            foreach (var old in group
                         .OrderBy(r => r.RetiredAt ?? "", StringComparer.Ordinal)
                         .ThenBy(r => r.Def.InstanceId ?? "", StringComparer.Ordinal)
                         .Take(surplus))
                evicted.Add(old);
        }
        if (evicted.Count > 0) layout.Retained.RemoveAll(evicted.Contains);
        return evicted;
    }

    /// <summary>Which just-evicted instances are safe to
    /// <see cref="WidgetSecrets.ForgetInstance"/>: those NOT still referenced by any
    /// surviving live-page or surviving-retained slot. Call AFTER
    /// <see cref="CapRetained"/> has mutated <paramref name="survivors"/>. The guard is
    /// what keeps evict from destroying a bucket a live tile still uses (a restored tile
    /// keeps its instanceId, and corruption can duplicate one) — #188's rule: purge only
    /// what the app itself removed, never on inference.
    ///
    /// <para>The layout being OVERWRITTEN counts as live too, which is why
    /// <paramref name="disk"/> exists. A save carries only the copy that sent it, and a
    /// copy can be stale: its pages may have dropped a tile the disk still holds (a payload
    /// with no generation is never refused). Judging liveness from the incoming layout
    /// alone destroys that tile's derived credentials while it is, in every sense the user
    /// can see, still on the panel. Only the disk's PAGES are consulted — folding in its attic
    /// would protect the very entries eviction exists to remove.
    ///
    /// <para>The cost is a STRANDED bucket, and it can be permanent: a stale save that both
    /// drops the tile from its pages and evicts its attic entry leaves nothing that names
    /// that instance again, so no later eviction collects it and it lives until the widget
    /// is uninstalled (which forgets every instance of it). That is the better failure. The
    /// stranded value is sealed and unreachable — reading it needs an instanceId no tile
    /// holds — whereas the alternative destroys the credential of a tile that is live at
    /// that moment. And collecting it by scanning for buckets no layout mentions is exactly
    /// the inference #188 forbids: "this id was not seen" is not the same fact as "the app
    /// removed this tile".</para></summary>
    public static IReadOnlyList<(string WidgetId, string InstanceId)> InstancesToForget(
        IReadOnlyList<RetainedSlot> evicted, DashboardLayout survivors, DashboardLayout? disk = null)
    {
        var alive = new HashSet<string>(StringComparer.Ordinal);
        foreach (var p in survivors.Pages ?? [])
            foreach (var s in p.Slots ?? [])
                if (Key(s) is { } k) alive.Add(k);
        foreach (var r in survivors.Retained ?? [])
            if (Key(r?.Def) is { } k) alive.Add(k);
        foreach (var p in disk?.Pages ?? [])
            foreach (var s in p.Slots ?? [])
                if (Key(s) is { } k) alive.Add(k);
        var result = new List<(string, string)>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var e in evicted)
        {
            if (e is null || Key(e.Def) is not { } k || alive.Contains(k) || !seen.Add(k)) continue;
            result.Add((e.Def.WidgetId, e.Def.InstanceId!));
        }
        return result;
    }

    /// <summary>Identities an explicit Delete destroyed during THIS process run (#226).
    ///
    /// <para>A payload built before the Delete landed still carries the deleted def, and
    /// the union cannot tell that copy from a legitimate one (it only ever adds from disk,
    /// and never questions what came in), so the def would land back on disk with its
    /// sealed bytes, which still decrypt because DPAPI is user-scoped rather than
    /// instance-scoped. Delete's whole promise would be false for any such payload.</para>
    ///
    /// <para>This is the tombstone the design rejected, in the one form the objection does
    /// not apply to. That objection was the absence of an expiry story: in memory, for this
    /// process, keyed on instanceIds that are minted unique and never reissued, an identity
    /// recorded here can never legitimately come back — and a restart needs nothing, because
    /// the disk is already correct by then. Nothing is persisted and nothing accumulates
    /// across runs.</para>
    ///
    /// <para>Recorded only after the layout write LANDS. A failed write leaves the entry on
    /// disk for the user to retry, and tombstoning it would make the retry impossible.</para>
    /// </summary>
    private static readonly HashSet<string> DestroyedThisRun = new(StringComparer.Ordinal);

    /// <inheritdoc cref="DestroyedThisRun"/>
    public static void MarkDestroyed(string? widgetId, string? instanceId)
    {
        if (string.IsNullOrEmpty(widgetId) || string.IsNullOrEmpty(instanceId)) return;
        lock (DestroyedThisRun)
            DestroyedThisRun.Add(widgetId + "|i:" + instanceId);
    }

    private static void DropDestroyed(DashboardLayout edited)
    {
        if (edited.Retained is null || edited.Retained.Count == 0) return;
        lock (DestroyedThisRun)
        {
            if (DestroyedThisRun.Count == 0) return;
            edited.Retained.RemoveAll(r => Key(r?.Def) is { } k && DestroyedThisRun.Contains(k));
        }
    }

    /// <summary>A fresh random instance identity, for the slots of the stock first-run
    /// layout (<see cref="CreateDefault"/>). Anything that re-keys an EXISTING slot derives
    /// its id instead; see <see cref="MintMissingIds"/>.</summary>
    private static string NewInstanceId() => "s" + Guid.NewGuid().ToString("n")[..12];

    /// <summary>Stamps a stable identity onto every slot that has not got one, live and
    /// retired alike, and reports whether anything changed (#226, #68).
    ///
    /// <para><b>Why the host does this and the client must not.</b> A legacy slot predates
    /// instance ids. Left alone it acquires one from the settings replica on its first
    /// unrelated edit — a drag, a resize: the replica's persist freezes every id-less def
    /// it holds — while the copy on disk is still id-less. `SlotKey` then sees `|i:<new>`
    /// coming in against a stored slot that publishes no key at all, the carry-over misses
    /// as it is right to (#68), and the masked blank the editor round-trips reaches
    /// layout.json as the user's own edit. Moving a tile destroyed its credential. The
    /// client cannot fix this itself: the layout it holds is blanked, so a mint there is a
    /// mint against a copy with nothing to preserve.</para>
    ///
    /// <para><b>Why it is safe, on both credential axes.</b> A manifest secret is sealed
    /// INLINE in the slot's own settings, so stamping an id on the same object leaves the
    /// envelope exactly where it was — this operates on the model <see cref="Load"/>
    /// returns, sealed, and never goes near Reveal/Mask/Seal. And a `ww-secure.json` bucket
    /// cannot be orphaned because an id-less slot has never had one: the shell forwards its
    /// empty id verbatim rather than falling back to a positional scope, and the host
    /// refuses that as a bad scope (DashboardWindow.HandleSecureStore). There is nothing to
    /// migrate; there is only an identity to freeze.</para>
    ///
    /// <para>The attic is included. A retired def is addressed by identity alone, so an
    /// id-less entry is one the gallery can show but neither Restore nor Delete can name.
    /// Its sealed bytes ride along in the def for the same reason as above.</para>
    ///
    /// <para>Every id already present — live or retired — is reserved first, so a mint can
    /// never land on one. That matters more here than a GUID's collision odds suggest,
    /// because a live slot does NOT get a random id: it adopts the positional tag its
    /// widget is already running under, and those are strings a user's layout can already
    /// contain.</para></summary>
    public static bool MintMissingIds(DashboardLayout? layout)
    {
        if (layout is null) return false;
        // Reserve BEFORE minting, across both address spaces. A live id and a retired id
        // share one namespace — a restore seats the retired def back among the live ones —
        // so a pass that only looked at pages could hand a new tile a retired tile's key.
        var taken = new HashSet<string>(StringComparer.Ordinal);
        foreach (var page in layout.Pages ?? [])
            foreach (var slot in page.Slots ?? [])
                if (!string.IsNullOrEmpty(slot?.InstanceId)) taken.Add(slot.InstanceId!);
        foreach (var entry in layout.Retained ?? [])
            if (entry?.Def?.InstanceId is { Length: > 0 } retiredId) taken.Add(retiredId);

        var minted = 0;
        // Every id this pass invents is DERIVED from the layout, never drawn at random.
        // Load returns the healed model whether or not the Save below it lands, so a mint
        // that varied between runs would hand a client id A, persist nothing, and then
        // persist id B on the next read — and the client's next save, keyed A against a
        // stored B, would match nothing and read as a blank the user typed. Identical
        // bytes on disk must always freeze to identical identities; the counter suffix
        // resolves a collision the same way every time rather than by rolling again.
        string Free(string seed)
        {
            if (taken.Add(seed)) return seed;
            for (var n = 2; ; n++)
                if (taken.Add(seed + "-" + n)) return seed + "-" + n;
        }

        // A LIVE slot adopts the positional tag its widget is ALREADY running under, and
        // this is the whole difference between freezing an identity and changing one.
        // shell.js renders an id-less slot into an iframe fragment stamped
        // `#ww-slot=p{page}s{slot}` — the tag that backs the widget's `uniqueId` global and
        // therefore its storage namespace. The replica's own persist adopts `rec.tag` for
        // exactly this reason ("stored widget state carries over seamlessly"). A random id
        // here would freeze the identity and orphan the widget's state in the same stroke:
        // every never-edited legacy tile would come back blank.
        //
        // This does NOT address a credential by position (#68). The position is only where
        // the STRING comes from; once persisted it is an opaque identity that no longer
        // tracks position, and SlotKey resolves it through `|i:` like any other. What #68
        // forbids is the `|w:0` fallback, which this pass exists to make unreachable.
        for (var pi = 0; pi < (layout.Pages?.Count ?? 0); pi++)
        {
            var slots = layout.Pages![pi].Slots;
            for (var si = 0; si < (slots?.Count ?? 0); si++)
            {
                var slot = slots![si];
                // A slot with no widget id is not a tile — the save handler drops it — and
                // giving it an identity would only make the debris addressable.
                if (slot is null || string.IsNullOrWhiteSpace(slot.WidgetId)
                    || !string.IsNullOrEmpty(slot.InstanceId))
                    continue;
                // ...unless something already answers to that string. An explicit id of
                // literally "p0s0" is legal and does collide — SecretStore.AmbiguousSlots
                // calls out the same case — and two slots sharing an identity is the one
                // outcome worse than a widget losing its stored state.
                slot.InstanceId = Free("p" + pi + "s" + si);
                minted++;
            }
        }

        // A retired def has no position to adopt and nothing running to keep state for, so
        // its seed comes from what identifies the ENTRY instead: the widget, when it was
        // retired, and where from. Index would also be reproducible within one retry, but
        // the attic cap drops entries and shifts every index behind them; this survives
        // that. Deliberately not string.GetHashCode, which is randomised per process and
        // would reintroduce exactly the instability this is here to avoid.
        foreach (var entry in layout.Retained ?? [])
            if (entry?.Def is { } def && !string.IsNullOrWhiteSpace(def.WidgetId)
                && string.IsNullOrEmpty(def.InstanceId))
            {
                def.InstanceId = Free(RetiredSeed(def.WidgetId!, entry.RetiredAt, entry.OriginPage));
                minted++;
            }

        return minted > 0;
    }

    /// <summary>A reproducible seed for a retired def that reached the attic without an
    /// identity. Shaped `r&lt;hex&gt;` so it cannot collide with the `p{page}s{slot}` space a
    /// live slot adopts, and derived only from values already on the entry.</summary>
    private static string RetiredSeed(string widgetId, string? retiredAt, string? originPage)
    {
        var material = widgetId + "\n" + (retiredAt ?? "") + "\n" + (originPage ?? "");
        return "r" + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(material)))[..12]
            .ToLowerInvariant();
    }

    /// <summary>Gives every live slot that repeats an instanceId an earlier slot already
    /// holds an identity of its own, and reports whether anything changed.
    ///
    /// <para>Two tiles sharing one id share widget-local storage and a protected-store
    /// bucket, so settings and state on one visibly bleed into the other (field report:
    /// "editing settings on the top one directly impacts the one below it"). Layouts from
    /// older builds can carry such twins, and so can a hand-edited file with a slot pasted
    /// twice. The FIRST holder in page order keeps the id, and with it the storage it has
    /// been running under; each later one is re-minted.</para>
    ///
    /// <para>Raw ids, across every widget: the question <c>SecretPolicy.AmbiguousSlots</c>
    /// asks, so a healed layout gives it nothing to refuse. Retired ids are reserved, so a
    /// re-mint can never land on one, but a live slot is never re-keyed for sharing an id
    /// with an attic entry — that would detach a working tile to settle a question about one
    /// that does not render.</para>
    ///
    /// <para>DERIVED, never random, for the reason <see cref="MintMissingIds"/> gives: Load
    /// hands back the healed model whether or not its write lands, so the same bytes on disk
    /// must always heal to the same identities. A twin becomes its id with the first free
    /// <c>-N</c> suffix.</para></summary>
    public static bool HealDuplicateIds(DashboardLayout? layout)
    {
        if (layout is null) return false;
        var taken = new HashSet<string>(StringComparer.Ordinal);
        foreach (var page in layout.Pages ?? [])
            foreach (var slot in page?.Slots ?? [])
                if (!string.IsNullOrEmpty(slot?.InstanceId)) taken.Add(slot.InstanceId!);
        foreach (var entry in layout.Retained ?? [])
            if (entry?.Def?.InstanceId is { Length: > 0 } retiredId) taken.Add(retiredId);

        var seen = new HashSet<string>(StringComparer.Ordinal);
        var healed = 0;
        foreach (var page in layout.Pages ?? [])
            foreach (var slot in page?.Slots ?? [])
            {
                // Debris (no widget id) is not a tile — the save handler drops it — so it
                // never holds an id against a real one.
                if (slot is null || string.IsNullOrWhiteSpace(slot.WidgetId)
                    || string.IsNullOrEmpty(slot.InstanceId) || seen.Add(slot.InstanceId))
                    continue;
                for (var n = 2; ; n++)
                    if (taken.Add(slot.InstanceId + "-" + n))
                    {
                        slot.InstanceId += "-" + n;
                        break;
                    }
                seen.Add(slot.InstanceId);
                healed++;
            }
        return healed > 0;
    }

    /// <summary>The attic's identity key — widgetId + "|i:" + instanceId, the same id
    /// form SlotKey derives. Null for an id-less def: an id-less entry has no identity
    /// to reconcile or destroy by, and is never matched positionally (#68).</summary>
    private static string? Key(LayoutSlot? s) =>
        s is null || string.IsNullOrEmpty(s.WidgetId) || string.IsNullOrEmpty(s.InstanceId)
            ? null : s.WidgetId + "|i:" + s.InstanceId;

    /// <summary>Removes every slot referencing one of the given widget ids
    /// (retired stock migrations). Saves only when something changed.</summary>
    public static void RemoveWidgets(IEnumerable<string> widgetIds)
    {
        try
        {
            var ids = new HashSet<string>(widgetIds, StringComparer.OrdinalIgnoreCase);
            var layout = Load();
            var removed = 0;
            foreach (var page in layout.Pages)
                removed += page.Slots.RemoveAll(s => s.WidgetId is not null && ids.Contains(s.WidgetId));
            // The attic too (#226): a retired widget's retained tiles hold its sealed
            // credentials, and a package the app removed must not leave those behind for
            // whatever is installed under the id next. Folded into `removed` so an
            // attic-only scrub still saves. (The derived ww-secure store is purged by
            // ForgetSecrets on this same path, whole widget at once.)
            removed += layout.Retained?.RemoveAll(
                r => r?.Def?.WidgetId is { } id && ids.Contains(id)) ?? 0;
            if (removed > 0)
            {
                Save(layout);
                Log.Info($"Removed {removed} retired widget slot(s) from the saved layout");
            }
        }
        catch (Exception ex)
        {
            Log.Warn($"Could not scrub retired widgets from the layout: {ex.Message}");
        }
    }

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        WriteIndented = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    /// <summary>The layout as every consumer sees it — and the ONE place identities are
    /// frozen (#68, #226).
    ///
    /// <para>#289 stamped ids on id-less slots once at startup, which made the positional
    /// `|w:0` carry-over key rare. Rare is not enough to delete a safety net: a layout
    /// hand-edited through the tray's "Edit layout (JSON)" reintroduces an id-less slot
    /// mid-session, and that slot reaches `SlotKey` with no identity, no carry-over, and a
    /// masked blank that reads as "the user emptied it". Healing HERE instead makes the
    /// invariant hold by construction rather than by timing: every init payload, the save
    /// handler's `disk` and every migration read through this method, so no id-less slot
    /// can reach the credential pipeline from either side. That is what lets the positional
    /// key go.</para>
    ///
    /// <para>Duplicates are healed here for the same reason (<see cref="HealDuplicateIds"/>):
    /// the panel only displays, so this is the one place every reader passes through before
    /// a repeated identity could reach a widget.</para>
    ///
    /// <para>Writing inside a read is not new here — the fallback below has always
    /// persisted the default it regenerates — and it is bounded: healing is a no-op scan
    /// once done. A failed write does NOT withhold the healed model: consumers still need
    /// addressable slots, and handing them id-less ones puts back the very hole this
    /// closes. It costs nothing because the mint is reproducible — see
    /// <see cref="MintMissingIds"/> and <see cref="HealDuplicateIds"/> — so the next read that
    /// does persist freezes the same identities the client is already holding.</para></summary>
    public static DashboardLayout Load()
    {
        try
        {
            if (File.Exists(AppPaths.LayoutFile))
            {
                var layout = JsonSerializer.Deserialize<DashboardLayout>(File.ReadAllText(AppPaths.LayoutFile), JsonOptions);
                if (layout is { Pages.Count: > 0 })
                {
                    // Attributed to the host like every write this process performs on its
                    // own initiative (#281). The caller gets the healed model either way —
                    // a failed write must not hand back id-less or twinned slots it has just
                    // promised are addressable. Both passes run: `|` does not short-circuit.
                    var minted = MintMissingIds(layout);
                    var healed = HealDuplicateIds(layout);
                    if ((minted | healed) && Save(layout))
                    {
                        if (minted) Log.Info("Stamped stable instance ids onto slots that predated them");
                        if (healed) Log.Info("Gave widgets that shared an instance id one each");
                    }
                    return layout;
                }
            }
        }
        catch (Exception ex)
        {
            Log.Warn($"Failed to load layout.json, regenerating default: {ex.Message}");
        }

        // CreateDefault mints its own slots, so this needs no healing pass.
        var fallback = CreateDefault();
        Save(fallback);
        return fallback;
    }

    /// <summary>The writer id for a write this HOST performed on its own initiative — the
    /// identity heal in <see cref="Load"/>, a stock migration, the first-run materialize.
    /// Not a window, and not a value any client can produce: the writer is chosen by
    /// whichever HANDLER accepted the message, never read off the payload. See
    /// <see cref="IsStale"/>.</summary>
    public const string HostWriter = "host";

    /// <summary>The writer id for a save the settings window's payload made — the one
    /// client that writes layout.json; the panel only displays. It names the SURFACE, not
    /// the document — see <see cref="IsStale"/> for why per-document granularity buys
    /// nothing here.</summary>
    public const string SettingsWriter = "settings";

    private static readonly object GenerationGate = new();
    private static long _generation;
    private static string _lastWriter = HostWriter;

    /// <summary>Which version of layout.json a payload was built from (#281).
    ///
    /// <para>In memory, not persisted, for the same reason the destroyed-set is: a client
    /// only ever compares against a number THIS process handed it, and every window
    /// re-inits after a restart. Nothing to expire, nothing to migrate, no layout.json
    /// format change.</para>
    ///
    /// <para>Starts at 0 with the host as writer, so the settings window's first save is
    /// accepted: 0 is not behind 0.</para></summary>
    public static long Generation { get { lock (GenerationGate) return _generation; } }

    /// <summary>Is this payload built from a version the file has since moved past, by
    /// somebody other than the sender?
    ///
    /// <para>Both halves are load-bearing. Behind-ness alone would refuse ordinary editing:
    /// a second Save can leave the settings window before the first one's ack lands, so its
    /// payload is behind ITSELF — and it is not stale about anything, because its own
    /// working copy already contains what it just saved.</para>
    ///
    /// <para>The writer is therefore set ONLY by an accepted client save. Every write the
    /// host performs on its own — the identity heal in <see cref="Load"/>, a stock
    /// migration — is <see cref="HostWriter"/>, which no client can be. So a host write the
    /// editor never saw makes its next payload stale, and it is told to reload rather than
    /// write its older copy back over that change.</para>
    ///
    /// <para>A payload with no generation at all is ACCEPTED. Host and clients ship in one
    /// binary so it should not happen; if it does, the answer is the behaviour that
    /// predates this — last writer wins — not a window that can never save.</para></summary>
    public static bool IsStale(long? echoed, string writer)
    {
        if (echoed is null) return false;
        lock (GenerationGate)
            return echoed.Value < _generation && !string.Equals(_lastWriter, writer, StringComparison.Ordinal);
    }

    /// <summary>Writes layout.json, swallowing the failure — a save is triggered by
    /// ordinary editing, and throwing out of those paths would take something visible down
    /// with it.
    ///
    /// <para>Returns whether the write actually landed, for the callers that act on it: the
    /// settings save acks the editor with it, and only a landed write tombstones its
    /// Deletes (#226) or ends a "New" badge (#227) — a client told "done" after a silently
    /// failed write drops a row that reappears at the next init. The host's own writes
    /// ignore it, deliberately: a failed migration write is retried by the next read.</para>
    ///
    /// <para>The generation bump lives HERE, past the write and inside the success branch,
    /// so no caller can bump without writing (#281). A failed write leaves the file at the
    /// content the settings window last saw; bumping anyway would lock it out of a file
    /// that never changed. It also means every writer in the codebase — the
    /// migrations, the materialize, the identity heal — inherits the right behaviour by
    /// default, since <paramref name="writer"/> is the host unless the save handler names
    /// the window whose payload it just accepted.</para></summary>
    public static bool Save(DashboardLayout layout, string? writer = null)
    {
        try
        {
            DurableStore.Write(AppPaths.LayoutFile, JsonSerializer.Serialize(layout, JsonOptions));
            lock (GenerationGate)
            {
                _generation++;
                _lastWriter = writer ?? HostWriter;
            }
            return true;
        }
        catch (Exception ex)
        {
            Log.Warn($"Failed to save layout.json: {ex.Message}");
            return false;
        }
    }

    /// <summary>The stock first-run layout. Every slot is minted here rather than left for
    /// <see cref="MintMissingIds"/> to stamp on the next start: the pass exists to repair
    /// layouts written before identities existed, and a fresh install writing id-less slots
    /// would make it a permanent fixture instead of a migration.</summary>
    private static DashboardLayout CreateDefault() => new()
    {
        Pages =
        [
            new LayoutPage
            {
                Name = "System",
                Slots =
                [
                    new LayoutSlot { WidgetId = "ws.stock.cpu", Size = "half", InstanceId = NewInstanceId() },
                    new LayoutSlot { WidgetId = "ws.stock.gpu", Size = "half", InstanceId = NewInstanceId() },
                ],
            },
            new LayoutPage
            {
                Name = "Now Playing",
                Slots = [new LayoutSlot { WidgetId = "ws.stock.media", Size = "full", InstanceId = NewInstanceId() }],
            },
            new LayoutPage
            {
                Name = "Day",
                Slots =
                [
                    new LayoutSlot { WidgetId = "ws.stock.clock", Size = "half", InstanceId = NewInstanceId() },
                    new LayoutSlot { WidgetId = "ws.stock.weather", Size = "half", InstanceId = NewInstanceId() },
                ],
            },
        ],
    };
}
