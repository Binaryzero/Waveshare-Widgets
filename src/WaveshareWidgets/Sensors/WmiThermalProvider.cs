using System.Management;

namespace WaveshareWidgets.Sensors;

/// <summary>
/// Second zero-install temperature source: ACPI thermal zones via WMI
/// (MSAcpi_ThermalZoneTemperature in root\WMI). Some firmwares expose zones here that
/// the "Thermal Zone Information" performance counters miss; on many systems the query
/// needs elevation. Disables itself after repeated failures so it costs nothing where
/// unsupported.
/// </summary>
public sealed class WmiThermalProvider : ISensorProvider
{
    private ManagementObjectSearcher? _searcher;
    private int _failures;

    public string Name => "WmiThermal";

    public WmiThermalProvider()
    {
        try
        {
            _searcher = new ManagementObjectSearcher(
                @"root\WMI", "SELECT InstanceName, CurrentTemperature FROM MSAcpi_ThermalZoneTemperature");
        }
        catch (Exception ex)
        {
            Log.Warn($"WMI thermal query unavailable: {ex.Message}");
        }
    }

    public IEnumerable<SensorReading> Poll()
    {
        if (_searcher is null)
            return [];

        var readings = new List<SensorReading>();
        try
        {
            foreach (var zone in _searcher.Get())
            {
                var instance = zone["InstanceName"]?.ToString() ?? "TZ";
                var celsius = Convert.ToDouble(zone["CurrentTemperature"]) / 10.0 - 273.15; // tenths of Kelvin
                if (celsius is > -20 and < 150)
                {
                    readings.Add(new SensorReading($"sys:acpitz:{CleanName(instance)}",
                        $"ACPI Thermal {CleanName(instance)}", "System", "System", "Temperature", "°C",
                        Math.Round(celsius, 1)));
                }
            }
            _failures = 0;
        }
        catch (Exception ex)
        {
            // Typical on unsupported firmware or unelevated runs ("Not supported" /
            // access denied); give up quietly instead of paying WMI cost every tick.
            if (++_failures >= 2)
            {
                Log.Info($"ACPI thermal zones not readable ({ex.Message}); disabling WMI thermal provider");
                _searcher.Dispose();
                _searcher = null;
            }
        }
        return readings;
    }

    private static string CleanName(string instance)
    {
        var name = instance;
        var dot = name.LastIndexOf('.');
        if (dot >= 0 && dot < name.Length - 1)
            name = name[(dot + 1)..];
        var zero = name.IndexOf("_0", StringComparison.Ordinal);
        if (zero > 0)
            name = name[..zero];
        return name.TrimStart('\\', '_');
    }

    public void Dispose()
    {
        _searcher?.Dispose();
        _searcher = null;
    }
}
