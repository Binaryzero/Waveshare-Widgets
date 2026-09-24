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

    /// <summary>A tile to mark "Updated", and the widget whose settings changed. The widget
    /// is kept because a tile's widget can be swapped under the same instance id (Edit layout
    /// as JSON), and the new widget's settings did not change.</summary>
    public sealed class ReviewMark
    {
        public string InstanceId { get; set; } = "";
        public string WidgetId { get; set; } = "";
    }

    private sealed class Model
    {
        public Dictionary<string, Entry> Widgets { get; set; } = new(StringComparer.Ordinal);
        public List<ReviewMark> Review { get; set; } = [];
    }

    private readonly string _path;
    private readonly object _sync = new();
    private Model _model;
    /// <summary>True for the first comparison of a state that had no file: everything
    /// installed then is simply what there is. A later comparison in the same run (after an
    /// in-app install) is not a baseline — what it finds new is new.</summary>
    private bool _baseline;

    public WidgetCatalogState(string path)
    {
        _path = path;
        _model = Load(path, out var existed);
        _baseline = !existed;
    }

    /// <summary>The settings shape of a widget: its property names and types, in order of
    /// name. A label, help text or default is not a change the user has to check.</summary>
    /// <remarks>Serialized as JSON pairs, not joined text: a third-party property name may
    /// hold any character, and "a:text|b" joined is the same string as two properties
    /// named "a" and "b" — a real change that would compare equal.</remarks>
    public static string ShapeOf(WidgetManifest manifest) =>
        JsonSerializer.Serialize(manifest.Properties
            .Where(p => !string.IsNullOrEmpty(p.Name))
            .Select(p => new[] { p.Name, string.IsNullOrEmpty(p.Type) ? "text" : p.Type })
            .OrderBy(pair => pair[0], StringComparer.Ordinal)
            .ThenBy(pair => pair[1], StringComparer.Ordinal)
            .ToArray());

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
                        if (t.WidgetId == id && !string.IsNullOrEmpty(t.InstanceId)
                            && !_model.Review.Any(m => m.InstanceId == t.InstanceId && m.WidgetId == id))
                            _model.Review.Add(new ReviewMark { InstanceId = t.InstanceId!, WidgetId = id });
                    entry.Shape = shape;
                }
                if (placedIds.Contains(id))
                    entry.Placed = true;
            }
            // A flag for a tile that no longer exists is only clutter, and so is one for a tile
            // that now holds a different widget.
            var live = tiles.Where(t => t.InstanceId is not null)
                .Select(t => (t.InstanceId!, t.WidgetId))
                .ToHashSet();
            _model.Review.RemoveAll(m => !live.Contains((m.InstanceId, m.WidgetId)));
            _baseline = false;
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
        get { lock (_sync) return _model.Review.Select(m => m.InstanceId).Distinct().ToList(); }
    }

    /// <summary>The same tiles, each with the widget it was flagged for. The settings window
    /// marks a tile only while it still holds that widget.</summary>
    public IReadOnlyList<ReviewMark> ReviewTiles
    {
        get
        {
            lock (_sync)
                return _model.Review.Select(m => new ReviewMark { InstanceId = m.InstanceId, WidgetId = m.WidgetId }).ToList();
        }
    }

    public void MarkReviewed(string instanceId)
    {
        lock (_sync)
            if (_model.Review.RemoveAll(m => m.InstanceId == instanceId) > 0)
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
            // Valid JSON can still hold nulls ({"Widgets":{"x":null}}). Read as-is, one would
            // throw in Refresh on every start, before the file is ever rewritten, and leave
            // the indicators off for good. Same answer as a file that does not parse.
            if (model.Widgets.Values.Any(e => e is null || e.Shape is null)
                || model.Review.Any(r => r is null || string.IsNullOrEmpty(r.InstanceId) || string.IsNullOrEmpty(r.WidgetId)))
                throw new InvalidDataException("null entry");
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
