using Plinth.App;

namespace Plinth;

internal static class Program
{
    /// <summary>The single-instance mutex as it was named before the rename.
    ///
    /// <para>Renaming the mutex renamed the only thing that could see a pre-rename
    /// instance. A still-running WaveshareWidgets.exe holds this name and nothing else,
    /// so the new name reports "first instance" quite correctly and two dashboard hosts
    /// end up repositioning and serving the same panel until one is killed by hand. The
    /// window is small but real: an in-place upgrade with the old app still running, or
    /// the stale autostart entry firing at logon before TrayApplicationContext gets to
    /// delete it.</para>
    ///
    /// <para>Probed, never held. Taking ownership would leave the new app squatting a name
    /// that belongs to software being removed — and would then block the OLD app from
    /// starting, which is someone else's decision to make, not this process's.</para></summary>
    private const string LegacyMutexName = "WaveshareWidgets.SingleInstance";

    [STAThread]
    private static void Main()
    {
        // Checked BEFORE the new mutex is created, so a refusal leaves nothing behind.
        if (LegacyInstanceRunning())
        {
            MessageBox.Show(
                "An older Waveshare Widgets is still running.\n\n"
                + "It has been renamed to Plinth, and the two cannot share the panel — exit the "
                + "old one from its tray icon, then start Plinth again.",
                "Plinth", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return;
        }

        using var mutex = new Mutex(initiallyOwned: true, "Plinth.SingleInstance", out var isFirstInstance);
        if (!isFirstInstance)
            return;

        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);

        AppDomain.CurrentDomain.UnhandledException += (_, e) =>
            Log.Error($"Unhandled exception: {e.ExceptionObject}");
        Application.ThreadException += (_, e) =>
            Log.Error($"UI thread exception: {e.Exception}");

        Application.Run(new TrayApplicationContext());
    }

    /// <summary>True when a pre-rename instance holds the old mutex.
    ///
    /// <para>An abandoned name is not a running app: the kernel object dies with its last
    /// handle, so a crashed predecessor leaves nothing to open and this returns false —
    /// which is what we want, since there is no window for the user to go and close.</para>
    ///
    /// <para>An unexpected failure proceeds rather than refuses. Being unable to open the
    /// name is not evidence it is held, and treating it as such would make an unstartable
    /// app out of a guard whose whole job is a transitional courtesy. Proceeding restores
    /// exactly the behaviour this branch did not exist to change.</para></summary>
    private static bool LegacyInstanceRunning()
    {
        try
        {
            if (!Mutex.TryOpenExisting(LegacyMutexName, out var legacy))
                return false;
            legacy.Dispose();
            return true;
        }
        catch (Exception ex)
        {
            Log.Warn($"Could not check for a pre-rename instance: {ex.Message}");
            return false;
        }
    }
}
