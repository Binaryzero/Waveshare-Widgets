using System.Security.Principal;

namespace WaveshareWidgets.Sensors;

/// <summary>
/// Owns the sensor providers and polls them on a background timer, publishing one merged
/// snapshot per tick. Subscribers receive events on a thread-pool thread and must marshal
/// to their own thread as needed.
/// </summary>
public sealed class SensorHub : IDisposable
{
    private readonly List<ISensorProvider> _providers = [];
    private readonly MediaSessionProvider _media = new();
    private System.Threading.Timer? _timer;
    private int _polling;

    public IReadOnlyList<SensorReading> LatestSensors { get; private set; } = [];
    public MediaState LatestMedia { get; private set; } = MediaState.None;
    public bool IsElevated { get; }

    public event Action<IReadOnlyList<SensorReading>>? SensorsUpdated;
    public event Action<MediaState>? MediaUpdated;

    public SensorHub()
    {
        using var identity = WindowsIdentity.GetCurrent();
        IsElevated = new WindowsPrincipal(identity).IsInRole(WindowsBuiltInRole.Administrator);
    }

    public void Start(int pollIntervalMs)
    {
        _providers.Add(new SystemCountersProvider());
        _providers.Add(new WmiThermalProvider());
        _providers.Add(new LibreHardwareProvider());
        _media.InitializeAsync().GetAwaiter().GetResult();

        _timer = new System.Threading.Timer(_ => PollOnce(), null, dueTime: 0, period: pollIntervalMs);
        Log.Info($"Sensor hub started (elevated: {IsElevated}, interval: {pollIntervalMs} ms)");
    }

    private void PollOnce()
    {
        // Skip the tick if the previous poll is still running (LHM can be slow on some boards).
        if (Interlocked.Exchange(ref _polling, 1) == 1)
            return;

        try
        {
            var snapshot = new List<SensorReading>();
            foreach (var provider in _providers)
            {
                try
                {
                    snapshot.AddRange(provider.Poll());
                }
                catch (Exception ex)
                {
                    Log.Warn($"Provider {provider.Name} failed: {ex.Message}");
                }
            }
            LatestSensors = snapshot;
            SensorsUpdated?.Invoke(snapshot);

            var media = _media.PollAsync().GetAwaiter().GetResult();
            if (media != LatestMedia)
            {
                LatestMedia = media;
                MediaUpdated?.Invoke(media);
            }
        }
        catch (Exception ex)
        {
            Log.Error($"Poll tick failed: {ex.Message}");
        }
        finally
        {
            Interlocked.Exchange(ref _polling, 0);
        }
    }

    public Task ControlMediaAsync(string action) => _media.ControlAsync(action);

    public void Dispose()
    {
        _timer?.Dispose();
        _media.Dispose();
        foreach (var provider in _providers)
        {
            try { provider.Dispose(); } catch { /* shutdown path */ }
        }
        _providers.Clear();
    }
}
