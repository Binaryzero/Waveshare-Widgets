using WaveshareWidgets.Widgets;

namespace WaveshareWidgets.App;

/// <summary>
/// Derives the full design-token palette every widget consumes from the three colors a
/// user actually picks (accent, background, text) plus a panel-opacity level. Surfaces,
/// text tiers, lines and state colors are mixed from those seeds, then run through a
/// WCAG contrast guard that repairs any role which would be unreadable on the surfaces
/// it appears on — so any theme the user invents stays legible in every widget.
/// </summary>
public static class PaletteEngine
{
    /// <summary>Contrast targets (WCAG ratios) per text tier.</summary>
    private const double TextContrast = 7.0;
    private const double MutedContrast = 4.5;
    private const double DimContrast = 3.0;
    private const double StateContrast = 4.5;

    public static Dictionary<string, string> Derive(ThemeSpec? theme)
    {
        var spec = theme ?? new ThemeSpec();
        var accent = ParseHex(spec.Accent, 0x4c, 0xc2, 0xff);
        var background = ParseHex(spec.Background, 0x05, 0x07, 0x0b);
        var text = ParseHex(spec.Text, 0xe8, 0xec, 0xf2);
        var panelAlpha = Math.Clamp(spec.PanelAlpha, 0.15, 1.0);

        // Tone is decided by the *derived surface*, not the label the user picked, so
        // an imported light theme still gets light-appropriate mixing ratios.
        var dark = Luminance(background) < 0.35;

        // Surfaces: pull the background toward the text color a little (dark themes
        // lighten, light themes darken — mixing toward text does both correctly).
        var surface = Mix(background, text, dark ? 0.055 : 0.035);
        var surfaceAlt = Mix(background, text, dark ? 0.10 : 0.07);
        var control = Mix(background, text, dark ? 0.15 : 0.11);

        // Text tiers and hairlines are text pulled toward the background.
        var muted = Mix(text, surface, 0.42);
        var dim = Mix(text, surface, 0.60);
        var line = Mix(text, surface, 0.78);

        // Contrast guard: repair each role against the surfaces it renders on.
        text = EnsureContrast(text, surface, TextContrast);
        muted = EnsureContrast(muted, surface, MutedContrast);
        muted = EnsureContrast(muted, surfaceAlt, MutedContrast);
        dim = EnsureContrast(dim, surface, DimContrast);

        // State colors: fixed hues repaired for the theme's surfaces.
        var ok = EnsureContrast((0x45, 0xd4, 0x83), surface, StateContrast);
        var warn = EnsureContrast((0xf0, 0xb8, 0x4f), surface, StateContrast);
        var err = EnsureContrast((0xff, 0x62, 0x68), surface, StateContrast);
        var info = EnsureContrast((0x62, 0xcb, 0xea), surface, StateContrast);

        // Readable foreground on accent: black or white, whichever contrasts more.
        var onAccent = Contrast(accent, (0, 0, 0)) >= Contrast(accent, (0xff, 0xff, 0xff))
            ? (r: (byte)0x0a, g: (byte)0x0a, b: (byte)0x0a)
            : (r: (byte)0xff, g: (byte)0xff, b: (byte)0xff);

        var hover = Mix(surface, text, 0.08);

        return new Dictionary<string, string>
        {
            ["--bg"] = Hex(background),
            ["--surface"] = Hex(surface),
            ["--surface-rgb"] = Rgb(surface),
            ["--surface-alt"] = Hex(surfaceAlt),
            ["--surface-alt-rgb"] = Rgb(surfaceAlt),
            ["--control-bg"] = Hex(control),
            ["--text"] = Hex(text),
            ["--text-muted"] = Hex(muted),
            ["--text-dim"] = Hex(dim),
            ["--line"] = Hex(line),
            ["--accent"] = Hex(accent),
            ["--accent-rgb"] = Rgb(accent),
            ["--on-accent"] = Hex(onAccent),
            ["--ok"] = Hex(ok),
            ["--warn"] = Hex(warn),
            ["--err"] = Hex(err),
            ["--info"] = Hex(info),
            ["--ok-bg"] = Tint(ok),
            ["--warn-bg"] = Tint(warn),
            ["--err-bg"] = Tint(err),
            ["--info-bg"] = Tint(info),
            ["--hover-bg"] = Hex(hover),
            ["--panel-alpha"] = panelAlpha.ToString("0.###", System.Globalization.CultureInfo.InvariantCulture),
            ["--appearance"] = dark ? "dark" : "light",
        };
    }

    // ---- color math -------------------------------------------------------------

    private static (byte r, byte g, byte b) ParseHex(string? hex, byte dr, byte dg, byte db)
    {
        if (string.IsNullOrWhiteSpace(hex))
            return (dr, dg, db);
        var h = hex.Trim().TrimStart('#');
        if (h.Length == 3)
            h = $"{h[0]}{h[0]}{h[1]}{h[1]}{h[2]}{h[2]}";
        if (h.Length != 6 || !int.TryParse(h, System.Globalization.NumberStyles.HexNumber, null, out var v))
            return (dr, dg, db);
        return ((byte)(v >> 16), (byte)(v >> 8 & 0xff), (byte)(v & 0xff));
    }

    private static string Hex((byte r, byte g, byte b) c) => $"#{c.r:x2}{c.g:x2}{c.b:x2}";
    private static string Rgb((byte r, byte g, byte b) c) => $"{c.r}, {c.g}, {c.b}";
    private static string Tint((byte r, byte g, byte b) c) => $"rgba({c.r}, {c.g}, {c.b}, 0.14)";

    private static (byte r, byte g, byte b) Mix((byte r, byte g, byte b) a, (byte r, byte g, byte b) b, double t) =>
        ((byte)Math.Round(a.r + (b.r - a.r) * t),
         (byte)Math.Round(a.g + (b.g - a.g) * t),
         (byte)Math.Round(a.b + (b.b - a.b) * t));

    private static double Luminance((byte r, byte g, byte b) c)
    {
        static double Channel(byte v)
        {
            var s = v / 255.0;
            return s <= 0.03928 ? s / 12.92 : Math.Pow((s + 0.055) / 1.055, 2.4);
        }
        return 0.2126 * Channel(c.r) + 0.7152 * Channel(c.g) + 0.0722 * Channel(c.b);
    }

    private static double Contrast((byte r, byte g, byte b) a, (byte r, byte g, byte b) b)
    {
        var la = Luminance(a);
        var lb = Luminance(b);
        var (hi, lo) = la > lb ? (la, lb) : (lb, la);
        return (hi + 0.05) / (lo + 0.05);
    }

    /// <summary>
    /// Repairs <paramref name="color"/> until it reaches <paramref name="target"/>
    /// contrast on <paramref name="surface"/>, by binary-searching a mix toward black
    /// or white (whichever direction helps). Colors that already pass are untouched.
    /// </summary>
    private static (byte r, byte g, byte b) EnsureContrast(
        (byte r, byte g, byte b) color, (byte r, byte g, byte b) surface, double target)
    {
        if (Contrast(color, surface) >= target)
            return color;

        var towardWhite = Luminance(surface) < 0.5;
        var pole = towardWhite ? ((byte)0xff, (byte)0xff, (byte)0xff) : ((byte)0x00, (byte)0x00, (byte)0x00);
        if (Contrast(pole, surface) < target)
            return pole; // theme is extreme; the pole is the best available

        double lo = 0, hi = 1;
        for (var i = 0; i < 18; i++)
        {
            var mid = (lo + hi) / 2;
            if (Contrast(Mix(color, pole, mid), surface) >= target)
                hi = mid;
            else
                lo = mid;
        }
        return Mix(color, pole, hi);
    }
}
