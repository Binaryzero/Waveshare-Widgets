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

    /// <summary>Set by <see cref="StartSession"/>. Until then this process has not shown it
    /// owns the log — it may be a second launch about to exit — so its lines are appended
    /// but never roll anything.</summary>
    private bool _sessionOwner;

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
            _sessionOwner = true;
            if (File.Exists(_path) && new FileInfo(_path).Length > 0) TryRoll();
            File.AppendAllText(_path, Clip(header) + Environment.NewLine);
        }
    }

    public void Append(string line)
    {
        line = Clip(line) + Environment.NewLine;
        lock (_sync)
        {
            // Roll BEFORE the write that would cross the cap, so the live file stays under it —
            // but only as the session's owner. A line written before the single-instance
            // lock (or by a second launch on its way out) rolling here would move the running
            // instance's log out from under it, or spend a slot just before StartSession
            // rolls again.
            if (_sessionOwner && File.Exists(_path)
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

    /// <summary>A roll that fails (a viewer holding app.log open without delete sharing, say)
    /// leaves app.log in place and the line is still written: losing the line is worse than
    /// one file running past its cap until a later roll succeeds.
    ///
    /// The LIVE file moves first, to a staging name. That is the step something outside
    /// can block, so it has to fail before any kept file is touched. Shifting the kept
    /// files first meant a blocked roll had already deleted the oldest and shuffled the
    /// rest, and every following line retried it, so four lines could erase all four.
    /// A roll that fails LATER, after staging, is made safe by <see cref="Vacate"/>.</summary>
    private void TryRoll()
    {
        var staged = _path + ".rolling";
        try
        {
            // A roll that stopped after staging left the last file here: finish that one.
            if (File.Exists(staged)) { Vacate(1); File.Move(staged, PathFor(1)); }
            File.Move(_path, staged);
            Vacate(1);
            File.Move(staged, PathFor(1));
        }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
    }

    /// <summary>Frees slot n by pushing what is in it one slot down, making room there
    /// first. Only a FULL chain loses its oldest file, so a roll that keeps failing part-way
    /// cannot erase the kept files one retry at a time: after one attempt the chain has a
    /// gap, and a gap stops the next attempt from deleting anything.</summary>
    private void Vacate(int n)
    {
        var at = PathFor(n);
        if (!File.Exists(at)) return;
        if (n >= _keep) { File.Delete(at); return; }
        Vacate(n + 1);
        File.Move(at, PathFor(n + 1));
    }
}
