// Issue #114 item 3 — live Stream Deck capture had no rate or size limit.
//
// A capture is a synchronous PrintWindow, a full-bitmap scan, a JPEG encode and a base64,
// all on the UI thread. The API invites polling and nothing put a floor under "faster", so a
// widget could degrade the dashboard without being hostile. The capture itself needs
// Windows, a running Stream Deck and a window handle; the two decisions are arithmetic.
using WaveshareWidgets.App;

var failures = 0;
void Check(string name, bool ok, string? detail = null)
{
    Console.WriteLine($"  {(ok ? "PASS" : "FAIL")} {name}{(detail is null ? "" : " - " + detail)}");
    if (!ok) failures++;
}

Console.WriteLine("Rate");

// K1 · the boundary, both sides. The interval is a floor on the worst case, so exactly the
// interval must be allowed — off-by-one here silently halves the achievable frame rate.
Check("K1 a capture exactly one interval later is allowed",
    !CaptureLimits.TooSoon(1000, 1000 + CaptureLimits.MinIntervalMs));
Check("K1b one millisecond sooner is refused",
    CaptureLimits.TooSoon(1000, 1000 + CaptureLimits.MinIntervalMs - 1));
Check("K1c an immediate repeat is refused", CaptureLimits.TooSoon(1000, 1000));

// K2 · the intended caller must not notice. The widget polls about four times a second;
// a limit that bit at that rate would be a bug dressed as a fix.
Check("K2 a 250 ms poll — what the stock widget does — is never refused",
    !CaptureLimits.TooSoon(1000, 1250) && CaptureLimits.MinIntervalMs < 250,
    $"floor {CaptureLimits.MinIntervalMs} ms");

// K3 · the states that are not a rate at all. "No capture yet" and a clock that appears to
// run backwards (a resumed machine) must not wedge capture permanently — refusing forever
// is the failure mode that looks exactly like the deck being broken.
Check("K3 the first capture is never too soon", !CaptureLimits.TooSoon(0, 5000));
Check("K3b a negative or absent stamp is not too soon", !CaptureLimits.TooSoon(-1, 5000));
Check("K3c a clock that moved backwards does not block capture", !CaptureLimits.TooSoon(9000, 1000));

Console.WriteLine("Size");

// K4 · dimensions, checked before the bitmap is allocated.
Check("K4 an ordinary VSD window is sane", CaptureLimits.SaneSize(1200, 500));
Check("K4b the largest allowed edge is still sane",
    CaptureLimits.SaneSize(CaptureLimits.MaxEdgePixels, CaptureLimits.MaxEdgePixels));
Check("K4c one pixel over is refused",
    !CaptureLimits.SaneSize(CaptureLimits.MaxEdgePixels + 1, 100)
    && !CaptureLimits.SaneSize(100, CaptureLimits.MaxEdgePixels + 1));
Check("K4d zero and negative are refused",
    !CaptureLimits.SaneSize(0, 500) && !CaptureLimits.SaneSize(500, 0) && !CaptureLimits.SaneSize(-4, -4));

// K5 · the encoded frame. A real VSD capture is a few hundred KB, so the ceiling must sit
// well above that or live mirroring stops working for everyone.
Check("K5 a realistic frame is not too large", !CaptureLimits.EncodedTooLarge(400 * 1024));
Check("K5b exactly the ceiling is allowed", !CaptureLimits.EncodedTooLarge(CaptureLimits.MaxEncodedBytes));
Check("K5c one byte over is refused", CaptureLimits.EncodedTooLarge(CaptureLimits.MaxEncodedBytes + 1));
Check("K5d the ceiling leaves real captures plenty of room",
    CaptureLimits.MaxEncodedBytes >= 1024 * 1024, $"{CaptureLimits.MaxEncodedBytes} bytes");

Console.WriteLine("Wired up");

// K6 · a TEXT assertion, and labelled as one. The values above being right proves nothing
// about the capture asking them, and "computed but not used" has been the recurring defect
// in this repo — a ceiling passed to a method that substituted its own, twice. The capture
// needs Windows and a live Stream Deck, so its call sites cannot be driven from here.
var bridge = FindUpwards("src/WaveshareWidgets/App/StreamDeckBridge.cs");
if (bridge is null)
{
    Check("K6 setup: StreamDeckBridge.cs was found", false);
}
else
{
    var code = File.ReadAllText(bridge);
    Check("K6 the capture checks the window size before allocating a bitmap",
        code.Contains("CaptureLimits.SaneSize(rect.Right, rect.Bottom)")
        && code.IndexOf("CaptureLimits.SaneSize", StringComparison.Ordinal)
           < code.IndexOf("new Bitmap(", StringComparison.Ordinal));
    Check("K6b it enforces the rate floor", code.Contains("CaptureLimits.TooSoon(_lastCaptureMs"));
    Check("K6c and it refuses an oversized encoded frame",
        code.Contains("CaptureLimits.EncodedTooLarge(ms.Length)"));
}

static string? FindUpwards(string relative)
{
    var dir = new DirectoryInfo(AppContext.BaseDirectory);
    while (dir is not null)
    {
        var candidate = Path.Combine(dir.FullName, relative.Replace('/', Path.DirectorySeparatorChar));
        if (File.Exists(candidate)) return candidate;
        dir = dir.Parent;
    }
    return null;
}

Console.WriteLine(failures == 0 ? "ALL PASS" : $"{failures} FAILURES");
return failures == 0 ? 0 : 1;
