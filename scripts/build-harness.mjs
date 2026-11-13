/**
 * Costruisce l'harness browser: unisce i moduli del lato browser (metrics,
 * protocol, plugin) in un unico script di modulo senza import, da iniettare in
 * una pagina Chromium reale via CDP. Nessuna modifica ai sorgenti: solo
 * rimozione delle righe di import e rinomina dell'unico simbolo duplicato.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SRC = new URL("../src/", import.meta.url).pathname;
const strip = (code) =>
	code
		.split("\n")
		.filter((line) => !/^import .* from "\.\.\/(metrics|protocol)\.js";?$/.test(line))
		.join("\n");

const metrics = readFileSync(join(SRC, "metrics.js"), "utf8");
const protocol = readFileSync(join(SRC, "protocol.js"), "utf8").replaceAll("PROTOCOL_VERSION", "PROTOCOL_VERSION_P");
const browser = strip(readFileSync(join(SRC, "browser/index.js"), "utf8"));

const harness = `
const plugin = createBrowserPlugin().plugin;
const channels = [];
const peer = { openChannel: (op, input, opts) => { const ch = { input, opts, send(){}, close(){}, closed: new Promise(()=>{}) }; channels.push(ch); return Promise.resolve(ch); } };
const act = await plugin.activate({ apiVersion: 5, html: (s, ...v) => ({ t: "tpl" }), svg: (s, ...v) => ({ t: "tpl" }), runtimePluginId: "pi-token-speed" });
const labelCtx = { state: { selectedSession: { id: "demo" } }, session: { id: "demo" }, workspace: { projectId: "p", id: "w" }, peer, host: { requestRender() { window.__rr = (window.__rr || 0) + 1; } } };
act.contributions.sessionLabels[0].items(labelCtx);
const onData = channels[0].opts.onData;
const F = (o) => ({ v: 1, phase: "final", model: "ollama-local/Qwen3.5-9B", local: true, live: null, decode: null, decodeSrc: null, ttft: null, prefill: null, out: null, prompt: null, reason: null, partial: false, calibrated: false, req: 1, turn: 1, ts: Date.now(), ...o });
const label = () => act.contributions.sessionLabels[0].items(labelCtx)[0] ?? null;
onData({ t: "hello", last: null });
const steps = [];
onData(F({ phase: "streaming", live: 19.2, calibrated: false }));
steps.push({ step: "streaming (stima)", ...label() });
onData(F({ phase: "final", decode: 23.1, decodeSrc: "usage", ttft: 0.42, prefill: 812, out: 512, prompt: 1024, calibrated: true }));
steps.push({ step: "finale (token nativi)", ...label() });
onData(F({ phase: "final", decode: null, reason: "backend senza usage" }));
steps.push({ step: "N/D con motivo", ...label() });
const panel = act.contributions.workspacePanels[0];
const panelRendered = panel.render({ ...labelCtx, navigate() {}, prompt: {}, terminal: {}, host: { requestRender() {} } });
window.__RESULT = {
	steps,
	// nessuna superficie flottante sul documento: il badge sopra il composer e' stato tolto
	floatingDom: document.getElementById("pi-token-speed-badge") !== null,
	bodyChildren: document.body.children.length,
	panelTitle: panel.title,
	panelVisible: panel.visible?.({}) ?? true,
	panelRendered: panelRendered !== undefined && panelRendered !== null,
};
document.getElementById("log").textContent = JSON.stringify(window.__RESULT, null, 1);
// lascia a video il valore finale nativo per lo screenshot
onData(F({ phase: "final", decode: 23.1, decodeSrc: "usage", ttft: 0.42, prefill: 812, out: 512, prompt: 1024, calibrated: true }));
`;

writeFileSync(
	join(SRC, "..", "dist-harness.js"),
	`<script type="module">\n${metrics}\n${protocol}\n${browser}\n${harness}\n</script>`,
);
console.log("harness scritto:", readFileSync(join(SRC, "..", "dist-harness.js"), "utf8").length, "byte");
