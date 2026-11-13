/**
 * Integrazione contro le API REALI installate (nessun mock):
 *  - il token di capability del nostro plugin server deve coincidere
 *    (pluginId/id/version) con quello esportato dal Pi Web installato;
 *  - il bus reale di pi-coding-agent deve avere l'emissione sincrona su cui
 *    poggia il gate probe/pong dell'estensione;
 *  - l'estensione deve caricare attraverso il loader REALE dell'SDK Pi con un
 *    bus reale, senza toccare nulla dell'installazione.
 *
 * Se un'installazione non e' raggiungibile i test si dichiarano saltati.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const PI_WEB_DIST = join(homedir(), ".npm-global/lib/node_modules/@jmfederico/pi-web/dist");
const PI_CODING = join(
	homedir(),
	".pi/agent/install/releases/1.5.0/node_modules/@earendil-works/pi-coding-agent/dist",
);
const JITI = join(PI_CODING, "..", "..", "..", "jiti");
const havePiWeb = existsSync(join(PI_WEB_DIST, "server-plugin-api.js"));
const havePiSdk = existsSync(join(PI_CODING, "core/extensions/loader.js"));
const haveJiti = existsSync(join(JITI, "lib", "jiti.mjs"));

test("capability: identita' identica al dist Pi Web installato", { skip: !havePiWeb && "pi-web non installato" }, async () => {
	const mod = await import(pathToFileURL(join(PI_WEB_DIST, "server-plugin-api.js")).href);
	const ours = (await import("../src/server/index.js")).PI_WEB_HOST_PI_SESSION_EVENTS_CAPABILITY;
	const theirs = mod.PI_WEB_HOST_PI_SESSION_EVENTS_CAPABILITY;
	assert.equal(ours.pluginId, theirs.pluginId);
	assert.equal(ours.id, theirs.id);
	assert.equal(ours.version, theirs.version);
	// il parse del dist accetta il nostro token strutturale (stessa identita')
	assert.equal(typeof theirs.parse, "function");
});

test("d.ts installati: superfici usate presenti", { skip: !havePiWeb && "pi-web non installato" }, async () => {
	const { readFileSync } = await import("node:fs");
	const server = readFileSync(join(PI_WEB_DIST, "server-plugin-api.d.ts"), "utf8");
	const browser = readFileSync(join(PI_WEB_DIST, "plugin-api.d.ts"), "utf8");
	assert.match(server, /PiWebHostPiSessionEventsV1/);
	assert.match(server, /openChannel/);
	assert.match(browser, /sessionLabels/);
	assert.match(browser, /workspacePanels/);
	assert.match(browser, /PluginPeerChannelOptions/);
});

test("bus reale Pi: emissione sincrona (fondamento del gate probe/pong)", { skip: !havePiSdk && "pi SDK non trovato" }, async () => {
	const { createEventBus } = await import(pathToFileURL(join(PI_CODING, "core/event-bus.js")).href);
	const bus = createEventBus();
	let pong = false;
	bus.on("pong", () => {
		pong = true;
	});
	bus.on("probe", () => bus.emit("pong", {}));
	bus.emit("probe", {});
	assert.equal(pong, true, "l'handler deve girare nello stesso tick dell'emit");
});

test("estensione installata via symlink: importabile dal percorso installato", { skip: !haveJiti && "jiti non trovato" }, async () => {
	// Regressione: `ln -s .../src/extension/index.js ~/.pi/agent/extensions/pi-token-speed.js`
	// NON funziona. Il loader di Pi ancora gli import relativi alla path con cui il file
	// viene aperto (il symlink), quindi `../metrics.js` finiva su ~/.pi/agent/metrics.js e
	// l'estensione falliva in bootstrap ("Cannot find module '../metrics.js'").
	// L'installazione corretta e la cartella: ~/.pi/agent/extensions/pi-token-speed ->
	// progetto, con `pi.extensions` nel package.json (discovery "one level deep" di Pi).
	const root = resolve(import.meta.dirname, "..");
	const tmp = mkdtempSync(join(tmpdir(), "pts-install-"));
	try {
		const extensionsDir = join(tmp, "extensions");
		mkdirSync(extensionsDir);
		const installedDir = join(extensionsDir, "pi-token-speed");
		symlinkSync(root, installedDir, "dir");

		// stessa regola di resolveExtensionEntries2 di Pi
		const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).pi;
		assert.ok(Array.isArray(manifest?.extensions) && manifest.extensions.length > 0, "pi.extensions nel package.json");
		const entries = manifest.extensions
			.map((entry) => resolve(installedDir, entry))
			.filter((entry) => existsSync(entry));
		assert.equal(entries.length, 1, "una sola entry installata");

		const { createJiti } = await import(pathToFileURL(join(JITI, "lib", "jiti.mjs")).href);
		const jiti = createJiti(import.meta.url, { moduleCache: false });
		const mod = await jiti.import(entries[0]);
		assert.equal(typeof mod.default, "function", "la factory dell'estensione deve caricare dal path installato");
	} finally {
		rmSync(join(tmp, "extensions", "pi-token-speed"), { force: true });
		rmSync(tmp, { recursive: true, force: true });
	}
});

test("estensione caricata dal loader reale dell'SDK Pi", { skip: !havePiSdk && "pi SDK non trovato" }, async () => {
	const { loadExtensionFromFactory, createExtensionRuntime } = await import(
		pathToFileURL(join(PI_CODING, "core/extensions/loader.js")).href
	);
	const { createEventBus } = await import(pathToFileURL(join(PI_CODING, "core/event-bus.js")).href);
	const factory = (await import("../src/extension/index.js")).default;
	const runtime = createExtensionRuntime();
	const bus = createEventBus();
	const result = await loadExtensionFromFactory(factory, process.cwd(), bus, runtime);
	assert.ok(result, "il loader deve restituire l'estensione inizializzata");
	// l'estensione reale risponde al probe sul bus reale (stessa superficie usata
	// dalle estensioni di Pi Web)
	let pongSeen = false;
	bus.on("pi-token-speed:pong", () => (pongSeen = true));
	bus.emit("pi-token-speed:probe", { v: 1, type: "probe" });
	// il nostro shim non risponde ai probe (risponde il plugin server): qui si
	// verifica solo che il caricamento non rompa il bus
	assert.equal(pongSeen, false);
	bus.clear();
});
