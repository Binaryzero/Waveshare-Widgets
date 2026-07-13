using System.Runtime.InteropServices;

namespace WaveshareWidgets.Sensors;

/// <summary>
/// Battery levels for Corsair wireless devices via the official iCUE SDK (cue-sdk v4).
/// The public SDK exposes no system sensors (temps/fans are iCUE-internal), but
/// CDPI_BatteryLevel works for wireless keyboards/mice/headsets.
///
/// Opt-in by presence: place iCUESDK.x64_2019.dll (from the cue-sdk GitHub releases)
/// next to WaveshareWidgets.exe and enable "SDK" in iCUE's settings. Without the DLL
/// this provider is inert.
/// </summary>
public sealed partial class CorsairSdkProvider : ISensorProvider
{
    private const string DllName = "iCUESDK.x64_2019.dll";
    private const int MaxDevices = 64;
    private const int CorsairStringSizeM = 128;
    private const int SessionStateConnected = 6; // CSS_Connected
    private const int PropertyBatteryLevel = 9;  // CDPI_BatteryLevel
    private const int DataTypeInt32 = 1;         // CT_Int32

    public string Name => "CorsairSdk";

    private IntPtr _lib;
    private CorsairConnectFn? _connect;
    private CorsairGetDevicesFn? _getDevices;
    private CorsairReadDevicePropertyFn? _readProperty;
    private SessionStateChangedHandler? _stateHandler; // rooted so the native callback stays valid
    private volatile bool _connected;
    private bool _connectRequested;
    private bool _loggedDevices;
    private readonly HashSet<string> _loggedBatteries = [];
    private int _failures;

    public CorsairSdkProvider()
    {
        try
        {
            var loadedFrom = TryLoadLibrary();
            if (_lib == IntPtr.Zero)
            {
                Log.Info("iCUE SDK DLL not found (drop iCUESDK.x64_2019.dll next to the exe, " +
                         "or install iCUE); battery sensors disabled");
                return;
            }

            _connect = Marshal.GetDelegateForFunctionPointer<CorsairConnectFn>(NativeLibrary.GetExport(_lib, "CorsairConnect"));
            _getDevices = Marshal.GetDelegateForFunctionPointer<CorsairGetDevicesFn>(NativeLibrary.GetExport(_lib, "CorsairGetDevices"));
            _readProperty = Marshal.GetDelegateForFunctionPointer<CorsairReadDevicePropertyFn>(NativeLibrary.GetExport(_lib, "CorsairReadDeviceProperty"));
            Log.Info($"iCUE SDK client loaded from '{loadedFrom}'; connecting to iCUE");
        }
        catch (Exception ex)
        {
            // Most likely a missing export -> wrong/old DLL for this iCUE version.
            Log.Warn($"iCUE SDK load failed (wrong DLL version?): {ex.Message}");
            _lib = IntPtr.Zero;
        }
    }

    /// <summary>Searches the exe dir, the data dir, and common iCUE install locations for
    /// a loadable SDK DLL. Returns the resolved path, or null.</summary>
    private string? TryLoadLibrary()
    {
        var names = new[] { DllName, "iCUESDK.x64_2019.dll", "iCUESDK_2019.dll", "iCUESDK.dll" };
        var dirs = new List<string> { AppContext.BaseDirectory, AppPaths.DataDir };

        foreach (var root in new[]
                 {
                     Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
                     Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86),
                 })
        {
            if (string.IsNullOrEmpty(root))
                continue;
            var corsair = Path.Combine(root, "Corsair");
            if (!Directory.Exists(corsair))
                continue;
            // e.g. "CORSAIR iCUE5 Software" — enumerate to survive naming/version changes.
            try
            {
                foreach (var sub in Directory.GetDirectories(corsair, "*iCUE*"))
                    dirs.Add(sub);
            }
            catch { /* permissions */ }
        }

        foreach (var dir in dirs)
        {
            foreach (var name in names)
            {
                var path = Path.Combine(dir, name);
                if (File.Exists(path) && NativeLibrary.TryLoad(path, out _lib))
                    return path;
            }
        }
        return null;
    }

    public IEnumerable<SensorReading> Poll()
    {
        if (_lib == IntPtr.Zero || _connect is null || _getDevices is null || _readProperty is null)
            return [];

        try
        {
            if (!_connectRequested)
            {
                _connectRequested = true;
                _stateHandler = OnSessionStateChanged;
                var error = _connect(_stateHandler, IntPtr.Zero); // async; the callback flips _connected
                Log.Info($"iCUE SDK CorsairConnect -> {error} (0 = success; session handshake continues async)");
            }
            if (!_connected)
                return [];

            var readings = new List<SensorReading>();
            var filter = new CorsairDeviceFilter { DeviceTypeMask = unchecked((int)0xFFFFFFFF) };
            var infoSize = Marshal.SizeOf<CorsairDeviceInfo>();
            var buffer = Marshal.AllocHGlobal(infoSize * MaxDevices);
            try
            {
                var devicesError = _getDevices(ref filter, MaxDevices, buffer, out var count);
                if (devicesError != 0)
                {
                    if (!_loggedDevices)
                    {
                        _loggedDevices = true;
                        Log.Warn($"iCUE SDK CorsairGetDevices -> error {devicesError}");
                    }
                    return [];
                }
                if (!_loggedDevices)
                {
                    _loggedDevices = true;
                    Log.Info($"iCUE SDK connected: {count} device(s) enumerated");
                }

                for (var i = 0; i < Math.Min(count, MaxDevices); i++)
                {
                    var info = Marshal.PtrToStructure<CorsairDeviceInfo>(buffer + i * infoSize);
                    if (string.IsNullOrEmpty(info.Id))
                        continue;

                    // Most devices don't support the property; errors just mean "not wireless".
                    var propError = _readProperty(info.Id, PropertyBatteryLevel, 0, out var property);
                    if (propError == 0 && property.DataType == DataTypeInt32)
                    {
                        if (_loggedBatteries.Add(info.Id))
                            Log.Info($"iCUE SDK battery sensor: {info.Model} = {property.Int32}%");
                        readings.Add(new SensorReading(
                            $"corsair:{info.Id}:battery", $"{info.Model} Battery",
                            "Corsair", "Corsair", "Level", "%", property.Int32));
                    }
                    else if (_loggedBatteries.Add(info.Id))
                    {
                        Log.Info($"iCUE SDK device '{info.Model}' (type {info.Type}): no battery (error {propError}, dataType {property.DataType})");
                    }
                }
            }
            finally
            {
                Marshal.FreeHGlobal(buffer);
            }
            _failures = 0;
            return readings;
        }
        catch (Exception ex)
        {
            if (++_failures >= 2)
            {
                Log.Warn($"iCUE SDK polling failed ({ex.Message}); disabling provider");
                _lib = IntPtr.Zero;
            }
            return [];
        }
    }

    private void OnSessionStateChanged(IntPtr context, IntPtr eventData)
    {
        try
        {
            // CorsairSessionStateChanged begins with the CorsairSessionState enum.
            var state = eventData != IntPtr.Zero ? Marshal.ReadInt32(eventData) : -1;
            _connected = state == SessionStateConnected;
            Log.Info($"iCUE SDK session state -> {state} (6 = connected; 4 = refused, check iCUE's 'Enable SDK' setting)");
        }
        catch
        {
            _connected = false;
        }
    }

    public void Dispose()
    {
        var lib = _lib;
        _lib = IntPtr.Zero;
        if (lib != IntPtr.Zero)
        {
            try
            {
                if (NativeLibrary.TryGetExport(lib, "CorsairDisconnect", out var disconnect))
                    Marshal.GetDelegateForFunctionPointer<CorsairDisconnectFn>(disconnect)();
            }
            catch { /* shutdown path */ }
        }
    }

    // --- native surface (cue-sdk v4, cdecl) ---

    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    private delegate void SessionStateChangedHandler(IntPtr context, IntPtr eventData);

    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    private delegate int CorsairConnectFn(SessionStateChangedHandler onStateChanged, IntPtr context);

    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    private delegate int CorsairGetDevicesFn(ref CorsairDeviceFilter filter, int sizeMax, IntPtr devices, out int size);

    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    private delegate int CorsairReadDevicePropertyFn(
        [MarshalAs(UnmanagedType.LPStr)] string deviceId, int propertyId, uint index, out CorsairProperty property);

    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    private delegate int CorsairDisconnectFn();

    [StructLayout(LayoutKind.Sequential)]
    private struct CorsairDeviceFilter
    {
        public int DeviceTypeMask;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Ansi)]
    private struct CorsairDeviceInfo
    {
        public int Type;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = CorsairStringSizeM)] public string Id;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = CorsairStringSizeM)] public string Serial;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = CorsairStringSizeM)] public string Model;
        public int LedCount;
        public int ChannelCount;
    }

    /// <summary>CorsairProperty: a data-type tag plus an 8-byte-aligned union.</summary>
    [StructLayout(LayoutKind.Explicit)]
    private struct CorsairProperty
    {
        [FieldOffset(0)] public int DataType;
        [FieldOffset(8)] public int Int32;
        [FieldOffset(8)] public double Float64;
        [FieldOffset(8)] public IntPtr Pointer;
        [FieldOffset(16)] public uint Count;
    }
}
