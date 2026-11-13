/**
 * Plugin browser Pi Web v5 di pi-token-speed.
 *
 * Superfici (tutte con API verificate su @jmfederico/pi-web 1.202611.2):
 *  - etichetta live sulla riga della sessione selezionata nella lista: fa anche
 *    da bootstrap del canale (la lista e' sempre renderizzata, pattern gia'
 *    collaudato);
 *  - pannello "Token Speed": decode/prefill/TTFT/token con la natura di ogni
 *    valore (nativa / stima / N/A + motivo) e la storia dei turni in memoria.
 *
 * Niente DOM flottante: il plugin non crea elementi propri sul documento (il
 * badge sopra il composer e' stato tolto su richiesta, 2026-11-13).
 *
 * Il canale peer viene aperto per la sola sessione selezionata e chiuso al
 * cambio; nessun timer fisso a regime: l'indicatore si aggiorna sui frame (≤1/s)
 * e si nasconde dopo `keepLastMs` dal frame finale.
 */

import { describeFrame, formatRate } from "../metrics.js";
import { PEER_OPERATION, parseHello, parseMetricFrame } from "../protocol.js";

export const PANEL_ID = "token-speed";
export const LABEL_ID = "token-speed-label";
export const ACTION_ID = "token-speed-open";
const KEEP_LAST_MS = 60_000;
const MAX_HISTORY = 20;
/** Tetto agli stati tenuti nel browser (sessioni visitate). */
const MAX_STATES = 64;
/** Riaperture dopo un canale chiuso dall'host: progressione di backoff in ms. */
const BACKOFF_STEPS = Object.freeze([1000, 2000, 4000, 8000]);

export function createBrowserPlugin(options = {}) {
	const keepLastMs = options.keepLastMs ?? KEEP_LAST_MS;
	const now = options.now ?? (() => Date.now());
	const setTimeoutFn = options.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
	const clearTimeoutFn = options.clearTimeout ?? ((t) => clearTimeout(t));

	/** @type {Map<string, any>} */
	const states = new Map();
	let currentKey;
	let disposed = false;

	function keyOf(sel) {
		return `${sel.projectId}\u0000${sel.workspaceId}\u0000${sel.sessionId}`;
	}

	function stateFor(sel) {
		const key = keyOf(sel);
		let state = states.get(key);
		if (state !== undefined) {
			states.delete(key);
		} else {
			state = {
				key,
				sel,
				status: "connecting",
				frame: null,
				error: null,
				history: [],
				requestRender: null,
				channel: undefined,
				generation: 0,
				attempts: 0,
				nextAttemptAt: 0,
				keepTimer: undefined,
				retryTimer: undefined,
			};
		}
		states.set(key, state); // tocca la recency (LRU)
		evictStates();
		return state;
	}

	/** Rilascia canali e timer di uno stato ed eventualmente lo rimuove dalla mappa. */
	function releaseState(state, remove = true) {
		if (state === undefined) return;
		if (state.keepTimer !== undefined) clearTimeoutFn(state.keepTimer);
		if (state.retryTimer !== undefined) clearTimeoutFn(state.retryTimer);
		state.keepTimer = undefined;
		state.retryTimer = undefined;
		closeChannel(state, "rilascio");
		if (remove) states.delete(state.key);
	}

	/** Tetto LRU agli stati: le sessioni non piu' selezionate non restano in memoria. */
	function evictStates() {
		while (states.size > MAX_STATES) {
			let victimKey;
			for (const k of states.keys()) {
				if (k !== currentKey) {
					victimKey = k;
					break;
				}
			}
			if (victimKey === undefined) return;
			const victim = states.get(victimKey);
			states.delete(victimKey);
			releaseState(victim, false);
		}
	}

	/**
	 * Chiude il canale corrente di uno stato marcandolo come annullato: i risultati
	 * di quell'apertura (risolti o rifiutati che arrivino dopo) sono obsoleti e
	 * vengono ignorati, non trasformati in un errore permanente.
	 */
	function closeChannel(state, reason) {
		const mine = state.channel;
		if (mine === undefined) return;
		state.channel = undefined;
		mine.cancelled = true;
		try {
			mine.close(reason);
		} catch {
			/* già chiuso */
		}
	}

	function render(state) {
		try {
			state.requestRender?.();
		} catch {
			/* host senza requestRender */
		}
	}

	function ensureChannel(sel, peer, requestRender) {
		if (disposed) return undefined;
		if (peer === undefined || typeof peer.openChannel !== "function") {
			const state = stateFor(sel);
			state.status = "error";
			state.error = "canale peer non disponibile (aggiornare Pi Web?)";
			return state;
		}
		const state = stateFor(sel);
		state.requestRender = requestRender ?? state.requestRender;
		if (currentKey !== undefined && currentKey !== state.key) {
			const previous = states.get(currentKey);
			if (previous?.channel !== undefined) {
				closeChannel(previous, "cambio sessione");
				previous.status = "connecting";
			}
		}
		currentKey = state.key;
		if (state.channel !== undefined) return state;
		if (state.status === "closed" && now() < state.nextAttemptAt) return state;

		const generation = (state.generation += 1);
		const abort = new AbortController();
		const mine = {
			generation,
			cancelled: false,
			raw: undefined,
			close: (reason) => {
				abort.abort();
				try {
					mine.raw?.close?.(reason ?? "client-detach");
				} catch {
					/* già chiuso */
				}
			},
		};
		state.channel = mine;
		state.status = "connecting";
		// Qualsiasi risultato di questa apertura che arrivi dopo un annullamento o un
		// cambio di generazione e' obsoleto: va ignorato (e il canale chiuso).
		// Lo stato `closed` NON rende obsoleti i dati gia' in volo: arrivano pur
		// sempre dalla connessione corrente.
		const obsolete = () => mine.cancelled || state.generation !== mine.generation;

		// L'host autorizza la selezione; se la sessione non e' ospitata o il
		// plugin server non e' attivo, la open fallisce (sincrono o asincrono):
		// stato esplicito, niente fallimento silenzioso.
		let opening;
		try {
			opening = peer.openChannel(PEER_OPERATION, state.sel, {
				signal: abort.signal,
				onData: (data) => {
					if (obsolete()) return;
					onFrame(state, data);
				},
			});
		} catch (error) {
			if (!obsolete()) {
				mine.cancelled = true;
				markClosed(state, error, generation);
			}
			return state;
		}
		Promise.resolve(opening).then(
			(channel) => {
				if (obsolete()) {
					try {
						channel?.close?.("apertura obsoleta");
					} catch {
						/* host gia' oltre */
					}
					return;
				}
				mine.raw = channel;
				// se l'host non espone una promise `closed`, il canale non viene
				// considerato chiuso: niente riaperture fantasma
				const closed = channel?.closed;
				if (closed !== undefined) {
					Promise.resolve(closed).then(
						(info) => {
							if (obsolete()) return;
							mine.cancelled = true;
							const reason = info?.error?.message ?? (info?.wasClean === false ? info.reason : null);
							markClosed(state, reason ?? null, generation);
						},
						(error) => {
							if (obsolete()) return;
							mine.cancelled = true;
							markClosed(state, error ?? null, generation);
						},
					);
				}
			},
			(error) => {
				if (obsolete()) return; // annullamento voluto: non e' un errore
				mine.cancelled = true;
				markClosed(state, error, generation);
			},
		);
		return state;
	}

	function markClosed(state, error, generation) {
		// un canale di un'apertura superata non deve toccare lo stato corrente
		if (disposed || (generation !== undefined && state.generation !== generation)) return;
		if (state.channel !== undefined && state.channel.generation !== generation) return;
		state.channel = undefined;
		state.status = "closed";
		state.error = error === null ? null : String(error?.message ?? error);
		scheduleRetry(state);
		render(state);
	}

	/** Un solo timer per stato: la riapertura e' programmata, non concausa dei rendering. */
	function scheduleRetry(state) {
		const step = BACKOFF_STEPS[Math.min(state.attempts, BACKOFF_STEPS.length - 1)];
		state.attempts += 1;
		state.nextAttemptAt = now() + step;
		if (state.retryTimer !== undefined) clearTimeoutFn(state.retryTimer);
		state.retryTimer = setTimeoutFn(() => {
			state.retryTimer = undefined;
			state.nextAttemptAt = 0;
			render(state); // chiede un rendering: sara' ensureChannel a riaprire
		}, step);
	}

	/** Un frame e' ancora "attuale" solo entro la finestra di persistenza. */
	function isFresh(frame) {
		return (
			typeof frame?.ts === "number" &&
			Number.isFinite(frame.ts) &&
			now() - frame.ts <= keepLastMs
		);
	}

	function onFrame(state, data) {
		const hello = parseHello(data);
		if (hello !== undefined) {
			if (hello.t === "error") {
				const generation = state.generation;
				closeChannel(state, "errore dal server");
				markClosed(state, hello.message, generation);
				return;
			}
			const last = hello.last;
			if (last === null || last === undefined) {
				state.status = "waiting";
				render(state);
				return;
			}
			if (!isFresh(last)) {
				// cache piu' vecchia della finestra: meglio restare in attesa che
				// ripresentare un valore vecchio come misura corrente
				state.status = "waiting";
				state.frame = null;
				render(state);
				return;
			}
			applyFrame(state, last, { fromCache: true });
			return;
		}
		const frame = parseMetricFrame(data);
		if (frame === undefined) return;
		applyFrame(state, data);
	}

	function applyFrame(state, frame, { fromCache = false } = {}) {
		state.status = "ready";
		state.frame = frame;
		if (!fromCache) state.attempts = 0;
		if (state.keepTimer !== undefined) clearTimeoutFn(state.keepTimer);
		state.keepTimer = undefined;
		if (frame.phase !== "idle") {
			const remaining = fromCache ? Math.max(0, keepLastMs - Math.max(0, now() - frame.ts)) : keepLastMs;
			state.keepTimer = setTimeoutFn(() => {
				state.keepTimer = undefined;
				if (state.frame === frame) {
					state.frame = null;
					render(state);
				}
			}, remaining);
		}
		if (frame.phase === "final") {
			// un valore recuperato dalla cache non e' un turno nuovo: non va
			// duplicato nello storico a ogni reload del browser
			if (!fromCache) {
				state.history.push(frame);
				while (state.history.length > MAX_HISTORY) state.history.shift();
			}
		}
		if (frame.phase === "idle") {
			if (state.keepTimer !== undefined) {
				clearTimeoutFn(state.keepTimer);
				state.keepTimer = undefined;
			}
			state.frame = null;
		}
		render(state);
	}

	// --- rendering host (template dell'host, nessun custom element) --------

	function statusLine(state) {
		if (state === undefined) return "No session selected.";
		if (state.status === "error") return `Indicator unavailable: ${state.error ?? "error"}`;
		if (state.status === "connecting") return "Connecting to the session…";
		if (state.status === "closed") return `Channel closed${state.error ? `: ${state.error}` : ""}. Reconnecting.`;
		if (state.status === "waiting") return "Connected. Waiting for the first generation.";
		return null;
	}

	function activate(context) {
		const html = context.html;
		const svg = typeof context.svg === "function" ? context.svg : context.html;
		const runtimePluginId = context.runtimePluginId ?? "pi-token-speed";
		const qualifiedPanelId = `${runtimePluginId}:workspace.${PANEL_ID}`;

		function selectionOf(ctx) {
			const sessionId = ctx?.state?.selectedSession?.id;
			const workspace = ctx?.workspace;
			if (typeof sessionId !== "string" || workspace === undefined) return undefined;
			return { projectId: workspace.projectId, workspaceId: workspace.id, sessionId };
		}

		function connectionFor(ctx) {
			const sel = selectionOf(ctx);
			if (sel === undefined) return undefined;
			// ensureChannel aggiorna currentKey: l'indicatore segue la selezione
			return ensureChannel(sel, ctx.peer, ctx.host?.requestRender);
		}

		function rateText(state) {
			if (state?.frame === null || state?.frame === undefined) return null;
			return formatRate(state.frame);
		}

		function fmt(v, digits, suffix) {
			return typeof v === "number" ? `${v.toFixed(digits)}${suffix}` : "N/A";
		}

		return {
			contributions: {
				sessionLabels: [
					{
						id: LABEL_ID,
						items: (labelContext) => {
							try {
								const selected = labelContext?.state?.selectedSession?.id;
								if (typeof selected !== "string" || labelContext?.session?.id !== selected) return [];
								const state = connectionFor(labelContext);
								const rate = rateText(state);
								if (rate === null) return [];
								return [{ type: "text", text: `⚡ ${rate}`, title: describeFrame(state.frame) }];
							} catch {
								return [];
							}
						},
					},
				],
				workspacePanels: [
					{
						id: PANEL_ID,
						title: "Token Speed",
						icon: svg`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M13 2 3 14h7l-1 8 10-12h-7l1-8z"></path></svg>`,
						order: 85,
						visible: () => true,
						render: (panelContext) => {
							try {
								const state = connectionFor(panelContext);
								const parts = [];
								const status = statusLine(state);
								if (status !== null) parts.push(html`<p class="pts-hint">${status}</p>`);
								const frame = state?.frame;
								if (frame !== null && frame !== undefined) {
									const isFinal = frame.phase === "final";
									parts.push(html`
										<div class="pts-grid">
											<span>Model</span><b>${frame.model}${frame.local ? " · local" : " · remote"}</b>
											<span>Decode</span><b>${
												isFinal
													? typeof frame.decode === "number"
														? `${frame.decode.toFixed(1)} tok/s · native tokens, locally measured interval`
														: `N/A${typeof frame.reason === "string" ? `: ${frame.reason}` : ""}`
													: formatRate(frame) === null
														? "waiting"
														: `${formatRate(frame)} (estimate)`
											}</b>
											<span>TTFT</span><b>${isFinal ? fmt(frame.ttft, 2, " s") : "—"}</b>
											<span>Prefill</span><b>${
												isFinal && typeof frame.prefill === "number" ? `~${Math.round(frame.prefill)} tok/s (estimate)` : "N/A"
											}</b>
											<span>Tokens</span><b>${isFinal && typeof frame.out === "number" ? `${frame.out} out${typeof frame.prompt === "number" ? ` · ${frame.prompt} prompt` : ""}` : "—"}</b>
											<span>Request</span><b>${frame.req} of turn ${frame.turn}</b>
										</div>
										${frame.partial ? html`<p class="pts-warn">Interrupted answer: partial values.</p>` : null}
									`);
								}
								if (state !== undefined && state.history.length > 0) {
									parts.push(html`<h4>Recent turns</h4>`);
									parts.push(html`
										<ul class="pts-history">
											${state.history
												.slice(-8)
												.reverse()
												.map(
													(f) => html`<li>
														${typeof f.decode === "number" ? `${f.decode.toFixed(1)} tok/s` : `N/A${f.reason ? ` (${f.reason})` : ""}`}
														· ${f.model}${typeof f.ttft === "number" ? ` · TTFT ${f.ttft.toFixed(2)}s` : ""}
													</li>`,
												)}
										</ul>
									`);
								}
								return html`<section class="pts-root">
									<style>
										.pts-root { display: block; }
										.pts-hint { opacity: 0.75; }
										.pts-warn { color: #e0a53a; }
										.pts-grid { display: grid; grid-template-columns: auto 1fr; gap: 4px 12px; margin: 8px 0; }
										.pts-grid > span { opacity: 0.75; }
										.pts-history { margin: 4px 0 0; padding-left: 18px; font-size: 0.9em; opacity: 0.85; }
									</style>
									${parts}
								</section>`;
							} catch (error) {
								return html`<p class="pts-warn">Panel error: ${error instanceof Error ? error.message : String(error)}</p>`;
							}
						},
					},
				],
				actions: [
					{
						id: ACTION_ID,
						title: "Apri pannello Token Speed",
						group: "Pi",
						enabled: (actionContext) => selectionOf(actionContext) !== undefined,
						run: (actionContext) => {
							actionContext.selectWorkspaceTool(qualifiedPanelId);
							actionContext.selectMainView("workspace");
						},
					},
				],
			},
			dispose() {
				disposed = true;
				for (const state of states.values()) releaseState(state, false);
				states.clear();
			},
		};
	}

	return {
		plugin: { apiVersion: 5, name: "Pi Token Speed", activate },
		/** Solo per test. */
		__test: { states, onFrame },
	};
}

export default createBrowserPlugin().plugin;
