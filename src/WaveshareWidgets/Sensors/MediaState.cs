namespace WaveshareWidgets.Sensors;

/// <summary>Now-playing snapshot pushed to the dashboard alongside sensor data.</summary>
public sealed record MediaState(
    bool Available,
    string? Title,
    string? Artist,
    string? Album,
    string? Status,
    string? Thumbnail)
{
    public static MediaState None { get; } = new(false, null, null, null, null, null);
}
