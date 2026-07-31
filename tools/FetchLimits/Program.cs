using WaveshareWidgets;

// One body ceiling, two tiers (#117).
//
// The findings this covers are not "a comparison was missing" — the proxy tier always had
// one. They are that a SECOND tier was added without it, on a path the remote server elects
// by answering 403 or 429, while the host went on advertising the limit. So the probes are
// about the number reaching both places and about the browser tier refusing before it reads
// rather than after.

var failures = 0;
void Check(string name, bool ok, string? detail = null)
{
    Console.WriteLine($"  {(ok ? "PASS" : "FAIL")} {name}{(detail is null ? "" : " - " + detail)}");
    if (!ok) failures++;
}

const int Max = FetchLimits.MaxBodyBytes;

Console.WriteLine("The ceiling itself");

// F1 · the boundary, both sides. A cap that refuses a body of exactly the allowed size is a
// different cap from the one documented, and off-by-one here silently shrinks the limit.
Check("F1 a body of exactly the ceiling is allowed", !FetchLimits.DeclaredTooLarge(Max, Max));
Check("F1b one byte over is refused", FetchLimits.DeclaredTooLarge(Max + 1, Max));

// F2 · an UNKNOWN length is not a large one. Chunked responses declare no Content-Length,
// so refusing on a missing value would reject the ordinary case rather than the hostile one.
Check("F2 an absent or unparsed Content-Length is not treated as too large",
    !FetchLimits.DeclaredTooLarge(0, Max) && !FetchLimits.DeclaredTooLarge(-1, Max));

// F3 · the streaming check is asked BEFORE the append. Asking afterwards means the bytes
// past the bound have already been paid for, which on this path is the whole cost.
Check("F3 a chunk that exactly fills the ceiling is accepted", !FetchLimits.WouldExceed(Max - 1024, 1024, Max));
Check("F3b the chunk that would cross it is refused", FetchLimits.WouldExceed(Max - 1024, 1025, Max));
Check("F3c ...and so is one that starts already full", FetchLimits.WouldExceed(Max, 1, Max));

// F9 · the per-request ceiling. WW.fetch lets a widget LOWER its own, and until this the
// number never left the page: the host still fetched, buffered and base64-encoded the full
// 5 MiB, so "lowered" meant only that the wrapper threw afterwards — every byte the lower
// number exists to avoid had already been paid for.
Check("F9 a lower request lowers the ceiling", FetchLimits.EffectiveCap(64 * 1024) == 64 * 1024);
// The half that has to hold: the number arrives FROM a widget, and a ceiling a widget can
// raise is not a ceiling. Same rule as the shim's resolveCap, enforced again here because
// this side is the one that does the downloading.
Check("F9b a higher request cannot raise it", FetchLimits.EffectiveCap(Max * 2L) == Max);
Check("F9c ...nor can a colossal or negative one",
    FetchLimits.EffectiveCap(long.MaxValue) == Max && FetchLimits.EffectiveCap(-1) == Max);
// Absent means default, not "refuse everything": an older shell posts no maxBytes at all.
Check("F9d an unspecified request means the default", FetchLimits.EffectiveCap(0) == Max);
Check("F9e the ceiling itself is accepted unchanged", FetchLimits.EffectiveCap(Max) == Max);

// F10 · and the lowered number is USED, not merely computed — the same shape of bug as the
// shim's, where resolveCap returned the right value and the reader ignored it.
Check("F10 a declared length over the LOWERED ceiling is refused though under the default",
    FetchLimits.DeclaredTooLarge(1024 * 1024, FetchLimits.EffectiveCap(64 * 1024))
    && !FetchLimits.DeclaredTooLarge(1024 * 1024, Max));
Check("F10b ...and so is the chunk that would cross it",
    FetchLimits.WouldExceed(60 * 1024, 8 * 1024, FetchLimits.EffectiveCap(64 * 1024))
    && !FetchLimits.WouldExceed(60 * 1024, 8 * 1024, Max));

Console.WriteLine("Parity with the browser tier");

// A placeholder URL, so tests/harness/bodycap-run.js can point the SAME generated script at
// a server of its own and actually run it. Everything below is about the script's text; the
// harness is what checks it behaves, which text cannot.
var script = FetchLimits.BrowserFetchScript("\"__WW_URL__\"", "{\"Accept\":\"*/*\"}");

// The text assertions below are about CODE, so the comments come out first. Writing a
// comment that mentioned arrayBuffer() was enough to fail the "does not materialise the
// body" check a moment ago — a probe that a comment can break is measuring prose.
var code = string.Join("\n", script.Split('\n')
    .Select(line => line.TrimStart().StartsWith("//", StringComparison.Ordinal) ? "" : line));

// F4 · THE point of this probe. The browser tier enforces the ceiling inside the page, in a
// script built in C#, so the number has to travel there. A hardcoded literal in that script
// is exactly how the two tiers would drift apart again, silently, on a path only reachable
// from a Windows host with a server that answers 403.
Check("F4 the in-page script carries the same ceiling as the proxy tier",
    code.Contains(Max.ToString()), Max.ToString());

// F5 · and it must refuse by NOT READING. arrayBuffer() was the old shape: it materialises
// the whole body, and everything downstream — binary string, base64, the JSON hop, the
// decode — copies that length again. A cap applied after it has already lost.
Check("F5 the script streams with a reader instead of materialising the body",
    code.Contains("getReader()") && !code.Contains("arrayBuffer"));
Check("F5b ...and cancels the transfer when the budget is crossed",
    code.Contains("reader.cancel()"));
Check("F5c ...and reports the refusal so the caller can log it rather than see a blank body",
    code.Contains("tooLarge"));

// F7 · a response that FORBIDS a body — 204, 205 — has r.body === null, and getReader()
// throws on it. arrayBuffer() absorbed that as an empty read; the streaming rewrite has to
// absorb it deliberately, or a successful retry lands in the catch and the widget is left
// holding the 403 the proxy tier got. A cap must not turn an empty answer into a failure.
Check("F7 a null body is answered, not thrown on", code.Contains("if (!r.body)"));

// F8 · the WIDGET side of the same ceiling. WW.fetch wraps every response so a widget
// cannot materialise more than this either, and that number lives in widget-api.js because
// the shim is plain JS with no access to the C# constant. Two hand-kept copies is exactly
// how the proxy and browser tiers drifted apart in the first place, so they are compared.
var shim = FindUpwards("src/WaveshareWidgets/Shell/widget-api.js");
if (shim is null)
{
    Check("F8 the widget shim's ceiling matches the host's", false, "widget-api.js not found");
}
else
{
    var text = File.ReadAllText(shim);
    var declared = System.Text.RegularExpressions.Regex.Match(
        text, @"const MAX_BODY_BYTES = ([0-9*\s]+);");
    var value = declared.Success
        ? declared.Groups[1].Value.Split('*').Select(part => int.Parse(part.Trim())).Aggregate(1, (a, b) => a * b)
        : -1;
    Check("F8 the widget shim's ceiling matches the host's", value == Max, $"shim={value} host={Max}");
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

// F6 · the script is written out for the JS side. It is JavaScript living inside a C#
// string: nothing in this build would notice it becoming unparseable, and on the product it
// only ever executes on a Windows host talking to a server that answered 403 — so CI syntax-
// checks it, and bodycap-run.js runs it against a real server with a real ReadableStream.
//
// Everything above is a TEXT assertion, and text cannot tell "refuse before appending" from
// "refuse after": a mutation that moved the budget check below the push kept every string
// these look for. That is what the harness exists for.
if (args.Length > 0)
{
    File.WriteAllText(args[0], script);
    Console.WriteLine($"  wrote the generated script to {args[0]} for a syntax check");
}

Console.WriteLine(failures == 0 ? "ALL PASS" : $"{failures} FAILURES");
return failures == 0 ? 0 : 1;
