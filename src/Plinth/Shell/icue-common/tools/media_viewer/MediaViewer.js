// Plinth-authored stand-in for the media-selector viewer from iCUE's shared common/
// folder (see ../../plugins/IcueWidgetApiWrapper.js for why these files exist and
// when they are served). Every stock widget constructs one at script top level for
// its backgroundMedia setting — on Plinth that construction crashing to a missing
// class is what used to kill the whole widget script, so this class existing at all
// is most of its job.
//
// media-selector is not supported on Plinth (the asset lives inside the iCUE install
// on the user's machine), so backgroundMedia is normally undefined and widgets call
// clear(). loadMedia still renders URL-shaped sources faithfully — a package that
// points at its own bundled asset or a data: URI gets its background — and reports
// anything else through onMediaError instead of throwing.

class MediaViewer {
	constructor(options) {
		const opts = options || {};
		this.container = opts.container || null;
		this.onMediaLoaded = typeof opts.onMediaLoaded === 'function' ? opts.onMediaLoaded : null;
		this.onMediaError = typeof opts.onMediaError === 'function' ? opts.onMediaError : null;
		this._media = null;
	}

	clear() {
		if (this._media) {
			this._media.remove();
			this._media = null;
		}
	}

	loadMedia(descriptor) {
		const desc = descriptor || {};
		this.clear();
		const src = String(desc.path == null ? '' : desc.path);
		if (!this.container || !src) return;
		if (!/^(https?:|data:|blob:)/i.test(src)) {
			// An iCUE-machine file path: unreachable from this renderer, by design.
			this._fail(new Error('media-selector assets are not available on Plinth'));
			return;
		}

		const isVideo = /\.(webm|mp4|mkv)(\?|#|$)/i.test(src);
		const el = document.createElement(isVideo ? 'video' : 'img');
		if (isVideo) {
			el.muted = true;
			el.autoplay = true;
			el.loop = true;
			el.playsInline = true;
		}
		el.className = 'ww-media-view';
		const scale = Number(desc.scale) || 1;
		const angle = Number(desc.angle) || 0;
		const x = Number(desc.positionX) || 0;
		const y = Number(desc.positionY) || 0;
		el.style.transform = 'translate(-50%, -50%) translate(' + x + 'px, ' + y + 'px) ' +
			'rotate(' + angle + 'deg) scale(' + scale + ')';
		el.addEventListener(isVideo ? 'loadeddata' : 'load', () => {
			if (this.onMediaLoaded) {
				try { this.onMediaLoaded(el); } catch (e) { /* widget's handler, widget's problem */ }
			}
		});
		el.addEventListener('error', () => this._fail(new Error('media failed to load')));
		el.src = src;
		this.container.appendChild(el);
		this._media = el;
	}

	_fail(error) {
		if (this.onMediaError) {
			try { this.onMediaError(error); } catch (e) { /* widget's handler, widget's problem */ }
		}
	}
}
