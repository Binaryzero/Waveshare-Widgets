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

    public void Dispose()
    {
        _cpuLoad?.Dispose();
        foreach (var (_, received, sent) in _nics)
        {
            received.Dispose();
            sent.Dispose();
        }
        _nics.Clear();
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
