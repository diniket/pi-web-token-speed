/**
 * Genera docs/screenshot.png: una pagina che simula il layout di Pi Web
 * (lista sessioni + colonna laterale) con le superfici reali del plugin,
 * alimentata da frame sintetici. Nessun dato reale: nessun transcript,
 * nessun nome di macchina, nessun endpoint.
 *
 * Serve un Chromium con CDP aperto:
 *   PTS_CDP_URL=http://127.0.0.1:9223 npm run screenshot
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const CDP = process.env.PTS_CDP_URL;
if (!CDP) {
	console.error("Imposta PTS_CDP_URL (es. http://127.0.0.1:9223) su un Chromium con CDP.");
	process.exit(1);
}
const OUT = process.env.PTS_OUT || new URL("../docs/screenshot.png", import.meta.url).pathname;
const VIEWPORT = { width: 1180, height: 720, scale: 2 };

/* ---------------------------------------------------------------- pagina */

const SRC = new URL("../src/", import.meta.url).pathname;
const strip = (code) => code.split("\n").filter((l) => !/^import .* from "\.\.\/(metrics|protocol)\.js";?$/.test(l)).join("\n");
const modules = [
	readFileSync(join(SRC, "metrics.js"), "utf8"),
	readFileSync(join(SRC, "protocol.js"), "utf8").replaceAll("PROTOCOL_VERSION", "PROTOCOL_VERSION_P"),
	strip(readFileSync(join(SRC, "browser/index.js"), "utf8")),
]
	.map((c) => c.replace(/^export default /gm, "const __DEFAULT = ").replace(/^export /gm, ""))
	.join("\n");

const app = `
// html() minimo: basta a quello che usa il plugin (testi, nodi, array, null)
function html(strings, ...values) {
	const holes = [];
	let src = "";
	strings.forEach((s, i) => {
		src += s;
		if (i === values.length) return;
		const v = values[i];
		if (v === null || v === undefined || v === false || v === "") return;
		if (v instanceof Node) { src += "<!--h" + holes.length + "-->"; holes.push([v]); }
		else if (Array.isArray(v)) { src += "<!--h" + holes.length + "-->"; holes.push(v.flat(Infinity).filter((n) => n instanceof Node)); }
		else src += String(v).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
	});
	const tpl = document.createElement("template");
	tpl.innerHTML = src.trim();
	const hits = [];
	const walker = document.createTreeWalker(tpl.content, NodeFilter.SHOW_COMMENT);
	for (let n = walker.nextNode(); n; n = walker.nextNode()) {
		const m = /^h(\\d+)$/.exec(n.nodeValue.trim());
		if (m) hits.push([n, holes[Number(m[1])]]);
	}
	for (const [node, nodes] of hits) {
		const frag = document.createDocumentFragment();
		for (const n of nodes) frag.appendChild(n);
		node.replaceWith(frag);
	}
	return tpl.content;
}

const F = (o) => ({
	v: 1, phase: "final", model: "local/qwen3-9b", local: true, live: null, decode: null,
	decodeSrc: null, ttft: null, prefill: null, out: null, prompt: null, reason: null,
	partial: false, calibrated: false, req: 1, turn: 1, ts: Date.now(), ...o,
});

const activation = await createBrowserPlugin().plugin.activate({
	apiVersion: 5, html, svg: html, runtimePluginId: "pi-token-speed",
});
let onData;
const peer = { openChannel: (op, input, opts) => { onData = opts.onData; return Promise.resolve({ close() {} }); } };
const ctx = {
	state: { selectedSession: { id: "s2" } }, session: { id: "s2" },
	workspace: { projectId: "p", id: "w" }, peer, host: { requestRender() {} },
};

activation.contributions.sessionLabels[0].items(ctx); // apre il canale peer
onData({ t: "hello", last: null });
for (const [i, d] of [18.9, 24.6, 31.2].entries()) {
	onData(F({ decode: d, decodeSrc: "usage", ttft: 0.5 + i / 10, prefill: 1400 + i * 120, out: 380 + i * 40, prompt: 1900, req: 1, turn: i + 1 }));
}
onData(F({ phase: "streaming", live: 25.8 }));
onData(F({ decode: 27.4, decodeSrc: "usage", ttft: 0.42, prefill: 1830, out: 512, prompt: 2140, req: 2, turn: 4 }));

const label = activation.contributions.sessionLabels[0].items(ctx)[0];
document.getElementById("label").textContent = label ? label.text : "";
document.getElementById("label").title = label ? label.title : "";
document.getElementById("panel-body").appendChild(
	activation.contributions.workspacePanels[0].render(ctx),
);
`;

const page = `<!doctype html><html><head><meta charset="utf-8"><style>
:root { color-scheme: dark; }
* { box-sizing: border-box; }
body { margin:0; background:#15171b; color:#e6e6e6; font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; }
.wrap { display:flex; gap:16px; padding:16px; height:100vh; }
.card { background:#1d2025; border:1px solid #2a2e35; border-radius:10px; padding:14px 16px; }
.col { display:flex; flex-direction:column; gap:10px; }
.list { width:430px; }
.panel { flex:1; }
h3 { margin:0 0 10px; font-size:13px; letter-spacing:.06em; text-transform:uppercase; opacity:.6; }
.row { display:flex; align-items:baseline; justify-content:space-between; gap:12px; padding:9px 10px; border-radius:8px; }
.row.sel { background:#262b33; }
.row .t { font-weight:600; }
.row .m { font-size:12px; opacity:.55; }
.label { font-variant-numeric:tabular-nums; font-size:13px; color:#79c0ff; white-space:nowrap; }
.phead { display:flex; align-items:center; gap:8px; font-weight:600; margin-bottom:8px; }
.phead svg { width:16px; height:16px; color:#e3b341; }
.hint { opacity:.7; font-size:13px; }
footer { position:fixed; left:16px; bottom:10px; font-size:12px; opacity:.4; }
</style><script>window.__ERRORS=[];addEventListener("error",(e)=>__ERRORS.push(e.message+" @"+(e.filename||"")+":"+e.lineno));addEventListener("unhandledrejection",(e)=>__ERRORS.push("promise: "+(e.reason?.stack||e.reason)));</script></head><body>
<div class="wrap">
  <div class="card col list">
    <h3>Sessions</h3>
    <div class="row"><div><div class="t">Fix flaky tests</div><div class="m">2 hours ago</div></div></div>
    <div class="row sel"><div><div class="t">Refactor auth module</div><div class="m">running now</div></div><span class="label" id="label"></span></div>
    <div class="row"><div><div class="t">Update docs</div><div class="m">yesterday</div></div></div>
  </div>
  <div class="card col panel">
    <div class="phead"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2 3 14h7l-1 8 10-12h-7l1-8z"/></svg>Token Speed</div>
    <div id="panel-body"></div>
  </div>
</div>
<footer>Simulated layout — sample data</footer>
<script type="module">
${modules}
${app}
</script></body></html>`;

/* ------------------------------------------------------------------ CDP */

const version = await (await fetch(`${CDP}/json/version`)).json();
const ws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let id = 0;
const pending = new Map();
ws.onmessage = (e) => {
	const msg = JSON.parse(e.data);
	const p = pending.get(msg.id);
	if (p) { pending.delete(msg.id); msg.error ? p.rej(new Error(msg.error.message)) : p.res(msg.result); }
};
const send = (method, params = {}) =>
	new Promise((res, rej) => { pending.set(++id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });

const { targetId } = await send("Target.createTarget", { url: "about:blank" });
const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
const call = (method, params = {}) =>
	new Promise((res, rej) => { pending.set(++id, { res, rej }); ws.send(JSON.stringify({ id, method, params, sessionId })); });

await call("Page.enable");
await call("Emulation.setDeviceMetricsOverride", { width: VIEWPORT.width, height: VIEWPORT.height, deviceScaleFactor: VIEWPORT.scale, mobile: false });
await call("Runtime.evaluate", { expression: `document.open();document.write(${JSON.stringify(page)});document.close();` });
await new Promise((r) => setTimeout(r, 700));

const shot = await call("Page.captureScreenshot", { format: "png" });
writeFileSync(OUT, Buffer.from(shot.data, "base64"));
const text = await call("Runtime.evaluate", { expression: "document.getElementById('label').textContent" });
const errs = await call("Runtime.evaluate", { expression: "JSON.stringify(window.__ERRORS||[])", returnByValue: true });
if (errs.result.value !== "[]") console.log("errori pagina:", errs.result.value);
await call("Target.closeTarget", { targetId });
ws.close();

console.log(`screenshot: ${OUT} — etichetta: "${text.result.value}"`);
