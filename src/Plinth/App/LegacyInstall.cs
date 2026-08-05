namespace Plinth.App;

/// <summary>Everything that exists ONLY because the app used to be called something else.
///
/// <para>Kept in one file so the transition can be ended by deleting the file and its two
/// call sites in <see cref="Program"/>, rather than by hunting for rename-era special cases
/// scattered through startup.</para>
///
/// <para>Both members are about the same failure: two dashboard hosts alive at once,
/// repositioning and serving the same 1280x400 panel, each undoing the other. The rename
/// created it — a renamed mutex cannot see the old process, and a renamed Run value leaves
/// the old one behind — so unwinding it belongs here and not in the app proper.</para></summary>
internal static class LegacyInstall
{
    /// <summary>The single-instance mutex as it was named before the rename. A running
    /// WaveshareWidgets.exe holds this and nothing else.</summary>
    private const string MutexName = "WaveshareWidgets.SingleInstance";

    /// <summary>The autostart Run value as it was named before the rename. It points at
    /// WaveshareWidgets.exe, which either still exists — and then launches a second app that
    /// fights this one for the panel — or does not, and fails silently at every logon.</summary>
    private const string AutostartValueName = "WaveshareWidgets";

    /// <summary>True when a pre-rename instance is running.
    ///
    /// <para>An abandoned name is not a running app: the kernel object dies with its last
    /// handle, so a crashed predecessor leaves nothing to open and this returns false —
    /// which is what we want, since there is no window for the user to go and close.</para>
    ///
    /// <para>The name is PROBED, never held. Taking ownership would leave this process
    /// squatting a name that belongs to software being removed, and would then block the old
    /// app from starting, which is someone else's decision to make.</para></summary>
    public static bool InstanceRunning()
    {
        try
        {
            if (!Mutex.TryOpenExisting(MutexName, out var legacy))
                return false;
            legacy.Dispose();
            return true;
        }
        catch (UnauthorizedAccessException)
        {
            // "The named mutex exists, but the user does not have the security access
            // required to use it" — the documented meaning of this exception specifically,
            // and therefore POSITIVE evidence of a live predecessor rather than an error.
            // Reachable when the old app is running elevated and this one is not: the
            // string overload asks for Synchronize|Modify, which a higher-integrity owner
            // does not grant downward. Falling through here would start Plinth beside the
            // very process this exists to detect, in the one case where the user is least
            // able to work out why their panel is flickering between two dashboards.
            Log.Info("A pre-rename instance is running (its mutex exists but is not open to us)");
            return true;
        }
        catch (Exception ex)
        {
            // Any OTHER failure proceeds rather than refuses. Being unable to open a name is
            // not, in general, evidence that it is held, and refusing on it would turn a
            // transitional courtesy into an app that will not start.
            Log.Warn($"Could not check for a pre-rename instance: {ex.Message}");
            return false;
        }
    }

    /// <summary>Repoints the pre-rename Run value at this executable, if it is still there.
    ///
    /// <para>The old value is DELETED and the current one WRITTEN, because the two halves are
    /// one repair rather than two. What the value encodes is a live instruction — "start this
    /// at logon" — and the rename broke the instruction, not the intent behind it. Deleting
    /// alone fixes the wrong executable and silently turns autostart off for someone who had
    /// switched it on; they would find out at the next logon, from a panel that stayed
    /// blank.</para>
    ///
    /// <para>This is not migrating the old install's data, which is deliberately not carried
    /// over. Nothing is read from the old data directory, and no setting, secret or layout
    /// moves. It repairs a startup instruction this rename is otherwise about to break.</para>
    ///
    /// <para>Called before the instance check, not after, and that ordering is the whole
    /// point. At logon Windows starts both Run values; if the old one wins the race it holds
    /// the mutex, and a version of this that cleaned up only on the successful startup path
    /// would refuse, exit, and leave the stale value in place — reproducing the same race at
    /// every logon, forever. The guard would be preserving the conflict it exists to resolve.
    /// Running it on the refusal path too is what actually breaks that loop: the next logon
    /// starts this app and not its predecessor.</para>
    ///
    /// <para>Absence is left alone. Someone who had autostart OFF before updating has no old
    /// value to find here, so nothing is written and the setting stays off — the intent is
    /// carried in both directions, not just the one that adds an entry.</para></summary>
    public static void MoveAutostartEntry()
    {
        try
        {
            if (!Autostart.HasValue(AutostartValueName))
                return;
            Autostart.RemoveValue(AutostartValueName);
            Autostart.SetEnabled(true);
            Log.Info($"Moved the pre-rename autostart entry to '{Autostart.ValueName}'");
        }
        catch (Exception ex)
        {
            // A policy-locked or unreadable Run key is not a reason to fail startup. The cost
            // of not getting here is a stale entry, which is what we already had.
            Log.Warn($"Could not move the pre-rename autostart entry: {ex.Message}");
        }
    }
}
