using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Plinth.Widgets;

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

            // Map iCUE control types onto our editors: enumerations become selects,
            // the sensor picker maps to our native one, and search-combobox (whose
            // options come from widget-shipped ES modules we don't execute) degrades
            // to a plain text field.
            if (options is { Count: > 0 } && type is "tab-buttons" or "combobox")
                type = "select";
            else if (type == "sensors-combobox")
                type = "sensor";
            else if (type == "search-combobox")
                type = "textfield";

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

    [GeneratedRegex(@"'([^']*)'", RegexOptions.Singleline)]
    private static partial Regex QuotedStringPattern();

    /// <summary>data-values is a JS-ish array: either [{'key':'hot','value':tr('Hot')}, …]
    /// (the keys are what the widget expects) or a simple ['a', 'b', 'c'] list. One
    /// expression is understood rather than parsed: iCUE.allTimeZones(), which the stock
    /// clocks use for their timezone combobox — without evaluating it the control
    /// rendered with ZERO options, so the user could never supply the value whose
    /// absence was crashing the widget.</summary>
    private static List<string>? ParseValueKeys(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw))
            return null;
        if (raw.Trim() == "iCUE.allTimeZones()")
            return AllTimeZoneIds();
        var keys = ValueKeyPattern().Matches(raw).Select(m => m.Groups[1].Value).ToList();
        if (keys.Count == 0 && !raw.Contains('{'))
            keys = QuotedStringPattern().Matches(raw).Select(m => m.Groups[1].Value)
                .Where(v => v.Length > 0).ToList();
        return keys.Count > 0 ? keys : null;
    }

    /// <summary>Labels are JS expressions: tr('Text Color'), a 'quoted literal', or
    /// occasionally a bare string. Unwrap to the display text.</summary>
    private static string CleanLabel(string? label, string fallback)
    {
        if (string.IsNullOrWhiteSpace(label))
            return fallback;
        var text = label.Trim();
        var tr = TrLabelPattern().Match(text);
        if (tr.Success)
            return tr.Groups[1].Value;
        if (text.Length >= 2 && text.StartsWith('\'') && text.EndsWith('\''))
            return text[1..^1];
        return text;
    }

    /// <summary>data-default holds a JS expression: 'string', true/false, a number, or an
    /// arbitrary call (e.g. plugins.….getDefaultSensorIdBlock('temperature')). Literals are
    /// converted; the iCUE environment calls the stock clocks lean on are evaluated here
    /// (their values feed globals the widgets read BARE, so a null default meant a
    /// ReferenceError on a fresh install); any other expression becomes null and the
    /// widget falls back to its own default.</summary>
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
        if (text == "iCUE.defaultTimeZone()")
            return JsonValue.Create(DefaultTimeZoneId());
        if (text == "iCUE.default24HourFormat()")
            return JsonValue.Create(Default24HourKey());
        return null;
    }

    /// <summary>The machine's time zone as the IANA id the widgets expect (they pass it
    /// to Intl, and split(' ')[0] first — a bare id survives both).</summary>
    private static string DefaultTimeZoneId()
    {
        try
        {
            var local = TimeZoneInfo.Local;
            if (local.HasIanaId)
                return local.Id;
            return TimeZoneInfo.TryConvertWindowsIdToIanaId(local.Id, out var iana) ? iana : local.Id;
        }
        catch
        {
            return "UTC";
        }
    }

    /// <summary>The tab-buttons KEY the stock clocks declare ('12h'/'24h'), chosen the
    /// way iCUE chooses it: from the system's own short time format.</summary>
    private static string Default24HourKey()
    {
        try
        {
            return System.Globalization.CultureInfo.CurrentCulture.DateTimeFormat
                .ShortTimePattern.Contains('H') ? "24h" : "12h";
        }
        catch
        {
            return "24h";
        }
    }

    private static List<string>? AllTimeZoneIds()
    {
        try
        {
            var ids = new SortedSet<string>(StringComparer.Ordinal);
            foreach (var zone in TimeZoneInfo.GetSystemTimeZones())
            {
                if (zone.HasIanaId)
                    ids.Add(zone.Id);
                else if (TimeZoneInfo.TryConvertWindowsIdToIanaId(zone.Id, out var iana))
                    ids.Add(iana);
            }
            return ids.Count > 0 ? [.. ids] : null;
        }
        catch
        {
            return null;
        }
    }

    private static double? ParseDouble(string? raw) =>
        double.TryParse(raw, System.Globalization.CultureInfo.InvariantCulture, out var value) ? value : null;
}
