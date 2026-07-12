using WaveshareWidgets.App;

namespace WaveshareWidgets;

internal static class Program
{
    [STAThread]
    private static void Main()
    {
        using var mutex = new Mutex(initiallyOwned: true, "WaveshareWidgets.SingleInstance", out var isFirstInstance);
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
