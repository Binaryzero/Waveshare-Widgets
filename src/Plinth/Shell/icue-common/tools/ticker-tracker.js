// Plinth-authored stand-in for the scrolling-text helper from iCUE's shared common/
// folder (see plugins/IcueWidgetApiWrapper.js for why these files exist and when
// they are served). Stock widgets ship the markup themselves —
// .ticker > .ticker-track > .ticker-item — and call init() with those three element
// ids, then setText() on every data update. Text that fits stays put; text that
// overflows sweeps back and forth so the whole string is readable.
//
// The sweep is a CSS transform animation (ticker-track.css), driven by two custom
// properties set here — transform-only, so it stays compositor-cheap on a panel
// that runs 24/7.

const TickerTracker = (() => {
	let ticker = null;
	let track = null;
	let item = null;

	function measure() {
		if (!ticker || !track || !item) return;
		const overflow = item.scrollWidth - ticker.clientWidth;
		if (overflow > 4) {
			track.style.setProperty('--ww-ticker-shift', -overflow + 'px');
			// Sweep speed scales with distance so long strings aren't a blur; the
			// floor keeps short overflows from twitching.
			track.style.setProperty('--ww-ticker-secs', Math.max(6, overflow / 24) + 's');
			track.classList.add('ww-ticker-scroll');
		} else {
			track.classList.remove('ww-ticker-scroll');
			track.style.removeProperty('--ww-ticker-shift');
			track.style.removeProperty('--ww-ticker-secs');
		}
	}

	return {
		init(tickerId, trackId, itemId) {
			ticker = document.getElementById(tickerId);
			track = document.getElementById(trackId);
			item = document.getElementById(itemId);
			if (ticker && 'ResizeObserver' in window)
				new ResizeObserver(measure).observe(ticker);
		},
		setText(text) {
			if (!item) return;
			const next = text == null ? '' : String(text);
			if (item.textContent !== next) item.textContent = next;
			measure();
		},
	};
})();
