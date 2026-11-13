import test from "node:test";
import assert from "node:assert/strict";
import {
	METRIC_CHANNEL,
	PROBE_CHANNEL,
	PONG_CHANNEL,
	PEER_OPERATION,
	parseHello,
	parseMetricFrame,
	parseProbe,
	parseSelection,
} from "../src/protocol.js";

const FRAME = {
	v: 1,
	phase: "final",
	model: "llama/qwen",
	local: true,
	live: null,
	decode: 21.3,
	decodeSrc: "usage",
	ttft: 0.42,
	prefill: 800,
	out: 512,
	prompt: 1024,
	reason: null,
	partial: false,
	calibrated: true,
	req: 1,
	turn: 1,
	ts: 1234,
};

test("frame valido accettato, immutato", () => {
	assert.deepEqual(parseMetricFrame(FRAME), FRAME);
});

test("frame streaming valido", () => {
	assert.ok(parseMetricFrame({ ...FRAME, phase: "streaming", live: 12.0, decode: null, decodeSrc: null }));
});

test("frame idle valido", () => {
	assert.ok(parseMetricFrame({ ...FRAME, phase: "idle" }));
});

test("frame malformati scartati", () => {
	const bad = [
		null,
		undefined,
		"string",
		42,
		{ ...FRAME, v: 2 },
		{ ...FRAME, phase: "weird" },
		{ ...FRAME, model: 5 },
		{ ...FRAME, model: "x".repeat(300) },
		{ ...FRAME, local: "yes" },
		{ ...FRAME, ts: "now" },
		{ ...FRAME, decode: Number.NaN },
		{ ...FRAME, live: "fast" },
		{ ...FRAME, out: -1 },
		{ ...FRAME, decodeSrc: "vibes" },
		{ ...FRAME, reason: 99 },
		{ ...FRAME, calibrated: "sì" },
		{ ...FRAME, partial: 1 },
	];
	for (const value of bad) {
		assert.equal(parseMetricFrame(value), undefined, `avrebbe accettato: ${JSON.stringify(value)}`);
	}
});

test("selezione sessione", () => {
	const ok = { projectId: "p", workspaceId: "w", sessionId: "s" };
	assert.deepEqual(parseSelection(ok), ok);
	assert.equal(parseSelection(null), undefined);
	assert.equal(parseSelection({ ...ok, projectId: "" }), undefined);
	assert.equal(parseSelection({ ...ok, sessionId: 5 }), undefined);
	assert.equal(parseSelection({ ...ok, workspaceId: "x".repeat(600) }), undefined);
});

test("handshake probe/pong", () => {
	assert.ok(parseProbe({ v: 1, type: "probe" }));
	assert.equal(parseProbe({ v: 1, type: "pong" }), undefined);
	assert.ok({ [PONG_CHANNEL]: true } && parseProbe({ v: 2, type: "probe" }) === undefined);
});

test("hello ed error del server", () => {
	assert.ok(parseHello({ t: "hello", last: null }));
	assert.ok(parseHello({ t: "hello", last: FRAME }));
	assert.equal(parseHello({ t: "hello", last: { junk: true } }), undefined);
	assert.ok(parseHello({ t: "error", message: "plugin server non attivo" }));
	assert.equal(parseHello({ t: "error", message: 42 }), undefined);
	assert.equal(parseHello({ t: "altro" }), undefined);
});

test("nomi canale stabili", () => {
	assert.equal(METRIC_CHANNEL, "pi-token-speed:metric");
	assert.equal(PROBE_CHANNEL, "pi-token-speed:probe");
	assert.equal(PONG_CHANNEL, "pi-token-speed:pong");
	assert.equal(PEER_OPERATION, "metrics");
});
