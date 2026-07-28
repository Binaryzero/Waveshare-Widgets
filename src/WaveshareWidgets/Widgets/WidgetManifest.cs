using System.Text.Json.Nodes;
using System.Text.Json.Serialization;

namespace WaveshareWidgets.Widgets;

/// <summary>Parsed manifest.json of a widget package. See docs/WIDGET-SPEC.md.</summary>
public sealed class WidgetManifest
{
    [JsonPropertyName("id")] public string Id { get; set; } = "";
    [JsonPropertyName("name")] public string Name { get; set; } = "";
    [JsonPropertyName("author")] public string Author { get; set; } = "";
    [JsonPropertyName("version")] public string Version { get; set; } = "0.0.0";
    [JsonPropertyName("description")] public string? Description { get; set; }
    [JsonPropertyName("min_api_version")] public int MinApiVersion { get; set; } = 1;
    [JsonPropertyName("preview_icon")] public string? PreviewIcon { get; set; }
    [JsonPropertyName("supported_slots")] public List<string> SupportedSlots { get; set; } = ["quarter", "half", "full"];
    [JsonPropertyName("properties")] public List<WidgetProperty> Properties { get; set; } = [];

    public bool IsValid(out string error)
    {
        if (string.IsNullOrWhiteSpace(Id)) { error = "manifest is missing 'id'"; return false; }
        if (string.IsNullOrWhiteSpace(Name)) { error = "manifest is missing 'name'"; return false; }
        error = "";
        return true;
    }
}

/// <summary>A user-configurable widget setting, declared in the manifest and rendered by the host.
/// Types: text, number, slider, color, select, sensor, location, list (see WIDGET-SPEC).
///
/// This class sits in the middle of a round-trip — manifest.json is deserialized here and
/// re-serialized to the settings window — so ANY schema key it doesn't carry is silently
/// stripped in the field. That is exactly what happened to the list-type keys below: the
/// settings window received lists with no field definitions, the editor threw, and whole
/// property panels vanished on real installs while harness fixtures (raw JS, no C# in the
/// path) stayed green. The extension-data map is the safety net: unknown keys now ride
/// through untouched, and tools/ManifestRoundTrip in CI fails the build on any loss.</summary>
public sealed class WidgetProperty
{
    [JsonPropertyName("name")] public string Name { get; set; } = "";
    [JsonPropertyName("label")] public string Label { get; set; } = "";
    [JsonPropertyName("type")] public string Type { get; set; } = "text";
    [JsonPropertyName("default")] public JsonNode? Default { get; set; }
    [JsonPropertyName("min")] public double? Min { get; set; }
    [JsonPropertyName("max")] public double? Max { get; set; }
    [JsonPropertyName("step")] public double? Step { get; set; }
    [JsonPropertyName("options")] public List<string>? Options { get; set; }
    [JsonPropertyName("sensor_type")] public string? SensorType { get; set; }

    /// <summary>Settings-UI section this property belongs to (iCUE x-icue-groups).</summary>
    [JsonPropertyName("group")] public string? Group { get; set; }

    /// <summary>Row field definitions for the list type ([{key, label, type, placeholder}]).
    /// Pass-through data — the settings window is the only consumer.</summary>
    [JsonPropertyName("fields")] public JsonNode? Fields { get; set; }

    /// <summary>Noun for the list type's add-row button ("Add host").</summary>
    [JsonPropertyName("itemLabel")] public string? ItemLabel { get; set; }

    /// <summary>Expected-format hint for text inputs — the sanctioned place to teach syntax.</summary>
    [JsonPropertyName("placeholder")] public string? Placeholder { get; set; }

    /// <summary>Host-provided dropdown source for selects (e.g. "sd-profiles").</summary>
    [JsonPropertyName("optionsSource")] public string? OptionsSource { get; set; }

    /// <summary>Any manifest key this model doesn't know yet survives the round-trip here
    /// instead of being stripped on its way to the settings window.</summary>
    [JsonExtensionData] public Dictionary<string, System.Text.Json.JsonElement>? Extra { get; set; }
}
