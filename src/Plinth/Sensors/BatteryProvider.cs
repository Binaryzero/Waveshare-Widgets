using System.Management;
using System.Text.RegularExpressions;

namespace Plinth.Sensors;

/// <summary>
/// Battery levels for wireless peripherals (headsets, mice, keyboards, phones) plus
/// system battery packs / UPS units — no vendor SDK required.
///
/// Peripherals: Windows maintains DEVPKEY_Bluetooth_Battery for every device whose
/// Bluetooth profile reports a level. Two details are load-bearing (technique studied
/// from the Xenon project's research): the sweep must cover the WHOLE PnP tree — a
/// headset's battery lives on a PNPClass=System "Hands-Free AG" node, so filtering to
/// the Bluetooth class silently loses headsets — and a device whose
/// DEVPKEY_Device_IsConnected is explicitly false must be dropped, because Windows
/// keeps reporting a paired-but-absent device's last-known level forever. Devices on
/// proprietary 2.4 GHz dongles (Logitech Unifying, Corsair Slipstream) expose no
/// battery to Windows at all — those need per-vendor HID readers and cannot show here.
///
/// The sweep touches a few hundred PnP nodes (~1-2 s), so it runs on its own 60 s
/// background timer; <see cref="Poll"/> just returns the cached snapshot.
/// </summary>
public sealed class BatteryProvider : ISensorProvider, IDisposable
{
    private const string BatteryKey = "{104EA319-6EE2-4701-BD47-8DDBF425BBE5} 2";    // DEVPKEY_Bluetooth_Battery
    private const string ConnectedKey = "{83DA6326-97A6-4088-9453-A1923F573B29} 15"; // DEVPKEY_Device_IsConnected

    // Windows appends the Bluetooth profile role to the node name ("Zone Vibe 100
    // Hands-Free AG"). Protocol names, never localized, so trimming is safe.
    private static readonly Regex ProfileSuffix = new(
        @"\s+(Hands-Free (AG|HF)|Stereo|AVRCP Transport|Avrcp Transport)$",
        RegexOptions.Compiled | RegexOptions.IgnoreCase);

    private static readonly Regex SlugFilter = new("[^a-z0-9]+", RegexOptions.Compiled);

    private volatile IReadOnlyList<SensorReading> _cache = [];
    private readonly System.Threading.Timer _refresh;
    private int _sweeping;

    public string Name => "Battery";

    public BatteryProvider()
    {
        _refresh = new System.Threading.Timer(_ => Sweep(), null, TimeSpan.Zero, TimeSpan.FromSeconds(60));
    }

    public IEnumerable<SensorReading> Poll() => _cache;

    private void Sweep()
    {
        if (Interlocked.Exchange(ref _sweeping, 1) == 1)
            return;
        try
        {
            _cache = ReadAll();
        }
        catch (Exception ex)
        {
            Log.Warn($"Battery sweep failed: {ex.Message}");
        }
        finally
        {
            Interlocked.Exchange(ref _sweeping, 0);
        }
    }

    private static IReadOnlyList<SensorReading> ReadAll()
    {
        var readings = new List<SensorReading>();
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        using (var searcher = new ManagementObjectSearcher("SELECT * FROM Win32_PnPEntity"))
        {
            foreach (var obj in searcher.Get())
            {
                using var device = (ManagementObject)obj;
                try
                {
                    var name = (device["Name"] as string)?.Trim();
                    if (string.IsNullOrEmpty(name))
                        continue;

                    using var inParams = device.GetMethodParameters("GetDeviceProperties");
                    inParams["devicePropertyKeys"] = new[] { BatteryKey, ConnectedKey };
                    using var outParams = device.InvokeMethod("GetDeviceProperties", inParams, null);
                    if (outParams?["deviceProperties"] is not ManagementBaseObject[] props)
                        continue;

                    string? raw = null;
                    bool? connected = null;
                    foreach (var prop in props)
                    {
                        // WMI reports well-known keys by friendly name ("DEVPKEY_...")
                        // instead of the "{guid} pid" form, so match either spelling.
                        var key = ReadString(prop, "KeyName") ?? ReadString(prop, "key") ?? "";
                        var data = ReadValue(prop, "Data");
                        if (key == BatteryKey || key.Contains("104EA319", StringComparison.OrdinalIgnoreCase) ||
                            key.EndsWith("Bluetooth_Battery", StringComparison.OrdinalIgnoreCase))
                            raw = data?.ToString();
                        else if ((key == ConnectedKey || key.Contains("83DA6326", StringComparison.OrdinalIgnoreCase) ||
                                  key.EndsWith("Device_IsConnected", StringComparison.OrdinalIgnoreCase)) && data is bool b)
                            connected = b;
                    }

                    if (raw is null)
                        continue;
                    // Absent property => keep (not every device reports it); only an
                    // explicit false means "paired but not actually here right now".
                    if (connected == false)
                        continue;
                    if (!int.TryParse(raw, out var percent) || percent is < 0 or > 100)
                        continue;

                    name = ProfileSuffix.Replace(name, "").Trim();
                    if (name.Length == 0)
                        continue;
                    if (name.Length > 64)
                        name = name[..64];

                    // One entry per device: a single peripheral owns several PnP nodes
                    // (audio profile, HID service, transport) mirroring the same battery.
                    if (!seen.Add(name))
                        continue;

                    readings.Add(new SensorReading($"battery:{Slug(name)}", name, name,
                        "Battery", "Battery", "%", percent));
                }
                catch
                {
                    // Per-device failures are normal (method unsupported, races); skip.
                }
            }
        }

        // Laptop packs and USB-connected UPS units — the one source that also knows
        // whether we're charging. Desktops without a UPS enumerate nothing.
        try
        {
            using var batteries = new ManagementObjectSearcher("SELECT Name, EstimatedChargeRemaining, BatteryStatus FROM Win32_Battery");
            foreach (var obj in batteries.Get())
            {
                using var b = (ManagementBaseObject)obj;
                var name = (b["Name"] as string)?.Trim();
                if (string.IsNullOrEmpty(name))
                    name = "Battery";
                if (b["EstimatedChargeRemaining"] is null)
                    continue;
                var percent = Convert.ToInt32(b["EstimatedChargeRemaining"]);
                if (percent is < 0 or > 100)
                    continue;
                // BatteryStatus 6-9 = charging states. 2 only means "on AC, not
                // necessarily charging" (e.g. held at full), so it doesn't count.
                var status = Convert.ToInt32(b["BatteryStatus"]);
                var charging = status is 6 or 7 or 8 or 9;
                if (!seen.Add(name))
                    continue;
                readings.Add(new SensorReading($"battery:{Slug(name)}",
                    charging ? name + " (charging)" : name, name, "Battery", "Battery", "%", percent));
            }
        }
        catch
        {
            // Win32_Battery absent on many desktops; nothing to report.
        }

        return readings;
    }

    private static string Slug(string name) => SlugFilter.Replace(name.ToLowerInvariant(), "-").Trim('-');

    private static string? ReadString(ManagementBaseObject obj, string property)
    {
        try { return obj[property] as string; }
        catch { return null; }
    }

    private static object? ReadValue(ManagementBaseObject obj, string property)
    {
        try { return obj[property]; }
        catch { return null; }
    }

    public void Dispose() => _refresh.Dispose();
}
