using Microsoft.Web.WebView2.Core;
using WaveshareWidgets.Widgets;

namespace WaveshareWidgets.App;

/// <summary>
/// The set of virtual hosts a WebView currently serves, and the only supported way to
/// change it.
///
/// A mapping is what makes an origin exist. Adding one is how a widget becomes reachable;
/// REMOVING one is how a widget stops being reachable — and only one of the two windows
/// used to do the second. The dashboard tracked what it had mapped and cleared what the
/// library no longer listed; the settings window mapped the current library over whatever
/// was already there and cleared nothing.
///
/// That difference is a security hole rather than a cosmetic one. A widget refused by the
/// library — a replaced stock folder, a manifest that started declaring a plaintext
/// credential — leaves the dashboard's origin space and stays in the settings window's,
/// still served from the folder it was refused for. Any other widget can then iframe that
/// origin, and the refused page runs there, inside the origin whose stored data the
/// refusal was protecting.
///
/// So there is one implementation, and both windows hold one of these. The rule it
/// enforces is the whole point: what the library does not list is not served.
/// </summary>
public sealed class VirtualHostMap
{
    private readonly HashSet<string> _mapped = new(StringComparer.OrdinalIgnoreCase);
    private readonly HashSet<string> _permanent = new(StringComparer.OrdinalIgnoreCase);

    /// <summary>Maps a host that is not backed by a widget — the shell, the backgrounds
    /// folder, the media library. Exempt from the sweep below, and mapped once.</summary>
    public void MapFixed(CoreWebView2 core, string host, string folder)
    {
        if (!_permanent.Add(host))
            return;
        core.SetVirtualHostNameToFolderMapping(host, folder, CoreWebView2HostResourceAccessKind.Allow);
        _mapped.Add(host);
    }

    /// <summary>Makes the served origins match <paramref name="widgets"/> exactly: newly
    /// listed widgets become reachable, and anything previously mapped that the library no
    /// longer lists stops being reachable.</summary>
    /// <remarks>Clearing happens BEFORE mapping so that a host moving between folders
    /// cannot be left pointing at the old one by an ordering accident. Re-mapping an
    /// existing host updates its folder, so no clear is needed for that case.</remarks>
    public void Sync(CoreWebView2 core, IEnumerable<InstalledWidget> widgets)
    {
        var wanted = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var w in widgets)
            wanted[w.VirtualHost] = w.Folder;

        foreach (var stale in WidgetIdentity.StaleHosts(_mapped, _permanent, wanted.Keys))
        {
            core.ClearVirtualHostNameToFolderMapping(stale);
            _mapped.Remove(stale);
        }
        foreach (var (host, folder) in wanted)
        {
            core.SetVirtualHostNameToFolderMapping(host, folder, CoreWebView2HostResourceAccessKind.Allow);
            _mapped.Add(host);
        }
    }
}
