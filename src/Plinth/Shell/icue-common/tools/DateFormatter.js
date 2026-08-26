// Plinth-authored stand-in for the date helper from iCUE's shared common/ folder
// (see plugins/IcueWidgetApiWrapper.js for why these files exist and when they are
// served). The clock widgets construct it per render and call getDateText with the
// dateText combobox KEY, the day-of-week they last rendered, and a force flag; the
// promise resolves to the display string, or to undefined when nothing needs to
// change (same day, not forced) so the caller can skip the DOM write.
//
// The format keys are the literal option keys the stock clocks declare — each is the
// sample date 5 April 2020 written in the format it names.

class DateFormatter {
	constructor(languageCode, timeZone) {
		this.languageCode = languageCode || 'en';
		this.timeZone = timeZone || undefined;
	}

	_parts(options) {
		try {
			return new Intl.DateTimeFormat(this.languageCode,
				Object.assign({ timeZone: this.timeZone }, options)).formatToParts(new Date());
		} catch (e) {
			// An unresolvable time zone must degrade to local time, not kill the clock.
			return new Intl.DateTimeFormat(this.languageCode, options).formatToParts(new Date());
		}
	}

	_get(options, type) {
		const part = this._parts(options).find((p) => p.type === type);
		return part ? part.value : '';
	}

	getDateText(formatKey, lastDay, forceUpdate) {
		// The callers track lastDay with the local Date#getDay, so the skip check
		// matches their bookkeeping rather than second-guessing the time zone.
		if (!forceUpdate && lastDay === new Date().getDay()) return Promise.resolve(undefined);

		const key = String(formatKey == null ? 'None' : formatKey);
		if (key === 'None') return Promise.resolve('');

		const two = (v) => String(v).padStart(2, '0');
		const day = this._get({ day: 'numeric' }, 'day');
		const monthNum = this._get({ month: 'numeric' }, 'month');
		const yearFull = this._get({ year: 'numeric' }, 'year');
		let text;
		switch (key) {
			case '04/05/2020': text = two(monthNum) + '/' + two(day) + '/' + yearFull; break;
			case '05/04/2020': text = two(day) + '/' + two(monthNum) + '/' + yearFull; break;
			case '05 Apr 20':
				text = two(day) + ' ' + this._get({ month: 'short' }, 'month') + ' ' + yearFull.slice(-2);
				break;
			case 'Sun 5 Apr':
				text = this._get({ weekday: 'short' }, 'weekday') + ' ' + day + ' ' +
					this._get({ month: 'short' }, 'month');
				break;
			case 'Sunday 5 April':
				text = this._get({ weekday: 'long' }, 'weekday') + ' ' + day + ' ' +
					this._get({ month: 'long' }, 'month');
				break;
			default: // 'System' and anything unrecognized: the locale's own short form.
				try { text = new Date().toLocaleDateString(this.languageCode, { timeZone: this.timeZone }); }
				catch (e) { text = new Date().toLocaleDateString(this.languageCode); }
				break;
		}
		return Promise.resolve(text);
	}
}
