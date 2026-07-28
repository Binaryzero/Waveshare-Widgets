using System.Text.Json;
using System.Text.Json.Nodes;
using WaveshareWidgets.Widgets;

// Every value present in a shipped manifest must survive the host's round-trip —
// keys the model doesn't carry get stripped on their way to the settings window,
// and the field failure that causes (dead property panels) is invisible to the
// JS-fixture harnesses. Run from the repo root: dotnet run --project tools/ManifestRoundTrip

var widgetsDir = Path.Combine(Directory.GetCurrentDirectory(), "widgets");
if (!Directory.Exists(widgetsDir))
{
    Console.Error.WriteLine($"widgets/ not found under {Directory.GetCurrentDirectory()} — run from the repo root");
    return 2;
}

var failures = new List<string>();
var checkedCount = 0;
foreach (var dir in Directory.GetDirectories(widgetsDir).OrderBy(d => d))
{
    var manifestPath = Path.Combine(dir, "manifest.json");
    if (!File.Exists(manifestPath))
        continue;
    checkedCount++;
    var name = Path.GetFileName(dir);
    var text = File.ReadAllText(manifestPath);

    JsonNode original;
    WidgetManifest? manifest;
    try
    {
        original = JsonNode.Parse(text)!;
        manifest = JsonSerializer.Deserialize<WidgetManifest>(text);
    }
    catch (Exception ex)
    {
        failures.Add($"{name}: manifest does not parse — {ex.Message}");
        continue;
    }
    if (manifest is null)
    {
        failures.Add($"{name}: deserialized to null");
        continue;
    }

    var roundTripped = JsonSerializer.SerializeToNode(manifest)!;
    var diffs = new List<string>();
    SubsetCheck(original, roundTripped, "$", diffs);
    if (diffs.Count > 0)
        failures.Add($"{name}:\n    " + string.Join("\n    ", diffs));
}

if (failures.Count > 0)
{
    Console.Error.WriteLine("Manifest data LOST in the host round-trip (extend WidgetManifest/WidgetProperty):");
    foreach (var f in failures)
        Console.Error.WriteLine("  " + f);
    return 1;
}
Console.WriteLine($"manifest round-trip OK: {checkedCount} manifests, no data loss");
return 0;

// Every key/value in `original` must exist (deep-equal) in `round`; keys ADDED by the
// round-trip (materialized defaults, explicit nulls) are fine.
static void SubsetCheck(JsonNode? original, JsonNode? round, string path, List<string> diffs)
{
    switch (original)
    {
        case JsonObject obj:
            if (round is not JsonObject roundObj)
            {
                diffs.Add($"{path}: object became {Kind(round)}");
                return;
            }
            foreach (var (key, value) in obj)
            {
                if (!roundObj.TryGetPropertyValue(key, out var roundValue))
                {
                    diffs.Add($"{path}.{key}: KEY DROPPED");
                    continue;
                }
                SubsetCheck(value, roundValue, $"{path}.{key}", diffs);
            }
            return;

        case JsonArray arr:
            if (round is not JsonArray roundArr)
            {
                diffs.Add($"{path}: array became {Kind(round)}");
                return;
            }
            if (roundArr.Count != arr.Count)
            {
                diffs.Add($"{path}: array length {arr.Count} -> {roundArr.Count}");
                return;
            }
            for (var i = 0; i < arr.Count; i++)
                SubsetCheck(arr[i], roundArr[i], $"{path}[{i}]", diffs);
            return;

        case null:
            if (round is not null && round.GetValueKind() != JsonValueKind.Null)
                diffs.Add($"{path}: null became {Kind(round)}");
            return;

        default: // scalar
            if (round is JsonObject or JsonArray or null)
            {
                diffs.Add($"{path}: {Kind(original)} became {Kind(round)}");
                return;
            }
            var a = original.GetValueKind();
            var b = round.GetValueKind();
            if (a == JsonValueKind.Number && b == JsonValueKind.Number)
            {
                if (Math.Abs(original.GetValue<double>() - round.GetValue<double>()) > 1e-9)
                    diffs.Add($"{path}: {original.ToJsonString()} -> {round.ToJsonString()}");
            }
            else if (original.ToJsonString() != round.ToJsonString())
            {
                diffs.Add($"{path}: {original.ToJsonString()} -> {round.ToJsonString()}");
            }
            return;
    }
}

static string Kind(JsonNode? node) => node switch
{
    null => "missing",
    JsonObject => "object",
    JsonArray => "array",
    _ => node.GetValueKind().ToString().ToLowerInvariant(),
};
