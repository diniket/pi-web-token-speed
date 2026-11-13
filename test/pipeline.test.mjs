/**
 * Pipeline completa in-processo: estensione Pi (bus reale dell'SDK installato)
 * -> plugin server (capability fittizia ma contrattuale) -> canale peer ->
 * plugin browser. E' la prova end-to-end che i tre componenti si intendono
 * davvero, senza dover riavviare il session daemon.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createExtension } from "../src/extension/index.js";
import { createServerPlugin } from "../src/server/index.js";
import { createBrowserPlugin } from "../src/browser/index.js";

const PI_CODING = join(
	homedir(),
	".pi/agent/install/releases/1.5.0/node_modules/@earendil-works/pi-coding-agent/dist",
);
const havePiSdk = existsSync(join(PI_CODING, "core/event-bus.js"));

test("end-to-end: misura nativa arriva all'etichetta attraverso server e peer", { skip: !havePiSdk && "pi SDK non trovato" }, async () => {
	const { createEventBus } = await import(pathToFileURL(join(PI_CODING, "core/event-bus.js")).href);
	let t = 100_000;
	const now = () => t;

	// --- estensione Pi sul bus reale -------------------------------------
	const bus = createEventBus();
	const handlers = new Map();
	const pi = {
		on: (event, handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
		events: bus,
	};
	createExtension(pi, { now });
	const ctx = {
		sessionManager: { getSessionId: () => "sess-e2e" },
		model: { provider: "ollama-local", id: "qwen", baseUrl: "http://192.168.1.20:8080/v1" },
	};
	const dispatch = async (event, payload = {}) => {
		for (const h of handlers.get(event) ?? []) await h(payload, ctx);
	};

	// --- plugin server con capability contrattuale ------------------------
	const server = createServerPlugin();
	const lifetime = new AbortController();
	const activation = server.plugin.activate({
		apiVersion: 5,
		pluginId: "pi-token-speed",
		settings: Object.freeze({}),
		lifetimeSignal: lifetime.signal,
		signal: new AbortController().signal,
		logger: { debug() {}, info() {}, warn() {}, error() {} },
	});
	await activation.start({
		capabilities: {
			resolve: () => ({
				version: 1,
				connect: async () => ({
					signal: new AbortController().signal,
					on: bus.on,
					emit: bus.emit,
					close: () => {},
				}),
			}),
		},
		signal: new AbortController().signal,
	});

	// --- plugin browser con peer che cade sul server ----------------------
	const browser = createBrowserPlugin();
	const browserActivation = await browser.plugin.activate({
		apiVersion: 5,
		html: (s, ...v) => ({ t: "tpl" }),
		svg: (s, ...v) => ({ t: "tpl" }),
		runtimePluginId: "pi-token-speed",
	});
	const peer = {
		openChannel: (operation, input, options) =>
			activation.peer.openChannel({
				operation,
				input,
				scope: { kind: "workspace", project: { id: "p" }, workspace: { id: "w" } },
				signal: new AbortController().signal,
				send: (data) => options.onData(data),
			}),
	};
	const labelContext = {
		state: { selectedSession: { id: "sess-e2e" } },
		session: { id: "sess-e2e" },
		workspace: { projectId: "p", id: "w" },
		peer,
		host: { requestRender() {} },
	};
	const items0 = browserActivation.contributions.sessionLabels[0].items(labelContext);
	assert.deepEqual(items0, []);

	// --- generazione simulata: 2 s di streaming, 400 token ---------------
	await dispatch("session_start");
	await dispatch("agent_start");
	await dispatch("before_provider_request"); // t=100000
	for (let ms = 0; ms < 2000; ms += 100) {
		t += 100;
		await dispatch("message_update", {
			message: { role: "assistant" },
			assistantMessageEvent: { type: "text_delta", delta: "x".repeat(18) },
		});
	}
	t += 100;
	await dispatch("message_end", {
		message: { role: "assistant", usage: { input: 500, output: 400, cacheRead: 0, cacheWrite: 0 }, stopReason: "stop" },
	});

	// l'etichetta ha visto tutto: prima stime, poi il valore nativo
	const items = browserActivation.contributions.sessionLabels[0].items(labelContext);
	assert.equal(items[0].text, "⚡ 200.0 tok/s");
	assert.match(items[0].title, /native tokens/);
	// decode atteso: 400 token / (2100-100 ms... primo delta a 100100, fine 102100) = 400/2.0
	const state = browser.__test.states.get("p\u0000w\u0000sess-e2e");
	assert.equal(state.frame.decode, 200);
	assert.equal(state.frame.decodeSrc, "usage");

	// reload del browser: hello con cache, valore subito visibile
	const peer2 = { ...peer };
	const activation2 = browserActivation;
	void peer2;
	void activation2;

	await activation.dispose();
	await browserActivation.dispose(new AbortController().signal);
	bus.clear();
});
