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
    private int _failures;

    public CorsairSdkProvider()
    {
        try
        {
            foreach (var dir in new[] { AppContext.BaseDirectory, AppPaths.DataDir })
            {
                var path = Path.Combine(dir, DllName);
                if (File.Exists(path) && NativeLibrary.TryLoad(path, out _lib))
                    break;
            }
            if (_lib == IntPtr.Zero)
                return; // SDK not installed — provider stays inert

            _connect = Marshal.GetDelegateForFunctionPointer<CorsairConnectFn>(NativeLibrary.GetExport(_lib, "CorsairConnect"));
            _getDevices = Marshal.GetDelegateForFunctionPointer<CorsairGetDevicesFn>(NativeLibrary.GetExport(_lib, "CorsairGetDevices"));
            _readProperty = Marshal.GetDelegateForFunctionPointer<CorsairReadDevicePropertyFn>(NativeLibrary.GetExport(_lib, "CorsairReadDeviceProperty"));
            Log.Info("iCUE SDK client loaded; connecting to iCUE");
        }
        catch (Exception ex)
        {
            Log.Warn($"iCUE SDK unavailable: {ex.Message}");
            _lib = IntPtr.Zero;
        }
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
                _connect(_stateHandler, IntPtr.Zero); // async; the callback flips _connected
            }
            if (!_connected)
                return [];

            var readings = new List<SensorReading>();
            var filter = new CorsairDeviceFilter { DeviceTypeMask = unchecked((int)0xFFFFFFFF) };
            var infoSize = Marshal.SizeOf<CorsairDeviceInfo>();
            var buffer = Marshal.AllocHGlobal(infoSize * MaxDevices);
            try
            {
                if (_getDevices(ref filter, MaxDevices, buffer, out var count) != 0)
                    return [];

                for (var i = 0; i < Math.Min(count, MaxDevices); i++)
                {
                    var info = Marshal.PtrToStructure<CorsairDeviceInfo>(buffer + i * infoSize);
                    if (string.IsNullOrEmpty(info.Id))
                        continue;

                    // Most devices don't support the property; errors just mean "not wireless".
                    if (_readProperty(info.Id, PropertyBatteryLevel, 0, out var property) == 0 &&
                        property.DataType == DataTypeInt32)
                    {
                        readings.Add(new SensorReading(
                            $"corsair:{info.Id}:battery", $"{info.Model} Battery",
                            "Corsair", "Corsair", "Level", "%", property.Int32));
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
            _connected = eventData != IntPtr.Zero && Marshal.ReadInt32(eventData) == SessionStateConnected;
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
