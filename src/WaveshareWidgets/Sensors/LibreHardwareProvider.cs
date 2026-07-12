using LibreHardwareMonitor.Hardware;

namespace WaveshareWidgets.Sensors;

/// <summary>
/// Primary sensor backend, wrapping LibreHardwareMonitorLib.
/// Unelevated it still yields GPU stats (via the vendor's user-mode driver DLLs), memory and
/// storage data; CPU temperatures and motherboard/SuperIO sensors appear only when the app
/// runs elevated (see README).
/// </summary>
public sealed class LibreHardwareProvider : ISensorProvider
{
    private readonly Computer _computer;
    private readonly UpdateVisitor _visitor = new();
    private bool _open;

    public string Name => "LibreHardwareMonitor";

    public LibreHardwareProvider()
    {
        _computer = new Computer
        {
            IsCpuEnabled = true,
            IsGpuEnabled = true,
            IsMemoryEnabled = true,
            IsMotherboardEnabled = true,
            IsStorageEnabled = true,
            IsNetworkEnabled = false, // network throughput comes from SystemCountersProvider
        };
        try
        {
            _computer.Open();
            _open = true;
        }
        catch (Exception ex)
        {
            Log.Error($"LibreHardwareMonitor failed to open: {ex.Message}");
        }
    }

    public IEnumerable<SensorReading> Poll()
    {
        if (!_open)
            return [];

        var readings = new List<SensorReading>();
        try
        {
            _computer.Accept(_visitor);
            foreach (var hardware in _computer.Hardware)
                Collect(hardware, readings);
        }
        catch (Exception ex)
        {
            Log.Warn($"LibreHardwareMonitor poll failed: {ex.Message}");
        }
        return readings;
    }

    private static void Collect(IHardware hardware, List<SensorReading> readings)
    {
        foreach (var sensor in hardware.Sensors)
        {
            readings.Add(new SensorReading(
                Id: $"lhm:{sensor.Identifier}",
                Name: sensor.Name,
                Device: hardware.Name,
                DeviceType: hardware.HardwareType.ToString(),
                Type: sensor.SensorType.ToString(),
                Units: UnitsFor(sensor.SensorType),
                Value: sensor.Value is { } v ? Math.Round(v, 2) : null));
        }
        foreach (var sub in hardware.SubHardware)
            Collect(sub, readings);
    }

    private static string UnitsFor(SensorType type) => type switch
    {
        SensorType.Temperature => "°C",
        SensorType.Load or SensorType.Level or SensorType.Control => "%",
        SensorType.Clock => "MHz",
        SensorType.Fan => "RPM",
        SensorType.Power => "W",
        SensorType.Voltage => "V",
        SensorType.Current => "A",
        SensorType.Data => "GB",
        SensorType.SmallData => "MB",
        SensorType.Throughput => "B/s",
        SensorType.Flow => "L/h",
        SensorType.Frequency => "Hz",
        SensorType.Energy => "mWh",
        _ => "",
    };

    public void Dispose()
    {
        if (_open)
        {
            _open = false;
            try { _computer.Close(); } catch { /* shutdown path */ }
        }
    }

    private sealed class UpdateVisitor : IVisitor
    {
        public void VisitComputer(IComputer computer) => computer.Traverse(this);

        public void VisitHardware(IHardware hardware)
        {
            hardware.Update();
            foreach (var sub in hardware.SubHardware)
                sub.Accept(this);
        }

        public void VisitSensor(ISensor sensor) { }
        public void VisitParameter(IParameter parameter) { }
    }
}
