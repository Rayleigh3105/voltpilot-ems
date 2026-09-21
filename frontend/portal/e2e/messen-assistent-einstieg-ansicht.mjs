// Baut die Ansicht „Einstieg Messen-Assistent“ (AP-01 E5 = A) aus den Bildern von
// `EINSTIEG_BILDER=<ordner> npx playwright test e2e/messen-assistent-einstieg.spec.ts --project=desktop-chromium`.
// Aufruf: node e2e/messen-assistent-einstieg-ansicht.mjs <ordner> <ziel.html>. Jedes Bild wird eingebettet (data:).
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
  ['karte-knopf', 'Karte „Funktionen“ mit Knopf', 'Aus dem Hinweis „Nächster Schritt: …“ wird der Knopf mit dem Text aus <code>messenEinstieg</code>. Er öffnet den Assistenten am Standort (Schritt 1, weil die Funktion dort noch kein Objekt hat).'],
  ['assistent-schritt1', 'Nach dem Klick: Assistent, Schritt 1', 'Gerendert von <code>App.tsx</code> — eine Stelle, nachgeladen beim ersten Öffnen.'],
  ['karte-fortsetzen', 'Wiedereinstieg: „Einrichtung fortsetzen (Schritt 3 von 5)“', 'Funktion im Entwurf, Entwurf im Browser bei Schritt 3 — der Knopf nennt den Schritt, der Klick landet dort.'],
  ['avatar-menue', 'Avatar-Menü „Funktionen“ (Variante A, gebaut)', 'Der Eintrag führt zur Karte „Funktionen“ der Übersicht und setzt den Fokus auf ihre Überschrift. Nur, wo die Landung eine Ebene mit Karte ist; Anlage- und Bestands-Landung sehen keinen neuen Eintrag.'],
  ['variante-b-avatar', 'Variante B — nur als Foto', 'Das Menü öffnet die Assistenten direkt. Verworfen: für „Steuern & Optimieren“ gibt es ohne Standort keinen Einstieg, das Menü müsste Zustände selbst laden und würde Steuern auch dort anbieten, wo nur gemessen wird. Das Bild ist per DOM-Einsatz auf der echten Seite entstanden, nicht gebaut.'],
  ['leer-messstellen', 'Leerzustand „Unternehmen › Messstellen“', 'Der Satz bleibt; daneben „Messen & Auswerten einrichten“ (nur mit Recht). „Zur Übersicht“ bleibt stehen.'],
  ['satz-weg', 'Satz „Daten kommen an – noch keiner Messreihe zugeordnet“ mit Weg', '„Im Messen-Assistenten zuordnen“ öffnet Schritt 2 („Datenquellen aus Ihren Geräten“) am Standort der Messstelle.'],
  ['ohne-recht', 'Konto ohne Recht (Person CB)', 'Kein Knopf: an seiner Stelle Grund und Weg aus <code>/me</code>.'],
];
const abschnitte = FAELLE.map(([name, titel, satz]) => `
<section>
  <h2>${titel}</h2>
  <p>${satz}</p>
  <div class="paar"><figure>${bild(name, 375)}<figcaption>375 px</figcaption></figure><figure>${bild(name, 1440)}<figcaption>1440 px</figcaption></figure></div>
</section>`).join('\n');
writeFileSync(ziel, `<!doctype html>
<html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Einstieg Messen-Assistent</title>
<style>
:root{--bg:#f6f7f9;--fg:#0f172a;--muted:#475569;--card:#fff;--line:#e2e8f0}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#0b1220;--fg:#e2e8f0;--muted:#94a3b8;--card:#111a2b;--line:#1e293b}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}
main{max-width:1200px;margin:0 auto;padding:24px 16px}
section{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;margin:16px 0}
h1{font-size:1.5rem;margin:0 0 8px}h2{font-size:1.1rem;margin:0 0 4px}p{color:var(--muted);margin:0 0 12px}
.paar{display:grid;grid-template-columns:minmax(0,375px) minmax(0,1fr);gap:16px;align-items:start}
@media (max-width:760px){.paar{grid-template-columns:minmax(0,1fr)}}
figure{margin:0}img{max-width:100%;height:auto;border:1px solid var(--line);border-radius:8px;display:block}
figcaption{font-size:.8rem;color:var(--muted)}.fehlt{color:#b91c1c}
</style></head><body><main>
<h1>Einstieg in den Messen-Assistenten (AP-01 E5 = A)</h1>
<p>Echte Playwright-Aufnahmen der gebauten Fläche auf der App-Schale (<code>startansicht.html?rechte=1</code>, Kunststoffwerk Ahrenberg, 20.10.2026). Empfohlen und gebaut: Variante A (Avatar-Menü → Karte). Variante B nur als Foto.</p>
${abschnitte}
</main></body></html>
`);
console.log(`Ansicht geschrieben: ${ziel}`);
