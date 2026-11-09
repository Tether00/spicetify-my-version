// NAME: My Version
// AUTHOR: Tether00
// DESCRIPTION: Right-click a song → "Add my version…". Whenever that song plays, your own audio file plays instead.
// A song can have several versions; pick the one to hear, and set each file's volume, in "My versions" (top bar).
// How: Spotify keeps playing the original at native volume 0, so the queue, buttons, media keys and Connect keep working.
// The user's file, decoded with Web Audio, is the real clock. The player state the UI gets is rewritten
// (duration/position from the file, volume from the user), so the bar and the slider show the file, not the muted original.
// Web Audio, not <audio>: Spotify's renderer never loads media elements (stuck in networkState LOADING).

(async function myVersion() {
	// only the player is needed to start: the UI parts (menu, button, notifications) may not exist yet
	// while Spotify is minimized, and waiting for them let the original play unreplaced
	const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
	// __volume is -1 until Spotify reports the real volume; taking that as 0 would mute the user's version
	while (!Spicetify?.Platform?.PlayerAPI || !(Spicetify.Platform.PlaybackAPI?.__volume >= 0)) await sleep(100);
	const api = Spicetify.Platform.PlayerAPI;
	const pb = Spicetify.Platform.PlaybackAPI;
	// Not a track: { vol, held } — the user's volume, and whether we hold Spotify at 0 meanwhile. Spotify writes its own
	// volume (and localStorage) to disk late, so after a crash or a `spicetify apply` it would start at the 0 we held.
	const VOLUME = "volume";
	const ctx = new AudioContext();
	const notify = (message, isError) => Spicetify.showNotification?.(message, isError);
	const notifyBadFile = () => notify("My Version: can't open this file (use mp3, wav, flac or ogg)", true);

	// ---------- storage: IndexedDB "my-version", key = track URI,
	// value = { name, artist, image, versions: [{ file, fileName, duration, gainDb? }], active } — active -1 = the original

	const db = new Promise((res, rej) => {
		const r = indexedDB.open("my-version", 1);
		r.onupgradeneeded = () => r.result.createObjectStore("files");
		r.onsuccess = () => res(r.result);
		r.onerror = () => rej(r.error);
	});
	const store = (mode, fn) =>
		db.then(
			(d) =>
				new Promise((res, rej) => {
					const t = d.transaction("files", mode);
					const q = fn(t.objectStore("files"));
					t.oncomplete = () => res(q.result);
					t.onerror = () => rej(t.error);
				})
		);

	// throws if the file can't be played
	const describeFile = async (file) => ({ file, fileName: file.name, duration: (await ctx.decodeAudioData(await file.arrayBuffer())).duration });
	async function trackInfo(uri) {
		try {
			const t = (await Spicetify.GraphQL.Request(Spicetify.GraphQL.Definitions.getTrack, { uri })).data.trackUnion;
			return {
				name: t.name,
				artist: [...t.firstArtist.items, ...t.otherArtists.items].map((a) => a.profile.name).join(", "),
				image: t.albumOfTrack.coverArt.sources.reduce((a, b) => (a.width < b.width ? a : b)).url,
			};
		} catch {
			return { name: uri, artist: "", image: "" };
		}
	}

	const entries = new Map(); // the file Blobs inside are only read when they play
	const save = (uri) => store("readwrite", (s) => (entries.has(uri) ? s.put(entries.get(uri), uri) : s.delete(uri)));
	const activeVersion = (uri) => {
		const e = entries.get(uri);
		return e?.versions[e.active];
	};
	const keys = await store("readonly", (s) => s.getAllKeys());
	const values = await store("readonly", (s) => s.getAll());
	for (const [i, uri] of keys.entries()) {
		const rec = values[i];
		if (uri === VOLUME) continue;
		if (rec.file) {
			// saved before songs could have several versions
			const { file, fileName, duration, ...info } = rec;
			entries.set(uri, { ...info, versions: [{ file, fileName, duration }], active: 0 });
			await save(uri);
		} else entries.set(uri, rec);
	}

	// ---------- playback of the user's file: the bits of an <audio> element we need, on a decoded AudioBuffer.
	// Like Spotify, pausing and seeking dip the sound instead of cutting it, so the waveform never jumps (no click).

	const FADE_OUT = 0.06;
	const FADE_IN = 0.12;
	function player(buffer, volume) {
		const gain = ctx.createGain();
		gain.gain.value = volume;
		gain.connect(ctx.destination);
		let src = null;
		let env = null; // per-source fade envelope
		let offset = 0; // position while paused
		let startedAt = 0; // ctx time at which position 0 would have played
		const p = {
			duration: buffer.duration,
			ended: false,
			onended: null,
			get paused() {
				return !src;
			},
			get currentTime() {
				return src ? Math.max(offset, ctx.currentTime - startedAt) : offset;
			},
			set currentTime(t) {
				const was = !!src;
				p.pause();
				offset = Math.min(Math.max(0, t), buffer.duration);
				p.ended = false;
				if (was) p.play(FADE_OUT); // come back in once the old spot has faded out
			},
			set volume(v) {
				gain.gain.setTargetAtTime(v, ctx.currentTime, 0.015);
			},
			play(delay = 0) {
				if (src) return;
				ctx.resume();
				const s = (src = ctx.createBufferSource());
				const e = (env = ctx.createGain());
				s.buffer = buffer;
				s.connect(e).connect(gain);
				s.onended = () => {
					e.disconnect();
					if (src !== s) return; // stopped by pause()/seek, not a natural end
					src = null;
					offset = buffer.duration;
					p.ended = true;
					p.onended?.();
				};
				const t = ctx.currentTime + delay;
				e.gain.setValueAtTime(0, t);
				e.gain.linearRampToValueAtTime(1, t + FADE_IN);
				startedAt = t - offset;
				s.start(t, offset);
			},
			pause() {
				if (!src) return;
				offset = p.currentTime;
				const t = ctx.currentTime;
				env.gain.cancelScheduledValues(t);
				env.gain.setValueAtTime(env.gain.value, t);
				env.gain.linearRampToValueAtTime(0, t + FADE_OUT);
				src.stop(t + FADE_OUT);
				src = env = null;
			},
			close() {
				p.pause();
				setTimeout(() => gain.disconnect(), 500);
			},
		};
		return p;
	}

	let curUri = null; // track we're attached to
	let audio = null;
	let curVersion = null; // the version `audio` plays
	const level = () => userVol * 10 ** ((curVersion?.gainDb ?? 0) / 20); // the user's volume × this file's own adjustment
	let loadToken = 0; // bumps on every song/version change, so a slow decode can't attach late
	let hold = false; // our file ended, waiting for Spotify to move on
	let userVol = null; // while not null: Spotify itself is held at volume 0, and this is the volume the user hears and sees
	let real = api.getState(); // last player state Spotify really sent (before rewriting)
	let shown = { pos: 0, at: 0 }; // position we last showed the UI
	let nativeSeekAt = 0; // when we last moved the muted original ourselves

	const nativePos = (s) => s.positionAsOfTimestamp + (s.isPaused ? 0 : Date.now() - s.timestamp);
	const isLocal = () => Spicetify.Platform.ConnectAPI?.state?.activeDevice?.isLocal !== false;

	// ---------- volume: the slider and Spicetify.Player.getVolume() see userVol; Spotify's real volume stays 0

	const nativeSetVolume = pb.setVolume.bind(pb);
	const nativeRaise = pb.raiseVolume.bind(pb);
	const nativeLower = pb.lowerVolume.bind(pb);
	const holding = () => userVol !== null && isLocal(); // while another device plays, the slider is that device's
	const saveVolume = (vol, held) => store("readwrite", (s) => s.put({ vol, held }, VOLUME));
	Object.defineProperty(pb, "_volume", {
		configurable: true,
		get() {
			return holding() ? userVol : this.__volume;
		},
		set(v) {
			this.__volume = v;
			this._muteHelper.onVolumeChange(this._volume);
			if (userVol === null && isLocal() && v >= 0) saveVolume(v, false); // a normal song: remember the user's volume too
		},
	});
	const showVolume = () => {
		pb._muteHelper.onVolumeChange(pb._volume);
		pb.emitVolume();
	};
	const setUserVol = (v) => {
		userVol = Math.min(1, Math.max(0, v));
		if (audio) audio.volume = level();
		saveVolume(userVol, true);
		showVolume();
	};
	pb.setVolume = async (v) => (holding() ? setUserVol(v) : nativeSetVolume(v));
	pb.raiseVolume = async () => (holding() ? setUserVol(userVol + 0.0625) : nativeRaise());
	pb.lowerVolume = async () => (holding() ? setUserVol(userVol - 0.0625) : nativeLower());

	function holdVolume() {
		if (userVol !== null) return;
		setUserVol(pb.__volume);
		pb.__volume = 0; // the native event confirms ~0.3 s later
		nativeSetVolume(0);
	}
	function releaseVolume() {
		if (userVol === null) return;
		const v = userVol;
		userVol = null;
		saveVolume(v, false);
		pb.__volume = v;
		nativeSetVolume(v);
		showVolume();
	}

	const saved = values[keys.indexOf(VOLUME)];
	// closed while we held Spotify at 0: we still do, and owe this volume (the first song keeps holding or releases it)
	if (saved?.held) {
		userVol = saved.vol;
		showVolume(); // Spotify's startup events (before our patch) left the mute icon on
	}
	// Spotify lost its own last volume (crash/kill) and came back with an old one, often our 0
	else if (saved && Math.abs(saved.vol - pb.__volume) > 0.005) nativeSetVolume(saved.vol);

	// ---------- player state: duration and position come from the user's file

	function rewrite(s) {
		const uri = s.item.uri;
		const mine = audio && uri === curUri;
		const dur = mine ? audio.duration : isLocal() && activeVersion(uri)?.duration;
		if (!dur) return s;
		const pos = mine ? audio.currentTime : Math.min(nativePos(s) / 1000, dur);
		shown = { pos, at: Date.now() };
		return {
			...s,
			duration: dur * 1000,
			positionAsOfTimestamp: pos * 1000,
			timestamp: shown.at,
			item: { ...s.item, duration: { milliseconds: dur * 1000 } },
		};
	}
	const events = api.getEvents();
	const emit = events.emit.bind(events);
	events.emit = (type, data) => {
		if (type === "update" && data?.item) {
			if (data !== real) {
				const restarted =
					audio && data.item.uri === real?.item?.uri && data.positionAsOfTimestamp < 1500 && nativePos(real) > 3000 && Date.now() - nativeSeekAt > 2000;
				if (restarted) {
					// Spotify restarted the song by itself (media key "previous", …)
					hold = false;
					audio.currentTime = 0;
				}
				real = data;
			}
			data = rewrite(data);
		}
		return emit(type, data);
	};
	const refresh = () => real?.item && events.emit("update", real);

	// ---------- controls that act on the user's file instead of the muted original

	const nativeSeekTo = api.seekTo.bind(api);
	const nativeSeekBy = api.seekBy.bind(api);
	const nativePrev = api.skipToPrevious.bind(api);
	function seekOwn(t) {
		hold = false;
		audio.currentTime = t;
		refresh();
		if (t * 1000 < real.duration - 5000) {
			// move the muted original along, so Spotify resumes at this spot after a restart
			nativeSeekAt = Date.now();
			nativeSeekTo(t * 1000);
		}
	}
	api.seekTo = async (ms) => (audio ? seekOwn(ms / 1000) : nativeSeekTo(ms));
	api.seekBy = async (ms) => (audio ? seekOwn(audio.currentTime + ms / 1000) : nativeSeekBy(ms));
	api.skipToPrevious = async (...args) => {
		if (!audio) return nativePrev(...args);
		if (audio.currentTime > 3) return seekOwn(0);
		nativeSeekAt = Date.now();
		await nativeSeekTo(0); // otherwise Spotify restarts the original instead of going back, if *its* position is > 3 s
		return nativePrev(...args);
	};

	// ---------- attaching the chosen version to the playing song

	function attach(buffer, at, version) {
		audio?.close(); // switching versions: the old one fades out while the new one fades in
		hold = false;
		curVersion = version;
		const a = (audio = player(buffer, level()));
		a.currentTime = at;
		a.onended = () => {
			if (audio !== a) return;
			if (real.repeat === 2) return seekOwn(0); // repeat one
			hold = true;
			api.skipToNext();
		};
		refresh();
	}

	async function start(uri, keepPosition) {
		const token = ++loadToken;
		const v = activeVersion(uri);
		let buffer;
		try {
			buffer = await ctx.decodeAudioData(await v.file.arrayBuffer());
		} catch {
			if (token !== loadToken) return;
			notifyBadFile();
			audio?.close();
			audio = null;
			releaseVolume();
			return refresh();
		}
		if (token !== loadToken) return; // switched song or version meanwhile
		const pos = audio ? audio.currentTime : nativePos(real) / 1000;
		attach(buffer, keepPosition || pos >= 2 ? pos : 0, v); // a song that just started plays from the top
		notify(`Playing your version: ${v.fileName}`);
	}

	// the chosen version of a song changed (or the song lost its versions)
	function applyChoice(uri) {
		if (uri !== curUri) return;
		if (activeVersion(uri)) {
			holdVolume();
			return start(uri, true); // same spot in the new version
		}
		loadToken++;
		if (audio) {
			const at = audio.currentTime * 1000; // back to the original at the same spot
			audio.close();
			audio = null;
			hold = false;
			if (at < real.duration) {
				nativeSeekAt = Date.now();
				nativeSeekTo(at);
			}
		}
		releaseVolume();
		refresh();
	}

	function tick() {
		const uri = (isLocal() && real?.item?.uri) || null;
		if (uri !== curUri) {
			curUri = uri;
			loadToken++;
			audio?.close();
			audio = null;
			hold = false;
			if (activeVersion(uri)) {
				holdVolume();
				start(uri, false);
			} else if (uri) releaseVolume(); // not while another device plays: Spotify's volume calls would hit that device
			refresh();
		}
		if (!audio) return;

		if (pb.__volume > 0) {
			// changed from outside (e.g. the phone's remote): take it for our audio, keep the original silent
			setUserVol(pb.__volume);
			pb.__volume = 0;
			nativeSetVolume(0);
		}
		if (real.isPaused) audio.pause();
		else if (!hold) {
			if (audio.paused && !audio.ended) audio.play();
			if (nativePos(real) > real.duration - 5000 && Date.now() - nativeSeekAt > 2000) {
				// our file is longer: keep the muted original from reaching its end and skipping
				nativeSeekAt = Date.now();
				nativeSeekTo(0);
			}
			if (Math.abs(shown.pos + (Date.now() - shown.at) / 1000 - audio.currentTime) > 0.3) refresh();
		}
	}
	setInterval(tick, 250);
	events.addListener("update", tick);

	// ---------- adding, choosing and removing versions

	async function addVersion(uri, file) {
		let v;
		try {
			v = await describeFile(file);
		} catch {
			return notifyBadFile();
		}
		const e = entries.get(uri) ?? { ...(await trackInfo(uri)), versions: [], active: 0 };
		e.versions.push(v);
		e.active = e.versions.length - 1; // you add a version to hear it
		entries.set(uri, e);
		await save(uri);
		applyChoice(uri);
		notify(`Added "${v.fileName}" to "${e.name}"`);
	}
	async function choose(uri, i) {
		entries.get(uri).active = i;
		await save(uri);
		applyChoice(uri);
	}
	async function removeVersion(uri, i) {
		const e = entries.get(uri);
		const wasActive = e.active === i;
		e.versions.splice(i, 1);
		if (!e.versions.length) entries.delete(uri);
		else if (e.active > i) e.active--;
		else if (wasActive) e.active = Math.min(i, e.versions.length - 1);
		await save(uri);
		if (wasActive) applyChoice(uri);
	}
	function setGain(uri, version, db, persist) {
		version.gainDb = db;
		if (audio && version === curVersion) audio.volume = level(); // hear it while dragging
		if (persist) save(uri); // only on release: each save rewrites the record
	}
	async function removeSong(uri) {
		entries.delete(uri);
		await save(uri);
		applyChoice(uri);
		notify("Original restored");
	}
	function pickFile(uri, then) {
		// no AAC/m4a codec in Spotify's Chromium
		const input = Object.assign(document.createElement("input"), { type: "file", accept: ".mp3,.wav,.flac,.ogg,.opus" });
		input.onchange = async () => {
			if (!input.files[0]) return;
			await addVersion(uri, input.files[0]);
			then?.();
		};
		input.click();
	}

	// ---------- "My versions" list (top bar button)

	document.head.append(
		Object.assign(document.createElement("style"), {
			textContent: `
.my-version-list { display: flex; flex-direction: column; }
.my-version-song { padding: 10px 4px; }
.my-version-song + .my-version-song { border-top: 1px solid rgba(255,255,255,.1); }
.my-version-head { display: flex; align-items: center; gap: 12px; margin-bottom: 4px; }
.my-version-head img, .my-version-noimg { width: 48px; height: 48px; border-radius: 4px; object-fit: cover; flex: none; background: rgba(255,255,255,.1); }
.my-version-info { flex: 1; min-width: 0; }
.my-version-info > * { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.my-version-title { all: unset; cursor: pointer; display: block; font-weight: 700; color: var(--spice-text); }
.my-version-title:hover { text-decoration: underline; }
.my-version-sub { color: var(--spice-subtext); font-size: 13px; }
.my-version-btn { all: unset; cursor: pointer; padding: 6px 14px; border-radius: 999px; border: 1px solid var(--spice-subtext); color: var(--spice-text); font-size: 13px; font-weight: 700; flex: none; }
.my-version-btn:hover { border-color: var(--spice-text); transform: scale(1.04); }
.my-version-option { display: flex; align-items: center; margin-left: 60px; border-radius: 6px; }
.my-version-option:hover { background: rgba(255,255,255,.07); }
.my-version-pick { all: unset; cursor: pointer; flex: 1; min-width: 0; display: flex; align-items: center; gap: 10px; padding: 7px 10px; color: var(--spice-subtext); font-size: 14px; }
.my-version-pick span:last-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.my-version-option.is-active .my-version-pick { color: var(--spice-text); font-weight: 700; }
.my-version-dot { width: 14px; height: 14px; box-sizing: border-box; border-radius: 50%; border: 2px solid currentColor; flex: none; }
.my-version-option.is-active .my-version-dot { border-color: #1ed760; background: radial-gradient(#1ed760 0 3px, transparent 3.5px); }
.my-version-x { all: unset; cursor: pointer; padding: 4px 12px; color: var(--spice-subtext); font-size: 18px; line-height: 1; }
.my-version-x:hover, .my-version-db:hover { color: var(--spice-text); }
.my-version-gain { width: 110px; flex: none; accent-color: #1ed760; cursor: pointer; }
.my-version-db { all: unset; cursor: pointer; width: 60px; text-align: right; color: var(--spice-subtext); font-size: 12px; font-variant-numeric: tabular-nums; flex: none; }
.my-version-pick:focus-visible, .my-version-btn:focus-visible, .my-version-x:focus-visible, .my-version-title:focus-visible, .my-version-db:focus-visible { outline: 2px solid var(--spice-text); }
.my-version-empty { color: var(--spice-subtext); padding: 8px; }`,
		})
	);
	const h = (tag, props, ...children) => {
		const e = Object.assign(document.createElement(tag), props);
		e.append(...children);
		return e;
	};
	const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
	const fmtDb = (db = 0) => `${db > 0 ? "+" : ""}${Number(db).toFixed(1)} dB`;

	// per-file volume: slider is live while dragging, saved on release; clicking the value resets to 0 dB
	function gainControls(uri, v) {
		const label = h("button", { className: "my-version-db", title: "Reset to 0 dB" }, fmtDb(v.gainDb));
		// type and min/max before value, or the value gets clamped to the default 0–100 range
		const slider = h("input", { type: "range", min: -12, max: 12, step: 0.5, value: v.gainDb ?? 0, className: "my-version-gain", title: "Volume of this file", ariaLabel: `Volume of ${v.fileName}` });
		const set = (db, persist) => {
			slider.value = db;
			label.textContent = fmtDb(db);
			setGain(uri, v, Number(db), persist);
		};
		slider.oninput = () => set(slider.value, false);
		slider.onchange = () => set(slider.value, true);
		label.onclick = () => set(0, true);
		return [slider, label];
	}

	function renderList(root) {
		const rerender = () => renderList(root);
		if (!entries.size) return root.replaceChildren(h("div", { className: "my-version-empty" }, 'No songs yet. Right-click a song → "Add my version…".'));
		root.replaceChildren(
			...[...entries].map(([uri, e]) => {
				const option = (i, label, ...extra) =>
					h(
						"div",
						{ className: `my-version-option${e.active === i ? " is-active" : ""}` },
						h(
							"button",
							{ className: "my-version-pick", ariaPressed: String(e.active === i), onclick: () => choose(uri, i).then(rerender) },
							h("span", { className: "my-version-dot" }),
							h("span", {}, label)
						),
						...extra
					);
				return h(
					"div",
					{ className: "my-version-song" },
					h(
						"div",
						{ className: "my-version-head" },
						e.image ? h("img", { src: e.image, alt: "" }) : h("div", { className: "my-version-noimg" }),
						h(
							"div",
							{ className: "my-version-info" },
							h("button", { className: "my-version-title", title: "Play", onclick: () => Spicetify.Player.playUri(uri) }, e.name),
							h("div", { className: "my-version-sub" }, e.artist)
						),
						h("button", { className: "my-version-btn", onclick: () => pickFile(uri, rerender) }, "Add version"),
						h("button", { className: "my-version-btn", onclick: () => removeSong(uri).then(rerender) }, "Remove")
					),
					option(-1, "Original"),
					...e.versions.map((v, i) =>
						option(
							i,
							`${v.fileName} · ${fmt(v.duration)}`,
							...gainControls(uri, v),
							h("button", { className: "my-version-x", title: "Remove this version", ariaLabel: `Remove ${v.fileName}`, onclick: () => removeVersion(uri, i).then(rerender) }, "×")
						)
					)
				);
			})
		);
	}

	refresh(); // a replaced song may already be loaded at startup
	tick();

	// ---------- UI entry points, once the page has rendered

	while (!Spicetify?.ContextMenu || !Spicetify?.Topbar || !Spicetify?.PopupModal) await sleep(300);
	const isTrack = (uris) => uris.length === 1 && uris[0].startsWith("spotify:track:");
	new Spicetify.ContextMenu.Item("Add my version…", ([uri]) => pickFile(uri), isTrack, "plus2px").register();
	new Spicetify.ContextMenu.Item("Remove my versions", ([uri]) => removeSong(uri), (uris) => isTrack(uris) && entries.has(uris[0]), "x").register();
	new Spicetify.Topbar.Button(
		"My versions",
		`<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor"><path d="M14 1v9.5a2.5 2.5 0 1 1-1.5-2.29V4.1L6.5 5.3v7.2A2.5 2.5 0 1 1 5 10.21V2.2L14 1z"/></svg>`,
		() => {
			const root = h("div", { className: "my-version-list" });
			renderList(root);
			Spicetify.PopupModal.display({ title: "My versions", content: root, isLarge: true });
		}
	);
})();
