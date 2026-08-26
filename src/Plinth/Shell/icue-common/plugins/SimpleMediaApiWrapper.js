// Plinth-authored stand-in for the media promise wrapper from iCUE's shared common/
// folder (see IcueWidgetApiWrapper.js for why it exists and when it is served).
// Method list is the documented Media Data Provider contract
// (docs/ICUE-API-REFERENCE.md §Media Data Provider).

class SimpleMediaApiWrapper extends IcueWidgetApiWrapper {
	constructor(mediaPlugin, timeoutMs = 5000) {
		super(mediaPlugin, timeoutMs);
	}

	getSongName() { return this.request(this.plugin.getSongName); }
	getArtist() { return this.request(this.plugin.getArtist); }
}
