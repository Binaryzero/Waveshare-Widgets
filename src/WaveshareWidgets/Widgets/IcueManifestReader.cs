using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace WaveshareWidgets.Widgets;

/// <summary>
/// Compatibility reader for iCUE-style widgets: their user settings are declared as
/// &lt;meta name="x-icue-property"&gt; tags in index.html rather than in the manifest.
/// This extracts them into our WidgetProperty model so the Settings UI can render them
/// and the dashboard can inject their values.
/// </summary>
public static partial class IcueManifestReader
{
    [GeneratedRegex(@"<meta\s+[^>]*?name=""x-icue-property""[^>]*?>",
        RegexOptions.IgnoreCase | RegexOptions.Singleline)]
    private static partial Regex MetaTagPattern();

    [GeneratedRegex(@"([\w-]+)\s*=\s*""([^""]*)""", RegexOptions.Singleline)]
    private static partial Regex AttributePattern();

    [GeneratedRegex(@"^tr\(\s*'(.*)'\s*\)$", RegexOptions.Singleline)]
    private static partial Regex TrLabelPattern();

    public static List<WidgetProperty> ParseProperties(string indexHtmlPath)
    {
        var properties = new List<WidgetProperty>();
        string html;
        try
        {
            html = File.ReadAllText(indexHtmlPath);
        }
        catch
        {
            return properties;
        }

        foreach (Match tag in MetaTagPattern().Matches(html))
        {
            var attrs = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            foreach (Match attr in AttributePattern().Matches(tag.Value))
                attrs[attr.Groups[1].Value] = attr.Groups[2].Value;

            if (!attrs.TryGetValue("content", out var name) || string.IsNullOrWhiteSpace(name))
                continue;

            var type = attrs.GetValueOrDefault("data-type", "textfield");
            var options = ParseValueKeys(attrs.GetValueOrDefault("data-values"));

            // tab-buttons and combobox are enumerations; render them as selects.
            if (options is { Count: > 0 } && type is "tab-buttons" or "combobox")
                type = "select";

            properties.Add(new WidgetProperty
            {
                Name = name,
                Label = CleanLabel(attrs.GetValueOrDefault("data-label"), name),
                Type = type,
                Default = ParseDefault(attrs.GetValueOrDefault("data-default")),
                Min = ParseDouble(attrs.GetValueOrDefault("data-min")),
                Max = ParseDouble(attrs.GetValueOrDefault("data-max")),
                Step = ParseDouble(attrs.GetValueOrDefault("data-step")),
                Options = options,
            });
        }

        ApplyGroups(html, ref properties);
        return properties;
    }

    [GeneratedRegex(@"<script(?=[^>]*?id=""x-icue-groups"")[^>]*?>(.*?)</script>",
        RegexOptions.IgnoreCase | RegexOptions.Singleline)]
    private static partial Regex GroupsScriptPattern();

    /// <summary>x-icue-groups organizes properties into titled settings sections:
    /// [{"title": "tr('Widget Setup')", "properties": ["a", "b"]}, …]. Grouped
    /// properties are labeled and reordered to group order; ungrouped ones keep
    /// their original order at the end.</summary>
    private static void ApplyGroups(string html, ref List<WidgetProperty> properties)
    {
        var match = GroupsScriptPattern().Match(html);
        if (!match.Success)
            return;

        try
        {
            using var doc = System.Text.Json.JsonDocument.Parse(match.Groups[1].Value.Trim());
            var byName = properties.ToDictionary(p => p.Name);
            var ordered = new List<WidgetProperty>();

            foreach (var group in doc.RootElement.EnumerateArray())
            {
                var title = CleanLabel(group.TryGetProperty("title", out var t) ? t.GetString() : null, "");
                if (!group.TryGetProperty("properties", out var names))
                    continue;
                foreach (var nameElement in names.EnumerateArray())
                {
                    var name = nameElement.GetString();
                    if (name is not null && byName.Remove(name, out var prop))
                    {
                        prop.Group = string.IsNullOrWhiteSpace(title) ? null : title;
                        ordered.Add(prop);
                    }
                }
            }
            ordered.AddRange(properties.Where(p => byName.ContainsKey(p.Name)));
            properties = ordered;
        }
        catch (Exception ex)
        {
            Log.Warn($"Ignoring malformed x-icue-groups: {ex.Message}");
        }
    }

    [GeneratedRegex(@"'key'\s*:\s*'([^']*)'", RegexOptions.Singleline)]
    private static partial Regex ValueKeyPattern();

    /// <summary>data-values is a JS-ish array like [{'key':'hot','value':tr('Hot')}, …];
    /// the keys are what the widget expects in its settings.</summary>
    private static List<string>? ParseValueKeys(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw))
            return null;
        var keys = ValueKeyPattern().Matches(raw).Select(m => m.Groups[1].Value).ToList();
        return keys.Count > 0 ? keys : null;
    }

    /// <summary>Labels usually look like tr('Text Color'); unwrap the translation call.</summary>
    private static string CleanLabel(string? label, string fallback)
    {
        if (string.IsNullOrWhiteSpace(label))
            return fallback;
        var tr = TrLabelPattern().Match(label.Trim());
        return tr.Success ? tr.Groups[1].Value : label.Trim();
    }

    /// <summary>data-default holds a JS expression: 'string', true/false, a number, or an
    /// arbitrary call (e.g. plugins.….getDefaultSensorIdBlock('temperature')). Literals are
    /// converted; expressions become null and the widget falls back to its own default.</summary>
    private static JsonNode? ParseDefault(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw))
            return null;
        var text = raw.Trim();

        if ((text.StartsWith('\'') && text.EndsWith('\'') && text.Length >= 2) ||
            (text.StartsWith('"') && text.EndsWith('"') && text.Length >= 2))
            return JsonValue.Create(text[1..^1]);
        if (bool.TryParse(text, out var boolean))
            return JsonValue.Create(boolean);
        if (double.TryParse(text, System.Globalization.CultureInfo.InvariantCulture, out var number))
            return JsonValue.Create(number);
        return null;
    }

    private static double? ParseDouble(string? raw) =>
        double.TryParse(raw, System.Globalization.CultureInfo.InvariantCulture, out var value) ? value : null;
}
