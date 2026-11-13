/**
 * Motore di misura della velocita' di generazione. Puro: orologio iniettabile,
 * nessuna I/O, nessuna dipendenza da Pi o da Pi Web.
 *
 * Natura delle misure (dichiarata, mai implicita):
 *  - `usage`  valore da token nativi del backend (`usage.output` negli eventi Pi)
 *  - `estimate` stima da caratteri streamati x calibrazione tok/char
 *  - `null`   non misurabile -> l'interfaccia mostra N/A col motivo
 *
 * Perche' il rate live e' una stima: i conteggi token nativi (OpenAI-compatible)
 * arrivano solo nel chunk finale della risposta, quindi a richiesta conclusa.
 * Durante lo streaming l'unica osservabile e' la cadenza dei delta; la si
 * converte con una calibrazione tok/char appresa dai turni precedenti della
 * stessa sessione e corretta a ogni `requestEnd`. Non e' e non viene spacciata
 * per una misura di token.
 */

export const PROTOCOL_VERSION = 1;

/** Motivi per cui una misura non e' disponibile (stringhe brevi, UI-visible). */
export const ND = Object.freeze({
	NO_USAGE: "backend without usage",
	NO_OUTPUT: "no output",
	NO_STREAM: "no deltas",
	TOO_FAST: "window too short",
});

const DEFAULTS = Object.freeze({
	windowMs: 3000,
	minSpanMs: 250,
	maxSamples: 256,
	charsPerToken: 3.6,
	minDecodeSec: 0.05,
	minTtftSec: 0.01,
	/** Coda inattiva fra ultimo delta e fine richiesta ammessa nel decode. */
	maxTailMs: 2000,
	/** Limiti del rapporto token/caratteri: fuori da questi la stima non e' credibile. */
	minTokPerChar: 0.05,
	maxTokPerChar: 2,
	/** Peso della nuova osservazione nella calibrazione (media mobile). */
	calibrationBlend: 0.5,
});

function num(v) {
	return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/**
 * Classificazione endpoint da `ctx.model.baseUrl`: locale = rete privata/loopback.
 * Etichetta UI ("locale"/"remoto"), non una superficie di sicurezza.
 */
export function isLocalEndpoint(baseUrl) {
	if (typeof baseUrl !== "string" || baseUrl.trim() === "") return false;
	let h = baseUrl.trim();
	try {
		// `new URL("nas:11434")` interpreta nas come schema, non come host.
		// Aggiungere lo schema prima del parsing per gli endpoint senza ://.
		h = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(h) ? h : `http://${h}`).hostname;
	} catch {
		// Indirizzi IPv6 nudi e zone id non sono accettati dal parser URL.
		if (!/^[0-9a-f:]+(?:%[a-z0-9_.-]+)?$/i.test(h)) return false;
	}
	// toglie parentesi IPv6 e zone id (%eth0)
	h = h.replace(/^\[|\]$/g, "").replace(/%.*$/, "").toLowerCase();
	if (h === "localhost" || h.endsWith(".localhost") || h === "::1" || h.endsWith(".local")) return true;
	if (h.includes(":")) {
		// IPv6 di rete privata: ULA fc00::/7 e link-local fe80::/10
		return /^f[cd][0-9a-f]{2}:/.test(h) || /^fe[89ab][0-9a-f]:/.test(h);
	}
	const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
	if (m) {
		const o = m.slice(1).map(Number);
		if (o.some((n) => n > 255)) return false;
		return (
			o[0] === 127 ||
			o[0] === 10 ||
			(o[0] === 172 && o[1] >= 16 && o[1] <= 31) ||
			(o[0] === 192 && o[1] === 168) ||
			(o[0] === 169 && o[1] === 254)
		);
	}
	// nome nudo senza dominio (es. "nas"): in una LAN e' l'host di casa
	return !h.includes(".") && /^[a-z0-9_-]+$/i.test(h);
}

export function modelKey(model) {
	const provider = typeof model?.provider === "string" ? model.provider : "?";
	const id = typeof model?.id === "string" ? model.id : "?";
	return `${provider}/${id}`;
}

/**
 * Tracciatore di UNA sessione. Le istanze non condividono stato: il cambio di
 * modello o di sessione crea o azzera il tracciatore, mai lo eredita.
 */
export function createTracker(options = {}) {
	const cfg = { ...DEFAULTS, ...options.config };
	const now = options.now ?? (() => Date.now());
	const modelOf = options.model ?? (() => ({}));

	/** @type {{t:number,c:number}[]} */
	let samples = [];
	let t0 = null;
	let firstAt = null;
	let chars = 0;
	let tokPerChar = 1 / (cfg.charsPerToken || 3.6);
	let calibrated = false;
	let streaming = false;
	let measuring = false;
	let toolChars = 0;
	let lastDeltaAt = null;
	let reqIndex = 0;
	let turnIndex = 0;
	let lastFinal = null;
	let lastReason = null;
	let lastPublish = 0;
	let model = modelKey(modelOf());
	let local = false;

	function identity() {
		const m = modelOf();
		const next = modelKey(m);
		if (next !== model) {
			// Cambio modello: calibrazione e stato della richiesta non valgono piu'.
			model = next;
			tokPerChar = 1 / (cfg.charsPerToken || 3.6);
			calibrated = false;
			resetRequest();
		}
		local = isLocalEndpoint(m?.baseUrl);
		return { model, local };
	}

	function resetRequest() {
		samples = [];
		t0 = null;
		firstAt = null;
		lastDeltaAt = null;
		toolChars = 0;
		chars = 0;
		streaming = false;
		// il throttle di emissione e' per richiesta: una richiesta appena iniziata
		// deve poter pubblicare subito, anche se la precedente ha appena emesso
		lastPublish = 0;
	}

	/** Inizio di UNA richiesta provider (un turno con tool calling ne ha N). */
	function requestStart() {
		reqIndex += 1;
		resetRequest();
		measuring = true;
		streaming = true;
		t0 = now();
		lastReason = null;
	}

	/** Inizio di un turno dell'agente (azzera il contatore delle richieste). */
	function turnStart() {
		turnIndex += 1;
		reqIndex = 0;
	}

	/**
	 * Delta di streaming. `kind` e' text/thinking/toolcall: contano tutti perche'
	 * sono token generati dal modello (l'esecuzione dei tool e' fuori, non arriva qui).
	 */
	function delta(kind, length) {
		if (!streaming) return null;
		if (typeof length !== "number" || !(length > 0)) return null;
		const t = now();
		if (firstAt === null) firstAt = t;
		lastDeltaAt = t;
		chars += length;
		// gli argomenti dei tool call sono token generati ma non compaiono nei
		// delta testuali: la loro richiesta non e' un campione tok/char affidabile
		if (kind === "toolcall_delta") toolChars += length;
		samples.push({ t, c: length });
		// Finestra mobile limitata: niente crescita illimitata su risposte lunghe.
		prune(t);
		return liveRate(t);
	}

	function prune(t) {
		const cutoff = t - cfg.windowMs;
		while (samples.length > 1 && samples[0].t < cutoff) samples.shift();
		while (samples.length > cfg.maxSamples) samples.shift();
	}

	function liveRate(t) {
		prune(t);
		if (samples.length === 0) return null;
		const oldest = samples[0].t;
		const spanMs = t - Math.max(oldest, t - cfg.windowMs);
		if (spanMs < cfg.minSpanMs) return null;
		let c = 0;
		for (const s of samples) c += s.c;
		if (c <= 0) return null;
		return (c / (spanMs / 1000)) * tokPerChar;
	}

	/**
	 * Fine della richiesta provider. `usage` e `stopReason` vengono dal messaggio
	 * assistito di Pi (nativi del backend); `aborted` = interruzione.
	 */
	function requestEnd(fields = {}) {
		// Un fine-messaggio senza richiesta in corso (messaggio iniettato, stream non
		// misurato, sessione ricreata) non deve produrre un N/D che schiaccia
		// l'ultima misura valida.
		if (!measuring) return null;
		measuring = false;
		const t = now();
		const stopReason = typeof fields.stopReason === "string" ? fields.stopReason : null;
		const partial = stopReason === "aborted" || stopReason === "error";
		const usage = fields.usage ?? null;
		const out = usage ? num(usage.output) : 0;
		const prompt = usage ? num(usage.input) + num(usage.cacheRead) + num(usage.cacheWrite) : 0;

		const ttft = firstAt !== null && t0 !== null ? (firstAt - t0) / 1000 : null;
		// L'intervallo di decode e' locale (primo delta -> fine richiesta) e la coda
		// inattiva oltre maxTailMs non e' generazione: esclusa dal calcolo.
		const endAt = lastDeltaAt !== null ? Math.min(t, lastDeltaAt + cfg.maxTailMs) : t;
		const decodeSec = firstAt !== null ? (endAt - firstAt) / 1000 : 0;

		let decode = null;
		let decodeSrc = null;
		let reason = null;
		if (!usage) {
			reason = ND.NO_USAGE;
		} else if (out <= 0) {
			reason = ND.NO_OUTPUT;
		} else if (firstAt === null) {
			reason = ND.NO_STREAM;
		} else if (decodeSec < cfg.minDecodeSec) {
			reason = ND.TOO_FAST;
		} else {
			decode = out / decodeSec;
			decodeSrc = "usage";
		}

		const prefill =
			ttft !== null && ttft > cfg.minTtftSec && prompt > 0 ? prompt / ttft : null;

		// Calibrazione per i rate live successivi: solo richieste confrontabili
		// (usage utile, nessun tool call, non interrotte) e sempre confinata in un
		// intervallo plausibile, con media mobile per non inseguire l'outlier.
		if (out > 0 && chars > 0 && toolChars === 0 && !partial) {
			const raw = out / chars;
			const clamped = Math.min(cfg.maxTokPerChar, Math.max(cfg.minTokPerChar, raw));
			const blend = Math.min(1, Math.max(0, cfg.calibrationBlend));
			tokPerChar = tokPerChar * (1 - blend) + clamped * blend;
			calibrated = true;
		}

		lastFinal = { decode, decodeSrc, ttft, prefill, out: out || null, prompt: prompt || null };
		lastReason = reason;
		streaming = false;
		return frame("final", t, { partial, reason });
	}

	function frame(phase, t, extra = {}) {
		const id = identity();
		return {
			v: PROTOCOL_VERSION,
			phase,
			model: id.model,
			local: id.local,
			live: phase === "streaming" ? round(extra.live ?? liveRate(t), 1) : null,
			decode: phase === "final" ? round(lastFinal?.decode ?? null, 1) : null,
			decodeSrc: phase === "final" ? lastFinal?.decodeSrc ?? null : null,
			ttft: phase === "final" ? round(lastFinal?.ttft ?? null, 2) : null,
			prefill: phase === "final" ? round(lastFinal?.prefill ?? null, 0) : null,
			out: phase === "final" ? lastFinal?.out ?? null : null,
			prompt: phase === "final" ? lastFinal?.prompt ?? null : null,
			reason: phase === "final" ? extra.reason ?? lastReason ?? null : null,
			partial: phase === "final" ? extra.partial === true : false,
			calibrated,
			req: reqIndex,
			turn: turnIndex,
			ts: t,
		};
	}

	/** Frame di streaming (throttato dal chiamante). */
	function streamingFrame(force = false) {
		const t = now();
		if (!force && t - lastPublish < 1000) return null;
		const live = liveRate(t);
		if (live === null) return null;
		lastPublish = t;
		return frame("streaming", t, { live });
	}

	/** Frame di "nessuna misura in corso" per il bus: costruito qui, non a mano. */
	function idleFrame() {
		const id = identity();
		return {
			v: PROTOCOL_VERSION,
			phase: "idle",
			model: id.model,
			local: id.local,
			live: null,
			decode: null,
			decodeSrc: null,
			ttft: null,
			prefill: null,
			out: null,
			prompt: null,
			reason: null,
			partial: false,
			calibrated,
			req: reqIndex,
			turn: turnIndex,
			ts: now(),
		};
	}

	function clear() {
		measuring = false;
		resetRequest();
		lastFinal = null;
		lastReason = null;
		reqIndex = 0;
		turnIndex = 0;
	}

	return {
		requestStart,
		turnStart,
		delta,
		requestEnd,
		streamingFrame,
		idleFrame,
		clear,
		identity: identity,
		get calibrated() {
			return calibrated;
		},
		get tokPerChar() {
			return tokPerChar;
		},
	};
}

function round(v, digits) {
	if (typeof v !== "number" || !Number.isFinite(v)) return null;
	const f = 10 ** digits;
	return Math.round(v * f) / f;
}

/** Etichetta compatta per il badge: `≈` solo per le stime, `N/A` se non misurabile. */
export function formatRate(frame) {
	if (frame === null || frame === undefined) return null;
	if (frame.phase === "final") {
		if (typeof frame.decode === "number") return `${frame.decode.toFixed(1)} tok/s`;
		return "N/A";
	}
	if (typeof frame.live === "number") return `≈ ${frame.live.toFixed(1)} tok/s`;
	return null;
}

/** Titolo/tooltip con il dettaglio onesto di cosa si sta guardando. */
export function describeFrame(frame) {
	if (frame === null || frame === undefined) return "no measurement";
	if (frame.phase === "final") {
		const bits = [];
		if (typeof frame.decode === "number") {
			bits.push(`decode ${frame.decode.toFixed(1)} tok/s (native tokens, locally measured interval)`);
		} else if (typeof frame.reason === "string") {
			bits.push(`decode N/A: ${frame.reason}`);
		}
		if (typeof frame.ttft === "number") bits.push(`TTFT ${frame.ttft.toFixed(2)} s`);
		else bits.push("TTFT N/A");
		if (typeof frame.prefill === "number") bits.push(`prefill ~${frame.prefill} tok/s (estimate)`);
		else bits.push("prefill N/A");
		if (typeof frame.out === "number") bits.push(`${frame.out} tokens`);
		if (frame.partial === true) bits.push("interrupted answer");
		return bits.join(" · ");
	}
	if (typeof frame.live === "number") {
		return `live estimate (${frame.calibrated ? "calibrated on native tokens" : "default calibration"})`;
	}
	return "waiting for data";
}
