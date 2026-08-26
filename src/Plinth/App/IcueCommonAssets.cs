using Microsoft.Web.WebView2.Core;
using Plinth.Widgets;

namespace Plinth.App;

/// <summary>
/// Serves Plinth-authored stand-ins for iCUE's shared widget helpers at the paths
/// stock Corsair widgets reference them from.
///
/// iCUE ships one common/ folder BESIDE its stock widgets, and those widgets script-src
/// it from outside their own package — &lt;script src="../common/tools/…"&gt; (stock
/// tree) or "../../widgets/common/…" (the Stream Deck widget). On our per-widget
/// origins those references clamp at the origin root (/common/…, /widgets/common/…)
/// and 404 — and because every such widget constructs one of the helper classes at
/// script top level, the 404 became a ReferenceError that killed the whole widget.
/// Marketplace packages that vendored common/ never hit this; the stock widgets a
/// user copies straight out of an iCUE install always did.
///
/// Interception rather than files-on-disk, for two reasons the media relay already
/// established: WebResourceRequested fires before the virtual-host folder mapping
/// answers, so no widget folder needs touching (touching it would perturb the content
/// fingerprint that decides stock identity and trip the rescan watcher); and one
/// handler covers every widget origin at once, imports and rescans included.
///
/// A package that VENDORED its own copy keeps it: when the request path exists inside
/// the widget's folder, the handler steps aside and the folder mapping serves the
/// package's file. Only the whitelisted helper names are ever answered — everything
/// else falls through untouched, so this cannot become a general escape from the
/// widget's own folder.
/// </summary>
internal static class IcueCommonAssets
{
    /// <summary>The helper files we provide, keyed by their path under common/. The
    /// implementations live in Shell/icue-common (Plinth-authored, API-compatible —
    /// no Corsair code; the originals are all-rights-reserved).</summary>
    private static readonly string[] Provided =
    [
        "plugins/IcueWidgetApiWrapper.js",
        "plugins/SimpleSensorApiWrapper.js",
        "plugins/SimpleMediaApiWrapper.js",
        "plugins/SimpleFpsApiWrapper.js",
        "plugins/SimpleNotificationsApiWrapper.js",
        "tools/ColorTools.js",
        "tools/DateFormatter.js",
        "tools/ticker-tracker.js",
        "tools/ticker-track.css",
        "tools/media_viewer/MediaViewer.js",
        "tools/media_viewer/MediaViewer.css",
    ];

    public static void Attach(CoreWebView2 core, Func<IReadOnlyList<InstalledWidget>> widgets)
    {
        // Both clamp shapes the stock widgets produce. The explicit source-kinds
        // overload for the same reason MediaRelay uses it: widgets live in
        // cross-origin iframes, and the top-document-scoped filter never sees them.
        core.AddWebResourceRequestedFilter($"https://*{WidgetIdentity.HostSuffix}/common/*",
            CoreWebView2WebResourceContext.All, CoreWebView2WebResourceRequestSourceKinds.All);
        core.AddWebResourceRequestedFilter($"https://*{WidgetIdentity.HostSuffix}/widgets/common/*",
            CoreWebView2WebResourceContext.All, CoreWebView2WebResourceRequestSourceKinds.All);

        core.WebResourceRequested += (_, e) =>
        {
            try
            {
                Handle(core, e, widgets());
            }
            catch (Exception ex)
            {
                // Leaving e.Response unset lets the folder mapping produce its
                // ordinary 404 — a broken hook must not take the widget down with it.
                Log.Warn($"icue common assets: {ex.GetType().Name}");
            }
        };
    }

    private static void Handle(CoreWebView2 core, CoreWebView2WebResourceRequestedEventArgs e,
        IReadOnlyList<InstalledWidget> widgets)
    {
        if (!Uri.TryCreate(e.Request.Uri, UriKind.Absolute, out var uri))
            return;
        if (!uri.Host.EndsWith(WidgetIdentity.HostSuffix, StringComparison.OrdinalIgnoreCase))
            return;

        // Uri.AbsolutePath is already dot-segment-normalized; strip the clamp prefix.
        var path = uri.AbsolutePath;
        string tail;
        if (path.StartsWith("/widgets/common/", StringComparison.OrdinalIgnoreCase))
            tail = path["/widgets/common/".Length..];
        else if (path.StartsWith("/common/", StringComparison.OrdinalIgnoreCase))
            tail = path["/common/".Length..];
        else
            return;

        var provided = Provided.FirstOrDefault(p => string.Equals(p, tail, StringComparison.OrdinalIgnoreCase));
        if (provided is null)
            return;

        // A vendored copy always wins: if the request path resolves to a real file
        // inside the widget's own folder, step aside and let the mapping serve it.
        var widget = widgets.FirstOrDefault(w =>
            string.Equals(w.VirtualHost, uri.Host, StringComparison.OrdinalIgnoreCase));
        if (widget is not null)
        {
            var local = Path.Combine(widget.Folder,
                path.TrimStart('/').Replace('/', Path.DirectorySeparatorChar));
            if (File.Exists(local))
                return;
        }

        var file = Path.Combine(AppPaths.ShellDir, "icue-common",
            provided.Replace('/', Path.DirectorySeparatorChar));
        if (!File.Exists(file))
            return;

        var mime = provided.EndsWith(".css", StringComparison.OrdinalIgnoreCase)
            ? "text/css" : "text/javascript";
        var stream = new MemoryStream(File.ReadAllBytes(file));
        e.Response = core.Environment.CreateWebResourceResponse(stream, 200, "OK",
            $"Content-Type: {mime}; charset=utf-8");
    }
}
