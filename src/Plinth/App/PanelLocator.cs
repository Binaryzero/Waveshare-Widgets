namespace Plinth.App;

/// <summary>Finds the panel among the connected displays (<see cref="PanelModels"/>).</summary>
internal static class PanelLocator
{
    private static string? _warnedMissingDevice;

    /// <summary>
    /// Preference order: the display the user pinned in config, else the first display
    /// whose pixel size is a supported panel's: the Waveshare's 1280x400 (or 400x1280 while
    /// Windows still has it in its native portrait orientation — the dashboard will render,
    /// but the README tells users to rotate to landscape), or the XENEON EDGE's 2560x720.
    /// </summary>
    public static Screen? Find(string? preferredDeviceName)
    {
        var screens = Screen.AllScreens;

        if (!string.IsNullOrEmpty(preferredDeviceName))
        {
            var pinned = screens.FirstOrDefault(s => s.DeviceName == preferredDeviceName);
            if (pinned is not null)
            {
                _warnedMissingDevice = null;
                return pinned;
            }
            // The placement timer calls this every 2 s; warn once per missing device,
            // not once per tick.
            if (_warnedMissingDevice != preferredDeviceName)
            {
                _warnedMissingDevice = preferredDeviceName;
                Log.Warn($"Configured display '{preferredDeviceName}' not found; falling back to auto-detect");
            }
        }

        return screens.FirstOrDefault(s => LooksLikePanel(s.Bounds));
    }

    /// <summary>Whether a display is a supported panel, by its exact pixel size.</summary>
    public static bool LooksLikePanel(Rectangle bounds) => PanelModels.Match(bounds.Size) is not null;
}
