// Startet OpenWrt 25.12.5 (x86/generic) im Emulator v86 und arbeitet eine
// Befehlsliste an der seriellen Konsole ab.
//
//   node boot.mjs <zwischenspeicher> <befehle.txt> <protokoll.txt> [hdb.tar]
//
// Jede Zeile der Liste ist ein Befehl; "# " am Zeilenanfang ist ein Kommentar
// und landet im Protokoll; "@<s> " vor einem Befehl setzt dessen Frist in
// Sekunden (Vorgabe 120). FRIST_FAKTOR=<n> streckt alle Fristen, wenn der
// Rechner ausgelastet ist. Das Protokoll enthaelt jeden Befehl mit Prompt und
// seine Ausgabe, so wie sie an der Konsole erschien.
//
// Die zweite Platte (hdb) ist ein tar-Archiv; der Gast liest es mit
// "tar -xf /dev/sdb". Jeder Lauf startet vom unveraenderten Abbild: v86 liest
// es in den Speicher, schreibt nie zurueck.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const [cache, befehlsDatei, protokollDatei, hdbDatei] = process.argv.slice(2);
if (!cache || !befehlsDatei || !protokollDatei) {
  console.error("Aufruf: node boot.mjs <zwischenspeicher> <befehle.txt> <protokoll.txt> [hdb.tar]");
  process.exit(2);
}
const require = createRequire(path.join(cache, "node", "package.json"));
const { V86 } = require("v86");
const dl = path.join(cache, "dl");
const FAKTOR = Number(process.env.FRIST_FAKTOR || 1);

const lade = (f) => new Uint8Array(fs.readFileSync(f)).buffer;

const optionen = {
  wasm_path: path.join(cache, "node", "node_modules", "v86", "build", "v86.wasm"),
  bios: { buffer: lade(path.join(dl, "seabios.bin")) },
  vga_bios: { buffer: lade(path.join(dl, "vgabios.bin")) },
  bzimage: { buffer: lade(path.join(dl, "openwrt-25.12.5-x86-generic-generic-kernel.bin")) },
  cmdline: "console=ttyS0,115200n8 root=/dev/sda rootfstype=ext4 rootwait noinitrd",
  hda: { buffer: lade(path.join(dl, "openwrt-25.12.5-x86-generic-generic-ext4-rootfs.img")) },
  memory_size: 512 * 1024 * 1024,
  vga_memory_size: 2 * 1024 * 1024,
  autostart: true,
  disable_keyboard: true,
  disable_mouse: true,
  disable_speaker: true,
};
if (hdbDatei) optionen.hdb = { buffer: lade(hdbDatei) };

const emu = new V86(optionen);
const protokoll = fs.createWriteStream(protokollDatei);
let puffer = "";
emu.add_listener("serial0-output-byte", (b) => {
  const z = String.fromCharCode(b);
  puffer += z;
  protokoll.write(z);
  if (process.env.LAUT) process.stdout.write(z);
});

const schlaf = (ms) => new Promise((r) => setTimeout(r, ms));
async function warteAuf(muster, frist) {
  const ende = Date.now() + frist;
  while (Date.now() < ende) {
    const i = puffer.search(muster);
    if (i >= 0) {
      const rest = puffer.slice(i);
      puffer = "";
      return rest;
    }
    await schlaf(100);
  }
  throw new Error(`Zeitueberschreitung beim Warten auf ${muster}`);
}

// Lange Zeilen in kleinen Stuecken senden: der serielle Puffer des Gasts
// verliert sonst Zeichen (beobachtet bei einer Zeile mit rund 500 Zeichen).
async function senden(text) {
  for (let i = 0; i < text.length; i += 48) {
    emu.serial0_send(text.slice(i, i + 48));
    await schlaf(40);
  }
}
const beginn = Date.now();
const sek = () => ((Date.now() - beginn) / 1000).toFixed(1);

try {
  await warteAuf(/Please press Enter to activate this console/, 15 * 60 * 1000 * FAKTOR);
  console.log(`[${sek()} s] Konsole bereit`);
  await schlaf(1500);
  await senden("\n");
  await warteAuf(/root@[^:]+:[^#]*# /, 60 * 1000 * FAKTOR);
  // Kernel-Meldungen nicht in die Konsole: sie zerreissen sonst die Ausgaben.
  await senden("dmesg -n 1\n");
  await schlaf(1000);
  const zeilen = fs.readFileSync(befehlsDatei, "utf8").split("\n");
  let n = 0;
  for (const zeile of zeilen) {
    if (!zeile.trim()) continue;
    if (zeile.startsWith("# ")) {
      protokoll.write(`\n### ${zeile.slice(2)}\n`);
      console.log(`[${sek()} s] ${zeile}`);
      continue;
    }
    let frist = 120 * 1000 * FAKTOR;
    let befehl = zeile;
    const m = zeile.match(/^@(\d+)\s+(.*)$/);
    if (m) {
      frist = Number(m[1]) * 1000 * FAKTOR;
      befehl = m[2];
    }
    n += 1;
    const marke = `__FERTIG_${n}__`;
    await senden(`${befehl}; echo ${marke.slice(0, 4)}""${marke.slice(4)} rc=$?\n`);
    await warteAuf(new RegExp(`${marke} rc=\\d+`), frist);
  }
  console.log(`[${sek()} s] alle Befehle abgearbeitet`);
} catch (e) {
  console.error(`[${sek()} s] ABBRUCH: ${e.message}`);
  protokoll.write(`\n### ABBRUCH: ${e.message}\n`);
  process.exitCode = 1;
} finally {
  protokoll.end();
  emu.stop();
  emu.destroy?.();
  setTimeout(() => process.exit(process.exitCode ?? 0), 500);
}
