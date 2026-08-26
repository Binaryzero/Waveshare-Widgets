// Plinth-authored stand-in for the notifications promise wrapper from iCUE's shared
// common/ folder (see IcueWidgetApiWrapper.js for why it exists and when it is
// served). The Notifications provider (docs/ICUE-API-REFERENCE.md §Notifications
// Provider) follows the standard requestId/asyncResponse pattern; Plinth backs it
// with the same Windows notification mirror the stock Notifications widget uses.

class SimpleNotificationsApiWrapper extends IcueWidgetApiWrapper {
	constructor(notificationsPlugin, timeoutMs = 5000) {
		super(notificationsPlugin, timeoutMs);
	}

	getNotificationCount() { return this.request(this.plugin.getNotificationCount); }
}
