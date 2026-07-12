namespace WaveshareWidgets.App;

/// <summary>Finds the Waveshare panel among the connected displays.</summary>
internal static class PanelLocator
{
    private static string? _warnedMissingDevice;

    /// <summary>
    /// Preference order: the display the user pinned in config, else the display whose
    /// pixel size matches the panel's unique 1280x400 / 400x1280 signature (400x1280 means
    /// Windows is still in the panel's native portrait orientation — the dashboard will
    /// render, but the README tells users to rotate to landscape).
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

        return screens.FirstOrDefault(s =>
            (s.Bounds.Width == 1280 && s.Bounds.Height == 400) ||
            (s.Bounds.Width == 400 && s.Bounds.Height == 1280));
    }
}
