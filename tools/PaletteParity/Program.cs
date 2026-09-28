// Writes PaletteEngine.Derive for a fixed battery of themes, as JSON, to the file named on
// the command line: [{ "spec": {...}, "tokens": {...} }, ...]. tests/harness/
// paletteparity-run.js derives each spec with palette.js and compares every token.
//
// The battery: the stock theme, hand-picked edges (black on white, white on black, a grey
// accent, text equal to the background, short and malformed hex, the opacity bounds), and
// 400 themes from a fixed-seed generator, so the same themes come out on every run.
using System.Text.Json;
using System.Text.Json.Nodes;
using Plinth.App;
using Plinth.Widgets;

if (args.Length != 1)
{
    Console.Error.WriteLine("usage: PaletteParity <out.json>");
    return 2;
}

var specs = new List<ThemeSpec>
{
    new(),
    new() { Accent = "#000000", Background = "#ffffff", Text = "#000000" },
    new() { Accent = "#ffffff", Background = "#000000", Text = "#ffffff" },
    new() { Accent = "#808080", Background = "#101010", Text = "#e0e0e0" },
    new() { Accent = "#4dd4e8", Background = "#202020", Text = "#202020" },
    new() { Accent = "#f0f", Background = "#fff", Text = "#123" },
    new() { Accent = "not a colour", Background = "", Text = null },
    new() { Accent = "#ff0000", Background = "#f5f0e6", Text = "#1a1a1a", PanelAlpha = 0.15 },
    new() { Accent = "#00ff00", Background = "#0b0f14", Text = "#ffffff", PanelAlpha = 1.0 },
    new() { Accent = "#7a5cff", Background = "#e8e6e1", Text = "#12161a", PanelAlpha = 0.5 },
    new() { Accent = "#ffae52", Background = "#1b1b1f", Text = "#c8c8c8", PanelAlpha = 0.05 },
};
uint state = 0x2545F491;
uint Next() { state = state * 1664525 + 1013904223; return state; }
string Colour() => "#" + (Next() >> 8 & 0xffffff).ToString("x6");
for (var i = 0; i < 400; i++)
    specs.Add(new ThemeSpec { Accent = Colour(), Background = Colour(), Text = Colour(), PanelAlpha = 0.15 + (Next() % 86) / 100.0 });

var list = new JsonArray();
foreach (var spec in specs)
{
    var tokens = new JsonObject();
    foreach (var (k, v) in PaletteEngine.Derive(spec))
        tokens[k] = v;
    list.Add(new JsonObject
    {
        ["spec"] = new JsonObject
        {
            ["accent"] = spec.Accent, ["background"] = spec.Background, ["text"] = spec.Text,
            ["panelAlpha"] = spec.PanelAlpha,
        },
        ["tokens"] = tokens,
    });
}
File.WriteAllText(args[0], list.ToJsonString(new JsonSerializerOptions { WriteIndented = false }));
Console.WriteLine($"wrote {specs.Count} derived themes");
return 0;

namespace Plinth
{
    // Stand-ins for the app-side helpers LayoutStore.cs refers to. The probe only derives
    // palettes; nothing here is reached.
    internal static class Log
    {
        public static void Info(string message) { }
        public static void Warn(string message) { }
        public static void Error(string message) { }
    }

    internal static class AppPaths
    {
        public static string LayoutFile => Path.Combine(Path.GetTempPath(), "ww-palette-probe-layout.json");
        public static string BackgroundsDir => Path.GetTempPath();
    }

    internal static class DurableStore
    {
        public static void Write(string path, string contents) => File.WriteAllText(path, contents);
    }
}
