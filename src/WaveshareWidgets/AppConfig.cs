using System.Text.Json;
using System.Text.Json.Serialization;

namespace WaveshareWidgets;

/// <summary>User configuration persisted to %LocalAppData%\WaveshareWidgets\config.json.</summary>
public sealed class AppConfig
{
    /// <summary>Windows device name (e.g. \\.\DISPLAY2) of the screen to pin the dashboard to.
    /// Null means auto-detect by the panel's 1280x400 / 400x1280 resolution signature.</summary>
    public string? DisplayDeviceName { get; set; }

    /// <summary>Sensor poll interval. Values below 500 are clamped at load.</summary>
    public int PollIntervalMs { get; set; } = 2000;

    /// <summary>Enables the WebView2 dev tools context menu entry for widget debugging.</summary>
    public bool EnableDevTools { get; set; }

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        WriteIndented = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    public static AppConfig Load()
    {
        try
        {
            if (File.Exists(AppPaths.ConfigFile))
            {
                var config = JsonSerializer.Deserialize<AppConfig>(File.ReadAllText(AppPaths.ConfigFile), JsonOptions);
                if (config is not null)
                {
                    config.PollIntervalMs = Math.Max(500, config.PollIntervalMs);
                    return config;
                }
            }
        }
        catch (Exception ex)
        {
            Log.Warn($"Failed to load config, using defaults: {ex.Message}");
        }
        return new AppConfig();
    }

    public void Save()
    {
        try
        {
            File.WriteAllText(AppPaths.ConfigFile, JsonSerializer.Serialize(this, JsonOptions));
        }
        catch (Exception ex)
        {
            Log.Warn($"Failed to save config: {ex.Message}");
        }
    }
}
