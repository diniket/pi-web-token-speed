/**
 * Plugin server Pi Web v5 di pi-token-speed.
 *
 * Ponte tra il bus `pi.events` della sessione ospitata (dove l'estensione
 * companion misura) e il browser, sul canale peer della stessa package pair.
 *
 *  - dichiara la capability host `pi-web.host/pi-session-events` v1 (token
 *    strutturale: identita' verificata sul dist installato, nessun import dal
 *    pacchetto Pi Web);
 *  - su `openChannel("metrics")` si collega al bus della sessione indicata
 *    (l'host autorizza projectId/workspaceId/sessionId e rifiuta sessioni non
 *    ospitate lì) e inoltra i frame validati al browser;
 *  - risponde ai probe dell'estensione finche' c'e' un browser interessato:
 *    e' il gate che evita qualsiasi misura quando il plugin non serve;
 *  - conserva l'ultimo frame per sessione (LRU limitata) cosi' un browser che
 *    si riaggancia (reload, cambio tab) vede subito l'ultimo valore.
 *
 * Nessun file, nessun log di contenuto: transitano solo numeri e id.
 */

import {
	LAST_FRAME_MAX_AGE_MS,
	METRIC_CHANNEL,
	PEER_OPERATION,
	PONG_CHANNEL,
	PROBE_CHANNEL,
	PROTOCOL_VERSION,
	parseHello,
	parseMetricFrame,
	parseSelection,
} from "../protocol.js";

/** Token strutturale: identita' (pluginId, id, version) verificata sul dist. */
export const PI_WEB_HOST_PI_SESSION_EVENTS_CAPABILITY = Object.freeze({
	pluginId: "pi-web.host",
	id: "pi-session-events",
	version: 1,
	parse(value) {
		if (typeof value !== "object" || value === null) throw new Error("capability pi-session-events non valida");
		if (Reflect.get(value, "version") !== 1 || typeof Reflect.get(value, "connect") !== "function") {
			throw new Error("capability pi-session-events non valida");
		}
		return value;
	},
});

const MAX_CACHED_SESSIONS = 64;

export function createServerPlugin(options = {}) {
	/** @type {any} */
	let events;
	/** @type {Map<string, {connection: any, projectId: string, workspaceId: string, channels: Set<any>}>} */
	const hosted = new Map();
	/** @type {Map<string, {frame: any, at: number}>} ultimo frame per sessionId, con età. */
	const lastFrames = new Map();
	const log = options.log ?? (() => {});
	const now = options.now ?? (() => Date.now());
	let disposed = false;

	function touchCache(sessionId, frame) {
		lastFrames.delete(sessionId);
		lastFrames.set(sessionId, { frame, at: now() });
		while (lastFrames.size > MAX_CACHED_SESSIONS) {
			const oldest = lastFrames.keys().next();
			if (oldest.done) break;
			lastFrames.delete(oldest.value);
		}
	}

	/** Ultimo frame di una sessione, o null se assente o piu' vecchio della finestra. */
	function lastFrameFor(sessionId) {
		const hit = lastFrames.get(sessionId);
		if (hit === undefined) return null;
		// eta' = fra quando il relay l'ha visto e quando e' stato misurato: un frame
		// con timestamp vecchio non e' un valore attuale, qualunque sia la causa
		const measuredAt = typeof hit.frame?.ts === "number" ? hit.frame.ts : hit.at;
		const age = Math.max(now() - hit.at, now() - measuredAt);
		if (!(age <= LAST_FRAME_MAX_AGE_MS)) {
			lastFrames.delete(sessionId);
			return null;
		}
		// LRU vera: anche la lettura rinfresca la recency
		lastFrames.delete(sessionId);
		lastFrames.set(sessionId, hit);
		return hit.frame;
	}

	function closeConnection(entry) {
		const connection = entry.connection;
		entry.connection = undefined;
		for (const off of entry.listeners.splice(0)) {
			try { off(); } catch { /* gia' rimosso */ }
		}
		try { connection?.close(); } catch { /* gia' chiusa */ }
	}

	/** Chiude la connessione quando non resta nessun consumer (chiusura deterministica). */
	function releaseEntry(sessionId, entry) {
		if (entry.channels.size > 0 || entry.waiters > 0) return false;
		if (hosted.get(sessionId) === entry) hosted.delete(sessionId);
		closeConnection(entry);
		return true;
	}

	async function ensureBusConnection(selection) {
		const existing = hosted.get(selection.sessionId);
		if (existing !== undefined) {
			if (existing.projectId !== selection.projectId || existing.workspaceId !== selection.workspaceId) {
				throw new Error("selezione non coerente con la connessione gia' attiva");
			}
			// Prenotazione prima dell'attesa: un altro consumer annullato non
			// puo' chiudere la connessione mentre questa apertura e' in volo.
			existing.waiters += 1;
			try {
				if (existing.ready !== undefined) await existing.ready;
			} catch (error) {
				existing.waiters -= 1;
				throw error;
			}
			return existing;
		}
		// La entry viene pubblicata PRIMA di attendere il connect (single-flight):
		// due aperture concorrenti sulla stessa sessione condividono l'installazione
		// invece di creare due connessioni, una delle quali orfana.
		const entry = {
			connection: undefined,
			projectId: selection.projectId,
			workspaceId: selection.workspaceId,
			channels: new Set(),
			listeners: [],
			waiters: 1,
			ready: undefined,
		};
		let onReady;
		let onFailed;
		entry.ready = new Promise((resolve, reject) => {
			onReady = resolve;
			onFailed = reject;
		});
		entry.ready.catch(() => {}); // se nessuno attende, il rifiuto resta gestito
		hosted.set(selection.sessionId, entry);
		let connection;
		try {
			connection = await events.connect(selection);
			if (
				typeof connection?.on !== "function" ||
				typeof connection?.emit !== "function" ||
				typeof connection?.close !== "function"
			) {
				throw new Error("connessione al bus di sessione non utilizzabile");
			}
			if (disposed || connection.signal?.aborted) {
				connection.close();
				throw new Error("plugin terminato o connessione chiusa durante l'apertura");
			}
		} catch (error) {
			if (hosted.get(selection.sessionId) === entry) hosted.delete(selection.sessionId);
			onFailed(error);
			throw error;
		}
		entry.connection = connection;

		try {
		entry.listeners.push(connection.on(METRIC_CHANNEL, (data) => {
			const frame = parseMetricFrame(data);
			if (frame === undefined) return;
			// il frame deve appartenere alla sessione della connessione: senza sid
			// non e' attribuibile e va scartato
			if (data?.sid !== selection.sessionId) return;
			touchCache(selection.sessionId, data);
			for (const channel of entry.channels) {
				try {
					channel.send(data);
				} catch {
					channel.finish();
				}
			}
		}));

		// Risposta di presenza: l'estensione misura solo se riceve il pong.
		entry.listeners.push(connection.on(PROBE_CHANNEL, (data) => {
			if (typeof data !== "object" || data === null || data.v !== PROTOCOL_VERSION || data.type !== "probe") return;
			if (entry.channels.size === 0) return;
			try {
				connection.emit(PONG_CHANNEL, { v: PROTOCOL_VERSION, type: "pong" });
			} catch (error) {
				log("warn", "pong fallito", { sessionId: selection.sessionId, error: String(error?.message ?? error) });
			}
		}));

		if (connection.signal instanceof AbortSignal) {
			connection.signal.addEventListener(
				"abort",
				() => {
					if (hosted.get(selection.sessionId) === entry) hosted.delete(selection.sessionId);
					entry.connection = undefined; // la connessione e' gia' stata interrotta dall'host
					closeConnection(entry);
					for (const channel of entry.channels) channel.finish();
				},
				{ once: true },
			);
		}
		onReady(entry);
		return entry;
		} catch (error) {
			if (hosted.get(selection.sessionId) === entry) hosted.delete(selection.sessionId);
			closeConnection(entry);
			onFailed(error);
			throw error;
		}
	}

	async function openChannel(context) {
		if (disposed) throw new Error("plugin terminato: canale non apribile");
		if (context.operation !== PEER_OPERATION) throw new Error(`operazione peer non supportata: ${context.operation}`);
		const selection = parseSelection(context.input);
		if (selection === undefined) throw new Error("selezione sessione mancante o non valida");
		if (events === undefined) throw new Error("plugin non ancora attivo");
		// Difesa in profondita' *fail-closed*: senza uno scope workspace risolto
		// dall'host non c'e' nulla con cui confrontare la selezione: si rifiuta.
		const scope = context.scope;
		if (scope?.kind !== "workspace") {
			throw new Error("scope del canale non riconosciuto (atteso workspace)");
		}
		if (scope.project?.id !== selection.projectId || scope.workspace?.id !== selection.workspaceId) {
			throw new Error("selezione non coerente con lo scope del canale");
		}

		if (context.signal.aborted) throw new Error("apertura canale annullata");
		const entry = await ensureBusConnection(selection);
		entry.waiters -= 1;
		if (disposed || context.signal.aborted || !entry.connection || entry.connection.signal?.aborted) {
			releaseEntry(selection.sessionId, entry);
			throw new Error("apertura canale annullata o plugin terminato");
		}
		let resolveClosed;
		const closedPromise = new Promise((resolve) => { resolveClosed = resolve; });
		let closed = false;
		const channel = { send: context.send, finish: () => detach() };
		const detach = () => {
			if (closed) return;
			closed = true;
			context.signal.removeEventListener("abort", detach);
			entry.channels.delete(channel);
			resolveClosed();
			const released = releaseEntry(selection.sessionId, entry);
			log("info", released ? "canale metriche chiuso, connessione rilasciata" : "canale metriche chiuso", {
				sessionId: selection.sessionId,
			});
		};
		entry.channels.add(channel);
		context.signal.addEventListener("abort", detach, { once: true });

		const cached = lastFrameFor(selection.sessionId);
		try {
			context.send({ t: "hello", last: cached });
		} catch (error) {
			detach();
			throw error;
		}
		log("info", "canale metriche aperto", { sessionId: selection.sessionId });

		return {
			closed: closedPromise,
			receive() {
				// canale in sola lettura: il browser non invia comandi.
			},
			close() {
				detach();
			},
		};
	}

	function shutdown() {
		disposed = true;
		for (const entry of hosted.values()) {
			for (const channel of entry.channels) channel.finish();
			closeConnection(entry);
		}
		hosted.clear();
		lastFrames.clear();
	}

	return {
		plugin: {
			apiVersion: 5,
			name: "Pi Token Speed",
			requires: [PI_WEB_HOST_PI_SESSION_EVENTS_CAPABILITY],
			activate(context) {
				context.lifetimeSignal.addEventListener("abort", shutdown, { once: true });
				return {
					peer: { openChannel },
					start(startContext) {
						events = startContext.capabilities.resolve(PI_WEB_HOST_PI_SESSION_EVENTS_CAPABILITY);
					},
					dispose() {
						shutdown();
					},
					health() {
						return {
							status: "healthy",
							details: { connections: hosted.size, cachedSessions: lastFrames.size },
						};
					},
				};
			},
		},
		/** Solo per test. */
		__test: { hosted, lastFrames, lastFrameFor, parseHello, cacheFrame: touchCache },
	};
}

export default createServerPlugin().plugin;
