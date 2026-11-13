/**
 * Estensione Pi "pi-token-speed" — motore di misura per sessione.
 *
 * Misura con i soli hook nativi Pi (nessuna influenza sul backend):
 *   before_provider_request -> t0 della richiesta
 *   message_update          -> delta (text/thinking/toolcall) per TTFT e rate live
 *   message_end             -> usage nativo + stopReason (valore finale)
 *   agent_start             -> confine di turno
 *   model_select / session_*-> reset stato e calibrazione
 *
 * Pubblica frame compatti (~1 Hz) sul bus `pi.events` della sessione, canale
 * `pi-token-speed:metric`. Il bus trasporta SOLO canali custom: per questo la
 * misura deve vivere qui, dentro la sessione (verificato su pi-coding-agent
 * 1.5.0, core/event-bus.js).
 *
 * GATE di presenza: prima di misurare l'estensione lancia un probe sul bus e
 * pretende il pong del plugin server (stesso tick, EventEmitter sincrono —
 * pattern gia' collaudato da pi-sudo-web-prompt). Senza plugin server attivo
 * (TUI semplice, sessioni orfane, sub-agenti) non viene né misurato né emesso:
 * overhead prossimo a zero e nessun conflitto con il token-speed del footer TUI.
 *
 * Nessun contenuto del transcript finisce nei frame: solo numeri, id modello e
 * contatori.
 */

import { createTracker } from "../metrics.js";
import { METRIC_CHANNEL, PROBE_CHANNEL, PONG_CHANNEL, PROTOCOL_VERSION } from "../protocol.js";

const DELTA_TYPES = new Set(["text_delta", "thinking_delta", "toolcall_delta"]);

export function createExtension(pi, options = {}) {
	const now = options.now ?? (() => Date.now());
	/** @type {Map<string, {tracker: object, sid: string, serverSeen: boolean}>} */
	const sessions = new Map();
	/** @type {Map<string, () => void>} distacco del listener pong, per sessione. */
	const subscribed = new Map();
	/** Chiave di riserva per contesti senza `getSessionId`: mai condivisa. */
	const fallbackKeys = new WeakMap();
	let fallbackSeq = 0;

	function keyOf(ctx) {
		let sid;
		try {
			sid = ctx?.sessionManager?.getSessionId?.();
		} catch {
			sid = undefined;
		}
		if (typeof sid === "string" && sid !== "") return sid;
		// niente "unknown" condiviso: due sessioni senza id avrebbero lo stesso
		// tracker (misure mescolate) e i loro frame verrebbero scartati dal relay
		const owner = ctx?.sessionManager;
		if (owner === null || typeof owner !== "object") return undefined;
		let key = fallbackKeys.get(owner);
		if (key === undefined) {
			key = `ctx#${(fallbackSeq += 1)}`;
			fallbackKeys.set(owner, key);
		}
		return key;
	}

	function subscribe(sid) {
		if (subscribed.has(sid)) return;
		// Una sola sottoscrizione per sessione: il flag viene aggiornato a ogni
		// risposta del server (stesso tick del probe). Il distacco va richiamato a
		// fine sessione: il bus non rimuove gli handler da solo.
		const detach = pi?.events?.on?.(PONG_CHANNEL, (data) => {
			if (parsePongFrame(data)) {
				const entry = sessions.get(sid);
				if (entry) entry.serverSeen = true;
			}
		});
		if (typeof detach === "function") subscribed.set(sid, detach);
	}

	function unsubscribe(sid) {
		const detach = subscribed.get(sid);
		if (typeof detach === "function") {
			try {
				detach();
			} catch {
				/* bus gia' spento */
			}
		}
		subscribed.delete(sid);
	}

	function parsePongFrame(data) {
		return typeof data === "object" && data !== null && data.v === PROTOCOL_VERSION && data.type === "pong";
	}

	function entryFor(ctx, create = false) {
		const sid = keyOf(ctx);
		if (sid === undefined) return undefined;
		let entry = sessions.get(sid);
		if (entry === undefined && create) {
			entry = {
				sid,
				serverSeen: false,
				tracker: createTracker({
					now,
					// Lettura pigra: il tracker si accorge del cambio modello da solo.
					model: () => ctx?.model ?? {},
				}),
			};
			sessions.set(sid, entry);
			subscribe(sid);
		}
		return entry;
	}

	/** Chiede al plugin server se e' presente su questo bus (risposta sincrona). */
	function probeServer(entry) {
		try {
			pi?.events?.emit?.(PROBE_CHANNEL, { v: PROTOCOL_VERSION, type: "probe" });
		} catch {
			/* bus non disponibile */
		}
		return entry.serverSeen;
	}

	function publish(entry, frame) {
		if (frame === null || frame === undefined) return;
		try {
			pi?.events?.emit?.(METRIC_CHANNEL, { ...frame, sid: entry.sid });
		} catch {
			/* bus non disponibile: la misura resta locale */
		}
	}

	// --- hook -------------------------------------------------------------

	pi.on("session_start", async (_event, ctx) => {
		const entry = entryFor(ctx, true);
		if (entry === undefined) return;
		entry.serverSeen = false;
		entry.tracker.clear();
	});

	pi.on("model_select", async (_event, ctx) => {
		const entry = sessions.get(keyOf(ctx));
		if (entry !== undefined) {
			// identity() del tracker azzera calibrazione al primo frame col nuovo
			// modello; qui si azzera anche lo stato della richiesta in volo.
			entry.tracker.clear();
		}
	});

	pi.on("agent_start", async (_event, ctx) => {
		const entry = sessions.get(keyOf(ctx));
		// il contatore di turno costa zero e serve anche prima del primo probe
		if (entry !== undefined) entry.tracker.turnStart();
	});

	pi.on("before_provider_request", async (_event, ctx) => {
		const entry = entryFor(ctx, true);
		if (entry === undefined) return;
		entry.serverSeen = false;
		if (!probeServer(entry)) return; // nessun plugin server: niente misura
		entry.tracker.identity(); // rileva cambio modello anche senza model_select
		entry.tracker.requestStart();
	});

	pi.on("message_update", async (event, ctx) => {
		const sid = keyOf(ctx);
		const entry = sid === undefined ? undefined : sessions.get(sid);
		if (entry === undefined || !entry.serverSeen) return;
		const message = event?.message;
		if (!message || message.role !== "assistant") return;
		const ae = event?.assistantMessageEvent;
		if (!ae || !DELTA_TYPES.has(ae.type)) return;
		if (typeof ae.delta !== "string" || ae.delta.length === 0) return;
		entry.tracker.delta(ae.type, ae.delta.length);
		publish(entry, entry.tracker.streamingFrame());
	});

	pi.on("message_end", async (event, ctx) => {
		const sid = keyOf(ctx);
		const entry = sid === undefined ? undefined : sessions.get(sid);
		if (entry === undefined || !entry.serverSeen) return;
		const message = event?.message;
		if (!message || message.role !== "assistant") return;
		const frame = entry.tracker.requestEnd({
			usage: message.usage ?? null,
			stopReason: message.stopReason ?? null,
		});
		publish(entry, frame);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		const sid = keyOf(ctx);
		if (sid === undefined) return;
		const entry = sessions.get(sid);
		if (entry !== undefined) {
			try {
				pi?.events?.emit?.(METRIC_CHANNEL, { ...entry.tracker.idleFrame(), sid });
			} catch {
				/* bus gia' spento: nessun problema */
			}
		}
		sessions.delete(sid);
		unsubscribe(sid);
	});
}

export default function (pi) {
	createExtension(pi);
}
