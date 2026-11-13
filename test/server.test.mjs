import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createServerPlugin } from "../src/server/index.js";
import { METRIC_CHANNEL, PONG_CHANNEL, PROBE_CHANNEL } from "../src/protocol.js";

const SELECTION = { projectId: "p1", workspaceId: "w1", sessionId: "s1" };
const SCOPE = { kind: "workspace", project: { id: "p1" }, workspace: { id: "w1" } };

function fakeBus() {
	const emitter = new EventEmitter();
	return {
		emit: (c, d) => emitter.emit(c, d),
		on: (c, h) => {
			const safe = async (d) => {
				try {
					await h(d);
				} catch {
					/* isolato come il bus reale */
				}
			};
			emitter.on(c, safe);
			return () => emitter.off(c, safe);
		},
	};
}

function makeServer() {
	const handle = createServerPlugin();
	const plugin = handle.plugin;
	const buses = new Map();
	const capability = {
		version: 1,
		connect: async (selection) => {
			if (selection.sessionId !== SELECTION.sessionId) throw new Error("sessione non ospitata qui");
			const bus = fakeBus();
			const ac = new AbortController();
			buses.set(selection.sessionId, { bus, ac });
			return { signal: ac.signal, on: bus.on, emit: bus.emit, close: () => ac.abort() };
		},
	};
	const lifetime = new AbortController();
	let startContext;
	const activation = plugin.activate({
		apiVersion: 5,
		pluginId: "pi-token-speed",
		settings: Object.freeze({}),
		lifetimeSignal: lifetime.signal,
		signal: new AbortController().signal,
		logger: { debug() {}, info() {}, warn() {}, error() {} },
	});
	return {
		handle,
		plugin,
		activation,
		buses,
		lifetime,
		async start() {
			await activation.start({
				capabilities: { resolve: () => capability },
				signal: new AbortController().signal,
			});
		},
		async open(input = SELECTION, scope = SCOPE) {
			const ac = new AbortController();
			const sent = [];
			const channel = await activation.peer.openChannel({
				operation: "metrics",
				input,
				scope,
				signal: ac.signal,
				send: (data) => sent.push(data),
			});
			return { channel, sent, abort: ac };
		},
		bus: () => buses.get(SELECTION.sessionId)?.bus,
	};
}

const FRAME = {
	v: 1,
	sid: "s1",
	phase: "final",
	model: "m/x",
	local: true,
	live: null,
	decode: 12.5,
	decodeSrc: "usage",
	ttft: 0.3,
	prefill: 500,
	out: 100,
	prompt: 200,
	reason: null,
	partial: false,
	calibrated: true,
	req: 1,
	turn: 1,
	ts: Date.now(),
};

test("hello iniziale: null senza cache, frame con cache", async () => {
	const s = makeServer();
	await s.start();
	const first = await s.open();
	assert.deepEqual(first.sent, [{ t: "hello", last: null }]);
	s.bus().emit(METRIC_CHANNEL, FRAME);
	assert.deepEqual(first.sent.at(-1), FRAME);
	// un nuovo canale (reload browser) riceve subito l'ultimo frame
	const second = await s.open();
	assert.equal(second.sent[0].t, "hello");
	assert.deepEqual(second.sent[0].last, FRAME);
});

test("inoltra solo frame conformi, scarta gli altri", async () => {
	const s = makeServer();
	await s.start();
	const { sent } = await s.open();
	s.bus().emit(METRIC_CHANNEL, { junk: true });
	s.bus().emit(METRIC_CHANNEL, { ...FRAME, v: 9 });
	s.bus().emit(METRIC_CHANNEL, { ...FRAME, sid: "altra-sessione" });
	assert.equal(sent.length, 1, "solo hello");
	s.bus().emit(METRIC_CHANNEL, FRAME);
	assert.equal(sent.length, 2);
});

test("probe: pong solo con un canale browser aperto", async () => {
	const s = makeServer();
	await s.start();
	const { abort } = await s.open();
	let pongs = 0;
	s.bus().on(PONG_CHANNEL, () => (pongs += 1));
	s.bus().emit(PROBE_CHANNEL, { v: 1, type: "probe" });
	await new Promise((r) => setImmediate(r));
	assert.equal(pongs, 1, "browser aperto: il server risponde");
	// probe malformato ignorato
	s.bus().emit(PROBE_CHANNEL, { v: 9, type: "probe" });
	await new Promise((r) => setImmediate(r));
	assert.equal(pongs, 1);
	// browser chiuso (abort del segnale del canale): nessun pong, la misura si spegne da sola
	abort.abort();
	s.bus().emit(PROBE_CHANNEL, { v: 1, type: "probe" });
	await new Promise((r) => setImmediate(r));
	assert.equal(pongs, 1, "nessun browser: nessun pong");
});

test("rifiuti: operazione sbagliata, selezione invalida, scope incoerente", async () => {
	const s = makeServer();
	await s.start();
	const peer = s.activation.peer;
	await assert.rejects(
		peer.openChannel({ operation: "altro", input: SELECTION, scope: SCOPE, signal: new AbortController().signal, send() {} }),
		/operazione/,
	);
	await assert.rejects(
		peer.openChannel({ operation: "metrics", input: {}, scope: SCOPE, signal: new AbortController().signal, send() {} }),
		/selezione/,
	);
	await assert.rejects(
		peer.openChannel({
				operation: "metrics",
				input: SELECTION,
				scope: { kind: "workspace", project: { id: "ALTRO" }, workspace: { id: "w1" } },
				signal: new AbortController().signal,
				send() {},
		}),
		/scope/,
	);
	// sessione non ospitata: il connect dell'host fallisce (asincrono)
	await assert.rejects(s.open({ projectId: "p1", workspaceId: "w1", sessionId: "fantasma" }));
});

test("dispose chiude le connessioni e azzera la cache", async () => {
	const s = makeServer();
	await s.start();
	await s.open();
	s.bus().emit(METRIC_CHANNEL, FRAME);
	assert.equal(s.handle.__test.lastFrames.size, 1);
	await s.activation.dispose();
	assert.equal(s.handle.__test.hosted.size, 0);
	assert.equal(s.handle.__test.lastFrames.size, 0);
});

test("cache LRU limitata", async () => {
	const s = makeServer();
	await s.start();
	const { lastFrames } = s.handle.__test;
	for (let i = 0; i < 80; i += 1) lastFrames.set(`s${i}`, FRAME);
	const touch = await s.open();
	for (let i = 0; i < 70; i += 1) s.bus().emit(METRIC_CHANNEL, { ...FRAME, sid: "s1", ts: i });
	await new Promise((r) => setImmediate(r));
	assert.ok(lastFrames.size <= 64, `cache oltre il tetto: ${lastFrames.size}`);
	touch.abort.abort();
});
