// Probes for the web-message origin check (#72), run against the real MessageOrigin
// source. Exit code 0 = all pass.
//
// Two directions, and they are not equally dangerous. Accepting a widget frame would let
// installed third-party code drive save-layout, open-url and action. Rejecting the SHELL
// would drop every message with no symptom but a dead-looking app — and neither the CI
// host (Linux) nor the maintainer's setup can run WebView2 to notice. So the shell-side
// cases below are as thorough as the attacker-side ones.
using WaveshareWidgets;

var failures = 0;
void Check(string name, bool ok, string? detail = null)
{
    Console.WriteLine($"  {(ok ? "PASS" : "FAIL")} {name}{(detail is null ? "" : " - " + detail)}");
    if (!ok) failures++;
}

const string Shell = "app.wsw";

// ---- M1 · the documents the shells actually navigate to ------------------------------
// DashboardWindow navigates once to index.html; SettingsWindow once to settings.html.
// Both must pass, or the window they belong to goes silent.
Check("M1 the dashboard shell document is accepted",
    MessageOrigin.IsShell("https://app.wsw/index.html", Shell));
Check("M1b the settings shell document is accepted",
    MessageOrigin.IsShell("https://app.wsw/settings.html", Shell));
// Reload() preserves the URI, so nothing changes across a reload — but a future query
// string or fragment must not start dropping messages either. That is why the check is
// scheme+host rather than a full-URL match.
Check("M1c a query string does not lock the shell out",
    MessageOrigin.IsShell("https://app.wsw/index.html?r=3", Shell));
Check("M1d nor does a fragment",
    MessageOrigin.IsShell("https://app.wsw/settings.html#panel", Shell));
Check("M1e nor a page that does not exist yet",
    MessageOrigin.IsShell("https://app.wsw/some-future-page.html", Shell));
// Host names are case-insensitive; a differently-cased origin is the same document.
Check("M1f host comparison is case-insensitive, because host names are",
    MessageOrigin.IsShell("https://APP.WSW/index.html", Shell));
Check("M1g and so is the scheme",
    MessageOrigin.IsShell("HTTPS://app.wsw/index.html", Shell));

// ---- M2 · widget frames are rejected --------------------------------------------------
// Every widget is mapped to its own `{slug}.widgets.wsw` host, which is what makes the
// host the discriminator here.
Check("M2 a widget frame is rejected",
    !MessageOrigin.IsShell("https://clock.widgets.wsw/index.html", Shell));
Check("M2b including one whose slug looks like the shell",
    !MessageOrigin.IsShell("https://app.widgets.wsw/index.html", Shell));
// Subdomain and suffix games: neither is the shell host, and string containment would
// have accepted both.
Check("M2c a subdomain of the shell host is not the shell host",
    !MessageOrigin.IsShell("https://evil.app.wsw/index.html", Shell));
Check("M2d nor is a host that merely ends with it",
    !MessageOrigin.IsShell("https://notapp.wsw/index.html", Shell));
Check("M2e nor one that merely starts with it",
    !MessageOrigin.IsShell("https://app.wsw.evil.test/index.html", Shell));
// The asset hosts serve images, not documents — but they are not the shell either.
Check("M2f the backgrounds host is rejected",
    !MessageOrigin.IsShell("https://backgrounds.wsw/x.png", Shell));
Check("M2g the media host is rejected",
    !MessageOrigin.IsShell("https://media.wsw/x.png", Shell));

// ---- M3 · anything that is not an https document ---------------------------------------
Check("M3 http is rejected: the shell is served over https",
    !MessageOrigin.IsShell("http://app.wsw/index.html", Shell));
Check("M3b file: is rejected", !MessageOrigin.IsShell("file:///C:/index.html", Shell));
Check("M3c about:blank is rejected", !MessageOrigin.IsShell("about:blank", Shell));
Check("M3d a data: document is rejected",
    !MessageOrigin.IsShell("data:text/html,<script>1</script>", Shell));
Check("M3e javascript: is rejected", !MessageOrigin.IsShell("javascript:void 0", Shell));

// ---- M4 · degenerate input never throws and never passes -------------------------------
// This runs on every inbound message, so a throw here would be an availability bug.
Check("M4 null is rejected", !MessageOrigin.IsShell(null, Shell));
Check("M4b empty is rejected", !MessageOrigin.IsShell("", Shell));
Check("M4c whitespace is rejected", !MessageOrigin.IsShell("   ", Shell));
Check("M4d a relative URI is rejected", !MessageOrigin.IsShell("/index.html", Shell));
Check("M4e a bare host with no scheme is rejected", !MessageOrigin.IsShell("app.wsw", Shell));
Check("M4f garbage is rejected", !MessageOrigin.IsShell("not a uri at all", Shell));
// An empty expected host must never turn the check into "accept everything".
Check("M4g an empty shell host accepts nothing",
    !MessageOrigin.IsShell("https://app.wsw/index.html", ""));

// ---- M5 · a rejected origin does not leak into the log ---------------------------------
// The call sites log through SafeUrl (#59). A hostile frame's URL can carry a path or
// query the log has no business keeping.
var hostile = "https://clock.widgets.wsw/index.html?token=ghp_SUPERSECRET&u=someone";
var described = SafeUrl.Describe(hostile);
Check("M5 the logged form keeps only the host",
    described == "clock.widgets.wsw", described);
Check("M5b no query, path or credential survives into the log",
    !described.Contains("ghp_SUPERSECRET") && !described.Contains("someone")
        && !described.Contains('?') && !described.Contains("index.html"),
    described);
Check("M5c a null origin logs a placeholder rather than throwing",
    SafeUrl.Describe((string?)null) == "(no url)");

Console.WriteLine(failures == 0 ? "ALL PASS" : $"{failures} FAILURES");
return failures == 0 ? 0 : 1;
