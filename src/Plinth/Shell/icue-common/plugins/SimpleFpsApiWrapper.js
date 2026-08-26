// Plinth-authored stand-in for the FPS promise wrapper from iCUE's shared common/
// folder (see IcueWidgetApiWrapper.js for why it exists and when it is served).
// Method list is the documented FPS Data Provider contract
// (docs/ICUE-API-REFERENCE.md §FPS Data Provider). Plinth's Fpsdataprovider is an
// honest no-data stub, so these resolve to 0/false/'' — the widget's own
// "unavailable" state is the designed outcome.

class SimpleFpsApiWrapper extends IcueWidgetApiWrapper {
	constructor(fpsPlugin, timeoutMs = 5000) {
		super(fpsPlugin, timeoutMs);
	}

	getCurrentFps() { return this.request(this.plugin.getCurrentFps); }
	getFpsAvailable() { return this.request(this.plugin.getFpsAvailable); }
	getCurrentProcess() { return this.request(this.plugin.getCurrentProcess); }
}
