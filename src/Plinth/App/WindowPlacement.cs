using System.Drawing;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Plinth.App;

/// <summary>
/// Where the settings window opens, and how big. Pure arithmetic over the displays it is
/// handed, so tools/WindowPlacement can drive it without Windows.
///
/// The window used to open at a fixed 1000x640 PHYSICAL pixels. The app is per-monitor
/// DPI aware and WebView2 renders at the monitor's scale, so at 150% that left the page
/// about 667x427 CSS pixels: under the 780x480 the layout is built for, which is why the
/// header's buttons wrapped into tall blocks. Sizes here are LOGICAL (96 dpi) and scaled
/// by the display's own DPI, and a first open takes a share of the screen rather than a
/// constant. After that the window opens where the user last left it.
/// </summary>
public static class WindowPlacement
{
    /// <summary>A display as the placement sees it: its working area in physical pixels,
    /// its effective DPI, whether it is the panel, and whether it is the primary.</summary>
    public readonly record struct Display(Rectangle WorkingArea, int Dpi, bool IsPanel, bool IsPrimary);

    /// <summary>The window's normal (restored) bounds in physical pixels, and whether it
    /// was maximized over them.</summary>
    public readonly record struct Placement(Rectangle Bounds, bool Maximized);

    /// <summary>The smallest window the page's layout is built for (settings.css).</summary>
    public static readonly Size LogicalMinimum = new(780, 480);

    /// <summary>A first open never exceeds this, however large the screen: past it the
    /// canvas is already at native size and the extra is only empty width.</summary>
    public static readonly Size LogicalCap = new(1600, 1000);

    /// <summary>A first open's share of the screen's working area.</summary>
    public const double ShareOfScreen = 0.85;

    public static Size Scale(Size logical, int dpi)
    {
        var factor = (dpi > 0 ? dpi : 96) / 96.0;
        return new Size((int)Math.Round(logical.Width * factor), (int)Math.Round(logical.Height * factor));
    }

    /// <summary>The window's minimum size on a display: the logical minimum at that
    /// display's DPI, plus the window's frame (title bar and borders), but never more than
    /// the display can show. The minimum is for the PAGE, which gets the client area, and
    /// a form's MinimumSize is its outer size: without the frame the page got less than
    /// 780x480 at the smallest size the window allowed.</summary>
    public static Size MinimumFor(Display display, Size frame = default)
    {
        var min = Scale(LogicalMinimum, display.Dpi);
        return new Size(
            Math.Min(min.Width + Math.Max(0, frame.Width), display.WorkingArea.Width),
            Math.Min(min.Height + Math.Max(0, frame.Height), display.WorkingArea.Height));
    }

    /// <summary>
    /// Where to open. A saved placement is kept when its centre is still on a display
    /// that is not the panel, fitted to that display. Otherwise a first-open size on the
    /// display under the cursor, unless that is the panel: then the primary, then any
    /// other. The display it chose comes back with it, for the minimum size.
    /// </summary>
    public static (Placement Placement, Display Display) Choose(
        IReadOnlyList<Display> displays, int cursorDisplay, Placement? saved)
    {
        if (displays.Count == 0)
        {
            var none = new Display(new Rectangle(0, 0, 1280, 800), 96, false, true);
            return (new Placement(Centered(none), false), none);
        }

        if (saved is { } s && s.Bounds.Width > 0 && s.Bounds.Height > 0)
        {
            var centre = new Point(s.Bounds.X + s.Bounds.Width / 2, s.Bounds.Y + s.Bounds.Height / 2);
            foreach (var d in displays)
            {
                if (!d.IsPanel && d.WorkingArea.Contains(centre))
                    return (new Placement(Fit(s.Bounds, d), s.Maximized), d);
            }
        }

        var home = Home(displays, cursorDisplay);
        return (new Placement(Centered(home), false), home);
    }

    /// <summary>A rectangle kept on its display: no larger than the working area, no
    /// smaller than the minimum, and moved inside it.</summary>
    public static Rectangle Fit(Rectangle bounds, Display display)
    {
        var area = display.WorkingArea;
        var min = MinimumFor(display);
        var w = Math.Clamp(bounds.Width, min.Width, area.Width);
        var h = Math.Clamp(bounds.Height, min.Height, area.Height);
        var x = Math.Clamp(bounds.X, area.Left, area.Right - w);
        var y = Math.Clamp(bounds.Y, area.Top, area.Bottom - h);
        return new Rectangle(x, y, w, h);
    }

    /// <summary>A first open: a share of the working area, capped, at least the minimum,
    /// centred.</summary>
    public static Rectangle Centered(Display display)
    {
        var area = display.WorkingArea;
        var min = MinimumFor(display);
        var cap = Scale(LogicalCap, display.Dpi);
        var w = Math.Clamp((int)(area.Width * ShareOfScreen), min.Width, Math.Max(min.Width, Math.Min(cap.Width, area.Width)));
        var h = Math.Clamp((int)(area.Height * ShareOfScreen), min.Height, Math.Max(min.Height, Math.Min(cap.Height, area.Height)));
        return new Rectangle(area.Left + (area.Width - w) / 2, area.Top + (area.Height - h) / 2, w, h);
    }

    private static Display Home(IReadOnlyList<Display> displays, int cursorDisplay)
    {
        if (cursorDisplay >= 0 && cursorDisplay < displays.Count && !displays[cursorDisplay].IsPanel)
            return displays[cursorDisplay];
        foreach (var d in displays)
            if (d.IsPrimary && !d.IsPanel) return d;
        foreach (var d in displays)
            if (!d.IsPanel) return d;
        return cursorDisplay >= 0 && cursorDisplay < displays.Count ? displays[cursorDisplay] : displays[0];
    }

    public static string Serialize(Placement placement) => new JsonObject
    {
        ["x"] = placement.Bounds.X,
        ["y"] = placement.Bounds.Y,
        ["width"] = placement.Bounds.Width,
        ["height"] = placement.Bounds.Height,
        ["maximized"] = placement.Maximized,
    }.ToJsonString();

    /// <summary>A saved placement, or null for anything that is not one: a missing or
    /// hand-edited file must cost the saved position, never the window.</summary>
    public static Placement? Parse(string? json)
    {
        if (string.IsNullOrWhiteSpace(json)) return null;
        try
        {
            if (JsonNode.Parse(json) is not JsonObject o) return null;
            static int? Int(JsonNode? n) =>
                n is JsonValue v && v.TryGetValue<int>(out var i) ? i : null;
            if (Int(o["x"]) is not { } x || Int(o["y"]) is not { } y
                || Int(o["width"]) is not { } w || Int(o["height"]) is not { } h
                || w <= 0 || h <= 0)
                return null;
            var maximized = o["maximized"] is JsonValue m && m.TryGetValue<bool>(out var b) && b;
            return new Placement(new Rectangle(x, y, w, h), maximized);
        }
        catch (JsonException)
        {
            return null;
        }
    }
}
