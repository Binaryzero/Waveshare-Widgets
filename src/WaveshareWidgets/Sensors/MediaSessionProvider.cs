using Windows.Media.Control;
using Windows.Storage.Streams;

namespace WaveshareWidgets.Sensors;

/// <summary>
/// Now-playing info and transport control via the Windows Global System Media Transport
/// Controls (the same source the volume-flyout media card uses). Works unelevated;
/// requires Windows 10 1809+.
/// </summary>
public sealed class MediaSessionProvider : IDisposable
{
    private GlobalSystemMediaTransportControlsSessionManager? _manager;
    private string? _thumbnailKey;
    private string? _thumbnailDataUri;

    public async Task InitializeAsync()
    {
        try
        {
            _manager = await GlobalSystemMediaTransportControlsSessionManager.RequestAsync();
        }
        catch (Exception ex)
        {
            Log.Warn($"Media session manager unavailable: {ex.Message}");
        }
    }

    public async Task<MediaState> PollAsync()
    {
        var session = _manager?.GetCurrentSession();
        if (session is null)
            return MediaState.None;

        try
        {
            var props = await session.TryGetMediaPropertiesAsync();
            var status = session.GetPlaybackInfo()?.PlaybackStatus.ToString();

            double? position = null, duration = null;
            var timeline = session.GetTimelineProperties();
            if (timeline is not null && timeline.EndTime > timeline.StartTime)
            {
                duration = (timeline.EndTime - timeline.StartTime).TotalSeconds;
                position = Math.Clamp((timeline.Position - timeline.StartTime).TotalSeconds, 0, duration.Value);
            }

            // Album art decodes are comparatively expensive; only refetch when the track changes.
            var key = $"{props.Title}|{props.Artist}";
            if (key != _thumbnailKey)
            {
                _thumbnailKey = key;
                _thumbnailDataUri = await ReadThumbnailAsync(props.Thumbnail);
            }

            return new MediaState(true, props.Title, props.Artist, props.AlbumTitle, status, _thumbnailDataUri,
                position, duration);
        }
        catch (Exception ex)
        {
            Log.Warn($"Media poll failed: {ex.Message}");
            return MediaState.None;
        }
    }

    private static async Task<string?> ReadThumbnailAsync(IRandomAccessStreamReference? reference)
    {
        if (reference is null)
            return null;
        try
        {
            using var stream = await reference.OpenReadAsync();
            if (stream.Size == 0 || stream.Size > 2_000_000)
                return null;
            var reader = new DataReader(stream.GetInputStreamAt(0));
            await reader.LoadAsync((uint)stream.Size);
            var bytes = new byte[stream.Size];
            reader.ReadBytes(bytes);
            var mime = string.IsNullOrEmpty(stream.ContentType) ? "image/png" : stream.ContentType;
            return $"data:{mime};base64,{Convert.ToBase64String(bytes)}";
        }
        catch
        {
            return null;
        }
    }

    /// <summary>Handles a transport command coming from a widget ("toggle", "next", "prev").</summary>
    public async Task ControlAsync(string action)
    {
        var session = _manager?.GetCurrentSession();
        if (session is null)
            return;

        try
        {
            switch (action)
            {
                case "toggle": await session.TryTogglePlayPauseAsync(); break;
                case "next": await session.TrySkipNextAsync(); break;
                case "prev": await session.TrySkipPreviousAsync(); break;
                default: Log.Warn($"Unknown media action '{action}'"); break;
            }
        }
        catch (Exception ex)
        {
            Log.Warn($"Media control '{action}' failed: {ex.Message}");
        }
    }

    public void Dispose() => _manager = null;
}
