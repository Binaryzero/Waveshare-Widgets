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

    /// <summary>Immutable per-instance identity backing widget-local storage keys
    /// (the iCUE `uniqueId`). Assigned by the shell on first on-panel edit — adopting
    /// the positional tag the instance is already running under, so stored widget
    /// state survives rearranging. Null on layouts that were never edited on-panel
    /// (identity stays positional, exactly as before).</summary>
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

/// <summary>Loads/saves layout.json and creates the first-run default layout.</summary>
public static class LayoutStore
{
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
