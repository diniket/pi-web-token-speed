import test from "node:test";
import assert from "node:assert/strict";
import { createTracker, formatRate, describeFrame, isLocalEndpoint, modelKey } from "../src/metrics.js";

function clock(start = 10_000) {
	let t = start;
	return { now: () => t, advance: (ms) => (t += ms) };
}

const LOCAL_MODEL = { provider: "ollama-local", id: "qwen3-32b", baseUrl: "http://192.168.1.20:8080/v1" };

test("decode finale nativo: usage.output / durata decode", () => {
	const c = clock();
	const tr = createTracker({ now: c.now, model: () => LOCAL_MODEL });
	tr.turnStart();
	tr.requestStart(); // t=10000
	for (let i = 0; i < 3; i += 1) {
		c.advance(400); // 10400, 10800, 11200: primo delta a 10400
		tr.delta("text_delta", 100);
	}
	c.advance(200); // fine a 11400: decodeSec = 11400-10400 = 1.0 s
	const frame = tr.requestEnd({ usage: { input: 900, output: 450, cacheRead: 100, cacheWrite: 0 }, stopReason: "stop" });
	assert.equal(frame.phase, "final");
	assert.equal(frame.decodeSrc, "usage");
	assert.equal(frame.ttft, 0.4);
	assert.equal(frame.decode, 450);
	assert.equal(frame.prefill, Math.round(1000 / 0.4));
	assert.equal(frame.out, 450);
	assert.equal(frame.prompt, 1000);
	assert.equal(frame.partial, false);
	assert.equal(formatRate(frame), `${frame.decode.toFixed(1)} tok/s`);
	assert.ok(describeFrame(frame).includes("native tokens"));
});

test("rate live è stima e calibra tok/char sui token nativi", () => {
	const c = clock();
	const tr = createTracker({ now: c.now, model: () => LOCAL_MODEL });
	tr.requestStart();
	c.advance(300);
	tr.delta("text_delta", 36); // ~10 token col default 3.6 char/token
	c.advance(1000);
	tr.delta("text_delta", 36);
	const live = tr.streamingFrame(true);
	assert.equal(live.phase, "streaming");
	assert.ok(live.live > 0);
	assert.equal(tr.calibrated, false);
	assert.ok(formatRate(live).startsWith("≈"));
	// il turno chiude con 20 token nativi per 72 caratteri -> calibrazione 20/72
	tr.requestEnd({ usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0 }, stopReason: "stop" });
	assert.equal(tr.calibrated, true);
	assert.ok(Math.abs(tr.tokPerChar - 20 / 72) < 1e-9);
});

test("backend senza usage: decode N/D col motivo, TTFT presente", () => {
	const c = clock();
	const tr = createTracker({ now: c.now, model: () => LOCAL_MODEL });
	tr.requestStart();
	c.advance(500);
	tr.delta("text_delta", 50);
	c.advance(1000);
	const frame = tr.requestEnd({ usage: null, stopReason: "stop" });
	assert.equal(frame.decode, null);
	assert.equal(frame.decodeSrc, null);
	assert.equal(frame.reason, "backend without usage");
	assert.equal(frame.ttft, 0.5);
	assert.equal(frame.prefill, null); // prompt ignoto -> niente prefill
	assert.equal(formatRate(frame), "N/A");
});

test("usage presente ma output nullo: N/D output nullo", () => {
	const c = clock();
	const tr = createTracker({ now: c.now, model: () => LOCAL_MODEL });
	tr.requestStart();
	c.advance(300);
	tr.delta("text_delta", 10);
	c.advance(500);
	const frame = tr.requestEnd({ usage: { input: 5, output: 0, cacheRead: 0, cacheWrite: 0 }, stopReason: "stop" });
	assert.equal(frame.decode, null);
	assert.equal(frame.reason, "no output");
});

test("interruzione: finale partial=true, usa usage parziale", () => {
	const c = clock();
	const tr = createTracker({ now: c.now, model: () => LOCAL_MODEL });
	tr.requestStart();
	c.advance(200);
	tr.delta("text_delta", 40);
	c.advance(800);
	const frame = tr.requestEnd({ usage: { input: 10, output: 30, cacheRead: 0, cacheWrite: 0 }, stopReason: "aborted" });
	assert.equal(frame.partial, true);
	assert.equal(frame.decodeSrc, "usage");
	assert.equal(frame.decode, Math.round((30 / 0.8) * 10) / 10);
});

test("interruzione senza delta: N/D nessun delta", () => {
	const c = clock();
	const tr = createTracker({ now: c.now, model: () => LOCAL_MODEL });
	tr.requestStart();
	c.advance(300);
	const frame = tr.requestEnd({ usage: { input: 10, output: 0, cacheRead: 0, cacheWrite: 0 }, stopReason: "aborted" });
	assert.equal(frame.decode, null);
	assert.equal(frame.ttft, null);
	assert.equal(frame.reason, "no output");
});

test("nessun TTFT misurabile e senza usage: N/D esplicito", () => {
	const c = clock();
	const tr = createTracker({ now: c.now, model: () => LOCAL_MODEL });
	tr.requestStart();
	const frame = tr.requestEnd({ usage: null, stopReason: "error" });
	assert.equal(frame.decode, null);
	assert.equal(frame.ttft, null);
	assert.ok(frame.reason !== null);
});

test("tool calling: ogni richiesta misurata a sé, tempo tool escluso", () => {
	const c = clock();
	const tr = createTracker({ now: c.now, model: () => LOCAL_MODEL });
	tr.turnStart();
	// richiesta 1: finisce con toolUse
	tr.requestStart();
	c.advance(300);
	tr.delta("toolcall_delta", 60);
	c.advance(700);
	const f1 = tr.requestEnd({ usage: { input: 100, output: 100, cacheRead: 0, cacheWrite: 0 }, stopReason: "toolUse" });
	assert.equal(f1.decode, 142.9); // 100 tok / 0.7 s
	assert.equal(f1.req, 1);
	// il tool gira 30 s: NON deve entrare in nessuna misura
	c.advance(30_000);
	tr.requestStart();
	c.advance(200);
	tr.delta("text_delta", 36);
	c.advance(1600);
	const f2 = tr.requestEnd({ usage: { input: 200, output: 90, cacheRead: 0, cacheWrite: 0 }, stopReason: "stop" });
	assert.equal(f2.req, 2);
	assert.equal(f2.turn, 1);
	assert.equal(f2.decode, Math.round((90 / 1.6) * 10) / 10); // nessuna contaminazione
});

test("cambio modello azzera calibrazione e richiesta in volo", () => {
	const c = clock();
	let model = LOCAL_MODEL;
	const tr = createTracker({ now: c.now, model: () => model });
	tr.requestStart();
	c.advance(300);
	tr.delta("text_delta", 72);
	tr.requestEnd({ usage: { input: 1, output: 18, cacheRead: 0, cacheWrite: 0 }, stopReason: "stop" });
	assert.equal(tr.calibrated, true);
	model = { provider: "openai", id: "gpt-x", baseUrl: "https://api.openai.com/v1" };
	const id = tr.identity();
	assert.equal(id.model, "openai/gpt-x");
	assert.equal(id.local, false);
	assert.equal(tr.calibrated, false);
});

test("throttle streaming: al massimo 1 frame/s", () => {
	const c = clock();
	const tr = createTracker({ now: c.now, model: () => LOCAL_MODEL });
	tr.requestStart();
	let frames = 0;
	for (let ms = 100; ms <= 5000; ms += 50) {
		c.advance(50);
		tr.delta("text_delta", 10);
		if (tr.streamingFrame() !== null) frames += 1;
	}
	assert.ok(frames <= 5, `attesi <=5 frame in 5 s, ottenuti ${frames}`);
	assert.ok(frames >= 3, `attesi >=3 frame in 5 s, ottenuti ${frames}`);
});

test("finestra campioni limitata: nessuna crescita illimitata", () => {
	const c = clock();
	const tr = createTracker({ now: c.now, model: () => LOCAL_MODEL, config: { maxSamples: 16 } });
	tr.requestStart();
	for (let i = 0; i < 500; i += 1) {
		c.advance(20);
		tr.delta("text_delta", 4);
	}
	const f = tr.streamingFrame(true);
	assert.ok(f.live > 0);
});

test("classificazione endpoint", () => {
	assert.equal(isLocalEndpoint("http://127.0.0.1:8080/v1"), true);
	assert.equal(isLocalEndpoint("http://172.16.0.5:8731/v1"), true);
	assert.equal(isLocalEndpoint("http://192.168.1.9:1234"), true);
	assert.equal(isLocalEndpoint("http://nas.local:8080"), true);
	assert.equal(isLocalEndpoint("https://api.openai.com/v1"), false);
	assert.equal(isLocalEndpoint(undefined), false);
	assert.equal(modelKey({ provider: "a", id: "b" }), "a/b");
});

test("delta non numerici o nulli ignorati", () => {
	const c = clock();
	const tr = createTracker({ now: c.now, model: () => LOCAL_MODEL });
	tr.requestStart();
	assert.equal(tr.delta("text_delta", 0), null);
	assert.equal(tr.delta("text_delta", -3), null);
	assert.equal(tr.delta("text_delta", "x"), null);
});
