using Plinth.App;

namespace Plinth;

internal static class Program
{
    [STAThread]
    private static void Main()
    {
        // Before anything else, so the rename-era cleanup below has somewhere to log to.
        // Idempotent; TrayApplicationContext calls it again on the successful path.
        AppPaths.EnsureCreated();

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
}
