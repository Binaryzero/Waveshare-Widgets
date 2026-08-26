using System.Text.Json.Nodes;

namespace Plinth.Widgets;

/// <summary>
/// The single serialization point for the widget-derived credential file (#175, #226).
///
/// <para>Every operation on the store is a read-modify-write of the whole document, so
/// two writers racing would lose one of the two writes. There used to be exactly one
/// writer — the dashboard's secure-get/set/delete handler — and its lock lived there.
/// #226 added more: evict-on-cap fires from BOTH window's save handlers, and uninstall's
/// ForgetSecrets was never gated at all. One process-wide gate here means the dashboard
/// message loop, the settings message loop, and startup seeding can never interleave a
/// lost update on the file.</para>
/// </summary>
internal static class SecureStoreHost
{
    private static readonly object Gate = new();

    /// <summary>Read-modify-write under the gate. <paramref name="change"/> returns
    /// whether it changed the document; the file is written only then — a refused or
    /// no-op mutation must not rewrite (and re-timestamp) the store.</summary>
    public static void Mutate(Func<JsonObject, bool> change)
    {
        lock (Gate)
        {
            var path = AppPaths.WidgetSecretsFile;
            var doc = WidgetSecrets.Load(File.Exists(path) ? File.ReadAllText(path) : null);
            if (change(doc))
            {
                Directory.CreateDirectory(Path.GetDirectoryName(path)!);
                DurableStore.Write(path, WidgetSecrets.Serialize(doc));
            }
        }
    }

    /// <summary>A read under the same gate, so it can never observe a torn document
    /// mid-mutation.</summary>
    public static T Read<T>(Func<JsonObject, T> read)
    {
        lock (Gate)
        {
            var path = AppPaths.WidgetSecretsFile;
            return read(WidgetSecrets.Load(File.Exists(path) ? File.ReadAllText(path) : null));
        }
    }
}
