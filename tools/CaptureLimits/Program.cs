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

// K2 · the intended caller must not notice. Asserted against the FASTEST the stock widget can
// be configured to poll, not against its default: `widgets/streamdeck/index.html` clamps
// liveRefresh with Math.max(150, …), so 150 ms is a supported setting even though 400 ms is
// the default. Checking 250 ms would let the floor rise to 200 — passing every boundary check
// here while silently halving a configuration the widget offers.
const int WidgetFastestPollMs = 150;
Check("K2 the widget's FASTEST supported poll is never refused",
    !CaptureLimits.TooSoon(1000, 1000 + WidgetFastestPollMs)
    && CaptureLimits.MinIntervalMs <= WidgetFastestPollMs,
    $"floor {CaptureLimits.MinIntervalMs} ms vs widget minimum {WidgetFastestPollMs} ms");
// ...and the number above is the one the widget actually enforces, not a copy that drifted.
var deckWidget = FindUpwards("widgets/streamdeck/index.html");
Check("K2b the widget still clamps its poll to that same floor",
    deckWidget is not null
    && File.ReadAllText(deckWidget).Contains($"Math.max({WidgetFastestPollMs}, Number(s.liveRefresh)"),
    deckWidget is null ? "widget not found" : "clamp matches");

// K3 · the states that are not a rate at all. "No capture yet" and a clock that appears to
// run backwards (a resumed machine) must not wedge capture permanently — refusing forever
// is the failure mode that looks exactly like the deck being broken.
Check("K3 the first capture is never too soon", !CaptureLimits.TooSoon(0, 5000));
Check("K3b a negative or absent stamp is not too soon", !CaptureLimits.TooSoon(-1, 5000));
Check("K3c a clock that moved backwards does not block capture", !CaptureLimits.TooSoon(9000, 1000));

// K10 · the two bounds COMPOSED, which is the thing neither one alone tests. K1-K3 drive
// TooSoon in isolation and pass regardless of how the capture stamps its clock, so they said
// nothing about the version that measured the floor from completion — which refused the
// widget's own supported poll as soon as a capture took longer than 50 ms. These drive the
// pair the way the capture calls it.
static bool MayCapture(long lastStart, long lastEnd, long now) =>
    !CaptureLimits.TooSoon(lastStart, now)
    && !CaptureLimits.WouldExceedDutyCycle(lastStart, lastEnd, now);

// The exact scenario: 150 ms poll, 60 ms capture. Fresh frames must land every 150 ms, not
// every 300 ms.
Check("K10 a 60 ms capture on the widget's fastest 150 ms poll is not refused",
    MayCapture(1000, 1060, 1150));
Check("K10b ...and the one after that is not refused either",
    MayCapture(1150, 1210, 1300));
// The other direction: an expensive capture must leave the UI thread idle. A capture that
// takes as long as the floor cannot run back to back.
Check("K10c a 150 ms capture cannot start again the instant it finishes",
    !MayCapture(1000, 1150, 1160));
Check("K10d ...and is allowed once its own duration has passed — a 50% duty cycle",
    MayCapture(1000, 1150, 1300), "idle 1150-1300, next start 1300");
// A cheap capture is governed by the start-to-start floor, not the duty cycle.
Check("K10e a 5 ms capture is still held to the 100 ms floor",
    !MayCapture(1000, 1005, 1050) && MayCapture(1000, 1005, 1100));
// The nonsense states, same reasoning as K3: never wedge capture permanently.
Check("K10f no capture yet is never refused", MayCapture(0, 0, 5000));
Check("K10g an end before its own start is not believed",
    !CaptureLimits.WouldExceedDutyCycle(1000, 900, 1001));
Check("K10h a clock that moved backwards does not block capture",
    !CaptureLimits.WouldExceedDutyCycle(1000, 1060, 900));
// K10i · a SUSPENSION between the two stamps. TickCount64 is GetTickCount64, which counts
// sleep, so a lid closed mid-capture reads back as a capture that took as long as the nap —
// large, ordered, and therefore invisible to every check above. Used as a delay it freezes
// the deck on its pre-suspend frame for another nap's worth of time, which is the exact
// failure K3 exists to prevent, arriving by a route K3 cannot see.
Check("K10i a 30-minute suspend mid-capture does not freeze the deck afterwards",
    !CaptureLimits.WouldExceedDutyCycle(1000, 1000 + 30 * 60 * 1000, 1000 + 30 * 60 * 1000 + 1),
    "resumes immediately, not after another 30 minutes");
Check("K10j the cap sits above any real capture and below a plausible nap",
    CaptureLimits.MaxPlausibleCaptureMs > 500 && CaptureLimits.MaxPlausibleCaptureMs <= 10_000,
    $"{CaptureLimits.MaxPlausibleCaptureMs} ms");
// ...and the cap does not quietly disable the bound for durations that ARE real.
Check("K10k a slow but plausible capture is still duty-cycle limited",
    CaptureLimits.WouldExceedDutyCycle(1000, 1000 + CaptureLimits.MaxPlausibleCaptureMs,
        1000 + CaptureLimits.MaxPlausibleCaptureMs + 1));

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
    // Everything asserting that a line of CODE exists reads the stripped text, so a guard
    // that has been commented out cannot satisfy its own check. (K6d below is the exception
    // and must stay on the raw text: it locates warnings BY their message, which stripping
    // removes along with every other string literal.)
    var src = StripCode(code);
    Check("K6 the capture checks the window size before allocating a bitmap",
        src.Contains("CaptureLimits.SaneSize(rect.Right, rect.Bottom)")
        && src.IndexOf("CaptureLimits.SaneSize", StringComparison.Ordinal)
           < src.IndexOf("new Bitmap(", StringComparison.Ordinal));
    Check("K6b it enforces the rate floor", src.Contains("CaptureLimits.TooSoon(_lastCaptureMs"));
    Check("K6c and it refuses an oversized encoded frame",
        src.Contains("CaptureLimits.EncodedTooLarge(ms.Length)"));
    // K6d · the two limits keep SEPARATE one-time-log latches. Sharing one means whichever
    // trips first silences the other for the process lifetime — and these warnings are the
    // only reason a refused capture is visible at all, so a silenced one is a refusal that
    // presents as the deck simply not working.
    // K6e · the throttle must REUSE, not report unavailable. HandleSdCapture assigns this
    // result straight into its own cache, so a null while merely throttled answers the
    // widget with {available:false} and the deck falls back to icons — and because two
    // callers poll (profile poll and capture timer), the second is always throttled when
    // their intervals coincide, so the fallback recurs rather than blipping.
    // Matched against the STATEMENT, not against the trailing comment that used to follow it
    // — `// reuse` was part of the assertion, so the check could have been satisfied by the
    // comment alone. K7 is what actually pins this down; K6e is kept as a cheap floor.
    Check("K6e a throttled capture returns the cached frame instead of null",
        src.Contains("return _lastCaptureResult;"));
    // ...and the cache is cleared on every DEFINITE failure, or a deck that really went
    // away would be reported as present forever.
    Check("K6f every definite failure clears the cached frame",
        src.Split("return _lastCaptureResult = null;").Length - 1 >= 5,
        (src.Split("return _lastCaptureResult = null;").Length - 1) + " clearing returns");

    // K7 · the invariant, not a list of sites. K6f counts clearing returns, which says
    // nothing about the returns it did NOT count — and that is exactly how the uniform-bitmap
    // branch sat there returning a bare null while the field's own doc comment claimed it
    // cleared. Enumerate every return in the method instead: exactly one may reuse the cached
    // frame (the throttle) and every other must assign the field. A new early return added
    // later without touching the cache fails this, which is the regression class.
    var body = MethodBody(code, "public (string DataUri, int W, int H, string Hash)? CaptureVsdWindow()");
    Check("K7 setup: the capture method body was located", body.Length > 0);
    // Comments and string literals are stripped BEFORE the scan, and whitespace after the
    // keyword is normalised. Splitting on the literal text "return " missed `return\n null;`
    // — valid C# that this probe would then not enumerate at all, so the stale-cache
    // regression could be reintroduced in a form no check here even looked at. It also read
    // the word "return" inside comments as a statement.
    var returns = ReturnStatements(body);
    var reusing = returns.Where(r => r == "return _lastCaptureResult;").ToList();
    var unaccounted = returns
        .Where(r => r != "return _lastCaptureResult;"
                    && !r.StartsWith("return _lastCaptureResult =", StringComparison.Ordinal))
        .ToList();
    // The exact count is asserted, not just "some were found". A tokeniser that silently
    // enumerated a SUBSET is the failure this whole check exists to prevent, and a subset
    // still satisfies "every return I found assigns the cache". Nine: five definite failures
    // before the try, the throttle, PrintWindow, uniform, oversize, success and the catch.
    // If a return is legitimately added or removed, update this number deliberately.
    Check("K7 setup: the scan found every return the method has",
        returns.Count == 9, returns.Count + " returns");
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

// K9 · the cooldown runs from when the work ENDED, not when it began. Stamping only at the
// start bounds how often a capture may BEGIN, which leaves no idle time at all once a capture
// itself takes longer than the floor — plausible near the four-megapixel ceiling — because the
// next request is already allowed the instant this one returns. That is back-to-back captures
// on the UI thread despite a limiter that reads as if it prevents them.
//
// A TEXT assertion, on the same terms as K6: it catches the finally-stamp being removed, not
// one neutered in place. The capture needs Windows and a live Stream Deck to time for real.
if (bridge is not null)
{
    var code2 = File.ReadAllText(bridge);
    // Stripped of comments and strings BEFORE any of these look at it. Searching the raw text
    // meant commenting a line out left the substring in place and the check stayed green — so
    // K9/K9b/K9c were asserting that the wiring was *described*, not that it was there.
    var capture = StripCode(
        MethodBody(code2, "public (string DataUri, int W, int H, string Hash)? CaptureVsdWindow()"));
    Check("K9 setup: the capture method body was located", capture.Length > 0);
    var fin = capture.LastIndexOf("finally", StringComparison.Ordinal);
    Check("K9 the capture records when the work FINISHED, in a finally",
        fin >= 0 && capture[fin..].Contains("_lastCaptureEndMs = Environment.TickCount64;"));
    // ...and the start stamp survives it. Overwriting _lastCaptureMs at completion is the
    // version that turned the start-to-start floor into a completion-to-start one and refused
    // the widget's own supported poll rate; the pair is what carries the duration.
    Check("K9b and the START stamp is not overwritten at completion",
        fin >= 0 && capture[..fin].Contains("_lastCaptureMs = nowMs;")
        && !capture[fin..].Contains("_lastCaptureMs ="));
    // K9c · the capture consults BOTH bounds. Either alone is a version this PR shipped and
    // had to take back.
    Check("K9c the capture checks the duty cycle as well as the floor",
        capture.Contains("CaptureLimits.TooSoon(_lastCaptureMs")
        && capture.Contains("CaptureLimits.WouldExceedDutyCycle(_lastCaptureMs, _lastCaptureEndMs"));
}

/// Every `return` statement in a block of C#, with comments and string literals removed and
/// whitespace normalised, so the enumeration does not depend on how the source is formatted.
/// Each entry reads `return <expr-prefix>;` with runs of whitespace collapsed to one space.
static List<string> ReturnStatements(string body)
{
    var found = new List<string>();
    foreach (System.Text.RegularExpressions.Match m in
             System.Text.RegularExpressions.Regex.Matches(StripCode(body), @"\breturn\b[^;]*;"))
    {
        var stmt = System.Text.RegularExpressions.Regex.Replace(m.Value, @"\s+", " ").Trim();
        found.Add(stmt);
    }
    return found;
}

/// C# with comments and string literals removed, so a check for a line of code cannot be
/// satisfied by that line appearing in a comment. K9 originally searched the raw method text,
/// and commenting out the assignment it looks for left the substring in place and the check
/// green — the guard was asserting on its own documentation.
static string StripCode(string body)
{
    var clean = new System.Text.StringBuilder(body.Length);
    for (var i = 0; i < body.Length; i++)
    {
        // Line comment
        if (body[i] == '/' && i + 1 < body.Length && body[i + 1] == '/')
        {
            while (i < body.Length && body[i] != '\n') i++;
            clean.Append('\n');
            continue;
        }
        // Block comment
        if (body[i] == '/' && i + 1 < body.Length && body[i + 1] == '*')
        {
            i += 2;
            while (i + 1 < body.Length && !(body[i] == '*' && body[i + 1] == '/')) i++;
            i++;
            clean.Append(' ');
            continue;
        }
        // String or interpolated string — replaced by a placeholder so a `return` inside one
        // is not read as a statement, and so braces inside it cannot confuse anything later.
        if (body[i] == '"')
        {
            i++;
            while (i < body.Length && body[i] != '"')
            {
                if (body[i] == '\\') i++;
                i++;
            }
            clean.Append("\"\"");
            continue;
        }
        clean.Append(body[i]);
    }
    return clean.ToString();
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
