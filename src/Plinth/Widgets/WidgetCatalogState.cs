using System.Text.Json;

namespace Plinth.Widgets;

/// <summary>What the app has seen of each installed widget, across updates (#227).
///
/// Widgets update with the app: the version that ships is the version that runs, so an
/// update cannot be held back for one tile. What the user is owed instead is to be told.
/// A widget that is new in an update is marked "New" in the settings palette until it is
/// placed or two weeks pass. A placed tile whose widget changed its settings (a property
/// added, removed or retyped) is marked "Updated" until the user opens it.
///
/// The first run records a baseline: nothing is new on a fresh install, and nothing is
/// flagged for the update that introduced this file. Pure apart from its one file, so
/// tools/WidgetCatalog covers it with a temp path.</summary>
public sealed class WidgetCatalogState
{
    public static readonly TimeSpan NewFor = TimeSpan.FromDays(14);

    /// <summary>The instance the windows read. Set once at startup; null until then, and
    /// every reader treats null as "nothing is new, nothing is flagged".</summary>
    public static WidgetCatalogState? Shared { get; set; }

    private sealed class Entry
    {
        public DateTime? FirstSeen { get; set; }
        public string Shape { get; set; } = "";
        public bool Placed { get; set; }
    }

    private sealed class Model
    {
        public Dictionary<string, Entry> Widgets { get; set; } = new(StringComparer.Ordinal);
        public List<string> Review { get; set; } = [];
    }

    private readonly string _path;
    private readonly object _sync = new();
    private Model _model;
    private readonly bool _baseline;

    public WidgetCatalogState(string path)
    {
        _path = path;
        _model = Load(path, out var existed);
        _baseline = !existed;
    }

    /// <summary>The settings shape of a widget: its property names and types, in order of
    /// name. A label, help text or default is not a change the user has to check.</summary>
    public static string ShapeOf(WidgetManifest manifest) =>
        string.Join("|", manifest.Properties
            .Where(p => !string.IsNullOrEmpty(p.Name))
            .Select(p => p.Name + ":" + (string.IsNullOrEmpty(p.Type) ? "text" : p.Type))
            .OrderBy(s => s, StringComparer.Ordinal));

    /// <summary>Compares what is installed now with what was recorded, once per start.</summary>
    /// <param name="installed">Every installed widget and its current shape.</param>
    /// <param name="placed">Every placed tile: its widget and instance id.</param>
    public void Refresh(IEnumerable<(string Id, string Shape)> installed,
        IEnumerable<(string WidgetId, string? InstanceId)> placed, DateTime now)
    {
        lock (_sync)
        {
            var tiles = placed.Where(t => !string.IsNullOrEmpty(t.WidgetId)).ToList();
            var placedIds = new HashSet<string>(tiles.Select(t => t.WidgetId), StringComparer.Ordinal);
            foreach (var (id, shape) in installed)
            {
                if (string.IsNullOrEmpty(id))
                    continue;
                if (!_model.Widgets.TryGetValue(id, out var entry))
                {
                    _model.Widgets[id] = entry = new Entry { FirstSeen = _baseline ? null : now, Shape = shape };
                }
                else if (entry.Shape != shape)
                {
                    foreach (var t in tiles)
                        if (t.WidgetId == id && !string.IsNullOrEmpty(t.InstanceId) && !_model.Review.Contains(t.InstanceId!))
                            _model.Review.Add(t.InstanceId!);
                    entry.Shape = shape;
                }
                if (placedIds.Contains(id))
                    entry.Placed = true;
            }
            // A flag for a tile that no longer exists is only clutter.
            var live = new HashSet<string>(tiles.Where(t => t.InstanceId is not null).Select(t => t.InstanceId!), StringComparer.Ordinal);
            _model.Review.RemoveAll(i => !live.Contains(i));
            Save();
        }
    }

    public bool IsNew(string id, DateTime now)
    {
        lock (_sync)
            return _model.Widgets.TryGetValue(id, out var e)
                && e.FirstSeen is { } first && now - first < NewFor && !e.Placed;
    }

    /// <summary>Tiles to mark "Updated", by instance id.</summary>
    public IReadOnlyList<string> Review
    {
        get { lock (_sync) return _model.Review.ToList(); }
    }

    public void MarkReviewed(string instanceId)
    {
        lock (_sync)
            if (_model.Review.Remove(instanceId))
                Save();
    }

    /// <summary>Placing a widget ends its "New" badge for good, even if the tile is later
    /// removed.</summary>
    public void MarkPlaced(IEnumerable<string> widgetIds)
    {
        lock (_sync)
        {
            var changed = false;
            foreach (var id in widgetIds)
                if (_model.Widgets.TryGetValue(id, out var e) && !e.Placed)
                {
                    e.Placed = true;
                    changed = true;
                }
            if (changed)
                Save();
        }
    }

    private static Model Load(string path, out bool existed)
    {
        existed = File.Exists(path);
        if (!existed)
            return new Model();
        try
        {
            var model = JsonSerializer.Deserialize<Model>(File.ReadAllText(path)) ?? new Model();
            model.Widgets = new Dictionary<string, Entry>(model.Widgets ?? new(), StringComparer.Ordinal);
            model.Review ??= [];
            return model;
        }
        catch (Exception)
        {
            // A damaged file costs only badges. Treat it as a baseline rather than
            // announcing every installed widget as new.
            existed = false;
            return new Model();
        }
    }

    private void Save()
    {
        try
        {
            var temp = _path + ".tmp";
            File.WriteAllText(temp, JsonSerializer.Serialize(_model));
            File.Move(temp, _path, overwrite: true);
        }
        catch (Exception)
        {
            // Badges are a convenience; a failed write must never reach the caller.
        }
    }
}
