/**
 * Regressioni di affidabilita' (change: harden-token-speed).
 *
 * Ogni test riproduce un difetto riportato dall'audit 2026-11-13: race di apertura,
 * cambio sessione durante la connessione, leak di canali/timer/listener, cache
 * scaduta, calibrazione contaminata, `message_end` spurio, validazione del trasporto.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createServerPlugin } from "../src/server/index.js";
import { createBrowserPlugin } from "../src/browser/index.js";
import { createExtension } from "../src/extension/index.js";
import { createTracker, isLocalEndpoint } from "../src/metrics.js";
import {
	LAST_FRAME_MAX_AGE_MS,
	METRIC_CHANNEL,
	PONG_CHANNEL,
	PROBE_CHANNEL,
	parseHello,
	parseSelection,
} from "../src/protocol.js";

const tick = () => new Promise((r) => setImmediate(r));
const NOW = 1_700_000_000_000;

function frame(over = {}) {
	return {
		v: 1, sid: "s1", phase: "final", model: "m/x", local: true, live: null, decode: 21.3, decodeSrc: "usage",
		ttft: 0.42, prefill: 800, out: 512, prompt: 1024, reason: null, partial: false, calibrated: true,
		req: 1, turn: 1, ts: NOW, ...over,
	};
}

// ------------------------------------------------------------------ server --

function makeServer({ connectDelay = 0, connectGate, failOn = false, clock = () => NOW } = {}) {
	const handle = createServerPlugin({ now: clock });
	const plugin = handle.plugin;
	const buses = new Map();
	const stats = { connects: 0, closes: 0 };
	const capability = {
		version: 1,
		async connect(selection) {
			stats.connects += 1;
			if (connectGate) await connectGate;
			if (connectDelay > 0) await new Promise((r) => setTimeout(r, connectDelay));
			const emitter = new EventEmitter();
			const bus = {
				emit: (c, d) => emitter.emit(c, d),
				on: (c, h) => {
					const safe = async (d) => { try { await h(d); } catch { /* isolato */ } };
					emitter.on(c, safe);
					return () => emitter.off(c, safe);
				},
				listenerCount: (c) => emitter.listenerCount(c),
			};
			const ac = new AbortController();
			buses.set(selection.sessionId, { bus, ac });
			return {
				signal: ac.signal,
				on: failOn ? () => { throw new Error("listener fallito"); } : bus.on,
				emit: bus.emit,
				close: () => { stats.closes += 1; ac.abort(); },
			};
		},
	};
	const lifetime = new AbortController();
	const activation = plugin.activate({
		apiVersion: 5,
		pluginId: "pi-token-speed",
		settings: Object.freeze({}),
		lifetimeSignal: lifetime.signal,
		signal: new AbortController().signal,
		logger: { debug() {}, info() {}, warn() {}, error() {} },
	});
	let startContextReady = false;
	return {
		handle, activation, stats, buses, lifetime,
		async start() {
			if (startContextReady) return;
			startContextReady = true;
			await activation.start({ capabilities: { resolve: () => capability }, signal: new AbortController().signal });
		},
		async open(input = { projectId: "p1", workspaceId: "w1", sessionId: "s1" }, scope = { kind: "workspace", project: { id: "p1" }, workspace: { id: "w1" } }, ac = new AbortController()) {
			const sent = [];
			const channel = await activation.peer.openChannel({
				operation: "metrics", input, scope, signal: ac.signal, send: (d) => sent.push(d),
			});
			return { channel, sent, abort: ac };
		},
		bus: (sid = "s1") => buses.get(sid)?.bus,
	};
}

test("server: due aperture concorrenti condividono una sola connessione", async () => {
	const s = makeServer({ connectDelay: 5 });
	await s.start();
	const [a, b] = await Promise.all([s.open(), s.open()]);
	await tick();
	assert.equal(s.stats.connects, 1, `connessioni create: ${s.stats.connects}`);
	s.bus().emit(METRIC_CHANNEL, frame());
	assert.equal(a.sent.at(-1)?.decode, 21.3);
	assert.equal(b.sent.at(-1)?.decode, 21.3);
	a.abort.abort();
	b.abort.abort();
	await tick();
	assert.equal(s.stats.closes, 1, "la connessione va chiusa all'ultimo consumer");
	assert.equal(s.handle.__test.hosted.size, 0, "nessuna entry orfana");
});

test("server: errore registrazione listener chiude e libera la connessione", async () => {
	const s = makeServer({ failOn: true });
	await s.start();
	await assert.rejects(s.open(), /listener fallito/);
	assert.equal(s.handle.__test.hosted.size, 0);
	assert.equal(s.stats.closes, 1);
	await assert.rejects(s.open(), /listener fallito/);
	assert.equal(s.stats.connects, 2);
	assert.equal(s.stats.closes, 2);
});

test("server: dispose durante connect chiude il risultato tardivo", async () => {
	let resume;
	const s = makeServer({ connectGate: new Promise((r) => { resume = r; }) });
	await s.start();
	const opening = s.open();
	await s.activation.dispose();
	resume();
	await assert.rejects(opening, /terminato|chiusa/);
	assert.equal(s.stats.closes, 1);
	assert.equal(s.handle.__test.hosted.size, 0);
});

test("server: un waiter annullato non chiude la connessione condivisa", async () => {
	let resume;
	const s = makeServer({ connectGate: new Promise((r) => { resume = r; }) });
	await s.start();
	const ac = new AbortController();
	const a = s.open(undefined, undefined, ac);
	const b = s.open();
	ac.abort();
	resume();
	await assert.rejects(a, /annullata/);
	const survivor = await b;
	assert.equal(s.stats.closes, 0);
	s.bus().emit(METRIC_CHANNEL, frame());
	assert.equal(survivor.sent.at(-1).decode, 21.3);
	survivor.abort.abort();
	assert.equal(s.stats.closes, 1);
});

test("server: abort del bus completa i canali e consente una nuova apertura", async () => {
	const s = makeServer();
	await s.start();
	const first = await s.open();
	s.buses.get("s1").ac.abort();
	await first.channel.closed;
	assert.equal(s.handle.__test.hosted.size, 0);
	const second = await s.open();
	assert.equal(s.stats.connects, 2);
	second.abort.abort();
});

test("server: apertura dopo dispose rifiutata, nessuna riconnessione", async () => {
	const s = makeServer();
	await s.start();
	await s.open();
	await s.activation.dispose();
	const prima = s.stats.connects;
	await assert.rejects(s.open(), /terminat|chius|non attivo/);
	assert.equal(s.stats.connects, prima, "dopo dispose non vanno create connessioni");
	assert.equal(s.handle.__test.hosted.size, 0);
});

test("server: l'ultimo consumer chiude la connessione e la riapertura funziona", async () => {
	const s = makeServer();
	await s.start();
	const a = await s.open();
	const b = await s.open();
	a.abort.abort();
	await tick();
	assert.equal(s.stats.closes, 0, "resta un consumer: la connessione deve restare aperta");
	b.abort.abort();
	await tick();
	assert.equal(s.stats.closes, 1);
	assert.equal(s.handle.__test.hosted.size, 0);
	const c = await s.open();
	assert.equal(s.stats.connects, 2, "la nuova apertura ristabilisce la connessione");
	assert.equal(c.sent[0].t, "hello");
});

test("server: scope non workspace rifiutato (fail-closed)", async () => {
	const s = makeServer();
	await s.start();
	const peer = s.activation.peer;
	for (const scope of [undefined, { kind: "session" }, { kind: "application" }]) {
		await assert.rejects(
			peer.openChannel({
				operation: "metrics",
				input: { projectId: "p1", workspaceId: "w1", sessionId: "s1" },
				scope,
				signal: new AbortController().signal,
				send() {},
			}),
			/scope|selezione/,
			`scope accettato: ${JSON.stringify(scope)}`,
		);
	}
	assert.equal(s.stats.connects, 0, "nessun connect tentato senza scope riconosciuto");
});

test("server: entry riusata solo con la stessa selezione", async () => {
	const s = makeServer();
	await s.start();
	await s.open();
	await assert.rejects(
		s.open({ projectId: "ALTRO", workspaceId: "w1", sessionId: "s1" }, { kind: "workspace", project: { id: "ALTRO" }, workspace: { id: "w1" } }),
		/coerent|scope|selezione/,
	);
});

test("server: frame senza sid o di altra sessione scartati", async () => {
	const s = makeServer();
	await s.start();
	const { sent } = await s.open();
	s.bus().emit(METRIC_CHANNEL, frame({ sid: undefined }));
	s.bus().emit(METRIC_CHANNEL, frame({ sid: "altra" }));
	s.bus().emit(METRIC_CHANNEL, frame({ sid: "s1" }));
	await tick();
	assert.equal(sent.length, 2, "solo hello + frame della sessione corretta");
});

test("server: la cache non consegna un frame scaduto", async () => {
	const s = makeServer();
	await s.start();
	const first = await s.open();
	s.bus().emit(METRIC_CHANNEL, frame({ ts: NOW - LAST_FRAME_MAX_AGE_MS - 1000 }));
	await tick();
	first.abort.abort();
	await tick();
	const reload = await s.open();
	assert.deepEqual(reload.sent[0], { t: "hello", last: null }, "frame vecchio non ripresentato come attuale");
});

test("server: la cache consegna un frame recente", async () => {
	const s = makeServer();
	await s.start();
	const first = await s.open();
	const fresh = frame({ ts: NOW - 1000 });
	s.bus().emit(METRIC_CHANNEL, fresh);
	await tick();
	const reload = await s.open();
	assert.deepEqual(reload.sent[0], { t: "hello", last: fresh });
});

// ----------------------------------------------------------------- browser --

function makeBrowser({ keepLastMs = 60_000, clock = () => NOW, autoClose = false } = {}) {
	const opens = [];
	const timers = [];
	const plugin = createBrowserPlugin({
		keepLastMs,
		now: clock,
		setTimeout: (fn, ms) => { const t = { fn, ms, done: false }; timers.push(t); return t; },
		clearTimeout: (t) => { if (t) t.done = true; },
	});
	const peer = {
		openChannel(operation, input, opts) {
			const rec = { operation, input, opts, closeCalls: [], resolve: null, reject: null };
			rec.promise = new Promise((res, rej) => { rec.resolve = res; rec.reject = rej; });
			rec.promise.catch(() => {});
			opens.push(rec);
			if (autoClose) {
				queueMicrotask(() => rec.resolve({ close() {}, closed: Promise.resolve() }));
			}
			return rec.promise;
		},
	};
	const context = {
		apiVersion: 5,
		html: (strings, ...values) => ({ strings, values }),
		svg: (strings, ...values) => ({ strings, values }),
		runtimePluginId: "pi-token-speed",
		signal: new AbortController().signal,
		lifetimeSignal: new AbortController().signal,
	};
	let activation;
	const onRenderHooks = [];
	return {
		plugin, peer, opens, timers,
		onRender(fn) { onRenderHooks.push(fn); },
		async activate() { activation = await plugin.plugin.activate(context); return activation; },
		labelContext(sessionId = "s1", selected = sessionId) {
			return {
				state: { selectedSession: { id: selected } },
				session: { id: sessionId },
				workspace: { projectId: "p1", id: "w1" },
				peer,
				host: { requestRender: () => onRenderHooks.forEach((f) => f()) },
			};
		},
		settle(index, channel = { closed: new Promise(() => {}) }) { opens[index].resolve(channel); return tick(); },
		fail(index, error) { opens[index].reject(error); return tick(); },
		runTimers() { for (const t of timers) if (!t.done) { t.done = true; t.fn(); } return tick(); },
	};
}

test("browser: cambio sessione durante l'apertura non lascia un errore permanente", async () => {
	const h = makeBrowser();
	const { contributions } = await h.activate();
	const label = (sid, sel) => contributions.sessionLabels[0].items(h.labelContext(sid, sel));

	label("s1");                                  // apertura 0 in volo
	assert.equal(h.opens.length, 1);
	label("s2");                                  // cambio: apertura 0 obsoleta
	assert.equal(h.opens.length, 2);
	assert.equal(h.opens[0].opts.signal.aborted, true, "l'apertura obsoleta va annullata");
	await h.fail(0, new Error("apertura canale annullata"));
	await h.settle(1);

	// si torna su s1: deve riprovare, non restare bloccata
	const prima = h.opens.length;
	label("s1");
	assert.equal(h.opens.length, prima + 1, "il ritorno sulla sessione deve riaprire il canale");
	await h.settle(h.opens.length - 1);
	h.opens.at(-1).opts.onData({ t: "hello", last: null });
	h.opens.at(-1).opts.onData(frame({ ts: NOW }));
	const items = label("s1");
	assert.equal(items[0]?.text, "⚡ 21.3 tok/s", "l'indicatore torna a mostrare il valore");
});

test("browser: un'apertura risolta tardi viene chiusa, non persa", async () => {
	const h = makeBrowser();
	const { contributions } = await h.activate();
	const label = (sid) => contributions.sessionLabels[0].items(h.labelContext(sid));
	label("s1");
	label("s2");
	const late = { closed: new Promise(() => {}), closeCalls: [], close() { this.closeCalls.push("late"); } };
	await h.settle(0, late);                      // l'host risolve DOPO l'annullamento
	await h.settle(1);
	assert.ok(late.closeCalls.length > 0, "il canale obsoleto risolto tardi va chiuso");
});

test("browser: canale chiuso dall'host riaperto con backoff, non a ogni rendering", async () => {
	const h = makeBrowser({ autoClose: true });
	const { contributions } = await h.activate();
	const label = () => contributions.sessionLabels[0].items(h.labelContext("s1"));
	h.onRender(label); // come fa l'host: requestRender provoca un nuovo rendering
	label();
	await tick();
	await tick();
	const prima = h.opens.length;
	assert.ok(prima >= 1, "il canale deve essersi aperto e chiuso");
	for (let i = 0; i < 25; i += 1) { label(); await tick(); }
	assert.equal(h.opens.length, prima, `riaperture a ogni rendering: ${h.opens.length - prima}`);
	await h.runTimers();
	assert.equal(h.opens.length, prima + 1, "il backoff programmato apre un nuovo canale");
});

test("browser: un errore transitorio di apertura viene ritentato", async () => {
	const h = makeBrowser();
	const { contributions } = await h.activate();
	const label = () => contributions.sessionLabels[0].items(h.labelContext());
	h.onRender(label);
	label();
	await h.fail(0, new Error("plugin non ancora attivo"));
	assert.equal(h.timers.find((t) => !t.done)?.ms, 1000);
	await h.runTimers();
	assert.equal(h.opens.length, 2);
	await h.settle(1);
	h.opens[1].opts.onData(frame());
	assert.equal(label()[0].text, "⚡ 21.3 tok/s");
});

test("browser: errore inviato dal server chiude il canale e ritenta", async () => {
	const h = makeBrowser();
	const { contributions } = await h.activate();
	const label = () => contributions.sessionLabels[0].items(h.labelContext());
	h.onRender(label);
	label();
	let closes = 0;
	await h.settle(0, { close() { closes++; }, closed: new Promise(() => {}) });
	h.opens[0].opts.onData({ t: "error", message: "temporaneo" });
	assert.equal(closes, 1);
	await h.runTimers();
	assert.equal(h.opens.length, 2);
});

test("browser: il backoff aumenta per chiusure immediate successive", async () => {
	const h = makeBrowser({ autoClose: true });
	const { contributions } = await h.activate();
	const label = () => contributions.sessionLabels[0].items(h.labelContext());
	h.onRender(label);
	label();
	for (const delay of [1000, 2000, 4000, 8000, 8000]) {
		await tick();
		const timer = h.timers.find((t) => !t.done);
		assert.equal(timer?.ms, delay);
		timer.done = true;
		timer.fn();
	}
});

test("browser: la chiusura anomala conserva il motivo e ignora frame tardivi", async () => {
	const h = makeBrowser();
	const { contributions } = await h.activate();
	const label = () => contributions.sessionLabels[0].items(h.labelContext());
	label();
	let finish;
	await h.settle(0, { close() {}, closed: new Promise((r) => { finish = r; }) });
	finish({ wasClean: false, reason: "errore rete", error: { message: "rete interrotta" } });
	await tick();
	h.opens[0].opts.onData(frame());
	const state = h.plugin.__test.states.get("p1\u0000w1\u0000s1");
	assert.equal(state.error, "rete interrotta");
	assert.equal(state.status, "closed");
	assert.equal(state.frame, null);
});

test("browser: cambio selezione chiude il canale anche durante backoff", async () => {
	const h = makeBrowser();
	const { contributions } = await h.activate();
	const label = (sid) => contributions.sessionLabels[0].items(h.labelContext(sid));
	label("s1");
	let finish;
	await h.settle(0, { close() {}, closed: new Promise((r) => { finish = r; }) });
	finish();
	await tick();
	label("s2");
	let closed = 0;
	await h.settle(1, { close() { closed++; }, closed: new Promise(() => {}) });
	label("s1");
	assert.equal(closed, 1);
	assert.equal(h.opens[1].opts.signal.aborted, true);
});

test("browser: dispose ignora la chiusura tardiva", async () => {
	const h = makeBrowser();
	const activation = await h.activate();
	activation.contributions.sessionLabels[0].items(h.labelContext());
	let finish;
	await h.settle(0, { close() {}, closed: new Promise((r) => { finish = r; }) });
	activation.dispose();
	finish();
	await tick();
	assert.equal(h.timers.filter((t) => !t.done).length, 0);
	assert.equal(h.plugin.__test.states.size, 0);
});

test("browser: cache streaming e finale scadono all'eta' corretta", async () => {
	for (const phase of ["streaming", "final"]) {
		const h = makeBrowser();
		const { contributions } = await h.activate();
		const label = () => contributions.sessionLabels[0].items(h.labelContext());
		label();
		await h.settle(0);
		h.opens[0].opts.onData({ t: "hello", last: frame({ phase, ts: NOW - 59_000, live: phase === "streaming" ? 21 : null }) });
		assert.equal(h.timers.filter((t) => !t.done).at(-1).ms, 1000);
		assert.ok(label().length);
		await h.runTimers();
		assert.deepEqual(label(), []);
	}
});

test("browser: hello con frame scaduto non e' mostrato come attuale", async () => {
	const h = makeBrowser();
	const { contributions } = await h.activate();
	const label = () => contributions.sessionLabels[0].items(h.labelContext("s1"));
	label();
	await h.settle(0);
	h.opens[0].opts.onData({ t: "hello", last: frame({ ts: NOW - LAST_FRAME_MAX_AGE_MS - 5000 }) });
	assert.deepEqual(label(), [], "il frame vecchio non deve comparire come valore corrente");
});

test("browser: hello recente mostrato subito senza duplicare lo storico", async () => {
	const h = makeBrowser();
	const { contributions } = await h.activate();
	const label = () => contributions.sessionLabels[0].items(h.labelContext("s1"));
	label();
	await h.settle(0);
	const fresh = frame({ ts: NOW - 1000 });
	h.opens[0].opts.onData({ t: "hello", last: fresh });
	assert.equal(label()[0].text, "⚡ 21.3 tok/s");
	h.opens[0].opts.onData({ t: "hello", last: fresh });
	assert.equal(label()[0].text, "⚡ 21.3 tok/s");
	const state = h.plugin.__test.states.get("p1\u0000w1\u0000s1");
	assert.equal(state.history.length, 0, "il valore in cache non e' un turno nuovo");
	h.opens[0].opts.onData(frame({ ts: NOW }));
	assert.equal(state.history.length, 1, "la misura reale del turno finisce nello storico");
});

test("browser: stati limitati al variare delle sessioni selezionate", async () => {
	const h = makeBrowser();
	const { contributions } = await h.activate();
	for (let i = 0; i < 300; i += 1) contributions.sessionLabels[0].items(h.labelContext(`s${i}`));
	await tick();
	assert.ok(h.plugin.__test.states.size <= 64, `stati browser senza tetto: ${h.plugin.__test.states.size}`);
});

// --------------------------------------------------------------- extension --

function makeExtensionHarness({ serverPresent = true, start = 10_000 } = {}) {
	const emitter = new EventEmitter();
	const bus = {
		emit: (c, d) => emitter.emit(c, d),
		on: (c, h) => {
			const safe = async (d) => { try { await h(d); } catch { /* isolato */ } };
			emitter.on(c, safe);
			return () => emitter.off(c, safe);
		},
		listenerCount: (c) => emitter.listenerCount(c),
	};
	const handlers = new Map();
	const published = [];
	bus.on(METRIC_CHANNEL, (f) => published.push(f));
	let server = serverPresent;
	bus.on(PROBE_CHANNEL, (d) => { if (server && d?.v === 1 && d?.type === "probe") bus.emit(PONG_CHANNEL, { v: 1, type: "pong" }); });
	let t = start;
	const pi = { on: (e, h) => handlers.set(e, [...(handlers.get(e) ?? []), h]), events: bus };
	createExtension(pi, { now: () => t });
	return {
		bus, published, advance: (ms) => (t += ms), setServer: (on) => (server = on),
		async dispatch(event, payload = {}, ctx = { sessionManager: { getSessionId: () => "sess-1" }, model: { provider: "p", id: "m", baseUrl: "http://192.168.1.20:8080/v1" } }) {
			for (const h of handlers.get(event) ?? []) await h(payload, ctx);
		},
	};
}

test("extension: hook con contesto incompleto non lanciano eccezioni", async () => {
	const h = makeExtensionHarness();
	await h.dispatch("session_start", {}, {});
	await h.dispatch("before_provider_request", {}, {});
});

test("extension: i listener del pong sono rimossi a fine sessione", async () => {
	const h = makeExtensionHarness();
	for (let i = 0; i < 25; i += 1) {
		await h.dispatch("session_start");
		await h.dispatch("session_shutdown");
	}
	assert.equal(h.bus.listenerCount(PONG_CHANNEL), 0, "listener pong accumulati senza distacco");
});

test("extension: message_end senza richiesta misurata non emette N/D", async () => {
	const h = makeExtensionHarness();
	await h.dispatch("session_start");
	await h.dispatch("agent_start");
	await h.dispatch("before_provider_request");
	h.advance(100);
	await h.dispatch("message_update", { message: { role: "assistant" }, assistantMessageEvent: { type: "text_delta", delta: "x".repeat(40) } });
	h.advance(1000);
	await h.dispatch("message_end", { message: { role: "assistant", usage: { input: 10, output: 50 }, stopReason: "stop" } });
	const dopoIlBuono = h.published.length;
	assert.ok(dopoIlBuono > 0);
	assert.equal(h.published.at(-1).decode, 50);
	// un message_end orfano (nessun before_provider_request nuovo)
	await h.dispatch("message_end", { message: { role: "assistant", usage: null, stopReason: "stop" } });
	assert.equal(h.published.length, dopoIlBuono, "nessun frame spurio dopo una misura valida");
});

test("extension: sessioni senza id non condividono lo stesso tracker", async () => {
	const h = makeExtensionHarness();
	const ctxA = { sessionManager: {}, model: { provider: "p", id: "m", baseUrl: "http://192.168.1.20:8080/v1" } };
	const ctxB = { sessionManager: {}, model: { provider: "p", id: "m", baseUrl: "http://192.168.1.20:8080/v1" } };
	await h.dispatch("session_start", {}, ctxA);
	await h.dispatch("session_start", {}, ctxB);
	await h.dispatch("before_provider_request", {}, ctxA);
	h.advance(100);
	await h.dispatch("message_update", { message: { role: "assistant" }, assistantMessageEvent: { type: "text_delta", delta: "ciao" } }, ctxA);
	h.advance(1000);
	await h.dispatch("message_end", { message: { role: "assistant", usage: { input: 5, output: 20 }, stopReason: "stop" } }, ctxA);
	const sids = new Set(h.published.map((f) => f.sid));
	assert.ok(sids.size >= 1);
	assert.notEqual([...sids][0], "unknown", "la chiave di fallback non deve essere condivisa");
});

// ---------------------------------------------------------------- metrics --

function trackerAt(start = 1000) {
	let t = start;
	const tr = createTracker({ now: () => t, model: () => ({ provider: "p", id: "m", baseUrl: "http://192.168.1.20:8080" }) });
	return { tr, advance: (ms) => (t += ms) };
}

test("metrics: una richiesta con tool call non avvelena la calibrazione", () => {
	const { tr, advance } = trackerAt();
	const prima = tr.tokPerChar;
	tr.requestStart();
	tr.delta("toolcall_delta", 20);
	advance(500);
	tr.requestEnd({ usage: { output: 200 }, stopReason: "stop" });
	assert.equal(tr.tokPerChar, prima, "la calibrazione non deve essere riscritta da una richiesta contaminata");
});

test("metrics: una richiesta interrotta non aggiorna la calibrazione", () => {
	const { tr, advance } = trackerAt();
	const prima = tr.tokPerChar;
	tr.requestStart();
	tr.delta("text_delta", 30);
	advance(500);
	tr.requestEnd({ usage: { output: 900 }, stopReason: "aborted" });
	assert.equal(tr.tokPerChar, prima);
});

test("metrics: il rapporto tok/char resta confinato", () => {
	const { tr, advance } = trackerAt();
	tr.requestStart();
	tr.delta("text_delta", 10);          // pochissimi caratteri
	advance(100);
	tr.requestEnd({ usage: { output: 5000 }, stopReason: "stop" });   // moltissimi token
	assert.ok(tr.tokPerChar <= 2, `tok/char fuori range: ${tr.tokPerChar}`);
	tr.requestStart();
	tr.delta("text_delta", 5000);        // moltissimi caratteri
	advance(1000);
	tr.requestEnd({ usage: { output: 5 }, stopReason: "stop" });
	assert.ok(tr.tokPerChar >= 0.05, `tok/char fuori range: ${tr.tokPerChar}`);
});

test("metrics: la coda inattiva prima di message_end non entra nel decode", () => {
	const { tr, advance } = trackerAt();
	tr.requestStart();
	tr.delta("text_delta", 36);          // t = 1000 (primo delta)
	advance(1000);                       // ultimo delta a +1000 ms
	advance(20_000);                     // stallo, poi message_end
	const f = tr.requestEnd({ usage: { output: 100 }, stopReason: "stop" });
	// finestra reale 1 s + coda ammessa (2 s) => ~33 tok/s, non 100/21 s
	assert.ok(f.decode > 25, `decode non depurato dalla coda: ${f.decode}`);
});

test("metrics: requestEnd senza requestStart non produce un frame", () => {
	const { tr } = trackerAt();
	assert.equal(tr.requestEnd({ usage: { output: 10 }, stopReason: "stop" }), null);
});

test("metrics: il throttle riparte a ogni richiesta", () => {
	const { tr, advance } = trackerAt();
	tr.requestStart();
	tr.delta("text_delta", 40);
	advance(500);
	assert.ok(tr.streamingFrame() !== null, "primo frame della richiesta 1");
	tr.requestEnd({ usage: { output: 20 }, stopReason: "stop" });
	tr.requestStart();                   // richiesta subito dopo, < 1 s
	tr.delta("text_delta", 40);
	advance(300);
	assert.ok(tr.streamingFrame() !== null, "il throttle della richiesta precedente non deve zittire la nuova");
});

test("metrics: il cambio modello azzera la calibrazione appresa", () => {
	let t = 1000;
	let model = { provider: "p", id: "m1", baseUrl: "http://192.168.1.20:8080" };
	const tr = createTracker({ now: () => t, model: () => model });
	tr.requestStart();
	tr.delta("text_delta", 100);
	t += 500;
	tr.requestEnd({ usage: { output: 400 }, stopReason: "stop" });
	assert.equal(tr.calibrated, true);
	model = { provider: "p", id: "m2", baseUrl: "http://192.168.1.20:8080" };
	tr.identity();
	assert.equal(tr.calibrated, false, "la calibrazione del modello precedente deve cadere");
});

// --------------------------------------------------------------- protocol --

test("protocol: hello senza campo last e' comunque valido", () => {
	const parsed = parseHello({ t: "hello" });
	assert.ok(parsed, "hello senza last non va scartato");
	assert.equal(parsed.last ?? null, null);
});

test("protocol: id con caratteri di controllo rifiutati", () => {
	assert.equal(parseSelection({ projectId: "p", workspaceId: "w", sessionId: "a\u0000b" }), undefined);
	assert.equal(parseSelection({ projectId: "p\u001f", workspaceId: "w", sessionId: "s" }), undefined);
	assert.equal(parseSelection({ projectId: "p", workspaceId: "w", sessionId: "ok" }).sessionId, "ok");
});

test("metrics: etichetta locale/remoto dell'endpoint", () => {
	assert.equal(isLocalEndpoint("http://192.168.1.20:8080/v1"), true);
	assert.equal(isLocalEndpoint("192.168.1.20:8080/v1"), true, "host:port senza schema");
	assert.equal(isLocalEndpoint("http://nas:8080"), true, "nome host nudo di LAN");
	assert.equal(isLocalEndpoint("nas:11434"), true);
	assert.equal(isLocalEndpoint("localhost:11434/v1"), true);
	assert.equal(isLocalEndpoint("fc00::1"), true);
	assert.equal(isLocalEndpoint("fe80::1%eth0"), true);
	assert.equal(isLocalEndpoint("http://[fc00::12]:8080/v1"), true, "ULA IPv6");
	assert.equal(isLocalEndpoint("http://[fe80::1]:8080"), true, "link-local IPv6");
	assert.equal(isLocalEndpoint("https://api.openai.com/v1"), false);
	assert.equal(isLocalEndpoint("http://8.8.8.8:1234"), false);
});
