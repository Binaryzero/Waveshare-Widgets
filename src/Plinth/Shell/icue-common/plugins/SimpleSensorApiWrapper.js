// Plinth-authored stand-in for the sensor promise wrapper from iCUE's shared common/
// folder (see IcueWidgetApiWrapper.js for why it exists and when it is served).
// Method list is the documented Sensors Data Provider contract
// (docs/ICUE-API-REFERENCE.md §Sensors Data Provider).

class SimpleSensorApiWrapper extends IcueWidgetApiWrapper {
	constructor(sensorPlugin, timeoutMs = 5000) {
		super(sensorPlugin, timeoutMs);
	}

	getSensorValue(sensorId) { return this.request(this.plugin.getSensorValue, sensorId); }
	getSensorUnits(sensorId) { return this.request(this.plugin.getSensorUnits, sensorId); }
	getSensorName(sensorId) { return this.request(this.plugin.getSensorName, sensorId); }
	getSensorDeviceName(sensorId) { return this.request(this.plugin.getSensorDeviceName, sensorId); }
	getSensorType(sensorId) { return this.request(this.plugin.getSensorType, sensorId); }
	getSensorKind(sensorId) { return this.request(this.plugin.getSensorKind, sensorId); }
	getAllSensorIds() { return this.request(this.plugin.getAllSensorIds); }
	sensorIsConnected(sensorId) { return this.request(this.plugin.sensorIsConnected, sensorId); }
	getDefaultSensorId(sensorType, preferredKind) {
		return this.request(this.plugin.getDefaultSensorId, sensorType, preferredKind);
	}
}
