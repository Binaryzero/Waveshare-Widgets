namespace Plinth;

/// <summary>The files a release placed in the install, so the next update can remove the
/// ones it no longer ships (#240). Pure, so tools/InstallManifest covers it without an
/// install to update.
///
/// The updater replaced and added files but never removed any: a DLL or shell asset a
/// release dropped survived every in-app update, and the install drifted from a clean
/// copy. The manifest is how a later update knows which files are the release's to
/// remove. Anything never listed in one was put there by someone else and is never
/// touched.</summary>
internal static class InstallManifest
{
    public const string FileName = "install-manifest.txt";

    /// <summary>One relative path per line, each followed by a newline, sorted so the file
    /// is stable across identical releases.</summary>
    public static string Serialize(IEnumerable<string> relativePaths) =>
        string.Concat(relativePaths
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .OrderBy(p => p, StringComparer.OrdinalIgnoreCase)
            .Select(p => p + "\n"));

    /// <summary>The listed paths. A last line with no newline after it is dropped: a torn
    /// write leaves a PREFIX of a name, and a prefix may name a different file.</summary>
    public static IReadOnlyList<string> Parse(string? text)
    {
        if (string.IsNullOrEmpty(text))
            return [];
        var lines = text.Replace("\r", "").Split('\n');
        // Split leaves "" after the final newline; anything else there is the torn line.
        return lines.Take(lines.Length - 1).Where(l => l.Length > 0).ToList();
    }

    /// <summary>The previous release's files the new one no longer ships.
    ///
    /// Only plain relative paths inside the install qualify. A rooted path, a "." or ".."
    /// segment, a drive or stream colon, an updater control file, or the manifest itself is
    /// skipped: every one of those is corruption or something this list must never
    /// remove, and skipping costs at most a stale file left behind.</summary>
    public static IReadOnlyList<string> Retirements(
        IEnumerable<string> previous, IEnumerable<string> current, Func<string, bool> isControlFile)
    {
        var keep = new HashSet<string>(current, StringComparer.OrdinalIgnoreCase);
        var retire = new List<string>();
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var rel in previous)
        {
            if (string.IsNullOrWhiteSpace(rel) || keep.Contains(rel) || !seen.Add(rel))
                continue;
            if (Path.IsPathRooted(rel) || rel[0] is '\\' or '/' || rel.Contains(':') || HasDotSegment(rel))
                continue;
            if (isControlFile(rel) || rel.Equals(FileName, StringComparison.OrdinalIgnoreCase))
                continue;
            retire.Add(rel);
        }
        return retire;
    }

    private static bool HasDotSegment(string rel)
    {
        foreach (var segment in rel.Split('\\', '/'))
            if (segment is "." or "..")
                return true;
        return false;
    }
}
