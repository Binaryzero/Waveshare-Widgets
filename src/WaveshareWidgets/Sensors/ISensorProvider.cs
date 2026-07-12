namespace WaveshareWidgets.Sensors;

public interface ISensorProvider : IDisposable
{
    string Name { get; }

    /// <summary>Collect current readings. Called on a background thread every poll tick;
    /// implementations may block briefly but must never throw for routine failures.</summary>
    IEnumerable<SensorReading> Poll();
}
