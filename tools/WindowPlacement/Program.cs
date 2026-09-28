// Where the settings window opens, and how big (src/Plinth/App/WindowPlacement.cs).
//
// It used to open at a fixed 1000x640 PHYSICAL pixels. WebView2 renders at the display's
// scale, so at 150% the page got about 667x427 CSS pixels, under the 780x480 its layout
// is built for, and the header's buttons wrapped into tall blocks. Sizes are logical now,
// scaled by the display's DPI; a first open takes a share of the screen; after that the
// window opens where it was left.
using System.Drawing;
using Plinth.App;
using static Plinth.App.WindowPlacement;

var failures = 0;
void Check(string name, bool ok, string? detail = null)
{
    Console.WriteLine($"  {(ok ? "PASS" : "FAIL")} {name}{(detail is null ? "" : " - " + detail)}");
    if (!ok) failures++;
}

// A 1440p monitor at 150% (the field report), a 1080p one at 100%, the panel, and a 4K.
var qhd150 = new Display(new Rectangle(0, 0, 2560, 1392), 144, false, true);
var fhd100 = new Display(new Rectangle(2560, 0, 1920, 1032), 96, false, false);
var panel = new Display(new Rectangle(-1280, 0, 1280, 400), 96, true, false);
var uhd100 = new Display(new Rectangle(0, 0, 3840, 2112), 96, false, true);

Console.WriteLine("First open");

// W1 · the field report's display: the page must get at least the layout's 780x480 in CSS
// pixels, which at 150% is 1170x720 physical. A share of the screen gives it far more.
var (w1, w1d) = Choose([qhd150, fhd100, panel], 0, null);
Check("W1 at 150% the window is a share of the screen, well over the logical minimum",
    w1.Bounds.Width == 2176 && w1.Bounds.Height == 1183 && !w1.Maximized && w1d == qhd150,
    $"{w1.Bounds}");
Check("W1b ...centred in the working area",
    w1.Bounds.X == (2560 - 2176) / 2 && w1.Bounds.Y == (1392 - 1183) / 2, $"{w1.Bounds.Location}");
Check("W1c ...and its minimum is the layout's 780x480 at 150%",
    MinimumFor(qhd150) == new Size(1170, 720), $"{MinimumFor(qhd150)}");
Check("W1d the old fixed 1000x640 would have been under that minimum",
    1000 < MinimumFor(qhd150).Width && 640 < MinimumFor(qhd150).Height);

// W2 · the same rule at 100% on the display under the cursor: 85% of 1920 is 1632,
// which the 1600 cap takes down; 85% of the height is 877.
var (w2, w2d) = Choose([qhd150, fhd100, panel], 1, null);
Check("W2 it opens on the display under the cursor, sized for that display",
    w2d == fhd100 && w2.Bounds == new Rectangle(2560 + (1920 - 1600) / 2, (1032 - 877) / 2, 1600, 877),
    $"{w2.Bounds}");
Check("W2b ...where the minimum is the plain 780x480", MinimumFor(fhd100) == new Size(780, 480));

// W3 · a very large screen: capped, since past it the canvas is already native size.
var (w3, _) = Choose([uhd100], 0, null);
Check("W3 a very large screen caps the first open at 1600x1000 logical",
    w3.Bounds.Size == new Size(1600, 1000), $"{w3.Bounds}");
var (w3b, _) = Choose([uhd100 with { Dpi = 192 }], 0, null);
Check("W3b ...scaled by the display's DPI (3200x1795 at 200%, under its 3200x2000 cap)",
    w3b.Bounds.Size == new Size(3200, 1795), $"{w3b.Bounds}");

// W4 · a screen smaller than the minimum at its scale: the whole working area, no more.
var tiny = new Display(new Rectangle(0, 0, 800, 560), 144, false, true);
var (w4, _) = Choose([tiny], 0, null);
Check("W4 a screen smaller than the minimum gets its whole working area",
    w4.Bounds == new Rectangle(0, 0, 800, 560) && MinimumFor(tiny) == new Size(800, 560), $"{w4.Bounds}");

// W5 · never on the panel: a 1280x400 screen cannot hold the window.
var (w5, w5d) = Choose([fhd100, panel, qhd150], 1, null);
Check("W5 with the cursor on the panel it opens on the primary", w5d == qhd150, $"{w5d.WorkingArea}");
var (_, w5bd) = Choose([panel with { IsPrimary = true }, fhd100], 0, null);
Check("W5b ...and with the panel as primary, on another display", w5bd == fhd100, $"{w5bd.WorkingArea}");

// W12 · the minimum is the PAGE's: a form's MinimumSize is its outer size, so the title
// bar and borders go on top of the scaled 780x480, or the page gets less than that.
var frame150 = new Size(24, 47);
Check("W12 the minimum adds the window's frame to the page's 780x480 at the display's scale",
    MinimumFor(qhd150, frame150) == new Size(1170 + 24, 720 + 47), $"{MinimumFor(qhd150, frame150)}");
Check("W12b ...still never more than the display can show",
    MinimumFor(tiny, frame150) == new Size(800, 560), $"{MinimumFor(tiny, frame150)}");

Console.WriteLine("Saved placement");

// W6 · where it was left, maximized or not.
var left = new Placement(new Rectangle(2700, 60, 1500, 900), true);
var (w6, w6d) = Choose([qhd150, fhd100, panel], 0, left);
Check("W6 a saved placement is reopened as it was, maximized included",
    w6 == left && w6d == fhd100, $"{w6.Bounds} max={w6.Maximized}");

// W7 · its display is gone: a first open instead, not a window off every screen.
var (w7, w7d) = Choose([qhd150, panel], 0, left);
Check("W7 a saved placement whose display is gone opens as a first open",
    w7d == qhd150 && w7.Bounds.Size == new Size(2176, 1183) && !w7.Maximized, $"{w7.Bounds}");

// W8 · it was left on the panel (dragged there): not reopened there.
var onPanel = new Placement(new Rectangle(-1200, 20, 900, 360), false);
var (_, w8d) = Choose([qhd150, fhd100, panel], 2, onPanel);
Check("W8 a placement saved on the panel is not reopened there", !w8d.IsPanel, $"{w8d.WorkingArea}");

// W9 · the display got smaller, or the window hung off an edge: fitted back on.
var big = new Placement(new Rectangle(2600, -40, 2500, 1400), false);
var (w9, _) = Choose([qhd150, fhd100], 0, big);
Check("W9 a saved size larger than its display is fitted inside it",
    w9.Bounds == new Rectangle(2560, 0, 1920, 1032), $"{w9.Bounds}");
var hanging = new Placement(new Rectangle(3900, 700, 900, 600), false);
var (w9b, _) = Choose([qhd150, fhd100], 0, hanging);
Check("W9b ...and one hanging off its right and bottom edges is moved on",
    w9b.Bounds == new Rectangle(4480 - 900, 1032 - 600, 900, 600), $"{w9b.Bounds}");

// W10 · saved under the minimum (the scale went up since): raised to it.
var small = new Placement(new Rectangle(100, 100, 900, 500), false);
var (w10, _) = Choose([qhd150], 0, small);
Check("W10 a saved size under the display's minimum is raised to it",
    w10.Bounds.Size == new Size(1170, 720), $"{w10.Bounds}");

Console.WriteLine("Stored form");

// W11 · the file round-trips, and anything else costs the position, never the window.
Check("W11 a placement round-trips through its stored form", Parse(Serialize(left)) == left);
foreach (var (label, text) in new[]
{
    ("empty", ""), ("not JSON", "{nope"), ("an array", "[1,2]"), ("a missing field", "{\"x\":1,\"y\":2,\"width\":3}"),
    ("a zero width", "{\"x\":1,\"y\":2,\"width\":0,\"height\":5}"), ("a fraction", "{\"x\":1.5,\"y\":2,\"width\":3,\"height\":5}"),
    ("a string", "{\"x\":\"1\",\"y\":2,\"width\":3,\"height\":5}"),
})
    Check($"W11 {label} reads as no saved placement", Parse(text) is null);
Check("W11c maximized defaults to false when absent",
    Parse("{\"x\":1,\"y\":2,\"width\":3,\"height\":5}") is { Maximized: false });

Console.WriteLine(failures == 0 ? "ALL PASS" : $"{failures} FAILURE(S)");
return failures == 0 ? 0 : 1;
