/* =========================================================================
   DIE CODE-SPLITTING-GRENZE DES PORTALS, AN EINER STELLE
   Bewegungs-Programm P5 (Konzept `data/vp-motion-konzept-m1/report.md` §9,
   Risiko „Suspense-Fallback während der Transition").

   Hier steht je nachgeladener Seite GENAU EIN `import()`. Zwei Abnehmer
   teilen sich diese Aufrufe:

     · `App.tsx` / `pages/AnlagenPage.tsx` — sie bauen daraus ihre
       `lazy()`-Komponenten (das Stück wird geladen, wenn React es rendert);
     · `pageTransition.ts` — es lädt dasselbe Stück VOR, damit der
       Seitenwechsel nicht ein Skelett hereinschiebt und danach hart auf den
       Inhalt springt.

   ⚠ **DIE EINE STELLE IST HIER KEINE STILFRAGE, SIE IST DAS BÜNDEL.** Vite
     erzeugt je `import()`-AUFRUFSTELLE einen eigenen `__vitePreload`-Rumpf
     samt seiner Abhängigkeitsliste. Standen dieselben 27 Adressen ein zweites
     Mal im Vorlade-Modul, wüchse das EINSTIEGS-Bündel um gemessene 1,03 kB gz
     (228,81 → 229,84 bei einer Grenze von 230 kB, `test/bundle-smoke.sh`) —
     für null zusätzliche Funktion. Wer eine neue Seite lazy schneidet, trägt
     sie deshalb HIER ein und ruft sie an beiden Enden ab.

   ⚠ **Dieses Modul importiert nichts.** Es liegt im Einstieg (`App.tsx` hängt
     statisch daran), und ein statischer Import zöge das Ziel-Stück genau
     dorthin zurück, wo es nicht hingehört (E10 a: „das Einstiegs-Bündel trägt
     NUR das erste Bild").
   ========================================================================= */

/** Die Seiten der Flotten- und Plattform-Ebene (Abnehmer: `App.tsx`). */
export const PAGE_CHUNK = {
  hilfe: () => import('./help/HelpPage'),
  onboarding: () => import('./Onboarding'),
  uebersicht: () => import('./pages/UebersichtPage'),
  portfolio: () => import('./pages/PortfolioPage'),
  'portfolio-standorte': () => import('./pages/StandortePage'),
  'portfolio-messstellen': () => import('./pages/MessstellenPage'),
  'portfolio-bezugsgroessen': () => import('./pages/BezugsgroessenPage'),
  'portfolio-kennzahlen': () => import('./pages/KennzahlenPage'),
  'portfolio-berichte': () => import('./pages/BerichtePage'),
  'portfolio-bewertung': () => import('./pages/BewertungPage'),
  'portfolio-verbesserung': () => import('./pages/VerbesserungBereich'),
  'portfolio-messwerte': () => import('./pages/PortfolioMesswerte'),
  'portfolio-erloese': () => import('./pages/PortfolioErloese'),
  standort: () => import('./pages/StandortUebersichtPage'),
  mandanten: () => import('./pages/admin/MandantenPage'),
  'plattform-uebersicht': () => import('./pages/admin/PlattformUebersichtPage'),
  'geraete-registry': () => import('./pages/admin/GeraeteBereich'),
  optimizer: () => import('./pages/admin/OptimizerPage'),
  flows: () => import('./pages/admin/FlowsPage'),
  'steuerungs-freigabe': () => import('./pages/admin/SteuerungsFreigabePage'),
  vorlagen: () => import('./pages/admin/VorlagenPage'),
  'komponenten-flotte': () => import('./pages/admin/KomponentenFlottePage'),
} as const;

/** Die Unterseiten EINER Anlage (Abnehmer: `pages/AnlagenPage.tsx`). */
export const SUB_CHUNK = {
  daten: () => import('./pages/DataPages'),
  messwerte: () => import('./pages/MesswerteSection'),
  energiebilanz: () => import('./pages/EnergiebilanzSection'),
  erloese: () => import('./pages/ErloeseSection'),
  modell: () => import('./pages/AnlagenModellSection'),
  geraet: () => import('./pages/GeraetSeiteSection'),
  box: () => import('./pages/BoxSeiteSection'),
  ladevorgaenge: () => import('./pages/LadevorgaengeSection'),
  lastspitzen: () => import('./pages/LastspitzenSection'),
  steuerung: () => import('./pages/SteuerungSection'),
  technik: () => import('./pages/AnlageTechnik'),
  befehle: () => import('./pages/BefehleSection'),
  prognose: () => import('./pages/PrognosePage'),
} as const;
