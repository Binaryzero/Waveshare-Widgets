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
// The edge bound still has to admit a long, thin window — the area bound is a second
// constraint, not a replacement. (This check used to pass MaxEdgePixels on BOTH axes, which
// the area bound now correctly refuses; it was encoding the contract before K4e existed.)
Check("K4b the largest allowed edge is sane when the area allows it",
    CaptureLimits.SaneSize(CaptureLimits.MaxEdgePixels, CaptureLimits.MaxTotalPixels / CaptureLimits.MaxEdgePixels));
Check("K4c one pixel over is refused",
    !CaptureLimits.SaneSize(CaptureLimits.MaxEdgePixels + 1, 100)
    && !CaptureLimits.SaneSize(100, CaptureLimits.MaxEdgePixels + 1));
// K4e · the edge bound is not a budget on its own. 8192x8192 satisfies it and is 64
// megapixels — about 256 MiB of bitmap, allocated and then PrintWindow'd, hashed and
// JPEG-encoded on the UI thread before the encoded-size ceiling downstream can refuse the
// result. That ceiling cannot give the allocation back.
Check("K4e a window within the edge bound but enormous in area is refused",
    !CaptureLimits.SaneSize(CaptureLimits.MaxEdgePixels, CaptureLimits.MaxEdgePixels),
    $"{CaptureLimits.MaxEdgePixels}x{CaptureLimits.MaxEdgePixels}");
Check("K4f the area bound leaves a real VSD window far inside it",
    CaptureLimits.SaneSize(1200, 500) && CaptureLimits.MaxTotalPixels >= 2_000_000,
    $"{CaptureLimits.MaxTotalPixels} px");
Check("K4g exactly the area bound is allowed, one pixel over is not",
    CaptureLimits.SaneSize(CaptureLimits.MaxTotalPixels / 1000, 1000)
    && !CaptureLimits.SaneSize(CaptureLimits.MaxTotalPixels / 1000 + 1, 1000));
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
    // K6d · the two limits keep SEPARATE one-time-log latches. Sharing one means whichever
    // trips first silences the other for the process lifetime — and these warnings are the
    // only reason a refused capture is visible at all, so a silenced one is a refusal that
    // presents as the deck simply not working.
    // K6e · the throttle must REUSE, not report unavailable. HandleSdCapture assigns this
    // result straight into its own cache, so a null while merely throttled answers the
    // widget with {available:false} and the deck falls back to icons — and because two
    // callers poll (profile poll and capture timer), the second is always throttled when
    // their intervals coincide, so the fallback recurs rather than blipping.
    Check("K6e a throttled capture returns the cached frame instead of null",
        code.Contains("return _lastCaptureResult;   // reuse"));
    // ...and the cache is cleared on every DEFINITE failure, or a deck that really went
    // away would be reported as present forever.
    Check("K6f every definite failure clears the cached frame",
        code.Split("return _lastCaptureResult = null;").Length - 1 >= 5,
        (code.Split("return _lastCaptureResult = null;").Length - 1) + " clearing returns");

    // K7 · the invariant, not a list of sites. K6f counts clearing returns, which says
    // nothing about the returns it did NOT count — and that is exactly how the uniform-bitmap
    // branch sat there returning a bare null while the field's own doc comment claimed it
    // cleared. Enumerate every return in the method instead: exactly one may reuse the cached
    // frame (the throttle) and every other must assign the field. A new early return added
    // later without touching the cache fails this, which is the regression class.
    var body = MethodBody(code, "public (string DataUri, int W, int H, string Hash)? CaptureVsdWindow()");
    Check("K7 setup: the capture method body was located", body.Length > 0);
    var returns = body.Split("return ").Skip(1).Select(s => "return " + s[..Math.Min(s.Length, 60)]).ToList();
    var reusing = returns.Where(r => r.StartsWith("return _lastCaptureResult;", StringComparison.Ordinal)).ToList();
    var unaccounted = returns
        .Where(r => !r.StartsWith("return _lastCaptureResult;", StringComparison.Ordinal)
                    && !r.StartsWith("return _lastCaptureResult =", StringComparison.Ordinal))
        .ToList();
    Check("K7 exactly one return reuses the cached frame — the throttle",
        reusing.Count == 1, reusing.Count + " reusing returns");
    Check("K7b every other return in the capture assigns the cache",
        unaccounted.Count == 0,
        unaccounted.Count == 0 ? "all accounted for" : string.Join(" | ", unaccounted.Select(r => r.Split('\n')[0].Trim())));
    // Checked PER SITE, not by "both names appear somewhere". The weaker version passed
    // with both branches using one latch and the other field left declared and unused —
    // the regression K6d exists for, surviving the probe named after it.
    var windowGuard = GuardFor(code, "window is {rect.Right}x{rect.Bottom}; too large");
    var frameGuard = GuardFor(code, "encoded frame is {ms.Length} bytes");
    Check("K6d setup: both warning sites were located",
        windowGuard.Length > 0 && frameGuard.Length > 0);
    Check("K6d the oversized-window warning is guarded by its own latch",
        windowGuard.Contains("_loggedOversizeWindow") && !windowGuard.Contains("_loggedOversizeFrame"),
        windowGuard.Trim());
    Check("K6d2 the oversized-frame warning is guarded by a DIFFERENT one",
        frameGuard.Contains("_loggedOversizeFrame") && !frameGuard.Contains("_loggedOversizeWindow"),
        frameGuard.Trim());
}

// K8 · the OTHER caller. Bounding the capture is not the same as bounding what gets shipped:
// the bridge throttle stops a repeat PrintWindow and then returns the cached frame, and the
// sd-profile route embeds that frame in full with no `have` hash to answer "unchanged" with.
// A tight poll therefore made the UI thread base64-serialize a maximum-sized frame through
// PostWebMessageAsJson without bound — the same resource-exhaustion path the PR closes on the
// capture route, left open on the profile one.
//
// A TEXT assertion, like K6 and labelled the same way: it catches the gate being removed, not
// one neutered in place, and the route needs Windows and a live WebView2 to drive.
var dash = FindUpwards("src/WaveshareWidgets/App/DashboardWindow.cs");
if (dash is null)
{
    Check("K8 setup: DashboardWindow.cs was found", false);
}
else
{
    var host = File.ReadAllText(dash);
    var profileRoute = CaseBody(host, "case \"sd-profile\":");
    Check("K8 setup: the sd-profile route was located", profileRoute.Length > 0);
    Check("K8 the profile route rate-limits the frame it embeds",
        profileRoute.Contains("CaptureLimits.TooSoon(_lastProfileFrameMs"));
    // ...and does so BEFORE capturing, so a refused request costs nothing at all.
    Check("K8b the gate precedes the capture call",
        profileRoute.IndexOf("CaptureLimits.TooSoon", StringComparison.Ordinal) >= 0
        && profileRoute.IndexOf("CaptureLimits.TooSoon", StringComparison.Ordinal)
           < profileRoute.IndexOf("CaptureVsdWindow()", StringComparison.Ordinal));
    // K8c · the stamp must be its OWN. Sharing the capture route's would make this gate fire
    // against the widget's 250 ms capture timer, so a 4 s profile poll would land inside the
    // window about 40% of the time and drop to the icon grid — a flicker introduced by the
    // fix for a flicker, which is this PR's recurring shape.
    Check("K8c the profile route's stamp is not the capture route's",
        profileRoute.Contains("_lastProfileFrameMs")
        && !profileRoute.Contains("_lastCaptureTicks")
        && !profileRoute.Contains("_lastCaptureMs"));
    Check("K8d and the stamp only advances when a frame was actually shipped",
        CaseBody(host, "case \"sd-profile\":").Contains("_lastProfileFrameMs = frameNow;"));
}

/// One `case` label's body, up to its `break`. Scopes a claim about the sd-profile route to
/// that route — asserting against the whole file would pass on a gate that lives in some
/// other handler entirely.
static string CaseBody(string code, string label)
{
    var at = code.IndexOf(label, StringComparison.Ordinal);
    if (at < 0) return "";
    var end = code.IndexOf("break;", at, StringComparison.Ordinal);
    return end < 0 ? "" : code[at..end];
}

/// The body of a method, by brace matching from its signature. Used so a claim about "every
/// return in the capture" is scoped to the capture rather than to the whole file.
static string MethodBody(string code, string signature)
{
    var at = code.IndexOf(signature, StringComparison.Ordinal);
    if (at < 0) return "";
    var open = code.IndexOf('{', at);
    if (open < 0) return "";
    var depth = 0;
    for (var i = open; i < code.Length; i++)
    {
        if (code[i] == '{') depth++;
        else if (code[i] == '}' && --depth == 0) return code[open..i];
    }
    return "";
}

/// The `if (!_logged…)` guard that precedes a given warning, so each site can be checked on
/// its own rather than by whether a name appears anywhere in the file.
static string GuardFor(string code, string warning)
{
    var at = code.IndexOf(warning, StringComparison.Ordinal);
    if (at < 0) return "";
    var from = code.LastIndexOf("if (!_logged", at, StringComparison.Ordinal);
    return from < 0 ? "" : code[from..at];
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
