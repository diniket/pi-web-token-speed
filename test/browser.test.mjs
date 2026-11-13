import test from "node:test";
import assert from "node:assert/strict";
import { createBrowserPlugin } from "../src/browser/index.js";

function makePlugin(overrides = {}) {
	let timerAt = null;
	let timerFn = null;
	const plugin = createBrowserPlugin({
		keepLastMs: 5000,
		setTimeout: (fn, ms) => {
			timerFn = fn;
			timerAt = ms;
			return { id: 1 };
		},
		clearTimeout: () => {
			timerFn = null;
			timerAt = null;
		},
	});
	const activations = [];
	const context = {
		apiVersion: 5,
		html: (strings, ...values) => ({ strings, values }),
		svg: (strings, ...values) => ({ strings, values }),
		runtimePluginId: "pi-token-speed",
		signal: new AbortController().signal,
		lifetimeSignal: new AbortController().signal,
	};
	const channels = [];
	const peer = overrides.peer ?? {
		openChannel: (operation, input, options) => {
			const channel = { operation, input, options, closed: new Promise(() => {}) };
			channels.push(channel);
			return Promise.resolve(channel);
		},
	};
	return {
		plugin,
		context,
		peer,
		channels,
		runKeepTimer: () => timerFn?.(),
		keepDelay: () => timerAt,
		async activate() {
			const result = await plugin.plugin.activate(context);
			activations.push(result);
			return result;
		},
		labelContext: (sessionId = "s1") => ({
			state: { selectedSession: { id: sessionId } },
			session: { id: sessionId },
			workspace: { projectId: "p1", id: "w1" },
			peer,
			host: { requestRender() {} },
		}),
	};
}

const STREAM_FRAME = {
	v: 1, phase: "streaming", model: "m/x", local: true, live: 12.0, decode: null, decodeSrc: null,
	ttft: null, prefill: null, out: null, prompt: null, reason: null, partial: false, calibrated: true,
	req: 1, turn: 1, ts: 1,
};
const FINAL_FRAME = {
	v: 1, phase: "final", model: "m/x", local: true, live: null, decode: 21.3, decodeSrc: "usage",
	ttft: 0.42, prefill: 800, out: 512, prompt: 1024, reason: null, partial: false, calibrated: true,
	req: 1, turn: 1, ts: Date.now(),
};
const ND_FRAME = {
	v: 1, phase: "final", model: "m/x", local: true, live: null, decode: null, decodeSrc: null,
	ttft: null, prefill: null, out: null, prompt: null, reason: "backend without usage", partial: false,
	calibrated: false, req: 1, turn: 1, ts: 3,
};

test("bootstrap: canale aperto sulla sessione selezionata, hello gestito", async () => {
	const h = makePlugin();
	const { contributions } = await h.activate();
	const items = contributions.sessionLabels[0].items(h.labelContext());
	assert.deepEqual(items, []);
	assert.equal(h.channels.length, 1);
	assert.deepEqual(h.channels[0].input, { projectId: "p1", workspaceId: "w1", sessionId: "s1" });
	h.channels[0].options.onData({ t: "hello", last: null });
	assert.equal(contributions.sessionLabels[0].items(h.labelContext()).length, 0);
});

test("streaming e finale: etichetta live, `≈` solo per la stima", async () => {
	const h = makePlugin();
	const { contributions } = await h.activate();
	contributions.sessionLabels[0].items(h.labelContext());
	const onData = h.channels[0].options.onData;
	onData({ t: "hello", last: null });
	onData(STREAM_FRAME);
	let items = contributions.sessionLabels[0].items(h.labelContext());
	assert.equal(items[0].text, "⚡ ≈ 12.0 tok/s");
	assert.match(items[0].title, /live estimate/);
	onData(FINAL_FRAME);
	items = contributions.sessionLabels[0].items(h.labelContext());
	assert.equal(items[0].text, "⚡ 21.3 tok/s");
	assert.ok(items[0].title.includes("native tokens"));
});

test("finale N/D col motivo, niente numeri inventati", async () => {
	const h = makePlugin();
	const { contributions } = await h.activate();
	contributions.sessionLabels[0].items(h.labelContext());
	const onData = h.channels[0].options.onData;
	onData({ t: "hello", last: null });
	onData(ND_FRAME);
	const items = contributions.sessionLabels[0].items(h.labelContext());
	assert.equal(items[0].text, "⚡ N/A");
	assert.ok(items[0].title.includes("backend without usage"));
});

test("hello con frame in cache: valore subito visibile (reload browser)", async () => {
	const h = makePlugin();
	const { contributions } = await h.activate();
	contributions.sessionLabels[0].items(h.labelContext());
	h.channels[0].options.onData({ t: "hello", last: FINAL_FRAME });
	const items = contributions.sessionLabels[0].items(h.labelContext());
	assert.equal(items[0].text, "⚡ 21.3 tok/s");
});

test("dopo keepLastMs il valore finale si nasconde", async () => {
	const h = makePlugin();
	const { contributions } = await h.activate();
	contributions.sessionLabels[0].items(h.labelContext());
	const onData = h.channels[0].options.onData;
	onData({ t: "hello", last: null });
	onData(FINAL_FRAME);
	assert.equal(h.keepDelay(), 5000);
	h.runKeepTimer();
	assert.deepEqual(contributions.sessionLabels[0].items(h.labelContext()), []);
});

test("frame malformati ignorati", async () => {
	const h = makePlugin();
	const { contributions } = await h.activate();
	contributions.sessionLabels[0].items(h.labelContext());
	const onData = h.channels[0].options.onData;
	onData({ junk: true });
	onData({ ...FINAL_FRAME, v: 99 });
	assert.deepEqual(contributions.sessionLabels[0].items(h.labelContext()), []);
});

test("canale che fallisce: stato esplicito nel pannello, niente crash", async () => {
	const h = makePlugin({
		peer: {
			openChannel: () => Promise.reject(new Error("plugin server non attivo (riavviare il session daemon?)")),
		},
	});
	const { contributions } = await h.activate();
	const ctx = h.labelContext();
	contributions.sessionLabels[0].items(ctx);
	await new Promise((r) => setImmediate(r));
	const panel = contributions.workspacePanels[0];
	const rendered = panel.render({ ...ctx, navigate() {}, prompt: {}, terminal: {}, host: { requestRender() {} } });
	const text = JSON.stringify(rendered);
	assert.ok(text.includes("non disponibile") || text.includes("riavviare"), "il pannello deve dichiarare il problema");
});

test("cambio sessione: canale ed etichetta seguono la selezione", async () => {
	const h = makePlugin();
	const { contributions } = await h.activate();
	contributions.sessionLabels[0].items(h.labelContext("s1"));
	h.channels[0].options.onData({ t: "hello", last: null });
	h.channels[0].options.onData(STREAM_FRAME);
	assert.equal(contributions.sessionLabels[0].items(h.labelContext("s1"))[0].text, "⚡ ≈ 12.0 tok/s");
	// si passa a s2: il canale di s1 viene chiuso, s2 non ha misure proprie
	contributions.sessionLabels[0].items(h.labelContext("s2"));
	assert.equal(h.channels.length, 2);
	assert.deepEqual(contributions.sessionLabels[0].items(h.labelContext("s2")), []);
	// la riga di s1 non e' piu' selezionata: nessuna etichetta
	const s1ConS2Selezionata = { ...h.labelContext("s1"), state: { selectedSession: { id: "s2" } } };
	assert.deepEqual(contributions.sessionLabels[0].items(s1ConS2Selezionata), []);
});

test("nessun DOM flottante: il plugin non crea elementi sul documento", async () => {
	const toccati = [];
	const stub = {
		body: { append: () => toccati.push("body") },
		head: { append: () => toccati.push("head") },
		createElement: () => {
			toccati.push("element");
			return { style: {}, setAttribute() {}, remove() {} };
		},
	};
	const previous = globalThis.document;
	globalThis.document = stub;
	try {
		const h = makePlugin();
		const { contributions } = await h.activate();
		const ctx = h.labelContext();
		contributions.sessionLabels[0].items(ctx);
		h.channels[0].options.onData({ t: "hello", last: FINAL_FRAME });
		contributions.sessionLabels[0].items(ctx);
		contributions.workspacePanels[0].render({ ...ctx, navigate() {}, prompt: {}, terminal: {}, host: { requestRender() {} } });
		assert.deepEqual(toccati, [], "il badge flottante sopra il composer e' stato tolto");
		assert.equal(h.plugin.__test.badge, undefined, "la superficie del plugin non espone piu' il badge");
	} finally {
		if (previous === undefined) delete globalThis.document;
		else globalThis.document = previous;
	}
});

test("pannello: griglia dei valori e storia", async () => {
	const h = makePlugin();
	const { contributions } = await h.activate();
	const panelContext = {
		...h.labelContext(),
		navigate() {},
		prompt: {},
		terminal: {},
		host: { requestRender() {} },
	};
	const panel = contributions.workspacePanels[0];
	panel.render(panelContext); // apre il canale
	h.channels[0].options.onData({ t: "hello", last: null });
	h.channels[0].options.onData(FINAL_FRAME);
	const rendered = JSON.stringify(panel.render(panelContext));
	assert.ok(rendered.includes("21.3"));
	assert.ok(rendered.includes("native tokens"));
	assert.ok(rendered.includes("0.42 s"), "il pannello deve mostrare il TTFT misurato");
	assert.ok(rendered.includes("locally measured interval"), "il valore finale deve dichiarare l'intervallo locale");
	// la storia dei turni è popolata
	const state = h.plugin.__test.states.get("p1\u0000w1\u0000s1");
	assert.equal(state.history.length, 1);
});

test("dispose: canali chiusi e stati azzerati", async () => {
	const h = makePlugin();
	const { contributions, dispose } = await (async () => {
		const r = await h.activate();
		return { contributions: r.contributions, dispose: r.dispose };
	})();
	contributions.sessionLabels[0].items(h.labelContext());
	h.channels[0].options.onData({ t: "hello", last: FINAL_FRAME });
	await dispose(new AbortController().signal);
	assert.equal(h.plugin.__test.states.size, 0);
});

test("corners: nessuna sessione selezionata", async () => {
	const h = makePlugin();
	const { contributions } = await h.activate();
	const items = contributions.sessionLabels[0].items({ state: {}, session: { id: "s1" }, workspace: { projectId: "p1", id: "w1" }, peer: h.peer });
	assert.deepEqual(items, []);
});
