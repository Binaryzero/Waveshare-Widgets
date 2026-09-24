namespace Plinth;

/// <summary>The file behind <see cref="Log"/> (#256): one file per session, a size cap that
/// ROLLS rather than deletes, and a fixed number of rolled files kept.
///
/// The logger this replaces kept every session in one file and, past 1 MB, deleted it —
/// so the file mixed weeks of old runs with the current one, and the moment it filled up,
/// the history a bug report needed was the thing thrown away. Now:
///
///   app.log      this session
///   app.1.log    the one before (or this session's first megabyte, if it rolled)
///   …
///   app.4.log    the oldest kept; the next roll drops it
///
/// So the directory never holds more than (keep + 1) × maxBytes of log, and nothing is
/// lost until it is the oldest of five files.</summary>
internal sealed class RollingLog
{
    public const long DefaultMaxBytes = 1_000_000;
    public const int DefaultKeep = 4;

    /// <summary>One line's ceiling. An exception with a deep stack is a few KB; a line far
    /// past this is a payload someone logged by accident (a renderer dump, a response body),
    /// and one of those alone could otherwise fill the file.</summary>
    public const int MaxLineChars = 16_384;

    private readonly string _path;
    private readonly long _maxBytes;
    private readonly int _keep;
    private readonly object _sync = new();

    public RollingLog(string path, long maxBytes = DefaultMaxBytes, int keep = DefaultKeep)
    {
        _path = path;
        _maxBytes = maxBytes;
        _keep = Math.Max(1, keep);
    }

    /// <summary>app.log for 0, app.N.log for N.</summary>
    public string PathFor(int n)
    {
        if (n == 0) return _path;
        var dir = Path.GetDirectoryName(_path) ?? "";
        return Path.Combine(dir, $"{Path.GetFileNameWithoutExtension(_path)}.{n}{Path.GetExtension(_path)}");
    }

    /// <summary>Begins a new session file: whatever app.log holds becomes app.1.log. Only the
    /// process that owns the single-instance lock may call this — a second launch that is
    /// about to exit must not roll the running instance's log out from under it.</summary>
    public void StartSession(string header)
    {
        lock (_sync)
        {
            if (File.Exists(_path) && new FileInfo(_path).Length > 0) TryRoll();
            File.AppendAllText(_path, Clip(header) + Environment.NewLine);
        }
    }

    public void Append(string line)
    {
        line = Clip(line) + Environment.NewLine;
        lock (_sync)
        {
            // Roll BEFORE the write that would cross the cap, so the live file stays under it.
            if (File.Exists(_path)
                && new FileInfo(_path).Length + System.Text.Encoding.UTF8.GetByteCount(line) > _maxBytes)
                TryRoll();
            File.AppendAllText(_path, line);
        }
    }

    public static string Clip(string line)
    {
        if (line.Length <= MaxLineChars) return line;
        return line[..MaxLineChars] + $" … [{line.Length - MaxLineChars} more characters not logged]";
    }

    /// <summary>A roll that fails (another process has a file open, say) leaves app.log in
    /// place and the line is still written: losing the line is worse than one file running
    /// past its cap until the next write's roll succeeds.</summary>
    private void TryRoll()
    {
        try
        {
            var oldest = PathFor(_keep);
            if (File.Exists(oldest)) File.Delete(oldest);
            for (var n = _keep - 1; n >= 1; n--)
            {
                var from = PathFor(n);
                if (File.Exists(from)) File.Move(from, PathFor(n + 1), overwrite: true);
            }
            File.Move(_path, PathFor(1), overwrite: true);
        }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
    }
}
