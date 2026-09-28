namespace Plinth.App;

/// <summary>
/// The Plinth mark: src/Plinth/Assets/plinth.ico, drawn by tools/plinth-icon.js. The same
/// file is the exe's icon (ApplicationIcon) and is embedded, so the tray and the settings
/// window take the size they need from it. The tray used to draw a "W" at runtime, left
/// over from the project's old name.
/// </summary>
internal static class AppIcon
{
    private const string ResourceName = "Plinth.plinth.ico";

    private static Icon? _window;

    /// <summary>Every size, for a window: Windows picks the title bar's and the taskbar's.
    /// One instance for the process, since the settings window is opened many times.</summary>
    public static Icon Window => _window ??= Load(null);

    /// <summary>The size the notification area draws at this DPI (16 px at 100%, 24 at
    /// 150%), so the tray gets a drawn size rather than a scaled one.</summary>
    public static Icon ForTray() => Load(SystemInformation.SmallIconSize);

    private static Icon Load(Size? size)
    {
        try
        {
            using var stream = typeof(AppIcon).Assembly.GetManifestResourceStream(ResourceName);
            if (stream is not null)
                return size is { } s ? new Icon(stream, s) : new Icon(stream);
            Log.Warn($"The app icon resource {ResourceName} is missing");
        }
        catch (Exception ex)
        {
            Log.Warn($"Could not load the app icon: {ex.Message}");
        }
        return (Icon)SystemIcons.Application.Clone();
    }
}
