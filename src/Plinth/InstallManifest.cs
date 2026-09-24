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

    /// <summary>The first line of every list this updater writes. A file of the same name
    /// that does not start with it was not written here — releases before this one never
    /// wrote one, and a portable folder can hold anything — so it is not read as a list of
    /// files that are the release's to remove.</summary>
    public const string Header = "# Plinth install manifest v1";

    /// <summary>The header line, then one relative path per line, each followed by a
    /// newline, sorted so the file is stable across identical releases.</summary>
    public static string Serialize(IEnumerable<string> relativePaths) =>
        Header + "\n" + string.Concat(relativePaths
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .OrderBy(p => p, StringComparer.OrdinalIgnoreCase)
            .Select(p => p + "\n"));

    /// <summary>The listed paths, or none when the file does not start with
    /// <see cref="Header"/>. A last line with no newline after it is dropped: a torn write
    /// leaves a PREFIX of a name, and a prefix may name a different file.</summary>
    public static IReadOnlyList<string> Parse(string? text)
    {
        if (string.IsNullOrEmpty(text))
            return [];
        // A byte-order mark is tolerated: the release build writes the list, and an
        // encoder's BOM in front of the header must not make the release's own list
        // read as someone else's.
        var lines = text.TrimStart('\uFEFF').Replace("\r", "").Split('\n');
        if (lines.Length < 2 || lines[0] != Header)
            return [];
        // Split leaves "" after the final newline; anything else there is the torn line.
        return lines.Skip(1).Take(lines.Length - 2).Where(l => l.Length > 0).ToList();
    }

    /// <summary>The previous release's files the new one no longer ships.
    ///
    /// Only plain relative paths inside the install qualify. A rooted path, a "." or ".."
    /// segment, a drive or stream colon, a character no Windows file name can hold (a NUL,
    /// which would throw mid-swap and fail every later update the same way), an updater
    /// control file, or the manifest itself is skipped: every one of those is corruption or
    /// something this list must never remove, and skipping costs at most a stale file left
    /// behind.</summary>
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
            if (Path.IsPathRooted(rel) || rel[0] is '\\' or '/' || rel.Contains(':') || HasDotSegment(rel)
                || rel.Any(c => c < ' ' || c is '"' or '<' or '>' or '|' or '*' or '?'))
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
