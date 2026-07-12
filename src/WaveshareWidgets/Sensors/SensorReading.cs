namespace WaveshareWidgets.Sensors;

/// <summary>One sensor value in the snapshot pushed to the dashboard every poll tick.</summary>
public sealed record SensorReading(
    string Id,
    string Name,
    string Device,
    string DeviceType,
    string Type,
    string Units,
    double? Value);
