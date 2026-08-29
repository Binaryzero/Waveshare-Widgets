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

    /// <summary>Retained "attic" (#226): verbatim deep-copies of slots removed on-panel or
    /// from the settings form, kept so a later change can restore them. Bounded
    /// (<see cref="LayoutStore.MaxRetainedPerWidget"/> per widget id, oldest evicted
    /// host-side on save). Nullable with NO initializer so a layout that never retired
    /// anything round-trips byte-identically (the serializer omits null members).
    /// Populated by shell.js removeSlot / settings.js removeSlotAt; unioned with disk and
    /// capped host-side in both save handlers.</summary>
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

    /// <summary>Widget panel opacity, 0.15–1.0. Glass background style renders at this
    /// level; solid forces 1; transparent forces 0.</summary>
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
    /// per-instance credential scope (the iCUE `uniqueId`). Assigned by the shell on add and
    /// frozen on first on-panel edit — adopting the positional tag the instance is already
    /// running under, so stored widget state survives rearranging. Null on layouts that were
    /// never edited on-panel (identity stays positional, exactly as before); the per-instance
    /// credential store (#226) keys on it and refuses to store under an absent id rather than
    /// address a credential by grid position (#68), so an unedited legacy tile simply keeps
    /// its derived token in memory until it acquires an id the ordinary way.</summary>
    [JsonPropertyName("instanceId")] public string? InstanceId { get; set; }

    /// <summary>Hide this widget while a fullscreen game is in the foreground —
    /// its grid cell is preserved, so it returns exactly where it was.</summary>

    /// <summary>Per-instance theme-seed overrides from the on-panel style editor.
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
/// the removed <see cref="LayoutSlot"/> (id-bearing: the shell mints an instanceId before
/// retiring), so every SecretStore function operates on it unchanged and a later restore
/// can deep-copy it back into a page. Addressed ONLY by identity
/// (<c>widgetId|i:instanceId</c>, the same form SlotKey derives for an id-bearing live
/// slot) — never by grid position (#68). A never-edited legacy tile (no instanceId in the
/// STORED layout) loses its manifest secret when retired on the masked path, by the same
/// #68 proof as the first-on-panel-edit loss — accepted and documented, not worked around
/// (see docs/SECRET-ADDRESSING.md).</summary>
public sealed class RetainedSlot
{
    [JsonPropertyName("def")] public LayoutSlot Def { get; set; } = new();

    /// <summary>ISO-8601 UTC, shell-minted. A string rather than DateTimeOffset so a
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
    /// <paramref name="disk"/> exists. A save carries only the window that sent it, and a
    /// window can be stale: its pages may have dropped a tile the OTHER window still shows
    /// and will save straight back. Judging liveness from the incoming layout alone
    /// destroys that tile's derived credentials while it is, in every sense the user can
    /// see, still on the panel. Only the disk's PAGES are consulted — folding in its attic
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

    /// <summary>What <see cref="RestoreRetained"/> did.</summary>
    public enum RestoreOutcome
    {
        /// <summary>The def left the attic and landed on the named page.</summary>
        Ok,

        /// <summary>No attic entry carries that identity — already restored, cleared, or
        /// evicted, plausibly by the other window. The client's list is stale.</summary>
        NotFound,

        /// <summary>The index names no page on disk. Refused, never clamped: the client
        /// names a page it is looking at, and silently restoring onto some OTHER page is
        /// worse than a refusal the user can see and retry.</summary>
        BadPage,
    }

    /// <summary>Moves one retained def back onto a live page (#226) — the whole restore,
    /// as a single mutation of <paramref name="layout"/>, so no intermediate state ever
    /// reaches disk.
    ///
    /// <para>Why one mutation: an identity seated in BOTH pages and retained poisons its
    /// own key in the stored index (SecretStore.BuildStoredIndex shares one seen-set
    /// across the pages and retained walks), and the next masked save would then read the
    /// restored slot's blank as "untouched" and REMOVE the credential the restore just
    /// reconnected. Hence the <see cref="List{T}.RemoveAll"/> rather than removing "the"
    /// match: a duplicate-identity attic (corruption, or two windows minting
    /// independently) would otherwise leave a twin behind and produce exactly that
    /// state.</para>
    ///
    /// <para>The instanceId is KEPT — it is what reconnects the derived ww-secure bucket —
    /// and re-minted only on a genuine collision with a live tile, where two slots would
    /// otherwise share one identity. On that path the bucket stays with the collision
    /// holder (it is that tile's, by #188's rule) and the restored tile re-authenticates;
    /// its Axis-A manifest secret still rides along, DPAPI being user-scoped rather than
    /// instance-scoped.</para>
    ///
    /// <para>The column anchor survives only onto the page it was retired from: off its
    /// origin page a stale <see cref="LayoutSlot.Col"/> pins the tile at an arbitrary
    /// column, and because the shell places every anchor before any unanchored slot, it
    /// could take a column out from under a tile the user can currently see. Both editors
    /// mirror this rule in their own fit check, so the button they enable and the
    /// placement the host performs agree.</para></summary>
    /// <param name="restored">The def now living on the page (id possibly re-minted), for
    /// the caller to mask and ack; null unless the outcome is <see cref="RestoreOutcome.Ok"/>.</param>
    /// <param name="expectPageName">What the client believes page <paramref name="page"/>
    /// is called. An index alone is not an identity: the settings editor is an
    /// explicit-save editor, so its page list can be reordered locally, and an index that
    /// is still in range then names a DIFFERENT page on disk — the tile lands somewhere
    /// the user was not looking, silently. Null skips the check.</param>
    public static RestoreOutcome RestoreRetained(
        DashboardLayout layout, string? widgetId, string? instanceId, int page,
        out LayoutSlot? restored, string? expectPageName = null)
    {
        restored = null;
        if (string.IsNullOrEmpty(widgetId) || string.IsNullOrEmpty(instanceId))
            return RestoreOutcome.NotFound;
        var key = widgetId + "|i:" + instanceId;
        var entry = layout.Retained?.FirstOrDefault(r => Key(r?.Def) == key);
        if (entry is null) return RestoreOutcome.NotFound;
        if (page < 0 || layout.Pages is null || page >= layout.Pages.Count)
            return RestoreOutcome.BadPage;
        if (expectPageName is not null)
        {
            // The name must match AND be the only one of its kind. Page names are free
            // text with no uniqueness rule, so a name two pages share proves nothing about
            // which of them the client meant — and the case this guard exists for (another
            // window reordered the pages) is exactly the case where the duplicate lands on
            // the wrong one. Ambiguity is a refusal, like the range check beside it.
            var named = 0;
            foreach (var p in layout.Pages)
                if (string.Equals(p.Name, expectPageName, StringComparison.Ordinal))
                    named++;
            if (named != 1
                || !string.Equals(layout.Pages[page].Name, expectPageName, StringComparison.Ordinal))
                return RestoreOutcome.BadPage;
        }

        var target = layout.Pages[page];
        target.Slots ??= [];
        var def = entry.Def;

        // Every entry under this identity, not just the matched one (see the twin note).
        layout.Retained!.RemoveAll(r => Key(r?.Def) == key);

        if (!string.Equals(entry.OriginPage, target.Name, StringComparison.Ordinal))
            def.Col = null;

        // Collision is a question about the RAW instanceId, not about this widget's copy of
        // it. The shell's duplicate healing builds one seenIds set across every page with no
        // widget id in it, so two different widgets sharing an id collide there and the
        // second is re-minted — under our nose, after this restore, detaching whichever tile
        // it picks from its widget-local storage and its protected-store bucket. Keying this
        // by widget was the same mistake SecretStore.AmbiguousSlots documents having made.
        var live = new HashSet<string>(StringComparer.Ordinal);
        foreach (var p in layout.Pages)
            foreach (var s in p.Slots ?? [])
                if (!string.IsNullOrEmpty(s?.InstanceId)) live.Add(s.InstanceId!);
        if (live.Contains(instanceId!)) def.InstanceId = NewInstanceId();

        target.Slots.Add(def);
        restored = def;
        return RestoreOutcome.Ok;
    }

    /// <summary>Destroys one retained entry for real (#226): drops it from the attic and
    /// reports which instance's derived ww-secure bucket the caller should forget.
    ///
    /// <para>The forget set comes from <see cref="InstancesToForget"/> over this single
    /// entry and the POST-removal layout, so Clear obeys exactly the rule eviction does —
    /// never an id a surviving live or retained slot still references (#188). Removing
    /// every entry under the identity rather than the first match matters here for a
    /// second reason: a leftover twin would sit in the survivors' attic, the liveness
    /// guard would correctly decline the forget, and the user's Clear would neither
    /// destroy the bucket nor empty the row they were looking at.</para>
    ///
    /// <para>Callers must treat the forget as the FIRST step and fail closed: if the
    /// secure store cannot be written, do NOT save the layout. Aborting costs nothing
    /// (only this in-memory copy was mutated) and leaves the entry restorable, whereas
    /// saving anyway would strand a working credential bucket that nothing references and
    /// only a whole-widget uninstall would ever collect.</para></summary>
    /// <returns>True when an entry was removed; false leaves <paramref name="layout"/>
    /// untouched.</returns>
    public static bool ClearRetained(
        DashboardLayout layout, string? widgetId, string? instanceId,
        out IReadOnlyList<(string WidgetId, string InstanceId)> toForget)
    {
        toForget = [];
        if (string.IsNullOrEmpty(widgetId) || string.IsNullOrEmpty(instanceId)) return false;
        var key = widgetId + "|i:" + instanceId;
        var entry = layout.Retained?.FirstOrDefault(r => Key(r?.Def) == key);
        if (entry is null) return false;
        layout.Retained!.RemoveAll(r => Key(r?.Def) == key);
        toForget = InstancesToForget([entry], layout);
        return true;
    }

    /// <summary>Identities an explicit Delete destroyed during THIS process run (#226).
    ///
    /// <para>The cross-window notice converges the two editors' copies, but it cannot
    /// reach a save that is already in flight: the panel serializes its whole model —
    /// attic included — on every drag and resize, and a payload built before the Delete
    /// can be PROCESSED after it. The union cannot tell that copy from a legitimate one
    /// (it only ever adds from disk, and never questions what came in), so the deleted def
    /// would land back on disk with its sealed bytes, which still decrypt because DPAPI is
    /// user-scoped rather than instance-scoped. Delete's whole promise is false for exactly
    /// that window.</para>
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

    /// <summary>A fresh instance identity, in the shell's own shape — the collision
    /// re-mint above cannot borrow Seal's stamper, which is a local function that
    /// deliberately no-ops on the id-bearing slots an attic def always is.</summary>
    private static string NewInstanceId() => "s" + Guid.NewGuid().ToString("n")[..12];

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

    public static DashboardLayout Load()
    {
        try
        {
            if (File.Exists(AppPaths.LayoutFile))
            {
                var layout = JsonSerializer.Deserialize<DashboardLayout>(File.ReadAllText(AppPaths.LayoutFile), JsonOptions);
                if (layout is { Pages.Count: > 0 })
                    return layout;
            }
        }
        catch (Exception ex)
        {
            Log.Warn($"Failed to load layout.json, regenerating default: {ex.Message}");
        }

        var fallback = CreateDefault();
        Save(fallback);
        return fallback;
    }

    /// <summary>The writer id for a write this HOST performed — a restore, a clear, a
    /// stock migration, the first-run materialize. Not a window, and not a value any
    /// client can produce: the writer is chosen by whichever HANDLER accepted the message,
    /// never read off the payload. See <see cref="IsStale"/>.</summary>
    public const string HostWriter = "host";

    /// <summary>The two window writers, so the handlers and the rule cannot disagree by
    /// typo. They name the SURFACE, not the document — see <see cref="IsStale"/> for why
    /// per-document granularity buys nothing here.</summary>
    public const string PanelWriter = "panel";

    /// <inheritdoc cref="PanelWriter"/>
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
    /// <para>Starts at 0 with the host as writer, so the first save from either window is
    /// accepted: 0 is not behind 0.</para></summary>
    public static long Generation { get { lock (GenerationGate) return _generation; } }

    /// <summary>Is this payload built from a version the file has since moved past, by
    /// somebody other than the sender?
    ///
    /// <para>Both halves are load-bearing. Behind-ness alone would break ordinary panel
    /// editing: the panel posts its whole model on every drag and its next payload is out
    /// long before the previous ack lands, so it is routinely behind ITSELF — and it is
    /// not stale about anything, because its own in-memory state already contains what it
    /// just saved.</para>
    ///
    /// <para>The writer is therefore set ONLY by an accepted client save. Every write the
    /// host performs on a client's behalf — Restore, Clear, a stock migration — is
    /// <see cref="HostWriter"/>, which no client can be. Without that, a Delete requested
    /// by the panel would make the PANEL the last writer, and the panel's own debounced
    /// save composed before the ack — carrying the attic entry the Delete just destroyed —
    /// would be exempted and resurrect it. (The destroyed-set covers that one from the
    /// other side; this is why it is still needed and why it is not enough alone.)</para>
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
    /// ordinary editing on both surfaces, and throwing out of those paths would take
    /// something visible down with it.
    ///
    /// <para>Returns whether the write actually landed, for the one caller that has to
    /// know: a destructive op (#226's Clear) acks the client, and a client told "done"
    /// after a silently failed write drops a row that reappears at the next init. Every
    /// other caller ignores it, deliberately — reporting a failed layout save into an
    /// ordinary edit is a notification with nothing behind it.</para>
    ///
    /// <para>The generation bump lives HERE, past the write and inside the success branch,
    /// so no caller can bump without writing (#281). A failed write leaves the file at the
    /// content the other window last saw; bumping anyway would lock that window out of a
    /// file that never changed. It also means every writer in the codebase — the
    /// migrations, the materialize, both restores, both clears — inherits the right
    /// behaviour by default, since <paramref name="writer"/> is the host unless a save
    /// handler names the window whose payload it just accepted.</para></summary>
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

    private static DashboardLayout CreateDefault() => new()
    {
        Pages =
        [
            new LayoutPage
            {
                Name = "System",
                Slots =
                [
                    new LayoutSlot { WidgetId = "ws.stock.cpu", Size = "half" },
                    new LayoutSlot { WidgetId = "ws.stock.gpu", Size = "half" },
                ],
            },
            new LayoutPage
            {
                Name = "Now Playing",
                Slots = [new LayoutSlot { WidgetId = "ws.stock.media", Size = "full" }],
            },
            new LayoutPage
            {
                Name = "Day",
                Slots =
                [
                    new LayoutSlot { WidgetId = "ws.stock.clock", Size = "half" },
                    new LayoutSlot { WidgetId = "ws.stock.weather", Size = "half" },
                ],
            },
        ],
    };
}
