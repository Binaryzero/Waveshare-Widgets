// Issue #115 — the Stream Deck icon resolver built filesystem paths out of profile strings.
//
// `Plugin.UUID` and the action UUID are read from the profile and used to name directories
// AND files. A crafted profile could point them at anything readable; the result is base64'd
// into the profile payload and handed to a widget, so a local parse quirk becomes
// disclosure. Not remotely reachable — it needs an imported or hand-edited profile — which
// is what keeps it medium rather than high.
//
// Reproducing it needs Windows, an Elgato installation and a profile on disk. The decision
// does not: it is two predicates over strings, and this drives them.
using WaveshareWidgets.App;

var failures = 0;
void Check(string name, bool ok, string? detail = null)
{
    Console.WriteLine($"  {(ok ? "PASS" : "FAIL")} {name}{(detail is null ? "" : " - " + detail)}");
    if (!ok) failures++;
}

Console.WriteLine("UUIDs that reach the filesystem");

// S1 · the shapes real plugins actually use. A rule that refuses these would take every
// default plugin icon off the deck, which is a worse outcome than the finding.
Check("S1 ordinary reverse-DNS UUIDs are accepted",
    StreamDeckPaths.IsPlausibleUuid("com.elgato.discord")
    && StreamDeckPaths.IsPlausibleUuid("com.elgato.discord.mute")
    && StreamDeckPaths.IsPlausibleUuid("com.barraider.vmtoggle")
    && StreamDeckPaths.IsPlausibleUuid("de.mediola.streamdeck.iqontrol")
    && StreamDeckPaths.IsPlausibleUuid("com.elgato.hue.brightness-set")
    && StreamDeckPaths.IsPlausibleUuid("plugin_2"));

// S2 · the reported vector, in both separator spellings. The Windows one is the one that
// matters on the product and the one a Linux-run containment check would let through.
Check("S2 a Windows traversal is refused",
    !StreamDeckPaths.IsPlausibleUuid(@"..\..\..\Users\victim\Pictures\secret"));
Check("S2b ...and a POSIX one",
    !StreamDeckPaths.IsPlausibleUuid("../../../etc/passwd"));
Check("S2c ...and a bare parent reference, which is in the alphabet but never a UUID",
    !StreamDeckPaths.IsPlausibleUuid("..") && !StreamDeckPaths.IsPlausibleUuid("com..elgato"));

// S3 · the other ways out of a directory that do not spell `..`.
Check("S3 an absolute path is refused",
    !StreamDeckPaths.IsPlausibleUuid(@"C:\Windows\win.ini") && !StreamDeckPaths.IsPlausibleUuid("/etc/passwd"));
Check("S3b a UNC path is refused", !StreamDeckPaths.IsPlausibleUuid(@"\\attacker\share\x"));
Check("S3c a drive-relative path is refused", !StreamDeckPaths.IsPlausibleUuid("C:x"));
Check("S3d an alternate data stream is refused", !StreamDeckPaths.IsPlausibleUuid("plugin:stream"));
Check("S3e a wildcard is refused", !StreamDeckPaths.IsPlausibleUuid("com.elgato.*"));
Check("S3f a NUL byte is refused", !StreamDeckPaths.IsPlausibleUuid("com.elgato\0.mute"));
Check("S3g percent-encoding is refused rather than decoded",
    !StreamDeckPaths.IsPlausibleUuid("..%c0%af..") && !StreamDeckPaths.IsPlausibleUuid("%2e%2e%2f"));

// S4 · empty and absent. "" is the resolver's own absent marker and is handled by its
// callers; the predicate itself must not call it plausible.
Check("S4 empty and null are not plausible UUIDs",
    !StreamDeckPaths.IsPlausibleUuid("") && !StreamDeckPaths.IsPlausibleUuid(null));
Check("S4b a pathological length is refused", !StreamDeckPaths.IsPlausibleUuid(new string('a', 5000)));

Console.WriteLine("Containment");

var root = Path.GetFullPath(Path.Combine(Path.GetTempPath(), "wwprobe", "Plugins", "com.example.sdPlugin"));

// S5 · the ordinary case, and the boundary that is usually written wrong.
Check("S5 a file under the root is inside",
    StreamDeckPaths.IsInside(root, Path.Combine(root, "images", "actions", "mute.png")));
Check("S5b a sibling directory sharing the root's PREFIX is not inside",
    !StreamDeckPaths.IsInside(root, root + "Evil" + Path.DirectorySeparatorChar + "x.png"),
    root + "Evil");
Check("S5c the root itself is not a file inside it", !StreamDeckPaths.IsInside(root, root));

// S6 · traversal that survives string checks but not resolution — the reason this exists
// as well as the UUID rule, since candidates are built from more than the UUIDs.
Check("S6 a path that climbs back out is not inside",
    !StreamDeckPaths.IsInside(root, Path.Combine(root, "..", "..", "secret.png")));
Check("S6b ...even when it climbs out and back in under a different name",
    !StreamDeckPaths.IsInside(root, Path.Combine(root, "..", "com.other.sdPlugin", "x.png")));
Check("S6c a path that climbs out and returns to the SAME root is inside",
    StreamDeckPaths.IsInside(root, Path.Combine(root, "images", "..", "plugin.png")));

// S7 · nothing is inside nothing.
Check("S7 empty inputs are not inside",
    !StreamDeckPaths.IsInside("", "x") && !StreamDeckPaths.IsInside(root, ""));

Console.WriteLine("Wired up");

// S8 · a TEXT check, and labelled as one. Everything above proves the predicates answer
// correctly; none of it proves the resolver asks them. That gap is not hypothetical — twice
// this week a ceiling was computed at a call site and then quietly ignored by the method it
// was passed to, and both times every value-level probe still passed. StreamDeckBridge needs
// Windows, an Elgato installation and a live profile, so its call sites cannot be driven
// from here; asserting they exist is weak, and weak beats absent.
var bridge = FindUpwards("src/WaveshareWidgets/App/StreamDeckBridge.cs");
if (bridge is null)
{
    Check("S8 setup: StreamDeckBridge.cs was found", false);
}
else
{
    var code = File.ReadAllText(bridge);
    Check("S8 the resolver validates both UUIDs before building a path",
        code.Contains("IsPlausibleUuid(pluginUuid)") && code.Contains("IsPlausibleUuid(actionUuid)"));
    Check("S8b every candidate is checked for containment before it is opened",
        code.Contains("StreamDeckPaths.IsInside(dir, candidate)"));
    Check("S8c the profile's own state image path is checked too",
        code.Contains("StreamDeckPaths.IsInside(pageDir, imagePath)"));
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
