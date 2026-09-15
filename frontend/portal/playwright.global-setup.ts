import { chromium, type Browser, type FullConfig } from '@playwright/test';

/* =========================================================================
   DIE ERSTE SEITE EINES LAUFS ZAHLT DIE ÜBERSETZUNG — NICHT EINE ZUSICHERUNG

   Der Vite-Entwicklungsserver übersetzt jedes Modul erst beim ersten Abruf.
   Gemessen am 16.09.2026 auf dieser Bühne (`help.spec.ts:7`, vier Worker):

     erste Seite des Laufs   nav 2,9–4,9 s   bis zur Überschrift 5,9–8,9 s
     jede weitere Seite      nav 0,3–1,2 s   bis zur Überschrift 0,4–1,3 s

   Dieselbe Seite, 0,5 s später neu geladen, steht in 0,5 s. Am Produkt ändert
   sich zwischen beiden Ladevorgängen nichts — nur der Übersetzungs-Cache des
   Entwicklungsservers ist dann warm. Der ausgelieferte Portal-Build kennt
   diese Wartezeit gar nicht: er ist fertig übersetzt, bevor ein Kunde ihn
   abruft. Kein echter Verwender wartet hier also auf irgendetwas.

   Wer die Rechnung bezahlt, entschied bisher allein die Worker-Verteilung:
   der Test, der als Erster einen Wirt mit ganzem `src/App.tsx` lud, lief in
   das 5-Sekunden-Budget seiner ersten Zusicherung. Im Oberflächen-Durchlauf
   vom 15.09.2026 traf es `help.spec.ts:7`; in Wiederholungsläufen ebenso
   `help.spec.ts:17`, `:35` und `:67` — je nachdem, wer zuerst drankam.

   ⚠ Deshalb wird die Rechnung HIER bezahlt, einmal pro Lauf, vor der ersten
     Zusicherung — und NICHT durch ein größeres Zusicherungs-Budget, durch
     `retries` oder durch erzwungene Klicks. Jede Zusicherung behält ihre
     strengen 5 s: wird die Hilfe wirklich einmal langsam, fällt sie weiterhin
     auf. `e2e/help.html` ist der Wirt mit dem größten geteilten Graphen
     (`src/App.tsx` samt Designsystem); ihn zu wärmen wärmt fast jeden anderen
     Wirt gleich mit.

   Das Wärmen ist BESTENFALLS-Arbeit: schlägt es fehl, läuft der Lauf wie
   zuvor weiter. Ein kalter Server ist langsam, kein Fehler.
   ========================================================================= */

const WIRT = '/e2e/help.html#/hilfe/fahrplan';
const GEDULD = 120_000;

export default async function globalSetup(config: FullConfig): Promise<void> {
  const baseURL = config.projects.find((p) => p.use?.baseURL)?.use?.baseURL;
  if (!baseURL) return;

  // ⚠ Auch das Starten des Browsers steht IM Versuch: fehlt Chromium (etwa
  //   weil jemand nur ein WebKit-Projekt fährt), soll der Lauf trotzdem
  //   beginnen — nicht schon vor dem ersten Test scheitern.
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch();
    const page = await browser.newPage();
    await page.goto(new URL(WIRT, baseURL).href, { waitUntil: 'load', timeout: GEDULD });
    // Erst wenn die nachgeladene Hilfe-Seite steht, ist auch ihr Stück
    // übersetzt — `load` allein sagt darüber nichts.
    await page.locator('main h1').first().waitFor({ state: 'visible', timeout: GEDULD });
  } catch (fehler) {
    console.warn(`[e2e] Wirt ${WIRT} liess sich nicht vorwaermen: ${String(fehler)}`);
  } finally {
    await browser?.close();
  }
}
