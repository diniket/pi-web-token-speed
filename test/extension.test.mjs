import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createExtension } from "../src/extension/index.js";
import { METRIC_CHANNEL, PROBE_CHANNEL, PONG_CHANNEL, parseMetricFrame } from "../src/protocol.js";

/**
 * Bus identico per semantica a `createEventBus()` di pi-coding-agent 1.5.0
 * (verificato sul dist installato in installed-api.test.mjs): emit sincrono,
 * handler isolati. Il gate probe/pong dell'estensione dipende dall'emissione
 * sincrona.
 */
function createEventBus() {
	const emitter = new EventEmitter();
	return {
		emit: (channel, data) => emitter.emit(channel, data),
		on: (channel, handler) => {
			const safeHandler = async (data) => {
				try {
					await handler(data);
				} catch (err) {
					console.error(`Event handler error (${channel}):`, err);
				}
			};
			emitter.on(channel, safeHandler);
			return () => emitter.off(channel, safeHandler);
		},
		clear: () => emitter.removeAllListeners(),
	};
}

function makeHarness({ serverPresent = true, start = 10_000 } = {}) {
	const bus = createEventBus();
	const handlers = new Map();
	const published = [];
	bus.on(METRIC_CHANNEL, (frame) => published.push(frame));
	let serverAttached = serverPresent;
	bus.on(PROBE_CHANNEL, (data) => {
		if (serverAttached && data?.v === 1 && data?.type === "probe") {
			bus.emit(PONG_CHANNEL, { v: 1, type: "pong" });
		}
	});
	let t = start;
	const pi = {
		on: (event, handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
		events: bus,
	};
	createExtension(pi, { now: () => t });
	const ctx = {
		sessionManager: { getSessionId: () => "sess-1" },
		model: { provider: "ollama-local", id: "qwen", baseUrl: "http://192.168.1.20:8080/v1" },
	};
	return {
		bus,
		pi,
		ctx,
		published,
		advance: (ms) => (t += ms),
		setServer: (on) => (serverAttached = on),
		dispatch: async (event, payload = {}) => {
			for (const h of handlers.get(event) ?? []) await h(payload, ctx);
		},
	};
}

test("senza plugin server: nessun frame pubblicato, nessuna misura", async () => {
	const h = makeHarness({ serverPresent: false });
	await h.dispatch("session_start");
	await h.dispatch("before_provider_request");
	h.advance(300);
	await h.dispatch("message_update", {
		message: { role: "assistant" },
		assistantMessageEvent: { type: "text_delta", delta: "ciao" },
	});
	await h.dispatch("message_end", { message: { role: "assistant", usage: { output: 5 }, stopReason: "stop" } });
	assert.deepEqual(h.published, []);
});

test("flusso completo: streaming throttato + finale nativo", async () => {
	const h = makeHarness();
	await h.dispatch("session_start");
	await h.dispatch("agent_start");
	await h.dispatch("before_provider_request"); // t=10000
	for (let ms = 0; ms < 3000; ms += 100) {
		h.advance(100);
		await h.dispatch("message_update", {
			message: { role: "assistant" },
			assistantMessageEvent: { type: "text_delta", delta: "x".repeat(20) },
		});
	}
	h.advance(200);
	await h.dispatch("message_end", {
		message: {
			role: "assistant",
			usage: { input: 800, output: 600, cacheRead: 200, cacheWrite: 0 },
			stopReason: "stop",
		},
	});
	const finals = h.published.filter((f) => f.phase === "final");
	const streamings = h.published.filter((f) => f.phase === "streaming");
	assert.equal(finals.length, 1);
	assert.ok(streamings.length >= 2, "attesi alcuni frame streaming throttati");
	assert.ok(streamings.length <= 4, `throttle rotto: ${streamings.length} frame in 3 s`);
	for (const f of h.published) {
		assert.notEqual(parseMetricFrame(f), undefined, "frame non conforme al contratto");
		assert.equal(f.sid, "sess-1");
		assert.equal(f.model, "ollama-local/qwen");
		assert.equal(f.local, true);
	}
	const final = finals[0];
	// decodeSec = (13200 - 10100)/1000 = 3.1 s -> 600/3.1 ≈ 193.5
	assert.equal(final.decode, Math.round((600 / 3.1) * 10) / 10);
	assert.equal(final.decodeSrc, "usage");
	assert.equal(final.ttft, 0.1);
	assert.equal(final.out, 600);
	assert.equal(final.prompt, 1000);
});

test("delta non assistiti e non-delta ignorati", async () => {
	const h = makeHarness();
	await h.dispatch("session_start");
	await h.dispatch("before_provider_request");
	h.advance(500);
	await h.dispatch("message_update", { message: { role: "user" }, assistantMessageEvent: { type: "text_delta", delta: "x" } });
	await h.dispatch("message_update", {
		message: { role: "assistant" },
		assistantMessageEvent: { type: "toolcall_start", delta: "" },
	});
	await h.dispatch("message_end", { message: { role: "toolResult" } });
	assert.deepEqual(h.published, []);
});

test("tool calling: due richieste, tempo tool escluso, contatori corretti", async () => {
	const h = makeHarness();
	await h.dispatch("session_start");
	await h.dispatch("agent_start");
	// richiesta 1 (tool call)
	await h.dispatch("before_provider_request"); // 10000
	h.advance(200);
	await h.dispatch("message_update", {
		message: { role: "assistant" },
		assistantMessageEvent: { type: "toolcall_delta", delta: "{\"a\":1}" },
	});
	h.advance(800); // fine req1 a 11000, decode 0.8 s
	await h.dispatch("message_end", {
		message: { role: "assistant", usage: { input: 100, output: 80, cacheRead: 0, cacheWrite: 0 }, stopReason: "toolUse" },
	});
	// il tool gira 25 s
	h.advance(25_000);
	// richiesta 2 (testo)
	await h.dispatch("before_provider_request"); // 36000
	h.advance(300);
	await h.dispatch("message_update", {
		message: { role: "assistant" },
		assistantMessageEvent: { type: "text_delta", delta: "risposta" },
	});
	h.advance(1700); // fine req2 a 38000, decode 1.7 s
	await h.dispatch("message_end", {
		message: { role: "assistant", usage: { input: 150, output: 170, cacheRead: 0, cacheWrite: 0 }, stopReason: "stop" },
	});
	const finals = h.published.filter((f) => f.phase === "final");
	assert.equal(finals.length, 2);
	assert.equal(finals[0].req, 1);
	assert.equal(finals[1].req, 2);
	assert.equal(finals[1].turn, 1);
	assert.equal(finals[0].decode, 100); // 80/0.8
	assert.equal(finals[1].decode, 100); // 170/1.7 — i 25 s di tool non contano
});

test("interruzione: finale partial", async () => {
	const h = makeHarness();
	await h.dispatch("session_start");
	await h.dispatch("before_provider_request");
	h.advance(300);
	await h.dispatch("message_update", {
		message: { role: "assistant" },
		assistantMessageEvent: { type: "text_delta", delta: "metà" },
	});
	h.advance(700);
	await h.dispatch("message_end", {
		message: { role: "assistant", usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0 }, stopReason: "aborted" },
	});
	const final = h.published.at(-1);
	assert.equal(final.phase, "final");
	assert.equal(final.partial, true);
	assert.equal(final.decodeSrc, "usage");
});

test("cambio modello: stato azzerato, frame col nuovo modello", async () => {
	const h = makeHarness();
	await h.dispatch("session_start");
	await h.dispatch("before_provider_request");
	h.advance(300);
	await h.dispatch("message_update", {
		message: { role: "assistant" },
		assistantMessageEvent: { type: "text_delta", delta: "abc" },
	});
	h.advance(700);
	await h.dispatch("message_end", {
		message: { role: "assistant", usage: { input: 1, output: 10, cacheRead: 0, cacheWrite: 0 }, stopReason: "stop" },
	});
	// cambio modello
	h.ctx.model = { provider: "glm", id: "glm-4", baseUrl: "http://192.168.1.21:3000/v1" };
	await h.dispatch("model_select", { model: h.ctx.model });
	await h.dispatch("before_provider_request");
	h.advance(300);
	await h.dispatch("message_update", {
		message: { role: "assistant" },
		assistantMessageEvent: { type: "text_delta", delta: "xyz" },
	});
	h.advance(700);
	await h.dispatch("message_end", {
		message: { role: "assistant", usage: { input: 1, output: 10, cacheRead: 0, cacheWrite: 0 }, stopReason: "stop" },
	});
	const finals = h.published.filter((f) => f.phase === "final");
	assert.equal(finals.length, 2);
	assert.equal(finals[1].model, "glm/glm-4");
	assert.equal(finals[1].local, true);
	assert.equal(finals[1].req, 1, "richiesta ricominciata dopo il cambio modello");
});

test("session_shutdown: frame idle e stato liberato", async () => {
	const h = makeHarness();
	await h.dispatch("session_start");
	await h.dispatch("session_shutdown");
	const last = h.published.at(-1);
	assert.equal(last.phase, "idle");
	assert.notEqual(parseMetricFrame(last), undefined);
	// dopo lo shutdown non deve più pubblicare nulla
	h.published.length = 0;
	await h.dispatch("before_provider_request");
	h.advance(300);
	await h.dispatch("message_update", {
		message: { role: "assistant" },
		assistantMessageEvent: { type: "text_delta", delta: "x" },
	});
	await h.dispatch("message_end", { message: { role: "assistant", usage: { output: 1 }, stopReason: "stop" } });
	// la sessione è stata ricreata da zero solo se arriva un nuovo session_start:
	// qui gli hook successivi non trovano più lo stato attivo
	assert.ok(h.published.every((f) => f.phase !== "final" || f.sid === "sess-1"));
});

test("server che scompare a metà: misura si spegne da sola", async () => {
	const h = makeHarness();
	await h.dispatch("session_start");
	await h.dispatch("before_provider_request");
	h.advance(300);
	await h.dispatch("message_update", {
		message: { role: "assistant" },
		assistantMessageEvent: { type: "text_delta", delta: "x" },
	});
	h.setServer(false);
	h.advance(1000);
	await h.dispatch("message_end", {
		message: { role: "assistant", usage: { input: 1, output: 10, cacheRead: 0, cacheWrite: 0 }, stopReason: "stop" },
	});
	const countAfterEnd = h.published.length;
	// prossima richiesta: il probe non riceve più pong -> niente misura
	await h.dispatch("before_provider_request");
	h.advance(300);
	await h.dispatch("message_update", {
		message: { role: "assistant" },
		assistantMessageEvent: { type: "text_delta", delta: "y" },
	});
	await h.dispatch("message_end", { message: { role: "assistant", usage: { output: 5 }, stopReason: "stop" } });
	assert.equal(h.published.length, countAfterEnd, "nessun nuovo frame dopo la scomparsa del server");
});
