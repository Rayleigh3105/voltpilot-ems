// Baut die Ansicht „Eigener Messwert: Was misst dieser Wert?“ (Paket vp-uems-baukasten-messwert-groesse)
// aus den Bildern von
//   EIGENER_MESSWERT_BILDER=<ordner> MESSEN_ASSISTENT_BILDER=<ordner> npx playwright test \
//     e2e/eigener-messwert.spec.ts e2e/messen-assistent.spec.ts -g "Eigenen Messwert|Baukasten-Zähler MIT" --project=desktop-chromium
// Variante B und „vorher“ sind nur Fotos (Komponente kurz umgebaut bzw. der Stand origin/uems, danach zurück).
// Aufruf: node e2e/eigener-messwert-ansicht.mjs <ordner> <ziel.html>. Jedes Bild wird eingebettet (data:).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [ordner, ziel] = process.argv.slice(2);
if (!ordner || !ziel) throw new Error('Aufruf: node … <ordner> <ziel.html>');
const bild = (name, breite) => {
  const pfad = join(ordner, `${name}-${breite}.png`);
  if (!existsSync(pfad)) return `<p class="fehlt">Bild fehlt: ${name}-${breite}.png</p>`;
  return `<img alt="${name} ${breite} px" src="data:image/png;base64,${readFileSync(pfad).toString('base64')}">`;
};
const FAELLE = [
  ['vorher', 'Vorher (origin/uems) — nur als Foto, nach Klick auf „Last und Volumen prüfen“', 'Keine Frage, was der Wert misst. Das Formular schickte fest <code>retentionClass: gauge</code> — eine Klasse, die die API nicht kennt: „Last und Volumen prüfen“ endete in 400 („Bitte eine Aufbewahrungsklasse … wählen“), und die Meldung landete im geschlossenen Katalog-Einschub. Im Formular geschah sichtbar nichts, „Jetzt aufzeichnen“ blieb gesperrt. Ein eigener Messwert aus dem Portal entstand nie; über die API angelegte trugen keine Größe und bekamen keine Messstelle. (Die Bühne lehnt unbekannte Klassen wie die API ab.)'],
  ['frage', 'Variante A (gebaut, empfohlen): EINE Frage als Auswahlfeld', 'Direkt unter der Bezeichnung: „Was misst dieser Wert?“. Ohne Antwort bleibt „Jetzt aufzeichnen“ gesperrt; die Zeile darunter sagt, wozu die Angabe dient.'],
  ['liste', 'Die elf Antworten', 'Energie-Zählerstand oder Leistung, je Bezug, Abgabe, Erzeugung, Laden, Entladen — genau die Kombinationen, die danach eine Messstelle tragen — und „Etwas anderes (ohne Messstelle)“. Einheit, Skala und Datentyp fragt das Formular wie bisher; nichts davon doppelt.'],
  ['gewaehlt', 'Gewählt: Energie-Zählerstand – Bezug', 'Die Zeile nennt die Folge und die passenden Einheiten. Geschickt werden die Katalogwörter <code>active_energy / import / counter</code> und die Aufbewahrung <code>energy_counter</code> — der Kunde sieht keins davon.'],
  ['einheit', 'Einheit passt nicht zur Antwort', 'kW an einem Energie-Zählerstand: derselbe Satz wie in der API („Ein Energie-Zählerstand braucht die Einheit Wh, kWh oder MWh.“), „Jetzt aufzeichnen“ bleibt gesperrt.'],
  ['variante-b', 'Variante B — nur als Foto: alle Antworten als sichtbare Liste', 'Verworfen: elf Zeilen schieben am Telefon alle Registerfelder aus dem ersten Bildschirm (Liste 688 px hoch bei 375 px Breite) und die Frage wirkt wie ein eigener Schritt. Die Auswahl (A) hält das Formular so kurz wie vorher, eine Zeile mehr.'],
  ['schritt3-baukasten', 'Danach: der Kanal im Messstellen-Vorschlag (Messen-Assistent, Schritt 3)', 'Der Baukasten-Zähler MIT Angabe wird vorgeschlagen (Wirkenergie · Bezug · Zählerstand); der ohne Angabe steht unter „Nicht vorgeschlagen“ mit „misst keine Größe, die eine Messstelle trägt“. Die Zeilen folgen der Server-Antwort aus <code>PortalwegMesskundeAbnahmeTest</code> (MS-06 → MS-0002, Werte führend, Viertelstunde mit Menge 3,6 kWh).'],
];
const abschnitte = FAELLE.map(([name, titel, satz]) => `
<section>
  <h2>${titel}</h2>
  <p>${satz}</p>
  <div class="paar"><figure>${bild(name, 375)}<figcaption>375 px</figcaption></figure><figure>${bild(name, 1440)}<figcaption>1440 px</figcaption></figure></div>
</section>`).join('\n');
writeFileSync(ziel, `<!doctype html>
<html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Eigener Messwert: Messgröße</title>
<style>
:root{--bg:#f6f7f9;--fg:#0f172a;--muted:#475569;--card:#fff;--line:#e2e8f0}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#0b1220;--fg:#e2e8f0;--muted:#94a3b8;--card:#111a2b;--line:#1e293b}}
:root[data-theme="dark"]{--bg:#0b1220;--fg:#e2e8f0;--muted:#94a3b8;--card:#111a2b;--line:#1e293b}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}
main{max-width:1200px;margin:0 auto;padding:24px 16px}
section{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;margin:16px 0}
h1{font-size:1.5rem;margin:0 0 8px}h2{font-size:1.1rem;margin:0 0 4px}p{color:var(--muted);margin:0 0 12px}
.paar{display:grid;grid-template-columns:minmax(0,375px) minmax(0,1fr);gap:16px;align-items:start}
@media (max-width:760px){.paar{grid-template-columns:minmax(0,1fr)}}
figure{margin:0}img{max-width:100%;height:auto;border:1px solid var(--line);border-radius:8px;display:block}
figcaption{color:var(--muted);font-size:.85rem;margin-top:4px}.fehlt{color:#b91c1c}
code{font-size:.9em}
</style></head><body><main>
<h1>Eigener Messwert: „Was misst dieser Wert?“</h1>
<p>Paket <code>vp-uems-baukasten-messwert-groesse</code> (Schnitt 2 der Untersuchung „Portal-Weg Messkunde“, 21.09.2026). Jedes Bild ist eine Playwright-Aufnahme der echten Portal-Komponente (<code>BeobachteteRegister</code> auf der Bühne <code>e2e/eigener-messwert.html</code>, Messen-Assistent auf <code>e2e/messen-assistent.html</code>), außer wo „nur als Foto“ steht.</p>
${abschnitte}
</main></body></html>
`);
