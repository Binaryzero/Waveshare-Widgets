// Plinth-authored stand-in for the color helper from iCUE's shared common/ folder
// (see plugins/IcueWidgetApiWrapper.js for why these files exist and when they are
// served). Stock widgets feed the result into CSS custom properties consumed as
// `rgb(var(--x))` / `rgba(var(--x), a)`, so the contract is a bare "r, g, b" triple.

function hexToRGB(hex) {
	let h = String(hex == null ? '' : hex).trim().replace(/^#/, '');
	if (h.length === 3) h = h.replace(/./g, (c) => c + c);
	const n = parseInt(h.slice(0, 6), 16);
	if (h.length < 6 || !Number.isFinite(n)) return '255, 255, 255';
	return ((n >> 16) & 255) + ', ' + ((n >> 8) & 255) + ', ' + (n & 255);
}
