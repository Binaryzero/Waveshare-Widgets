using System;
using System.Diagnostics;
using System.IO;
using System.Threading;

namespace Plinth.Recover;

/// <summary>
/// PlinthRecover.exe (#239): <c>PlinthRecover.exe &lt;install&gt;\swap-journal.txt &lt;stamp&gt;</c>.
///
/// <para>Before an update swaps any file, Plinth copies this exe to
/// <c>%LocalAppData%\Plinth\updates</c> and registers the copy under the current user's
/// RunOnce key, and it removes both once the swap has committed or rolled back. So this
/// only ever runs at the first sign-in after an update was cut off, which is when a
/// self-contained install may be unable to start and repair itself.</para>
///
/// <para>It does nothing while Plinth runs: holding the single-instance lock means Plinth
/// started, and its own recovery ran first. Otherwise it takes the lock, restores the
/// install, releases the lock and starts Plinth, whose recovery then retires the journal.</para>
/// </summary>
internal static class Program
{
    /// <summary>Plinth's own single-instance lock (Program.cs), so the two never move files
    /// in the install at the same time.</summary>
    private const string InstanceLock = @"Global\Plinth.SingleInstance";

    private static int Main(string[] args)
    {
        if (args.Length != 2 || !SwapRestore.IsStamp(args[1]))
            return 2;
        string journal;
        try { journal = Path.GetFullPath(args[0]); }
        catch (Exception) { return 2; }
        if (!string.Equals(Path.GetFileName(journal), SwapRestore.JournalName, StringComparison.OrdinalIgnoreCase))
            return 2;
        // No journal: the update finished, or Plinth has already put it right.
        if (!File.Exists(journal))
            return 0;

        var installDir = Path.GetDirectoryName(journal)!;
        SwapRestore.Result result;
        Mutex mutex;
        try { mutex = new Mutex(false, InstanceLock); }
        catch (UnauthorizedAccessException)
        {
            // Another account's Plinth holds it, so an instance is running on this machine.
            return 0;
        }
        using (mutex)
        {
            bool owned;
            try { owned = mutex.WaitOne(TimeSpan.Zero); }
            catch (AbandonedMutexException) { owned = true; }
            // Plinth is running, so it started and ran its own recovery. Not logged: its
            // session owns app.log now.
            if (!owned)
                return 0;
            try
            {
                result = SwapRestore.Run(journal, args[1], UpdatesDir(), Log);
            }
            catch (Exception ex)
            {
                Log("Restore stopped: " + ex.Message);
                result = new SwapRestore.Result { Relaunch = true };
            }
            finally
            {
                mutex.ReleaseMutex();
            }
        }

        Log(result.Skipped != null
            ? "Nothing restored: " + result.Skipped
            : "An interrupted update was undone: " + result.Restored + " file(s) restored, "
              + result.Removed + " removed, " + result.Failed + " failed");
        if (result.Relaunch)
        {
            // Plinth was running the update when it stopped. Its own recovery finishes the
            // job (or explains what is left) as it starts.
            try
            {
                Process.Start(new ProcessStartInfo(Path.Combine(installDir, "Plinth.exe"))
                {
                    UseShellExecute = true,
                    WorkingDirectory = installDir,
                });
            }
            catch (Exception ex) { Log("Could not start Plinth: " + ex.Message); }
        }
        return 0;
    }

    private static string DataDir() => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Plinth");

    private static string UpdatesDir() => Path.Combine(DataDir(), "updates");

    /// <summary>Appends to Plinth's app.log in its line format. Plinth is not running while
    /// this writes (the lock above), and its next session rolls these lines into app.1.log.</summary>
    private static void Log(string message)
    {
        try
        {
            File.AppendAllText(Path.Combine(DataDir(), "app.log"),
                DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + " [INFO] Recovery helper: " + message + Environment.NewLine);
        }
        catch (Exception) { /* Logging must never stop a restore. */ }
    }
}
