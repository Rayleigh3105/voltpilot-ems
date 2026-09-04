/**
 * **Die LAZY-GRENZE der Bewegungs-Bibliothek** (Bewegungs-Programm P0,
 * Captain-Entscheid E10 a: „nur in Lazy-Stuecken").
 *
 * ## ⚠ WARUM ES DIESE DATEI GIBT
 *
 * Gemessen (Konzept `data/vp-motion-konzept-m1/report.md` §7.1, Vite-Build im
 * Worktree): `motion/react` voll im Einstieg kostet **+45,1 kB gz**,
 * `LazyMotion`+`m` im Einstieg **+16,1 kB gz**, Motion NUR in einem
 * Lazy-Stueck **+0,07 kB gz**. Die Haus-Regel „das Einstiegs-Buendel traegt
 * NUR das erste Bild" laesst nur die letzte Zahl zu — und das erste Bild
 * bewegt sich ohnehin mit CSS und den Tokens (Karten-Staffel, Chart-Maske,
 * Zahlen-Durchblenden sind CSS).
 *
 * ## ⚠ DIESE DATEI DARF KEIN EINSTIEGS-MODUL IMPORTIEREN
 *
 * Sie ist ausschliesslich das Ziel eines **dynamischen** Imports:
 *
 * ```tsx
 * <LazyMotion strict features={() => import('../motionFeatures').then((m) => m.default)}>
 * ```
 *
 * Ein STATISCHER Import aus `main.tsx`, `App.tsx` oder irgendeinem Modul, das
 * von dort aus erreichbar ist, legt Vite das Paket zurueck in den Einstieg —
 * gemessen: `import('motion/react')` neben einem statischen Import kostete
 * +65,2 kB gz statt +0,07. Der Waechter `test/bundle-smoke.sh` faengt genau
 * das: er baut und verlangt, dass im Einstiegs-Chunk kein Motion-Symbol steht.
 *
 * ## Warum `domAnimation` und nicht `domMax`
 *
 * `domAnimation` (14,2 kB gz nachgeladen) traegt Animationen, Varianten,
 * Ausblenden und Gesten-freies `m`. `domMax` (dieselbe Groessenordnung, aber
 * mit Layout-Animationen und Drag) waere die Einladung, Layout zu animieren —
 * genau das, was Prinzip 9 verbietet („nie Hoehe/Breite/Layout"). Wer Drag
 * wirklich braucht, laedt `domMax` in SEINEM Lazy-Stueck und begruendet es.
 */
export { domAnimation as default } from 'motion/react';
