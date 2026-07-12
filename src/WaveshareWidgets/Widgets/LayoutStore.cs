using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;

namespace WaveshareWidgets.Widgets;

public sealed class DashboardLayout
{
    [JsonPropertyName("pages")] public List<LayoutPage> Pages { get; set; } = [];
}

public sealed class LayoutPage
{
    [JsonPropertyName("name")] public string Name { get; set; } = "";
    [JsonPropertyName("slots")] public List<LayoutSlot> Slots { get; set; } = [];
}

public sealed class LayoutSlot
{
    [JsonPropertyName("widgetId")] public string WidgetId { get; set; } = "";

    /// <summary>quarter (320x400), half (640x400) or full (1280x400).</summary>
    [JsonPropertyName("size")] public string Size { get; set; } = "quarter";

    /// <summary>Per-instance overrides of the widget's declared property defaults.</summary>
    [JsonPropertyName("settings")] public JsonObject? Settings { get; set; }
}

/// <summary>Loads/saves layout.json and creates the first-run default layout.</summary>
public static class LayoutStore
{
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
            File.WriteAllText(AppPaths.LayoutFile, JsonSerializer.Serialize(layout, JsonOptions));
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
