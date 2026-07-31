// Live Stream Deck frame dedup — per consumer, not per panel (issue #127).
//
// C1-C2  one consumer is not sent the same frame twice, and is sent the next one
// C3     THE REGRESSION: two consumers polling out of phase both stay current
// C4     a consumer joining late gets the current frame rather than "unchanged"
// C5     no capture, and unidentified callers, fail toward sending
// C6     the table is bounded, and forgetting a slot does not starve its successor
using WaveshareWidgets;

var failures = 0;
void Check(string name, bool ok, string? detail = null)
{
    Console.WriteLine($"  {(ok ? "PASS" : "FAIL")} {name}{(detail is null ? "" : " - " + detail)}");
    if (!ok) failures++;
}

// ---- C1-C2: the behaviour the dedup exists for -------------------------------------
var d = new CaptureDedup();
Check("C1 the first sight of a frame is sent", d.NeedsFrame("a", "h1"));
Check("C1b polling again on the same frame is not", !d.NeedsFrame("a", "h1"));
Check("C2 a changed frame is sent again", d.NeedsFrame("a", "h2"));
Check("C2b ...and then deduped at the new hash", !d.NeedsFrame("a", "h2"));

// ---- C3: the regression this file was written for -----------------------------------
//
// Two live widgets, phases far enough apart that they never share the capture throttle.
// Under one global hash, `a` advanced it and `b` was told "unchanged" about pixels it had
// never been sent — for as long as the phases held. Each poll below is a separate frame
// arriving at a separate moment, exactly as the two widgets see it.
d = new CaptureDedup();
var bStarved = false;
string[] frames = ["f1", "f1", "f2", "f2", "f3", "f3"];
for (var i = 0; i < frames.Length; i++)
{
    var hash = frames[i];
    var toA = d.NeedsFrame("a", hash);   // `a` always polls first
    var toB = d.NeedsFrame("b", hash);
    // On every NEW frame both must be served; on a repeat neither should be.
    var newFrame = i == 0 || frames[i - 1] != hash;
    if (newFrame && !(toA && toB)) bStarved = true;
    if (!newFrame && (toA || toB)) bStarved = true;
}
Check("C3 two consumers polling out of phase both stay current", !bStarved);

// The same run stated as the symptom, so a regression reads as the bug rather than as an
// abstract flag: `b` must have been sent every distinct frame.
d = new CaptureDedup();
var sentToB = 0;
foreach (var hash in new[] { "f1", "f1", "f2", "f2", "f3", "f3" })
{
    d.NeedsFrame("a", hash);
    if (d.NeedsFrame("b", hash)) sentToB++;
}
Check("C3b the second widget received all three frames, not zero", sentToB == 3, $"{sentToB} of 3");

// ---- C4: a consumer that arrives mid-stream ----------------------------------------
d = new CaptureDedup();
d.NeedsFrame("a", "h1");
Check("C4 a consumer joining at an unchanged frame still gets it", d.NeedsFrame("late", "h1"));

// ---- C5: fail toward sending -------------------------------------------------------
// Withholding a frame freezes a widget; sending a redundant one costs bandwidth. When in
// doubt the cheap failure is the right one.
d = new CaptureDedup();
Check("C5 an unidentified caller is always sent the frame",
    d.NeedsFrame(null, "h1") && d.NeedsFrame("", "h1") && d.NeedsFrame("   ", "h1"));
Check("C5b a missing hash (no capture) is never treated as already seen",
    d.NeedsFrame("a", null) && d.NeedsFrame("a", ""));

// ---- C6: bounded, and reuse-safe ---------------------------------------------------
d = new CaptureDedup(capacity: 4);
for (var i = 0; i < 50; i++) d.NeedsFrame("slot" + i, "h1");
Check("C6 the table does not grow without bound", d.TrackedCount <= 4, $"{d.TrackedCount} tracked");

// The reload case, stated the way the shell actually solves it: the replacement document
// is a DIFFERENT consumer, so it is sent the current frame even though the slot it sits
// in has already seen it. The previous version of this check called a Forget() method
// that nothing in the app ever called — it tested a path that did not exist.
d = new CaptureDedup();
d.NeedsFrame("slot1#0", "h1");
Check("C6b a reloaded slot is a new consumer and is sent the current frame",
    d.NeedsFrame("slot1#1", "h1"));

// C7 · eviction must not cascade. With more consumers than the bound, clearing the whole
// table made every other consumer look new on its next poll and clear it again, so the
// dedup degraded into sending a full frame nearly every time.
var big = new CaptureDedup(capacity: 4);
string[] clients = ["a", "b", "c", "d"];
foreach (var c in clients) big.NeedsFrame(c, "h1");        // fill to capacity
big.NeedsFrame("overflow", "h1");                          // evicts the oldest only
var stillDeduped = clients.Skip(1).Count(c => !big.NeedsFrame(c, "h1"));
Check("C7 an overflow consumer does not reset everyone else's baseline",
    stillDeduped == 3, $"{stillDeduped} of 3 kept their baseline");

Console.WriteLine(failures > 0 ? $"{failures} FAILURES" : "ALL PASS");
return failures > 0 ? 1 : 0;
