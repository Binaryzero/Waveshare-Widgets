using System.Text.Json.Nodes;
using Windows.UI.Notifications;
using Windows.UI.Notifications.Management;

namespace WaveshareWidgets.App;

/// <summary>
/// Mirrors Windows toast notifications for the notifications widget via the WinRT
/// <see cref="UserNotificationListener"/>. The listener's change event is unreliable for
/// unpackaged desktop apps, so it is POLLED — but demand-gated: polling only runs while
/// at least one widget is watching, and stops (buffer dropped) when none are. Payloads
/// are re-projected at this trust boundary: known keys only, hard caps on counts and
/// string lengths, our own stable ids.
/// </summary>
public sealed class NotificationCenter : IDisposable
{
    private const int PollMs = 2000;
    private const int MaxItems = 30;
    private const int MaxText = 400;

    private readonly object _gate = new();
    private System.Threading.Timer? _timer;
    private string _lastSignature = "";
    private bool _watching;

    /// <summary>Which demand interval the current polling belongs to (#132).</summary>
    /// <remarks>Bumped on every change to the demand situation. A poll captures it when it
    /// STARTS and quotes it back when it finishes, so a poll that began under demand which
    /// has since been withdrawn — or withdrawn and re-granted — cannot publish. Disposing
    /// the timer stops the NEXT poll; nothing stops one already awaiting.</remarks>
    private long _watchEpoch;

    /// <summary>The shell generation this demand was declared under (#132).</summary>
    /// <remarks>Held HERE, under the same lock as the epoch, so the value stamped on a
    /// payload is the one that was in force when the payload was authorised. Kept in
    /// DashboardWindow instead, it would be written outside this lock: a poll could hold the
    /// gate between that write and the SetWatching call which follows it, read the NEW
    /// generation and the OLD epoch, and stamp a stale payload as current.</remarks>
    private long _shellGen;
    private bool _accessRequested;

    /// <summary>Raised (on a worker thread) whenever the projected payload changes.</summary>
    public event Action<JsonObject, long>? Updated;

    /// <summary>A widget started or stopped watching; polling follows demand.</summary>
    public void SetWatching(bool on, long shellGen)
    {
        lock (_gate)
        {
            // Under the gate, together with the epoch, so a poll can never observe one
            // updated and the other not.
            _shellGen = shellGen;
            if (on == _watching)
            {
                // A repeated "on" means a NEW shell page (reload, crash recovery)
                // re-declared demand: its predecessor never posted watch(false), and
                // the buffered payload died with it. Reset dedup and poll now so the
                // rebuilt widget isn't stuck on "loading" until a toast changes.
                if (on && _timer is not null)
                {
                    _lastSignature = "";
                    // Bumped here too. This branch clears the dedup signature on purpose, so
                    // a poll still in flight from the previous page would arrive with nothing
                    // to be deduplicated against and would publish for a document that is
                    // gone. The immediate re-poll below replaces it anyway.
                    _watchEpoch++;
                    _timer.Change(0, PollMs);
                }
                return;
            }
            _watching = on;
            _watchEpoch++;
            if (on)
            {
                _lastSignature = ""; // force an immediate full push to the new watcher
                _timer = new System.Threading.Timer(_ => Poll(), null, 0, PollMs);
            }
            else
            {
                _timer?.Dispose();
                _timer = null;
            }
        }
    }

    /// <summary>Dismiss one mirrored notification by the id we projected.</summary>
    public void Dismiss(uint id)
    {
        try
        {
            UserNotificationListener.Current.RemoveNotification(id);
        }
        catch (Exception ex)
        {
            Log.Warn($"notification dismiss failed: {ex.Message}");
        }
    }

    private async void Poll()
    {
        // Captured BEFORE any await, so it names the demand interval this poll was started
        // for rather than whichever one happens to be current when it finishes.
        long epoch;
        lock (_gate) { epoch = _watchEpoch; }
        try
        {
            var listener = UserNotificationListener.Current;
            var access = listener.GetAccessStatus();
            if (access == UserNotificationListenerAccessStatus.Unspecified)
            {
                // First use: ask once — once per PROCESS, not per poll; a 2 s loop of
                // RequestAccessAsync would re-prompt on SKUs where the call surfaces UI.
                // On unpackaged apps this can stay Unspecified — projected as "denied"
                // with instructions so the widget can explain.
                bool ask;
                lock (_gate) { ask = !_accessRequested; _accessRequested = true; }
                if (ask)
                    access = await listener.RequestAccessAsync();
            }

            if (access != UserNotificationListenerAccessStatus.Allowed)
            {
                Push(epoch, new JsonObject { ["state"] = "denied", ["items"] = new JsonArray() });
                return;
            }

            var items = new JsonArray();
            var notifications = await listener.GetNotificationsAsync(NotificationKinds.Toast);
            // "allowed|" prefix: the signature must differ from the "" watch-reset
            // sentinel even with ZERO toasts, or the first allowed-but-empty poll is
            // deduped away and the widget spins on "loading" forever.
            var signature = "allowed|";
            foreach (var n in notifications.Take(MaxItems))
            {
                string app;
                try { app = n.AppInfo?.DisplayInfo?.DisplayName ?? "Unknown app"; }
                catch { app = "Unknown app"; } // AppInfo can throw for uninstalled senders
                string appId;
                try { appId = n.AppInfo?.AppUserModelId ?? app; }
                catch { appId = app; }

                var texts = new List<string>();
                try
                {
                    var binding = n.Notification?.Visual?.GetBinding(KnownNotificationBindings.ToastGeneric);
                    if (binding is not null)
                        foreach (var t in binding.GetTextElements())
                            texts.Add(t.Text ?? "");
                }
                catch { /* malformed toast — show the app line alone */ }

                var title = Cap(texts.Count > 0 ? texts[0] : "");
                var body = Cap(string.Join("\n", texts.Skip(1)));
                items.Add(new JsonObject
                {
                    ["id"] = n.Id,
                    ["app"] = Cap(app),
                    ["appId"] = Cap(appId),
                    ["title"] = title,
                    ["body"] = body,
                    ["time"] = n.CreationTime.ToUnixTimeMilliseconds(),
                });
                // Content rides the signature too: a toast UPDATED in place (progress
                // toasts, edited messages) keeps its id and position — id-only
                // signatures would never re-push it. Hash is per-process-stable,
                // which is all change detection needs.
                signature += n.Id + ":" + (app + "\n" + title + "\n" + body).GetHashCode() + "|";
            }

            Push(epoch, new JsonObject { ["state"] = "allowed", ["items"] = items }, signature);
        }
        catch (Exception ex)
        {
            // No listener on this SKU / policy-blocked: report once, keep polling cheap.
            Push(epoch, new JsonObject { ["state"] = "unavailable", ["items"] = new JsonArray() });
            Log.Warn($"notification poll failed: {ex.Message}");
        }
    }

    private static string Cap(string s) => s.Length <= MaxText ? s : s[..MaxText];

    private void Push(long pollEpoch, JsonObject payload, string? signature = null)
    {
        var sig = signature ?? payload["state"]!.GetValue<string>();
        long gen;
        lock (_gate)
        {
            if (!NotificationGate.ShouldPush(pollEpoch, _watchEpoch, sig, _lastSignature, _watching))
                return;
            _lastSignature = sig;
            // Captured WITH the decision, not read again later. Updated fires outside the
            // lock, and the handler marshals onto the UI thread — which can process a whole
            // watch-off/watch-on transition before that delegate runs. Reading the current
            // generation there would stamp this payload with a interval it was not authorised
            // under, which is the post-time-versus-production-time mistake one last time.
            gen = _shellGen;
        }
        Updated?.Invoke(payload, gen);
    }

    // Teardown, not a demand declaration: the generation is irrelevant because nothing can
    // be authorised after it.
    public void Dispose() => SetWatching(false, 0);
}
