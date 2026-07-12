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

            properties.Add(new WidgetProperty
            {
                Name = name,
                Label = CleanLabel(attrs.GetValueOrDefault("data-label"), name),
                Type = attrs.GetValueOrDefault("data-type", "textfield"),
                Default = ParseDefault(attrs.GetValueOrDefault("data-default")),
                Min = ParseDouble(attrs.GetValueOrDefault("data-min")),
                Max = ParseDouble(attrs.GetValueOrDefault("data-max")),
                Step = ParseDouble(attrs.GetValueOrDefault("data-step")),
            });
        }
        return properties;
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
