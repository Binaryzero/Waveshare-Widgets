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

    /// <summary>Refuses a manifest that would store a credential in the clear (issue #57).
    ///
    /// Kept SEPARATE from <see cref="IsValid"/> deliberately: iCUE-style widgets declare
    /// their settings in index.html meta tags, so at the point <c>IsValid</c> runs their
    /// property list is still empty. This has to be called once the properties are
    /// actually resolved, or the whole rule is skipped by exactly the widgets least
    /// likely to have been near the build-time validator.
    ///
    /// The check is on the TYPE, not the author: a property named like a credential and
    /// declared as anything but <c>secret</c> never reaches SecretPolicy, so its value is
    /// written to layout.json as plaintext with no signal to the user.</summary>
    public bool CredentialsAreTyped(out string error)
    {
        foreach (var p in Properties)
        {
            // A secret must not ship a value. Defaults are merged by the shell AFTER
            // SecretPolicy.Reveal, so a default here is handed straight to the widget and
            // to the settings preview as plaintext, having never been protected at all —
            // declaring `secret` would buy the credential nothing. The Node validator has
            // refused this since #15 (prop-secret-default); the install path did not.
            if (p.Type == "secret" && p.Default is not null
                && p.Default.ToString() is { Length: > 0 })
            {
                error = $"property '{p.Name}' is a secret with a default value. Secrets are "
                      + "revealed before defaults are merged, so a default is delivered as "
                      + "plaintext and is never encrypted; ship no default for a secret.";
                return false;
            }

            if (p.Type != "secret" && CredentialNames.LooksLikeCredential(p.Name))
            {
                error = $"property '{p.Name}' looks like a credential but is declared as "
                      + $"'{p.Type}'. Credentials must use type \"secret\" so the host can "
                      + "encrypt them; any other type is written to layout.json in plaintext.";
                return false;
            }

            // List rows are NEVER encrypted — SecretPolicy walks top-level properties
            // only — so a credential-looking key inside one has no safe type at all.
            if (p.Fields is JsonArray fields)
            {
                foreach (var field in fields)
                {
                    var key = field?["key"]?.GetValue<string>();
                    if (key is not null && CredentialNames.LooksLikeCredential(key))
                    {
                        error = $"list property '{p.Name}' has a field '{key}' that looks like a "
                              + "credential. List rows are never encrypted — declare a top-level "
                              + "\"secret\" property instead.";
                        return false;
                    }
                }
            }
        }
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

    /// <summary>Normalized to lowercase on the way in, because the host and the settings
    /// client disagreed about what counts. SecretPolicy matches the type with
    /// OrdinalIgnoreCase, but settings.js compares <c>pr.type === 'secret'</c> exactly —
    /// so a manifest declaring <c>"Secret"</c> was encrypted at rest AND rendered as an
    /// ordinary text field, which left it out of the replica's redaction list and pushed
    /// a freshly typed credential into the preview. Canonicalizing here removes the
    /// divergence at the source rather than teaching one more consumer to be lenient.</summary>
    [JsonPropertyName("type")]
    public string Type
    {
        get => _type;
        set
        {
            var normalized = (value ?? "").Trim().ToLowerInvariant();
            _type = normalized.Length == 0 ? "text" : normalized;
        }
    }
    private string _type = "text";
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
