// Baut die Ansicht „Gemeinsame Steuerung — das Betreiber-Blatt“ (Paket vp-uems-v15-ip24-betreiberblatt) aus den Bildern von
//   GSB_BILDER=<ordner> npx playwright test e2e/betreiberblatt.spec.ts --project=desktop-chromium
// Aufruf: node e2e/betreiberblatt-ansicht.mjs <ordner> <ziel.html>. Jedes Bild wird eingebettet (data:).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [ordner, ziel] = process.argv.slice(2);
if (!ordner || !ziel) throw new Error('Aufruf: node … <ordner> <ziel.html>');
const bild = (name, breite) => {
  const pfad = join(ordner, `${name}-${breite}.png`);
  if (!existsSync(pfad)) return `<p class="fehlt">Bild fehlt: ${name}-${breite}.png</p>`;
  return `<img alt="${name} ${breite} px" src="data:image/png;base64,${readFileSync(pfad).toString('base64')}">`;
};
const paar = (name) => `<div class="paar"><figure>${bild(name, 375)}<figcaption>375 px</figcaption></figure><figure>${bild(name, 1440)}<figcaption>1440 px</figcaption></figure></div>`;
const abschnitt = ([name, titel, satz]) => `
<section>
  <h2>${titel}</h2>
  <p>${satz}</p>
  ${paar(name)}
</section>`;

const LAGEN = [
  ['s1', 'S1 · beobachtet — Blatt mit offener I1-Liste', 'Kopf: Stufe und Epoche; darunter JEDES Wort aus <code>fehlt</code>, auch <code>nachweis_fehlt</code> (der Kunde sieht es nicht). Je Box eine Spalte nebeneinander: Erreichbarkeit, Fähigkeit (gemeldet / laut Versions-Tabelle / fehlt), Geräte mit Rückfall und Herkunft, Messpunkt und Alter, Wächter-Stufe je Richtung, <code>plan_id</code> veröffentlicht/angenommen, Anteils-Revision gesendet/quittiert, wirksame Anteile. Box Verwaltung ist hier eine „alte“ Box ohne Herzschlag-Block: „nicht gemeldet“ in Grau-kursiv — nie eine Null, nie grün. Sprungprobe-Knopf nur an Box Halle 1; an Box Verwaltung der Grund. I1-Liste je Bedingung erfüllt/offen, nur aus <code>fehlt</code> der api. Scharfschalten in S1 lehnt die api mit 409 ab — das Wort steht an seiner Stelle (vitest + Playwright).'],
  ['sprungprobe', 'Sprungprobe ausgelöst → das Protokoll erscheint', 'Dialog mit Art und Sprung (≤ 50 kW, deutsche Zahl) und dem, was danach gilt. Nach dem Auslösen die neue Zeile „ausgelöst — Bericht steht aus“ über der bestandenen Probe mit ihrer Abweichung je Sprung (−0,8 kW / +0,4 kW bei ± 3 kW Toleranz).'],
  ['uebergang', 'Scharfgeschaltet, Quittung fehlt — Übergangsstand „1 von 2“ (R12)', 'Die führende Box hat den Übergang quittiert, die mitsteuernde nicht: „Änderung wird übernommen — 1 von 2 Boxen hat bestätigt · wartet auf Box Verwaltung“. Kein Zielstand, kein Plan je Box („keiner“), die fehlende Quittung ist markiert. Auch „Neu lesen“ ändert daran nichts, bis die Quittung kommt — das Blatt nimmt den Zielstand nie vorweg.'],
  ['aktiv', 'Nach der Quittung — Zielstand steht (S3 · Anteile aktiv)', 'Erst jetzt, weil die api <code>schritt = ziel</code> meldet und jede Box quittiert hat: „Zielstand steht — alle 2 Boxen haben quittiert“. Beide Quittungen nebeneinander (§5.4), <code>plan_id</code> veröffentlicht = angenommen, wirksame Anteile 40/0 und 60/77 kW.'],
  ['angehalten', 'Vom Betreiber angehalten', 'Nach „Als Betreiber anhalten“ (Dialog: die Anteile bleiben in Kraft): Kopf „angehalten · vom Betreiber angehalten“, Hinweis, dass der Kunde nicht selbst fortsetzt; „Als Betreiber fortsetzen“ geht über die Admin-Route.'],
];

writeFileSync(ziel, `<!doctype html>
<html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Gemeinsame Steuerung: Betreiber-Blatt</title>
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
code{font-size:.9em}ol{color:var(--muted)}
</style></head><body><main>
<h1>Gemeinsame Steuerung — das Betreiber-Blatt (AP-15 IP-24)</h1>
<p>Mitteilung, keine Sperre. Jedes Bild ist eine Playwright-Aufnahme der echten Portal-Komponente (<code>GemeinsameSteuerungBetreiberBlatt</code> unter der Kundenkarte in <code>AnlageTechnik.tsx</code>, nur hinter <code>showTechnicalLayer()</code>) auf der Bühne <code>e2e/betreiberblatt.html</code> mit Plattform-Rolle; die Routen sind dort gestellt (Referenzdatei 1.5: Box Halle 1 führt, Box Verwaltung steuert mit). Keine echte Anlage wurde berührt.</p>
<section>
  <h2>Woher die Zahlen kommen</h2>
  <ol>
    <li>Zustand, <code>fehlt</code>, Epoche, Bilanz, Vorbehalt: <code>GET /api/v1/sites/{id}/gemeinsame-steuerung</code> (Bestand).</li>
    <li>Geräte, Rückfall mit Herkunft, Auslegung: <code>GET …/gemeinsame-steuerung/einrichten</code> (Bestand).</li>
    <li>NEU, nur Plattform-Rolle: <code>GET /api/v1/admin/sites/{id}/gemeinsame-steuerung</code> — je Box Fähigkeit mit Herkunft, Messpunkt und Alter, Wächter-Stufe, <code>plan_id</code> veröffentlicht/angenommen, Revision gesendet/quittiert, wirksame Anteile, letzter Herzschlag; dazu der Zweischritt (<code>bestaetigt</code>/<code>wartet_auf</code>) und alle Sprungprobe-Protokolle mit Abweichung je Sprung. Eine Ableitung (<code>uems/GemeinsameSteuerungBoxStand</code>), die die Kundenroute später mitbenutzen kann.</li>
    <li>Wächter-Stufe und wirksame Anteile kommen aus dem Herzschlag-Block und liegen nur im Prozess: nach einem Neustart der api stehen sie bis zum nächsten Herzschlag als „nicht gemeldet“ da.</li>
  </ol>
</section>
${LAGEN.map(abschnitt).join('\n')}
</main></body></html>
`);
