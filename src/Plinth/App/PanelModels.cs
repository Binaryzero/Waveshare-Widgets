using System.Drawing;

namespace Plinth.App;

/// <summary>
/// The displays Plinth recognises as its panel, by exact pixel size, and the page size the
/// dashboard lays out at on one. Pure arithmetic, so tools/WindowPlacement can drive it
/// without Windows.
///
/// <para>The dashboard's grid is 4 columns by 2 rows of equal fractions, so it fills any
/// panel; what differs between models is only how the app finds the display and how big the
/// settings window's preview must be to show the same tiles.</para>
/// </summary>
public static class PanelModels
{
    /// <summary>A supported panel: its name and its landscape resolution.</summary>
    public readonly record struct Model(string Name, int Width, int Height)
    {
        public Size Size => new(Width, Height);
    }

    /// <summary>The Waveshare 7.9" HDMI LCD. Its native scanout is portrait, so Windows
    /// can still report it as 400x1280 until the user rotates it; that is recognised too,
    /// so the dashboard appears while the README's rotation step is still to do.</summary>
    public static readonly Model Waveshare = new("Waveshare 7.9\"", 1280, 400);

    /// <summary>The Corsair XENEON EDGE, a 14.5" 2560x720 touch display. Landscape only:
    /// its native orientation is landscape, and the grid is a landscape strip.</summary>
    public static readonly Model XeneonEdge = new("Corsair XENEON EDGE", 2560, 720);

    public static readonly IReadOnlyList<Model> All = [Waveshare, XeneonEdge];

    /// <summary>For messages: every supported size, e.g. for "no panel found".</summary>
    public static string Sizes => string.Join(" or ", All.Select(m => $"{m.Width}x{m.Height}"));

    /// <summary>Which supported panel a display of this pixel size is, or null. Exact:
    /// a width alone would take a 2560x1440 monitor for the XENEON EDGE.</summary>
    public static Model? Match(Size pixels)
    {
        foreach (var m in All)
            if (pixels == m.Size) return m;
        if (pixels == new Size(Waveshare.Height, Waveshare.Width)) return Waveshare;
        return null;
    }

    /// <summary>The page size, in CSS pixels, the dashboard's WebView lays out at on a
    /// display of these physical pixels. The app is per-monitor DPI aware and WebView2
    /// renders at the monitor's scale, so at 150% a 2560x720 panel is a 1707x480 page. The
    /// settings window's preview is drawn at this size, so its tiles are the panel's.</summary>
    public static Size CssSize(Size pixels, int dpi)
    {
        var factor = (dpi > 0 ? dpi : 96) / 96.0;
        return new Size(
            Math.Max(1, (int)Math.Round(pixels.Width / factor)),
            Math.Max(1, (int)Math.Round(pixels.Height / factor)));
    }
}
