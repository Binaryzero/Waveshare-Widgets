// Plinth-authored stand-in for the promise wrapper iCUE tells widget authors to copy
// into their package from the SDK's shared common/ folder. Corsair's stock widgets
// reference that folder from OUTSIDE their package (../common/… or
// ../../widgets/common/…), which resolves to nothing on Plinth's per-widget origins —
// the host serves THIS file at those paths instead, unless the package vendored its
// own copy (a vendored file always wins; see IcueCommonAssets.cs).
//
// Written for Plinth against the documented plugin contract (docs/ICUE-API-REFERENCE.md
// §Plugins): async getters take a caller-chosen integer requestId and answer through
// the plugin's Qt-style asyncResponse(requestId, value) signal. This class turns that
// callback shape into a Promise. No Corsair code appears in this file.

class IcueWidgetApiWrapper {
	constructor(plugin, timeoutMs = 5000) {
		this.plugin = plugin || null;
		this.timeoutMs = timeoutMs;
		this._waiters = new Map(); // requestId -> {resolve, reject, timer}
		this._seq = 1;
		if (this.plugin && this.plugin.asyncResponse &&
			typeof this.plugin.asyncResponse.connect === 'function') {
			this.plugin.asyncResponse.connect((requestId, value) => this._settle(requestId, value));
		}
	}

	_settle(requestId, value) {
		const waiter = this._waiters.get(requestId);
		if (!waiter) return; // an answer for a request that already timed out (or another wrapper's)
		this._waiters.delete(requestId);
		clearTimeout(waiter.timer);
		waiter.resolve(value);
	}

	/** Call `method` on the plugin with a fresh requestId; resolves with the value the
	 * plugin emits on asyncResponse for that id, rejects after timeoutMs without one. */
	request(method, ...args) {
		return new Promise((resolve, reject) => {
			if (!this.plugin || typeof method !== 'function') {
				reject(new Error('plugin unavailable'));
				return;
			}
			const requestId = this._seq++;
			const timer = setTimeout(() => {
				if (this._waiters.delete(requestId)) reject(new Error('request timed out'));
			}, this.timeoutMs);
			this._waiters.set(requestId, { resolve, reject, timer });
			try {
				method.call(this.plugin, requestId, ...args);
			} catch (e) {
				if (this._waiters.delete(requestId)) {
					clearTimeout(timer);
					reject(e);
				}
			}
		});
	}
}
