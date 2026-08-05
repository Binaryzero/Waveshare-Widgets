using System.Collections.Concurrent;

namespace Plinth;

/// <summary>
/// Durable file persistence: write to a temp file in the same directory, flush it to
/// disk, then atomically swap it into place — a crash or power cut mid-save leaves the
/// previous file intact instead of a truncated one. Writes to the same path are
/// serialized by a per-path lock (the settings window and the on-panel editor can both
/// save layout.json), and the final rename retries briefly because antivirus and
/// indexer handles routinely hold just-written files on Windows.
/// </summary>
public static class DurableStore
{
    private static readonly ConcurrentDictionary<string, object> Gates = new(StringComparer.OrdinalIgnoreCase);

    public static void Write(string path, string contents)
    {
        var gate = Gates.GetOrAdd(Path.GetFullPath(path), _ => new object());
        lock (gate)
        {
            var tmp = path + ".tmp";
            using (var stream = new FileStream(tmp, FileMode.Create, FileAccess.Write, FileShare.None))
            using (var writer = new StreamWriter(stream))
            {
                writer.Write(contents);
                writer.Flush();
                stream.Flush(flushToDisk: true);
            }
            MoveWithRetry(tmp, path);
        }
    }

    private static void MoveWithRetry(string tmp, string path)
    {
        // File.Move(overwrite: true) is MoveFileEx(REPLACE_EXISTING) — atomic on the
        // same NTFS volume, which the temp file guarantees by living next to the target.
        for (var attempt = 0; ; attempt++)
        {
            try
            {
                File.Move(tmp, path, overwrite: true);
                return;
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException && attempt < 5)
            {
                Thread.Sleep(50 * (attempt + 1));
            }
        }
    }
}
