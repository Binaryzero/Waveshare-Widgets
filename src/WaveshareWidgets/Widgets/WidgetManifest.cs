using System.Text.Json.Nodes;
using System.Text.Json.Serialization;

namespace WaveshareWidgets.Widgets;

/// <summary>Parsed manifest.json of a widget package. See docs/WIDGET-SPEC.md.</summary>
public sealed class WidgetManifest
{
    [JsonPropertyName("id")] public string Id { get; set; } = "";
    [JsonPropertyName("name")] public string Name { get; set; } = "";
    [JsonPropertyName("author")] public string Author { get; set; } = "";
    [JsonPropertyName("version")] public string Version { get; set; } = "0.0.0";
    [JsonPropertyName("description")] public string? Description { get; set; }
    [JsonPropertyName("min_api_version")] public int MinApiVersion { get; set; } = 1;
    [JsonPropertyName("preview_icon")] public string? PreviewIcon { get; set; }
    [JsonPropertyName("supported_slots")] public List<string> SupportedSlots { get; set; } = ["quarter", "half", "full"];
    [JsonPropertyName("properties")] public List<WidgetProperty> Properties { get; set; } = [];

    public bool IsValid(out string error)
    {
        if (string.IsNullOrWhiteSpace(Id)) { error = "manifest is missing 'id'"; return false; }
        if (string.IsNullOrWhiteSpace(Name)) { error = "manifest is missing 'name'"; return false; }
        error = "";
        return true;
    }

    /// <summary>Refuses a manifest that would store a credential in the clear (issue #57).
    ///
    /// Kept SEPARATE from <see cref="IsValid"/> deliberately: iCUE-style widgets declare
    /// their settings in index.html meta tags, so at the point <c>IsValid</c> runs their
    /// property list is still empty. This has to be called once the properties are
    /// actually resolved, or the whole rule is skipped by exactly the widgets least
    /// likely to have been near the build-time validator.
    ///
    /// The check is on the TYPE, not the author: a property named like a credential and
    /// declared as anything but <c>secret</c> never reaches SecretPolicy, so its value is
    /// written to layout.json as plaintext with no signal to the user.</summary>
    public bool CredentialsAreTyped(out string error)
    {
        foreach (var p in Properties)
        {
            // A secret must not ship a value. Defaults are merged by the shell AFTER
            // SecretPolicy.Reveal, so a default here is handed straight to the widget and
            // to the settings preview as plaintext, having never been protected at all —
            // declaring `secret` would buy the credential nothing. The Node validator has
            // refused this since #15 (prop-secret-default); the install path did not.
            if (p.Type == "secret" && p.Default is not null
                && p.Default.ToString() is { Length: > 0 })
            {
                error = $"property '{p.Name}' is a secret with a default value. Secrets are "
                      + "revealed before defaults are merged, so a default is delivered as "
                      + "plaintext and is never encrypted; ship no default for a secret.";
                return false;
            }

            if (p.Type != "secret" && CredentialNames.LooksLikeCredential(p.Name))
            {
                error = $"property '{p.Name}' looks like a credential but is declared as "
                      + $"'{p.Type}'. Credentials must use type \"secret\" so the host can "
                      + "encrypt them; any other type is written to layout.json in plaintext.";
                return false;
            }

            // List rows are NEVER encrypted — SecretPolicy walks top-level properties
            // only — so a credential-looking key inside one has no safe type at all.
            //
            // Gated on the LIST type, matching the Node validator, which only reads
            // `fields` for `type: "list"`. Scanning it unconditionally refused a widget
            // over dormant metadata that nothing reads — a property demoted from `list`
            // to `text` and left with its old field definitions — which is precisely the
            // build-passes-install-refuses divergence this whole change exists to prevent,
            // just pointing the other way.
            if (p.Type == "list" && p.Fields is JsonArray fields)
            {
                foreach (var field in fields)
                {
                    // Pattern-match the MEMBER, not just the array. `fields: [1]` makes
                    // `field["key"]` throw (you cannot index a JsonValue), and a numeric
                    // `key` makes GetValue<string>() throw. Either one escaped to Rescan's
                    // outer catch, which skips the widget WITHOUT recording a rejection —
                    // so it vanished from the palette and from the banner that exists to
                    // explain exactly that.
                    //
                    // REFUSED, not skipped. Tolerating it here only moved the crash: the
                    // malformed array still installs and still reaches settings.js and
                    // shell.js, which iterate every member and read field.type/field.key —
                    // a null member throws while rendering the list or on Add, and a
                    // scalar member writes settings under an `undefined` key. Silently
                    // dropping the member instead would be the #24 mistake again, where
                    // quietly stripping list keys produced settings sheets that did not
                    // match what the widget expected and whole panels vanished in the
                    // field. A field definition the editor cannot render is a broken
                    // manifest, and the author is the only one who can fix it — so say so,
                    // in the banner, by name.
                    if (field is not JsonObject fieldObject)
                    {
                        error = $"list property '{p.Name}' has a malformed entry in 'fields' "
                              + "(every entry must be an object with a string \"key\"). The "
                              + "settings editor reads each entry's key and type directly, so "
                              + "this would break the list control rather than degrade it.";
                        return false;
                    }
                    var keyNode = fieldObject["key"];
                    if (keyNode is not JsonValue keyValue || !keyValue.TryGetValue<string>(out var key))
                    {
                        error = $"list property '{p.Name}' has a field whose \"key\" is missing or "
                              + "not a string. Row values are stored under that key, so without "
                              + "one the editor writes settings nothing can read back.";
                        return false;
                    }
                    if (CredentialNames.LooksLikeCredential(key))
                    {
                        error = $"list property '{p.Name}' has a field '{key}' that looks like a "
                              + "credential. List rows are never encrypted — declare a top-level "
                              + "\"secret\" property instead.";
                        return false;
                    }
                }
            }
        }
        error = "";
        return true;
    }

    /// <summary>The property names whose stored values must not be handed to the settings
    /// editor in the clear — every top-level property that is declared <c>secret</c> OR
    /// merely looks like a credential.
    ///
    /// This is the wider net that <see cref="CredentialsAreTyped"/> refuses on, and it is
    /// wider on purpose: it is asked about a manifest that has ALREADY been refused, where
    /// the declared type is exactly the thing not to be trusted.
    ///
    /// List properties are excluded. SecretPolicy walks top-level properties only, and a
    /// list VALUE cannot survive its round-trip — Mask would replace the array with a
    /// placeholder and Seal, finding no stored string to restore, would delete the whole
    /// list. Refusing to redact is the lesser harm; a credential inside a list row is
    /// tracked in issue #62.</summary>
    public List<string> CredentialPropertyNames()
    {
        var names = new List<string>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var p in Properties)
        {
            if (string.IsNullOrEmpty(p.Name) || p.Type == "list")
                continue;
            if ((p.Type == "secret" || CredentialNames.LooksLikeCredential(p.Name)) && seen.Add(p.Name))
                names.Add(p.Name);
        }
        return names;
    }

    /// <summary>A manifest that exists ONLY to keep a set of property names on the secret
    /// pipeline. Used for widgets the library refused: they are absent from
    /// <c>WidgetLibrary.Widgets</c>, so a manifest lookup for their slots returns null,
    /// <c>SecretPolicy.Mask</c> skips them, and every setting they hold — including the
    /// plaintext credential the refusal was about — is posted to the editor untouched.
    /// The refusal would then be the thing that created the exposure it exists to prevent.
    ///
    /// Declaring the names <c>secret</c> puts those slots back on the pipeline they fell
    /// off, which also makes the round-trip safe: Mask blanks the values and Seal restores
    /// or encrypts them on the next save, rather than the editor's blank overwriting
    /// them.</summary>
    public static WidgetManifest RedactionOnly(string id, string name, IEnumerable<string> secretNames) => new()
    {
        Id = id,
        Name = name,
        Properties = [.. secretNames.Select(n => new WidgetProperty { Name = n, Type = "secret" })],
    };

    /// <summary>A copy of this manifest with <paramref name="secretNames"/> forced to
    /// <c>secret</c> — present ones upgraded, absent ones added.
    ///
    /// Needed when a widget the snapshot ALREADY holds becomes refused. A stand-in cannot
    /// simply take its place (the existing entry is what masked the layout the editor is
    /// holding, and dropping it makes Seal blank every other secret that widget declares),
    /// but leaving the entry untouched is just as wrong: the refusal is often the moment a
    /// property was retyped, and the old entry still calls it <c>text</c>, so a credential
    /// typed into that field before the rescan is written out in the clear.
    ///
    /// Merging, with secret winning, is the only answer that loses nothing in either
    /// direction — the same rule the settings window's property union follows.</summary>
    public WidgetManifest WithSecretsForced(IEnumerable<string> secretNames)
    {
        var props = new List<WidgetProperty>(Properties);
        var byName = new Dictionary<string, int>(StringComparer.Ordinal);
        for (var i = 0; i < props.Count; i++)
            if (!string.IsNullOrEmpty(props[i].Name)) byName[props[i].Name] = i;
        foreach (var name in secretNames)
        {
            if (string.IsNullOrEmpty(name)) continue;
            if (byName.TryGetValue(name, out var at))
            {
                if (props[at].Type != "secret")
                    props[at] = new WidgetProperty { Name = name, Label = props[at].Label, Type = "secret" };
                continue;
            }
            byName[name] = props.Count;
            props.Add(new WidgetProperty { Name = name, Type = "secret" });
        }
        return new WidgetManifest
        {
            Id = Id,
            Name = Name,
            Author = Author,
            Version = Version,
            Description = Description,
            MinApiVersion = MinApiVersion,
            PreviewIcon = PreviewIcon,
            SupportedSlots = SupportedSlots,
            Properties = props,
        };
    }
}

/// <summary>A user-configurable widget setting, declared in the manifest and rendered by the host.
/// Types: text, number, slider, color, select, sensor, location, list (see WIDGET-SPEC).
///
/// This class sits in the middle of a round-trip — manifest.json is deserialized here and
/// re-serialized to the settings window — so ANY schema key it doesn't carry is silently
/// stripped in the field. That is exactly what happened to the list-type keys below: the
/// settings window received lists with no field definitions, the editor threw, and whole
/// property panels vanished on real installs while harness fixtures (raw JS, no C# in the
/// path) stayed green. The extension-data map is the safety net: unknown keys now ride
/// through untouched, and tools/ManifestRoundTrip in CI fails the build on any loss.</summary>
public sealed class WidgetProperty
{
    /// <summary>Never null, whatever the manifest says. A third-party manifest may contain
    /// <c>"name": null</c> — the property is declared as non-nullable, but the deserializer
    /// does not enforce that, so the null reaches every consumer that assumed otherwise. It
    /// used to be keyed into the settings window's property index and throw
    /// <see cref="ArgumentNullException"/> from inside an invoked UI delegate, where the
    /// surrounding catch cannot see it and the whole window goes down with it. A nameless
    /// property is meaningless — nothing can address it — so it becomes the empty name and
    /// is skipped by everything that walks the list, rather than being a landmine.</summary>
    [JsonPropertyName("name")]
    public string Name
    {
        get => _name;
        set => _name = value ?? "";
    }
    private string _name = "";

    [JsonPropertyName("label")] public string Label { get; set; } = "";

    /// <summary>Normalized to lowercase on the way in, because the host and the settings
    /// client disagreed about what counts. SecretPolicy matches the type with
    /// OrdinalIgnoreCase, but settings.js compares <c>pr.type === 'secret'</c> exactly —
    /// so a manifest declaring <c>"Secret"</c> was encrypted at rest AND rendered as an
    /// ordinary text field, which left it out of the replica's redaction list and pushed
    /// a freshly typed credential into the preview. Canonicalizing here removes the
    /// divergence at the source rather than teaching one more consumer to be lenient.</summary>
    [JsonPropertyName("type")]
    public string Type
    {
        get => _type;
        set
        {
            var normalized = (value ?? "").Trim().ToLowerInvariant();
            _type = normalized.Length == 0 ? "text" : normalized;
        }
    }
    private string _type = "text";
    [JsonPropertyName("default")] public JsonNode? Default { get; set; }
    [JsonPropertyName("min")] public double? Min { get; set; }
    [JsonPropertyName("max")] public double? Max { get; set; }
    [JsonPropertyName("step")] public double? Step { get; set; }
    [JsonPropertyName("options")] public List<string>? Options { get; set; }
    [JsonPropertyName("sensor_type")] public string? SensorType { get; set; }

    /// <summary>Settings-UI section this property belongs to (iCUE x-icue-groups).</summary>
    [JsonPropertyName("group")] public string? Group { get; set; }

    /// <summary>Row field definitions for the list type ([{key, label, type, placeholder}]).
    /// Pass-through data — the settings window is the only consumer.</summary>
    [JsonPropertyName("fields")] public JsonNode? Fields { get; set; }

    /// <summary>Noun for the list type's add-row button ("Add host").</summary>
    [JsonPropertyName("itemLabel")] public string? ItemLabel { get; set; }

    /// <summary>Expected-format hint for text inputs — the sanctioned place to teach syntax.</summary>
    [JsonPropertyName("placeholder")] public string? Placeholder { get; set; }

    /// <summary>Host-provided dropdown source for selects (e.g. "sd-profiles").</summary>
    [JsonPropertyName("optionsSource")] public string? OptionsSource { get; set; }

    /// <summary>Any manifest key this model doesn't know yet survives the round-trip here
    /// instead of being stripped on its way to the settings window.</summary>
    [JsonExtensionData] public Dictionary<string, System.Text.Json.JsonElement>? Extra { get; set; }
}
