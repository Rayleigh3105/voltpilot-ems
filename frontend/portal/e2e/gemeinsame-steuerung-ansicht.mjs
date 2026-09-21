// Baut die Ansicht „Gemeinsame Steuerung — die Kundenfläche“ (Paket vp-uems-v15-ip23-kundenflaeche) aus den Bildern von
//   GS_BILDER=<ordner> npx playwright test e2e/gemeinsame-steuerung.spec.ts --project=desktop-chromium
// Aufruf: node e2e/gemeinsame-steuerung-ansicht.mjs <ordner> <ziel.html>. Jedes Bild wird eingebettet (data:).
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

const KARTE = [
  ['karte-nicht-eingerichtet', 'Karte ohne Gemeinsame Steuerung', 'Anlage → Technik, nach „Mein Gerät“. Die Karte erscheint nur, wenn die Anlage steuert UND mehr als eine Box hat — an einer Anlage, die nur misst, oder mit einer Box gibt es weder Karte noch Sprungmarke (vitest + Playwright). Knopf nur mit Recht <code>funktion.steuern_einrichten</code>, sonst Grund und Weg. Kein Scharfschalten auf dieser Fläche (I5).'],
  ['karte-eingerichtet', 'Zustand „eingerichtet“ (S0, Struktur noch unvollständig)', 'Kundenwort + Zustand (S1). Was fehlt, steht darunter als Satz mit Weg (Netzanschluss eintragen, Datenquelle anlegen).'],
  ['karte-wird-geprueft', 'Zustand „eingerichtet · wird geprüft“ (S1) — direkt nach dem Einrichten', 'Satz „Prüfung läuft“ aus §5.8. Vor dem Freischalten hält keine Box einen Anteil: die mitsteuernde Box nennt ihren <i>vorgesehenen</i> Anteil. Darunter, was VoltPilot noch braucht (Update, Signal) — die Sprungprobe steht nicht da, sie ist Sache von VoltPilot.'],
  ['karte-aktiv', 'Zustand „aktiv“ (S3)', 'Zustandszeile, Box-Zeilen und Erklärung wörtlich aus §5.8; an der mitsteuernden Box die Verlust-Zeile (empfohlene Variante B, hier kWh 0). „Ändern“ gibt es in „aktiv“ nicht — die Fläche sagt, dass zuerst angehalten wird (409 <code>erst_anhalten</code>). Anhalten mit Recht <code>steuerung.starten_beenden</code> und Bestätigung.'],
  ['karte-angehalten', 'Zustand „angehalten“ — vom Kunden', 'Satz „Anhalten“ aus §5.8; „Fortsetzen“ und „Gemeinsame Steuerung ändern“ stehen wieder da.'],
  ['karte-betreiber', 'Angehalten von VoltPilot (<code>vom_betreiber_angehalten</code>)', 'Grund und Weg, kein Knopf „Fortsetzen“ und kein „Ändern“ — fortsetzen kann nur der Betreiber (W9/I5).'],
  ['ausfall-a1', 'Ausfall-Satz A1: Box Verwaltung antwortet nicht', 'Nur solange Anteile in Kraft sind (aktiv, angehalten). Die Uhrzeit ist der letzte Herzschlag der Box aus der Geräteliste (Befund 1 unten). A2 (führende Box) und A4 (beide) sind gebaut und getestet; A7 kommt aus <code>fehlt</code> (<code>fuehrende_box_misst_nicht</code>), A12 aus <code>faehigkeit_fehlt</code>.'],
];
const FRAGEN = [
  ['frage-1', 'Frage 1 · Welche Boxen steuern mit?', 'Vorgabe aus dem Vorschlag: jede Box, hinter der ein steuerbares Gerät antwortet — mit dem, was sie liest.'],
  ['frage-2', 'Frage 2 · Welche Box misst am Netzanschluss?', 'Vorgabe: die Box am Netzzähler (<code>netzzaehler_box_id</code>). Liest keine den Zähler, steht der Satz aus §5.2 mit Weg „Datenquelle an einer Box anlegen“. Die Datenquelle des Netzzählers wählt der Kunde (Befund 3); ohne sie geht es nicht weiter — die Lücke steht am Feld.'],
  ['frage-3', 'Frage 3 · Grenzen am Netzanschluss', 'Zeigt, was heute gilt (100 kW / 550 kW); ändern am Netzanschluss. Fehlt der Netzanschluss: „Bitte zuerst den Netzanschluss dieser Anlage eintragen.“ + Weg.'],
  ['frage-4', 'Frage 4 · Was keine Box steuert', 'Erzeuger: Pflicht „Keine“ oder Liste (ohne Antwort geht es nicht weiter). Verbrauch: Vorschlag aus den Messwerten (473 kW = 430 kW × 1,1, 14 Messtage), sonst Eingabe.'],
  ['frage-5', 'Frage 5 · Zähler, Geräte und Signal je Box', 'Je Box JEDE Komponente mit Schreibfreigabe je Richtung, Nennleistung vorbelegt, wo der Bestand sie kennt — der Speicher hat keine, die Lücke stand an seinem Feld, bis 100 kW eingetragen waren (eine 422-Lücke des Servers landet ebenso an ihrem Gerät). Zähler der mitsteuernden Box: DQ-10 oder „kein eigener Zähler“. Signal des Netzbetreibers: Ja · Nein · Weiß ich nicht. („Messpunkt“ ist auf Kundenflächen verboten, D3 — das Kundenwort ist „Zähler“.)'],
  ['frage-6', 'Frage 6 · Ergebnis — nach dem Absenden', 'Einspeisung 40 / 60 kW, Bezug 0 / 77 kW, beide „passt“ (Referenzdatei 1.5). Darunter die vier Sätze aus §5.2 Nr. 6: Update nötig · kein sicherer Rückfallwert (mit Feld „Am Gerät hinterlegen“ über <code>PUT …/komponenten/{id}/rueckfall</code>) · G7 Ladepark · Signal. Zustand „eingerichtet · wird geprüft“. Warum das Ergebnis erst nach dem Absenden kommt: Befund 2.'],
];

const verlust = (v, k) => bild(`verlust-${v}-${k}`, 375) + '</figure><figure>' + bild(`verlust-${v}-${k}`, 1440);
const VERLUST = `
<section>
  <h2>Verlust-Zeile an der mitsteuernden Box — zwei Varianten (Gestaltungs- und Wortlautfrage)</h2>
  <p><code>anteil_verlust.heute.kwh</code> ist eine UNTERGRENZE, <code>gebunden_s</code> exakt (PR 1044: im Referenzfall meldet die Box ≈ 0 kWh bei 9,1 h). Beide Varianten zeigen kWh nur ab 1 kWh, abgerundet und nie ohne „mindestens“; ohne kWh die Stunden. Unterschied: <b>A</b> wechselt je nach Tag die Einheit (kWh ODER Stunden), <b>B</b> nennt immer die exakte Zeit und die kWh nur als Zusatz.</p>
  <h3>Variante A — kWh, sonst die Stunden</h3>
  <div class="paar"><figure>${verlust('A', 'null')}</figure></div><p class="klein">kWh 0 → die Stunden</p>
  <div class="paar"><figure>${verlust('A', 'kwh')}</figure></div><p class="klein">kWh 160,8 → „mindestens 160 kWh“, die Zeit fällt weg</p>
  <h3>Variante B — immer die Stunden, kWh als Zusatz (empfohlen, gebaut als Vorgabe)</h3>
  <div class="paar"><figure>${verlust('B', 'null')}</figure></div><p class="klein">kWh 0 → die Stunden (gleich wie A)</p>
  <div class="paar"><figure>${verlust('B', 'kwh')}</figure></div><p class="klein">kWh 160,8 → Stunden und „— mindestens 160 kWh nicht erzeugt“</p>
  <p><b>Empfehlung B.</b> Die exakte Zahl führt, jeden Tag in derselben Form; eine Untergrenze steht nie allein da, wo sie wie der ganze Schaden gelesen würde („mindestens 3 kWh“ an einem Tag mit 9 Stunden Begrenzung wäre wahr und trotzdem irreführend). A wechselt von Tag zu Tag zwischen kWh und Stunden, und der Kunde kann zwei Tage nicht vergleichen. Umschalten ist eine Zeile (<code>VERLUST_VARIANTE</code>). Geldbeträge stehen bewusst nicht in der Zeile.</p>
</section>`;

writeFileSync(ziel, `<!doctype html>
<html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Gemeinsame Steuerung: Kundenfläche</title>
<style>
:root{--bg:#f6f7f9;--fg:#0f172a;--muted:#475569;--card:#fff;--line:#e2e8f0}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#0b1220;--fg:#e2e8f0;--muted:#94a3b8;--card:#111a2b;--line:#1e293b}}
:root[data-theme="dark"]{--bg:#0b1220;--fg:#e2e8f0;--muted:#94a3b8;--card:#111a2b;--line:#1e293b}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}
main{max-width:1200px;margin:0 auto;padding:24px 16px}
section{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;margin:16px 0}
h1{font-size:1.5rem;margin:0 0 8px}h2{font-size:1.1rem;margin:0 0 4px}h3{font-size:1rem;margin:16px 0 8px}p{color:var(--muted);margin:0 0 12px}
.paar{display:grid;grid-template-columns:minmax(0,375px) minmax(0,1fr);gap:16px;align-items:start}
@media (max-width:760px){.paar{grid-template-columns:minmax(0,1fr)}}
figure{margin:0}img{max-width:100%;height:auto;border:1px solid var(--line);border-radius:8px;display:block}
figcaption,.klein{color:var(--muted);font-size:.85rem;margin-top:4px}.fehlt{color:#b91c1c}
code{font-size:.9em}ol{color:var(--muted)}
</style></head><body><main>
<h1>Gemeinsame Steuerung — die Kundenfläche (AP-15 IP-23)</h1>
<p>Mitteilung, keine Sperre. Jedes Bild ist eine Playwright-Aufnahme der echten Portal-Komponente (<code>GemeinsameSteuerungAbschnitt</code> aus <code>AnlageTechnik.tsx</code> mit Karte und Einrichten-Folge) auf der Bühne <code>e2e/gemeinsame-steuerung.html</code>; die Routen der Gemeinsamen Steuerung sind dort mit den Zahlen der Referenzdatei 1.5 gestellt (V-1 an AN-1: Box Halle 1 führt, Box Verwaltung steuert mit). Die linke Spalte der Technik-Seite (Sprung-Navigation) bleibt auf der Bühne leer.</p>
<section>
  <h2>Befunde an der Schnittstelle (nicht nachgebaut)</h2>
  <ol>
    <li><b>Keine Erreichbarkeit je Mitglied in <code>GET …/gemeinsame-steuerung</code>.</b> A1/A2/A4 nehmen den letzten Herzschlag der Box aus der Geräteliste (<code>lastSeenAt</code>, dieselbe Quelle wie das Abzeichen „online“); eine Box ohne Herzschlag oder ohne Eintrag ist unbekannt — kein Satz.</li>
    <li><b>Frage 6 erst nach dem Absenden.</b> <code>GET …/einrichten</code> rechnet <code>ergebnis</code> nur für eine gespeicherte Erklärung; die Folge schreibt deshalb nach Frage 5 (Zustand „eingerichtet“, an den Boxen ändert sich nichts) und zeigt dann das Ergebnis.</li>
    <li><b>Die Datenquelle des Netzzählers fehlt im Vorschlag.</b> <code>netzzaehler_box_id</code> nennt die Box, nicht ihre Datenquelle — der Kunde wählt sie (B1 verlangt sie als Messpunkt der führenden Box).</li>
    <li><b>Keine wirksamen Anteile je Mitglied.</b> Die Box-Zeilen nehmen die Anteile der Auslegung aus <code>GET …/einrichten</code>; weicht der Betreiber beim Scharfschalten ab (G4 erlaubt es), stimmen die Zahlen auf der Karte nicht.</li>
  </ol>
</section>
<h2>Die Karte in ihren Zuständen</h2>
${KARTE.map(abschnitt).join('\n')}
<h2>Einrichten in sechs Fragen (375 px zuerst)</h2>
${FRAGEN.map(abschnitt).join('\n')}
${VERLUST}
</main></body></html>
`);
