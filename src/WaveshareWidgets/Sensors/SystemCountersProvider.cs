using System.Diagnostics;
using System.Runtime.InteropServices;

namespace WaveshareWidgets.Sensors;

/// <summary>
/// Zero-elevation fallback tier: CPU load and network throughput from PDH performance
/// counters, plus physical memory via GlobalMemoryStatusEx. Always available, so the
/// dashboard shows something useful even when LibreHardwareMonitor runs unelevated.
/// Counter names are the English ones; on non-English Windows the PDH counters silently
/// drop out while the memory readings remain.
/// </summary>
public sealed class SystemCountersProvider : ISensorProvider
{
    private PerformanceCounter? _cpuLoad;
    private readonly List<(string Nic, PerformanceCounter Received, PerformanceCounter Sent)> _nics = [];
    private readonly List<(string Zone, PerformanceCounter Counter)> _thermalZones = [];

    public string Name => "SystemCounters";

    public SystemCountersProvider()
    {
        try
        {
            _cpuLoad = new PerformanceCounter("Processor", "% Processor Time", "_Total", readOnly: true);
            _cpuLoad.NextValue(); // first sample always reads 0; prime it
        }
        catch (Exception ex)
        {
            Log.Warn($"CPU load counter unavailable: {ex.Message}");
        }

        // ACPI thermal zones: the only CPU-adjacent temperature Windows exposes without a
        // kernel driver or elevation. Which zones exist (and how honest they are) depends
        // on the motherboard firmware; values are reported in Kelvin.
        try
        {
            var category = new PerformanceCounterCategory("Thermal Zone Information");
            foreach (var zone in category.GetInstanceNames())
            {
                var counter = new PerformanceCounter("Thermal Zone Information", "Temperature", zone, readOnly: true);
                counter.NextValue();
                _thermalZones.Add((CleanZoneName(zone), counter));
            }
        }
        catch (Exception ex)
        {
            Log.Warn($"Thermal zone counters unavailable: {ex.Message}");
        }

        try
        {
            var category = new PerformanceCounterCategory("Network Interface");
            foreach (var nic in category.GetInstanceNames())
            {
                var received = new PerformanceCounter("Network Interface", "Bytes Received/sec", nic, readOnly: true);
                var sent = new PerformanceCounter("Network Interface", "Bytes Sent/sec", nic, readOnly: true);
                received.NextValue();
                sent.NextValue();
                _nics.Add((nic, received, sent));
            }
        }
        catch (Exception ex)
        {
            Log.Warn($"Network counters unavailable: {ex.Message}");
        }
    }

    public IEnumerable<SensorReading> Poll()
    {
        var readings = new List<SensorReading>();

        if (_cpuLoad is not null)
        {
            try
            {
                readings.Add(new SensorReading("sys:cpu:load", "CPU Total", "System", "System", "Load", "%",
                    Math.Round(_cpuLoad.NextValue(), 1)));
            }
            catch (Exception ex)
            {
                Log.Warn($"CPU load counter failed, disabling: {ex.Message}");
                _cpuLoad.Dispose();
                _cpuLoad = null;
            }
        }

        double downTotal = 0, upTotal = 0;
        var nicsOk = false;
        foreach (var (_, received, sent) in _nics)
        {
            try
            {
                downTotal += received.NextValue();
                upTotal += sent.NextValue();
                nicsOk = true;
            }
            catch
            {
                // NIC instances come and go (VPNs, sleep); skip broken ones this tick.
            }
        }
        if (nicsOk)
        {
            readings.Add(new SensorReading("sys:net:down", "Network Down", "System", "System", "Throughput", "B/s", Math.Round(downTotal)));
            readings.Add(new SensorReading("sys:net:up", "Network Up", "System", "System", "Throughput", "B/s", Math.Round(upTotal)));
        }

        foreach (var (zone, counter) in _thermalZones)
        {
            try
            {
                var kelvin = (double)counter.NextValue();
                if (kelvin > 1000) // some firmware reports tenths of Kelvin
                    kelvin /= 10;
                var celsius = kelvin - 273.15;
                if (celsius is > -20 and < 150)
                {
                    readings.Add(new SensorReading($"sys:thermal:{zone}", $"Thermal Zone {zone}",
                        "System", "System", "Temperature", "°C", Math.Round(celsius, 1)));
                }
            }
            catch
            {
                // Zones can disappear on ACPI events; skip this tick.
            }
        }

        var memory = new MEMORYSTATUSEX { dwLength = (uint)Marshal.SizeOf<MEMORYSTATUSEX>() };
        if (GlobalMemoryStatusEx(ref memory))
        {
            const double gib = 1024.0 * 1024 * 1024;
            var usedGib = (memory.ullTotalPhys - memory.ullAvailPhys) / gib;
            readings.Add(new SensorReading("sys:mem:load", "Memory Load", "System", "System", "Load", "%", memory.dwMemoryLoad));
            readings.Add(new SensorReading("sys:mem:used", "Memory Used", "System", "System", "Data", "GB", Math.Round(usedGib, 1)));
            readings.Add(new SensorReading("sys:mem:total", "Memory Total", "System", "System", "Data", "GB", Math.Round(memory.ullTotalPhys / gib, 1)));
        }

        return readings;
    }

    /// <summary>"\_TZ.CPUZ" → "CPUZ".</summary>
    private static string CleanZoneName(string instance)
    {
        var name = instance.Trim();
        var dot = name.LastIndexOf('.');
        if (dot >= 0 && dot < name.Length - 1)
            name = name[(dot + 1)..];
        return name.TrimStart('\\', '_');
    }

    public void Dispose()
    {
        _cpuLoad?.Dispose();
        foreach (var (_, received, sent) in _nics)
        {
            received.Dispose();
            sent.Dispose();
        }
        _nics.Clear();
        foreach (var (_, counter) in _thermalZones)
            counter.Dispose();
        _thermalZones.Clear();
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MEMORYSTATUSEX
    {
        public uint dwLength;
        public uint dwMemoryLoad;
        public ulong ullTotalPhys;
        public ulong ullAvailPhys;
        public ulong ullTotalPageFile;
        public ulong ullAvailPageFile;
        public ulong ullTotalVirtual;
        public ulong ullAvailVirtual;
        public ulong ullAvailExtendedVirtual;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GlobalMemoryStatusEx(ref MEMORYSTATUSEX lpBuffer);
}
