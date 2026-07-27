using System.Runtime.InteropServices;

namespace WaveshareWidgets.App;

/// <summary>
/// Windows Core Audio access for the Volume widget: the default render endpoint's
/// master volume/mute plus every active audio session (per-app volume), via raw COM
/// interop — no NAudio dependency. All calls are cheap enough to poll at 1 Hz.
/// </summary>
public sealed class AudioMixer
{
    public sealed record AudioSessionInfo(int Pid, string Name, float Level, bool Muted);
    public sealed record AudioSnapshot(float MasterLevel, bool MasterMuted, IReadOnlyList<AudioSessionInfo> Sessions);

    /// <summary>Reads the current master + per-session state. Returns null when audio is unavailable.</summary>
    public AudioSnapshot? Read()
    {
        try
        {
            var enumerator = (IMMDeviceEnumerator)new MMDeviceEnumeratorComObject();
            enumerator.GetDefaultAudioEndpoint(EDataFlow.Render, ERole.Multimedia, out var device);
            try
            {
                var epVolume = Activate<IAudioEndpointVolume>(device);
                epVolume.GetMasterVolumeLevelScalar(out var master);
                epVolume.GetMute(out var masterMuted);

                var sessions = new List<AudioSessionInfo>();
                var manager = Activate<IAudioSessionManager2>(device);
                manager.GetSessionEnumerator(out var sessionEnum);
                sessionEnum.GetCount(out var count);
                for (var i = 0; i < count; i++)
                {
                    try
                    {
                        sessionEnum.GetSession(i, out var control);
                        var control2 = (IAudioSessionControl2)control;
                        control2.GetProcessId(out var pid);
                        if (pid == 0)
                            continue; // system sounds session; master already covers it
                        control2.GetState(out var state);
                        if (state == AudioSessionState.Expired)
                            continue;

                        var volume = (ISimpleAudioVolume)control;
                        volume.GetMasterVolume(out var level);
                        volume.GetMute(out var muted);

                        sessions.Add(new AudioSessionInfo((int)pid, SessionName(control2, (int)pid), level, muted));
                        Marshal.ReleaseComObject(control);
                    }
                    catch
                    {
                        // sessions come and go mid-enumeration; skip strays
                    }
                }
                Marshal.ReleaseComObject(sessionEnum);
                Marshal.ReleaseComObject(manager);
                Marshal.ReleaseComObject(epVolume);

                // One entry per app: a game can own several sessions; merge by name,
                // keeping the loudest (that's the one the user is hearing).
                var merged = sessions
                    .GroupBy(s => s.Name, StringComparer.OrdinalIgnoreCase)
                    .Select(g => g.OrderByDescending(s => s.Level).First())
                    .OrderBy(s => s.Name, StringComparer.OrdinalIgnoreCase)
                    .ToList();
                return new AudioSnapshot(master, masterMuted, merged);
            }
            finally
            {
                Marshal.ReleaseComObject(device);
                Marshal.ReleaseComObject(enumerator);
            }
        }
        catch (Exception ex)
        {
            Log.Warn($"Audio read failed: {ex.Message}");
            return null;
        }
    }

    /// <summary>Sets master ("master") or a session's (pid as string) level/mute.</summary>
    /// <summary>Returns whether anything was actually applied — false when the target
    /// session vanished or the endpoint failed, so the widget can revert its
    /// optimistic UI instead of silently disagreeing with Windows.</summary>
    public bool Apply(string target, float? level, bool? muted)
    {
        try
        {
            var enumerator = (IMMDeviceEnumerator)new MMDeviceEnumeratorComObject();
            enumerator.GetDefaultAudioEndpoint(EDataFlow.Render, ERole.Multimedia, out var device);
            try
            {
                if (target == "master")
                {
                    var epVolume = Activate<IAudioEndpointVolume>(device);
                    var ctx = Guid.Empty;
                    if (level is { } l)
                        epVolume.SetMasterVolumeLevelScalar(Math.Clamp(l, 0f, 1f), ref ctx);
                    if (muted is { } m)
                        epVolume.SetMute(m, ref ctx);
                    Marshal.ReleaseComObject(epVolume);
                    return true;
                }

                if (!int.TryParse(target, out var targetPid))
                    return false;
                var manager = Activate<IAudioSessionManager2>(device);
                manager.GetSessionEnumerator(out var sessionEnum);
                sessionEnum.GetCount(out var count);
                // Apply to every session of the target app's NAME, not just the pid:
                // multi-process apps (browsers, games with helpers) split their audio.
                string? targetName = null;
                var applied = false;
                for (var pass = 0; pass < 2; pass++)
                {
                    for (var i = 0; i < count; i++)
                    {
                        try
                        {
                            sessionEnum.GetSession(i, out var control);
                            var control2 = (IAudioSessionControl2)control;
                            control2.GetProcessId(out var pid);
                            var name = SessionName(control2, (int)pid);
                            var matches = pass == 0
                                ? pid == targetPid
                                : targetName is not null && string.Equals(name, targetName, StringComparison.OrdinalIgnoreCase);
                            if (matches)
                            {
                                targetName ??= name;
                                var volume = (ISimpleAudioVolume)control;
                                var sctx = Guid.Empty;
                                if (level is { } sl)
                                    volume.SetMasterVolume(Math.Clamp(sl, 0f, 1f), ref sctx);
                                if (muted is { } sm)
                                    volume.SetMute(sm, ref sctx);
                                applied = true;
                            }
                            Marshal.ReleaseComObject(control);
                        }
                        catch { /* transient session */ }
                    }
                    if (targetName is null)
                        break;
                }
                Marshal.ReleaseComObject(sessionEnum);
                Marshal.ReleaseComObject(manager);
                return applied;
            }
            finally
            {
                Marshal.ReleaseComObject(device);
                Marshal.ReleaseComObject(enumerator);
            }
        }
        catch (Exception ex)
        {
            Log.Warn($"Audio set failed: {ex.Message}");
            return false;
        }
    }

    private static string SessionName(IAudioSessionControl2 control, int pid)
    {
        try
        {
            control.GetDisplayName(out var display);
            if (!string.IsNullOrWhiteSpace(display) && !display.StartsWith('@'))
                return display;
        }
        catch { /* fall through to process name */ }
        try
        {
            using var process = System.Diagnostics.Process.GetProcessById(pid);
            var title = process.MainWindowTitle;
            return string.IsNullOrWhiteSpace(title) || title.Length > 40 ? process.ProcessName : title;
        }
        catch
        {
            return "PID " + pid;
        }
    }

    private static T Activate<T>(IMMDevice device)
    {
        var iid = typeof(T).GUID;
        device.Activate(ref iid, 23 /* CLSCTX_ALL */, IntPtr.Zero, out var itf);
        return (T)itf;
    }

    // --- Core Audio COM interop (vtable order is load-bearing) ---

    private enum EDataFlow { Render, Capture, All }
    private enum ERole { Console, Multimedia, Communications }
    private enum AudioSessionState { Inactive, Active, Expired }

    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    private class MMDeviceEnumeratorComObject { }

    [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IMMDeviceEnumerator
    {
        void _EnumAudioEndpoints();
        void GetDefaultAudioEndpoint(EDataFlow dataFlow, ERole role, out IMMDevice device);
    }

    [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IMMDevice
    {
        void Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object itf);
    }

    [ComImport, Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioSessionManager2
    {
        void _GetAudioSessionControl();
        void _GetSimpleAudioVolume();
        void GetSessionEnumerator(out IAudioSessionEnumerator sessionEnum);
    }

    [ComImport, Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioSessionEnumerator
    {
        void GetCount(out int count);
        void GetSession(int index, out IAudioSessionControl session);
    }

    [ComImport, Guid("F4B1A599-7266-4319-A8CA-E70ACB11E8CD"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioSessionControl
    {
        void GetState(out AudioSessionState state);
        void GetDisplayName([MarshalAs(UnmanagedType.LPWStr)] out string name);
        void SetDisplayName([MarshalAs(UnmanagedType.LPWStr)] string value, ref Guid eventContext);
        void GetIconPath([MarshalAs(UnmanagedType.LPWStr)] out string path);
        void SetIconPath([MarshalAs(UnmanagedType.LPWStr)] string value, ref Guid eventContext);
        void GetGroupingParam(out Guid param);
        void SetGroupingParam(ref Guid param, ref Guid eventContext);
        void RegisterAudioSessionNotification(IntPtr client);
        void UnregisterAudioSessionNotification(IntPtr client);
    }

    [ComImport, Guid("BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioSessionControl2
    {
        // IAudioSessionControl
        void GetState(out AudioSessionState state);
        void GetDisplayName([MarshalAs(UnmanagedType.LPWStr)] out string name);
        void SetDisplayName([MarshalAs(UnmanagedType.LPWStr)] string value, ref Guid eventContext);
        void GetIconPath([MarshalAs(UnmanagedType.LPWStr)] out string path);
        void SetIconPath([MarshalAs(UnmanagedType.LPWStr)] string value, ref Guid eventContext);
        void GetGroupingParam(out Guid param);
        void SetGroupingParam(ref Guid param, ref Guid eventContext);
        void RegisterAudioSessionNotification(IntPtr client);
        void UnregisterAudioSessionNotification(IntPtr client);
        // IAudioSessionControl2
        void GetSessionIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string id);
        void GetSessionInstanceIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string id);
        void GetProcessId(out uint pid);
        [PreserveSig] int IsSystemSoundsSession();
        void SetDuckingPreference(bool optOut);
    }

    [ComImport, Guid("87CE5498-68D6-44E5-9215-6DA47EF883D8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface ISimpleAudioVolume
    {
        void SetMasterVolume(float level, ref Guid eventContext);
        void GetMasterVolume(out float level);
        void SetMute([MarshalAs(UnmanagedType.Bool)] bool muted, ref Guid eventContext);
        void GetMute([MarshalAs(UnmanagedType.Bool)] out bool muted);
    }

    [ComImport, Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioEndpointVolume
    {
        void _RegisterControlChangeNotify();
        void _UnregisterControlChangeNotify();
        void _GetChannelCount();
        void _SetMasterVolumeLevel();
        void SetMasterVolumeLevelScalar(float level, ref Guid eventContext);
        void _GetMasterVolumeLevel();
        void GetMasterVolumeLevelScalar(out float level);
        void _SetChannelVolumeLevel();
        void _SetChannelVolumeLevelScalar();
        void _GetChannelVolumeLevel();
        void _GetChannelVolumeLevelScalar();
        void SetMute([MarshalAs(UnmanagedType.Bool)] bool muted, ref Guid eventContext);
        void GetMute([MarshalAs(UnmanagedType.Bool)] out bool muted);
    }
}
