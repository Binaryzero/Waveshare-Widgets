using Plinth.Widgets;

namespace Plinth.App;

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
        var accent = ParseHex(spec.Accent, 0x4d, 0xd4, 0xe8);
        var background = ParseHex(spec.Background, 0x07, 0x0b, 0x12);
        var text = ParseHex(spec.Text, 0xdd, 0xe2, 0xe8);
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

        // Contrast guard: repair each role against the surfaces it renders on. Muted is
        // repaired against both of its surfaces in one pass — sequential repairs can
        // flip direction between mid-tone surfaces and undo the first guarantee.
        text = EnsureContrast(text, surface, TextContrast);
        muted = EnsureContrast(muted, [surface, surfaceAlt], MutedContrast);
        dim = EnsureContrast(dim, surface, DimContrast);

        // State colors: fixed hues repaired for the theme's surfaces — including the
        // 14% tints of themselves that pills and state icons composite on top.
        var ok = EnsureStateContrast((0x45, 0xd4, 0x83), surface, surfaceAlt);
        var warn = EnsureStateContrast((0xff, 0xae, 0x52), surface, surfaceAlt);
        var err = EnsureStateContrast((0xff, 0x62, 0x68), surface, surfaceAlt);
        var info = EnsureStateContrast((0x62, 0xcb, 0xea), surface, surfaceAlt);

        // Readable foreground on accent: compare the candidates actually emitted — on a
        // mid-tone accent pure black can edge out white while the near-black loses to it.
        var nearBlack = (r: (byte)0x0a, g: (byte)0x0a, b: (byte)0x0a);
        var white = (r: (byte)0xff, g: (byte)0xff, b: (byte)0xff);
        var onAccent = Contrast(accent, nearBlack) >= Contrast(accent, white) ? nearBlack : white;

        // Accent as a FOREGROUND: the seed itself is never repaired (it is the user's
        // exact pick, used for fills and glows), but outlined controls draw text and
        // borders in it directly, and an accent near the background disappears there.
        var accentFg = EnsureContrast(accent, [surface, surfaceAlt], StateContrast);

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
            ["--accent-fg"] = Hex(accentFg),
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
        (byte r, byte g, byte b) color, (byte r, byte g, byte b) surface, double target) =>
        EnsureContrast(color, [surface], target);

    /// <summary>
    /// State-color repair: meets <see cref="StateContrast"/> on both surfaces AND on the
    /// 14% tint of itself composited over each (the `.pill` / state-icon backgrounds).
    /// The tint tracks the color being repaired, so the constraint is a moving target —
    /// iterate to the fixed point; each pass only moves toward a pole, so it settles.
    /// </summary>
    private static (byte r, byte g, byte b) EnsureStateContrast(
        (byte r, byte g, byte b) seed, (byte r, byte g, byte b) surface, (byte r, byte g, byte b) surfaceAlt)
    {
        double OwnMin((byte r, byte g, byte b) c)
        {
            var min = Math.Min(Contrast(c, surface), Contrast(c, surfaceAlt));
            min = Math.Min(min, Contrast(c, Mix(surface, c, 0.14)));
            return Math.Min(min, Contrast(c, Mix(surfaceAlt, c, 0.14)));
        }

        var c = EnsureContrast(seed, [surface, surfaceAlt], StateContrast);
        for (var i = 0; i < 6; i++)
        {
            var next = EnsureContrast(
                c, [surface, surfaceAlt, Mix(surface, c, 0.14), Mix(surfaceAlt, c, 0.14)], StateContrast);
            if (next == c)
                break;
            c = next;
        }

        if (OwnMin(c) < StateContrast)
        {
            // Ratio unreachable on this theme (the composite chases the color toward the
            // pole): settle on whichever pole does best against its own tints, if that
            // beats where the iteration stopped.
            var white = ((byte)0xff, (byte)0xff, (byte)0xff);
            var black = ((byte)0x00, (byte)0x00, (byte)0x00);
            var pole = OwnMin(white) >= OwnMin(black) ? white : black;
            if (OwnMin(pole) > OwnMin(c))
                c = pole;
        }
        return c;
    }

    /// <summary>
    /// Multi-surface repair: the returned color meets <paramref name="target"/> on every
    /// surface at once. (Repairing for one surface and then re-repairing for another can
    /// flip the repair direction on mid-tone themes and undo the first guarantee, so
    /// roles that render on several surfaces must be repaired in a single pass.)
    /// </summary>
    private static (byte r, byte g, byte b) EnsureContrast(
        (byte r, byte g, byte b) color, (byte r, byte g, byte b)[] surfaces, double target)
    {
        double MinContrast((byte r, byte g, byte b) c)
        {
            var min = double.MaxValue;
            foreach (var s in surfaces)
                min = Math.Min(min, Contrast(c, s));
            return min;
        }

        if (MinContrast(color) >= target)
            return color;

        // Prefer the tone-appropriate pole, but switch to the opposite one when it can't
        // reach the ratio and the opposite pole does better — a mid-tone surface like
        // #999 caps white at ~2.7:1 while black exceeds 7:1.
        var towardWhite = Luminance(surfaces[0]) < 0.5;
        var pole = towardWhite ? ((byte)0xff, (byte)0xff, (byte)0xff) : ((byte)0x00, (byte)0x00, (byte)0x00);
        if (MinContrast(pole) < target)
        {
            var opposite = towardWhite ? ((byte)0x00, (byte)0x00, (byte)0x00) : ((byte)0xff, (byte)0xff, (byte)0xff);
            if (MinContrast(opposite) > MinContrast(pole))
                pole = opposite;
            if (MinContrast(pole) < target)
                return pole; // theme is extreme; this pole is the best available
        }

        double lo = 0, hi = 1;
        for (var i = 0; i < 18; i++)
        {
            var mid = (lo + hi) / 2;
            if (MinContrast(Mix(color, pole, mid)) >= target)
                hi = mid;
            else
                lo = mid;
        }
        return Mix(color, pole, hi);
    }
}
