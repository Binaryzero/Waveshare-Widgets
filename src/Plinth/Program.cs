using Plinth.App;

namespace Plinth;

internal static class Program
{
    [STAThread]
    private static void Main(string[] args)
    {
        // Before anything else, so the rename-era cleanup below has somewhere to log to.
        // Idempotent; TrayApplicationContext calls it again on the successful path.
        AppPaths.EnsureCreated();

        // A self-update relaunches THIS exe while the old instance is still tearing
        // down. The updater passes the dying instance's pid; wait it out (bounded)
        // before contending for the single-instance mutex below.
        var waitAt = Array.IndexOf(args, "--wait-for");
        var relaunched = false;
        if (waitAt >= 0 && waitAt + 1 < args.Length && int.TryParse(args[waitAt + 1], out var pid))
        {
            relaunched = true;
            try { System.Diagnostics.Process.GetProcessById(pid).WaitForExit(15000); }
            catch (ArgumentException) { /* already gone — the good case */ }
        }

        // The stale Run value goes FIRST, before the refusal below can return. At logon
        // Windows starts both entries, and if the old app wins the race it holds the legacy
        // mutex — so cleaning up only on the path that reaches TrayApplicationContext would
        // exit while leaving the value in place, and repeat the same race at every logon.
        LegacyInstall.MoveAutostartEntry();

        if (LegacyInstall.InstanceRunning())
        {
            // Said out loud rather than exiting quietly. The same-name case below is silent
            // because the user double-clicked an app that is already running and can see it
            // in the tray; this one is a different executable under a different name, and
            // "nothing happened when I ran it" is not a diagnosis anybody can act on.
            MessageBox.Show(
                "An older Waveshare Widgets is still running.\n\n"
                + "It has been renamed to Plinth, and the two cannot share the panel — exit the "
                + "old one from its tray icon, then start Plinth again.",
                "Plinth", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return;
        }

        // An ordinary second launch bounces immediately — the app is already in the
        // tray and the user can see it. A RELAUNCH after a self-update waits instead:
        // teardown can outlive the pid grace above (WebView2 and the sensor providers
        // dispose slowly), and bouncing here would silently cancel the restart the
        // updater promised.
        // Global\, not the default Local\: an unqualified name scopes to each Windows
        // SESSION, so a console and an RDP login could both become "the" instance and
        // run swaps and cleanup concurrently against the same portable install.
        using var mutex = new Mutex(initiallyOwned: false, @"Global\Plinth.SingleInstance");
        bool owned;
        try
        {
            owned = mutex.WaitOne(relaunched ? TimeSpan.FromSeconds(30) : TimeSpan.Zero);
        }
        catch (AbandonedMutexException)
        {
            owned = true; // the previous instance died holding it; ownership passed here
        }
        if (!owned)
            return;

        // Only as the single instance: swap recovery MOVES files in the install dir,
        // and the sweep deletes rename-aside remnants — neither may race a sibling.
        var outcome = UpdateManager.CleanupAtStartup();
        if (outcome == UpdateManager.StartupOutcome.Refuse)
        {
            // An active journal remains and nothing could be repaired yet: the
            // install is KNOWN-mixed, and running a session over it trades a clear
            // failure now for undiagnosable ones later. Refusing is deliberate; the
            // next start retries recovery once whatever holds the files lets go.
            Log.Warn("Update recovery could not run; refusing to start over a mixed install");
            MessageBox.Show(
                "An update did not finish, and Plinth could not repair it yet — a file "
                + "may still be locked by another program.\n\n"
                + "Close other programs using Plinth's folder, then start Plinth again.",
                "Plinth", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return;
        }
        if (outcome == UpdateManager.StartupOutcome.Relaunch)
        {
            // Recovery restored files UNDER this process: the assemblies already
            // loaded may be the dead transaction's new code, now facing the old
            // shell assets and dependencies on disk — a contract that no longer
            // exists. One clean relaunch loads the install as restored; the child
            // waits out this pid and the mutex exactly like an updater relaunch.
            Log.Warn("Update recovery restored files; relaunching into the restored install");
            try
            {
                System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo
                {
                    FileName = Environment.ProcessPath ?? Path.Combine(AppContext.BaseDirectory, "Plinth.exe"),
                    Arguments = $"--wait-for {Environment.ProcessId}",
                    UseShellExecute = true,
                });
            }
            catch (Exception ex)
            {
                // Exiting is the deliberate choice — mixed images must not run a
                // session — but a tray that silently never appears is not an
                // explanation. Say what happened and what to do.
                Log.Warn($"Relaunch after recovery failed: {ex.Message}");
                MessageBox.Show(
                    "Plinth restored an interrupted update but could not restart itself.\n\n"
                    + "Start Plinth again from the Start menu or its folder.",
                    "Plinth", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
            return;
        }

        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);

        AppDomain.CurrentDomain.UnhandledException += (_, e) =>
            Log.Error($"Unhandled exception: {e.ExceptionObject}");
        Application.ThreadException += (_, e) =>
            Log.Error($"UI thread exception: {e.Exception}");

        Application.Run(new TrayApplicationContext());
    }
}
