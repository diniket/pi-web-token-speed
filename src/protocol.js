/**
 * Contratto interno del pacchetto: canali del bus Pi, operazione peer e
 * validazione dei frame. Le due sponde (server e browser) validano entrambe:
 * un frame malformato viene scartato, mai interpolato.
 */

export const PROTOCOL_VERSION = 1;

/** Canale bus: l'estensione pubblica le misure. */
export const METRIC_CHANNEL = "pi-token-speed:metric";
/** Canale bus: il plugin server dichiara la propria presenza. */
export const PROBE_CHANNEL = "pi-token-speed:probe";
/** Canale bus: risposta del plugin server al probe. */
export const PONG_CHANNEL = "pi-token-speed:pong";
/** Operazione del canale peer browser <-> server. */
export const PEER_OPERATION = "metrics";

/**
 * Eta' massima di un frame per poter essere ancora presentato come "ultimo valore".
 * Oltre questa finestra il dato e' vecchio: meglio `N/D` che spacciarlo per attuale.
 */
export const LAST_FRAME_MAX_AGE_MS = 60_000;

const PHASES = new Set(["streaming", "final", "idle"]);
const SRC = new Set(["usage", "estimate", null]);
const MAX_MODEL_LEN = 200;
/** Id con caratteri di controllo (NUL in testa) non sono id validi. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

function isNum(v) {
	return typeof v === "number" && Number.isFinite(v);
}

/** Selezione sessione {projectId, workspaceId, sessionId} valida o undefined. */
export function parseSelection(value) {
	if (typeof value !== "object" || value === null) return undefined;
	const { projectId, workspaceId, sessionId } = value;
	if (
		typeof projectId !== "string" || projectId === "" ||
		typeof workspaceId !== "string" || workspaceId === "" ||
		typeof sessionId !== "string" || sessionId === ""
	) {
		return undefined;
	}
	if ([projectId, workspaceId, sessionId].some((s) => s.length > 512 || CONTROL_CHARS.test(s))) return undefined;
	return { projectId, workspaceId, sessionId };
}

/**
 * Frame di misura dal bus. Campi opzionali: se presenti devono avere il tipo
 * giusto, altrimenti l'intero frame e' scartato (ritorna undefined).
 */
export function parseMetricFrame(value) {
	if (typeof value !== "object" || value === null) return undefined;
	if (value.v !== PROTOCOL_VERSION) return undefined;
	if (typeof value.phase !== "string" || !PHASES.has(value.phase)) return undefined;
	if (typeof value.model !== "string" || value.model.length > MAX_MODEL_LEN) return undefined;
	if (typeof value.local !== "boolean") return undefined;
	if (typeof value.ts !== "number" || !Number.isFinite(value.ts)) return undefined;
	for (const key of ["live", "decode", "ttft", "prefill"]) {
		if (value[key] !== null && !isNum(value[key])) return undefined;
	}
	for (const key of ["out", "prompt", "req", "turn"]) {
		if (value[key] !== null && (!isNum(value[key]) || value[key] < 0)) return undefined;
	}
	if (!SRC.has(value.decodeSrc ?? null)) return undefined;
	if (value.reason !== null && value.reason !== undefined && typeof value.reason !== "string") {
		return undefined;
	}
	if (typeof value.reason === "string" && value.reason.length > 200) return undefined;
	if (typeof value.calibrated !== "boolean") return undefined;
	if (typeof value.partial !== "boolean") return undefined;
	return value;
}

/** Frame di handshake in ingresso sul bus (probe del server verso l'estensione). */
export function parseProbe(value) {
	return typeof value === "object" && value !== null && value.v === PROTOCOL_VERSION && value.type === "probe"
		? value
		: undefined;
}

export function parsePong(value) {
	return typeof value === "object" && value !== null && value.v === PROTOCOL_VERSION && value.type === "pong"
		? value
		: undefined;
}

/** Frame di controllo lato browser: `hello` del server (stato iniziale). */
export function parseHello(value) {
	if (typeof value !== "object" || value === null) return undefined;
	if (value.t === "hello") {
		// `last` e' opzionale: un hello senza ultimo frame e' comunque un handshake
		// valido (stato "in attesa"), non un frame malformato da scartare
		const last = value.last ?? null;
		if (last !== null && parseMetricFrame(last) === undefined) return undefined;
		return { t: "hello", last };
	}
	if (value.t === "error" && typeof value.message === "string" && value.message.length <= 500) {
		return value;
	}
	return undefined;
}
