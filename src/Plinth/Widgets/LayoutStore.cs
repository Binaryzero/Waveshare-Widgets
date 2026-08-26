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
    /// what the app itself removed, never on inference.</summary>
    public static IReadOnlyList<(string WidgetId, string InstanceId)> InstancesToForget(
        IReadOnlyList<RetainedSlot> evicted, DashboardLayout survivors)
    {
        var alive = new HashSet<string>(StringComparer.Ordinal);
        foreach (var p in survivors.Pages ?? [])
            foreach (var s in p.Slots ?? [])
                if (Key(s) is { } k) alive.Add(k);
        foreach (var r in survivors.Retained ?? [])
            if (Key(r?.Def) is { } k) alive.Add(k);
        var result = new List<(string, string)>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var e in evicted)
        {
            if (e is null || Key(e.Def) is not { } k || alive.Contains(k) || !seen.Add(k)) continue;
            result.Add((e.Def.WidgetId, e.Def.InstanceId!));
        }
        return result;
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

    public static void Save(DashboardLayout layout)
    {
        try
        {
            DurableStore.Write(AppPaths.LayoutFile, JsonSerializer.Serialize(layout, JsonOptions));
        }
        catch (Exception ex)
        {
            Log.Warn($"Failed to save layout.json: {ex.Message}");
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
