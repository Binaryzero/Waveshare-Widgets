// Issue #132 — host pushes carried no sequence, so a fast off/on of demand could let a
// payload produced under the PREVIOUS demand interval be accepted as current.
//
// The behavioural half of this is routing-run.js (R12/R12b/R12c/R12d), which drives the real
// shell. But that harness fakes the host, so it exercises the shell's CHECKING while only
// imitating the host's STAMPING — remove the stamp from PostToShell and every JS test still
// passes. These checks cover that gap, and they run in CI where routing-run.js cannot.
//
// Two kinds of check here, and the difference matters when reading a pass.
//
// The N1-N6 block drives a REAL PREDICATE. Whether a completed poll may still publish is a
// decision with three inputs, and NotificationGate exists so it can be exercised without
// WinRT, a packaged identity or a user with real toasts.
//
// Everything else is a TEXT ASSERTION and is labelled as such at each site. Those catch a
// line removed or commented out; they cannot catch one neutered in place. They cover the
// wiring — that the poll asks the predicate, that the host stamps and the shell checks —
// which is plumbing rather than a decision and has nothing to extract.
//
// The text half also covers a gap the behavioural harness cannot: routing-run.js drives the
// real shell against a FAKE host, so it exercises the checking while only imitating the
// stamping. Delete the stamp from PostToShell and every probe there still passes — verified
// by mutation, not assumed. That is why this file exists and why it runs in CI, where the
// Playwright harnesses do not.

using WaveshareWidgets.App;

var failures = 0;
void Check(string name, bool ok, string? detail = null)
{
    Console.WriteLine($"  {(ok ? "PASS" : "FAIL")} {name}{(detail is null ? "" : " - " + detail)}");
    if (!ok) failures++;
}

Console.WriteLine("Publish gate");

// N · the OTHER half of the race, and the one a stamp at post time cannot reach. A poll is
// async and awaits real I/O, so it can be in flight far longer than the message-queue hop the
// envelope generation covers. Turning demand off disposes the timer but cannot cancel a poll
// already awaiting: it resumes, sees demand true again, and publishes a payload found under
// demand that has since been withdrawn and re-granted. Stamping at POST time then labels it
// current, which is exactly the payload the whole change exists to refuse.
Check("N1 a poll from the current interval publishes",
    NotificationGate.ShouldPush(7, 7, "sig-a", "sig-b", watching: true));
Check("N2 a poll from a PREVIOUS interval does not, however current everything else looks",
    !NotificationGate.ShouldPush(6, 7, "sig-a", "sig-b", watching: true));
// N3 · the case that makes the epoch necessary rather than merely tidy. Re-declaring demand
// deliberately CLEARS the last signature so a rebuilt widget gets a full push — so a stale
// payload arrives with nothing to be deduplicated against. Signature and watching both say
// yes; only the epoch says no.
Check("N3 a stale poll is refused even when the dedup signature has just been cleared",
    !NotificationGate.ShouldPush(6, 7, "sig-a", "", watching: true));
Check("N3b ...and the equivalent CURRENT poll is published, so N3 is not just refusing everything",
    NotificationGate.ShouldPush(7, 7, "sig-a", "", watching: true));
Check("N4 nobody watching means no push, whatever the epoch says",
    !NotificationGate.ShouldPush(7, 7, "sig-a", "sig-b", watching: false));
Check("N5 unchanged content is still deduplicated",
    !NotificationGate.ShouldPush(7, 7, "same", "same", watching: true));
Check("N5b ...by exact comparison, not a loose one",
    NotificationGate.ShouldPush(7, 7, "Same", "same", watching: true));
Check("N6 a future epoch is refused too — a poll cannot begin in an interval not yet declared",
    !NotificationGate.ShouldPush(8, 7, "sig-a", "sig-b", watching: true));

Console.WriteLine("Host stamps");

var host = FindUpwards("src/WaveshareWidgets/App/DashboardWindow.cs");
var shell = FindUpwards("src/WaveshareWidgets/Shell/shell.js");

if (host is null)
{
    Check("G0 setup: DashboardWindow.cs was found", false);
}
else
{
    var src = StripComments(File.ReadAllText(host), js: false);

    // G1 · every envelope carries it, and it is built in ONE place. The point of stamping in
    // PostToShell rather than at each call site is that a channel added later cannot forget.
    var post = MethodBody(src, "private void PostToShell(string type, JsonNode? data, string? gen");
    Check("G1 setup: PostToShell was located", post.Length > 0);
    // G1 · the field is present ONLY when the producing path supplies one. A fallback to a
    // host-held "current" generation is worse than nothing: it stamps at post time, which is
    // the race this change closes, and it would let a future gated channel inherit a number
    // that means nothing rather than being forced to carry its own from its authorisation
    // point. The absence of the field is the thing that forces that.
    Check("G1 the envelope carries the producer's generation and has NO fallback",
        post.Contains("[\"gen\"] = gen,") && !post.Contains("gen ??"));
    Check("G1c the informational copy is gone entirely",
        !src.Contains("_pushGen"), "no second source of truth");
    // Exactly one ASSIGNMENT in the whole file: stamped where every envelope is built, and
    // nowhere hand-applied. A second site would mean two places that must agree.
    //
    // Counting `["gen"]` alone was wrong and reported two — the other is this file's own
    // READ of the incoming watch message. A probe that cannot tell writing a field from
    // reading one is measuring the wrong thing; it only surfaced because the count is in the
    // failure detail rather than hidden behind a boolean.
    Check("G1b and it is stamped in exactly one place",
        CountOccurrences(src, "[\"gen\"] =") == 1,
        CountOccurrences(src, "[\"gen\"] =") + " stamp site(s)");

    // G2 · the host hands what the shell told it straight to SetWatching and holds it
    // nowhere else. A second copy here is what let the wrong one be reset at ready.
    var watch = CaseBody(src, "case \"notifications-watch\":");
    Check("G2 setup: the notifications-watch case was located", watch.Length > 0);
    Check("G2 the declared generation goes straight to SetWatching",
        watch.Contains("_notifications.SetWatching(") && watch.Contains("declaredGen"));
    // G2e · read as an OPAQUE string. Parsing it to a number would give the host an opinion
    // about what a generation means, and two ends with opinions is the bug class the counter
    // exists to remove — it also cannot represent "<document>:<counter>" at all.
    Check("G2e the generation is treated as opaque, not parsed",
        watch.Contains("GetValue<string>()") && !watch.Contains("TryGetValue<double>"));

    // G2b · a new document resets it. notifGen is document-local and restarts at 0 while
    // this survives a reload, and polling continues because the dead document never posted
    // watch(false) — so with one notifications widget the old document ends at 1 and the new
    // one's first watch is also 1, and a poll in flight across the reload carries a matching
    // stamp. The shell only sends a generation on a demand transition, so it never sends 0.
    var ready = CaseBody(src, "case \"ready\":");
    Check("G2b setup: the ready case was located", ready.Length > 0);
    // G2b · a new document advances the base that makes its generations distinguishable
    // from the previous document's. Without it both count from zero and a payload already
    // authorised and stamped for the old document can equal what the new one produces —
    // which invalidating the epoch cannot revoke, because the stamp already happened.
    Check("G2b a new shell document advances the document sequence",
        ready.Contains("_documentSeq++"));
    Check("G2b4 and init carries it, so the shell composes onto this document's base",
        src.Contains("[\"genBase\"] = _documentSeq"));
    // G2b2 · and resets the AUTHORITATIVE one, not just the informational copy. The first
    // attempt reset only _pushGen, which is the field used for the envelope's informational
    // stamp; the value actually placed on a notifications payload is held in
    // NotificationCenter, so the collision stayed open. Duplicating the concept is what made
    // resetting the wrong one possible, so this names the copy that matters.
    Check("G2b2 ...including the one a notifications payload is actually stamped with",
        ready.Contains("_notifications.BeginNewDocument()"));
    // ...and before init, so nothing produced for the old document can be authorised while
    // the new one is still being set up.
    Check("G2b3 and it does so BEFORE init",
        ready.IndexOf("BeginNewDocument", StringComparison.Ordinal) >= 0
        && ready.IndexOf("BeginNewDocument", StringComparison.Ordinal)
           < ready.IndexOf("PostToShell(", StringComparison.Ordinal));

    // G2c · the generation is captured when the payload is AUTHORISED, not when the envelope
    // is built. PostToShellThreadSafe marshals via BeginInvoke and the UI thread can drain a
    // watch(false) and a watch(true) before reaching that continuation — the same
    // post-time-versus-production-time mistake, one level further down.
    Check("G2c the notifications push carries the generation it was authorised under",
        src.Contains("_notifications.Updated += (data, gen) => PostToShellThreadSafe(\"notifications\", data, gen)"));
    // G2d · and the shell's number reaches the lock that guards the epoch. Stored only in
    // this file, it would be written outside that lock — a poll could hold the gate between
    // the write and SetWatching, read the NEW generation with the OLD epoch, and stamp a
    // stale payload as current.
    Check("G2d the declared generation is handed to SetWatching, not merely stored here",
        src.Contains("_notifications.SetWatching(") && src.Contains(", declaredGen)"));

    // G3 · the host must NOT interpret it. Any arithmetic here means two ends with two
    // opinions about what a generation means, which is the bug class the counter exists to
    // remove. Echoed verbatim or not at all.
    Check("G3 the host does not do arithmetic on the generation",
        !src.Contains("_pushGen++") && !src.Contains("_pushGen +") && !src.Contains("_pushGen -"),
        "echoed verbatim");
}

var notif = FindUpwards("src/WaveshareWidgets/App/NotificationCenter.cs");
if (notif is null)
{
    Check("N7 setup: NotificationCenter.cs was found", false);
}
else
{
    var src = StripComments(File.ReadAllText(notif), js: false);
    // TEXT assertions again, for the same reason as G1-G6: the arithmetic above proves the
    // predicate, not that the poll asks it.
    Check("N7 the poll captures its epoch BEFORE awaiting anything",
        src.IndexOf("epoch = _watchEpoch", StringComparison.Ordinal) >= 0
        && src.IndexOf("epoch = _watchEpoch", StringComparison.Ordinal)
           < src.IndexOf("await ", StringComparison.Ordinal),
        "captured before the first await");
    Check("N7b and the publish path consults the gate",
        src.Contains("NotificationGate.ShouldPush(pollEpoch, _watchEpoch"));
    // N7d · the generation is captured INSIDE the lock that made the decision, so the value
    // stamped on a payload is the one in force when it was authorised.
    var push = MethodBody(src, "private void Push(long pollEpoch, JsonObject payload");
    Check("N7d setup: Push was located", push.Length > 0);
    // Checked against the BODY of the deciding lock, not by index ordering. The index
    // version passed when the capture was moved into a SECOND lock after the first: still
    // after the opening brace, still before the invoke, and still racy — the decision and
    // the capture must be in ONE critical section or a transition can land between them.
    var lockAt = push.IndexOf("lock (_gate)", StringComparison.Ordinal);
    var body = lockAt < 0 ? "" : Braced(push, push.IndexOf('{', lockAt));
    Check("N7d the stamp is captured inside the SAME lock that made the decision",
        body.Contains("ShouldPush") && body.Contains("gen = _shellGen"),
        body.Contains("gen = _shellGen") ? "same critical section" : "captured elsewhere");
    Check("N7e ...and only ONE critical section is involved",
        CountOccurrences(push, "lock (_gate)") == 1,
        CountOccurrences(push, "lock (_gate)") + " lock block(s)");
    // N7f · a new document invalidates the in-flight epoch under the gate, and clears both
    // the generation and the dedup signature with it.
    var begin = MethodBody(src, "public void BeginNewDocument()");
    Check("N7f setup: BeginNewDocument was located", begin.Length > 0);
    Check("N7f it invalidates the epoch, the generation and the signature together",
        begin.Contains("_watchEpoch++") && begin.Contains("_shellGen = \"\"")
        && begin.Contains("_lastSignature = \"\"") && begin.Contains("lock (_gate)"));

    Check("N7c the epoch advances on a demand transition",
        CountOccurrences(src, "_watchEpoch++") >= 3,
        CountOccurrences(src, "_watchEpoch++") + " bump site(s) — transition, re-declare, new document");
}

Console.WriteLine("Shell checks");

if (shell is null)
{
    Check("G4 setup: shell.js was found", false);
}
else
{
    var src = StripComments(File.ReadAllText(shell), js: true);

    // G4 · the shell owns the counter and advances it on every demand TRANSITION.
    var sync = FunctionBody(src, "function syncNotificationDemand()");
    Check("G4 setup: syncNotificationDemand was located", sync.Length > 0);
    Check("G4 the shell advances the generation when demand changes",
        sync.Contains("notifSeq++"));
    Check("G4c ...composing onto the host-assigned document base, not a bare counter",
        sync.Contains("genBase + ':' + notifSeq"));
    Check("G4b ...and sends it with the demand message",
        sync.Contains("gen: notifGen"));

    // G5 · and refuses a push from any other interval.
    Check("G5 the notifications branch refuses a foreign generation",
        src.Contains("msg.gen !== notifGen"));
    // G5b · ...but NOT in the replica. The settings window is a second host: it answers a
    // watch synchronously with sample toasts and never withdraws demand, so its reply carries
    // no generation. Gating it dropped every sample and left the replica's widget on its
    // loading spinner — the exact failure the sample data exists to prevent.
    Check("G5b the replica is exempt, because its host never declares a demand interval",
        src.Contains("!PREVIEW && msg.gen !== notifGen"));

    // G6 · THE HAZARD. game-mode is edge-triggered: GameModeWatcher raises Changed only on a
    // transition, so the host never re-sends the current state. Gating it would leave the
    // shell believing the wrong game state until the next real transition — possibly hours,
    // hiding or showing every hideInGame widget wrongly throughout. A worse bug than the one
    // being fixed, manufactured by fixing it.
    //
    // Checked as "this branch does not mention the generation at all", which is blunt on
    // purpose: any use of it here is a decision that should fail this and be argued for.
    foreach (var channel in new[] { "game-mode", "sensors", "media" })
    {
        var branch = BranchBody(src, $"msg.type === '{channel}'");
        Check($"G6 setup: the {channel} branch was located", branch.Length > 0);
        Check($"G6 the {channel} branch is NOT gated on the generation",
            !branch.Contains("gen"), branch.Contains("gen") ? branch.Trim() : "ungated");
    }
}

/// Counts non-overlapping occurrences.
static int CountOccurrences(string haystack, string needle) =>
    haystack.Split(needle).Length - 1;

/// A `function name(...)` body, by brace matching.
static string FunctionBody(string code, string signature) => MethodBody(code, signature);

/// One `else if (cond) { ... }` branch body, by brace matching from the condition.
static string BranchBody(string code, string condition)
{
    var at = code.IndexOf(condition, StringComparison.Ordinal);
    if (at < 0) return "";
    var open = code.IndexOf('{', at);
    if (open < 0) return "";
    // A single-statement branch on one line has its own braces in shell.js; if the next
    // brace is further away than the end of the line, treat the line itself as the body.
    var eol = code.IndexOf('\n', at);
    if (eol >= 0 && open > eol) return code[at..eol];
    return Braced(code, open);
}

/// A method or function body, by brace matching from its signature.
static string MethodBody(string code, string signature)
{
    var at = code.IndexOf(signature, StringComparison.Ordinal);
    if (at < 0) return "";
    var open = code.IndexOf('{', at);
    return open < 0 ? "" : Braced(code, open);
}

/// One `case` label's body, up to its `break`.
static string CaseBody(string code, string label)
{
    var at = code.IndexOf(label, StringComparison.Ordinal);
    if (at < 0) return "";
    var end = code.IndexOf("break;", at, StringComparison.Ordinal);
    return end < 0 ? "" : code[at..end];
}

static string Braced(string code, int open)
{
    var depth = 0;
    for (var i = open; i < code.Length; i++)
    {
        if (code[i] == '{') depth++;
        else if (code[i] == '}' && --depth == 0) return code[open..i];
    }
    return "";
}

/// Source with COMMENTS removed and string literals kept.
///
/// Comments are the hazard worth removing: a guard commented out rather than deleted leaves
/// its own text in place, and a check searching raw source then passes on its own
/// documentation. That hole was found in the capture probes by running it.
///
/// String literals are deliberately KEPT, and the first version of this file got that wrong.
/// Every anchor here — `case "notifications-watch":`, `msg.type === 'game-mode'`, `["gen"]` —
/// IS a string literal, so blanking them made the locators find nothing, and the assertions
/// that followed then ran against an empty string and passed vacuously. The setup checks
/// caught it. Locating code by its strings and refusing to read its strings cannot both be
/// done at once; the same tension is why the oversize-warning probe reads raw text.
///
/// The residual risk — a string literal that happens to contain one of the tokens asserted
/// on — is not present here and would be obvious if it ever were.
static string StripComments(string body, bool js)
{
    var clean = new System.Text.StringBuilder(body.Length);
    for (var i = 0; i < body.Length; i++)
    {
        if (body[i] == '/' && i + 1 < body.Length && body[i + 1] == '/')
        {
            while (i < body.Length && body[i] != '\n') i++;
            clean.Append('\n');
            continue;
        }
        if (body[i] == '/' && i + 1 < body.Length && body[i + 1] == '*')
        {
            i += 2;
            while (i + 1 < body.Length && !(body[i] == '*' && body[i + 1] == '/')) i++;
            i++;
            clean.Append(' ');
            continue;
        }
        // Skipped over intact, so a comment marker inside a string cannot start a "comment".
        if (body[i] == '"' || body[i] == '\'' || (js && body[i] == '`'))
        {
            var quote = body[i];
            clean.Append(body[i++]);
            while (i < body.Length && body[i] != quote)
            {
                if (body[i] == '\\' && i + 1 < body.Length) clean.Append(body[i++]);
                clean.Append(body[i++]);
            }
            if (i < body.Length) clean.Append(body[i]);
            continue;
        }
        clean.Append(body[i]);
    }
    return clean.ToString();
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
