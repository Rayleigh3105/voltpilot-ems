# Verbrauchsmanagement v1 · P2: der STEUERART-DIALOG

Ausgelagert aus `frontend/portal/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 32).


Die Zeile der Verbraucher-Zone ÖFFNET seit P2 einen vierschrittigen Dialog
(§6.2, Mockup „Steuerart-Dialog Schritt 1–4"): **Quelle → Einstellungen → Ziel →
Das passiert jetzt**. Alles Abgeleitete liegt rein in `src/steuerartDialog.ts`
(`steuerartDialog.test.ts`, 29); `components/SteuerartDialog.tsx` +
`SteuerartDialog.css` rendern NUR. Server-Seite, Projektion und die
Requirement-Form stehen in der Root-`AGENTS.md` („Verbrauchsmanagement v1 —
Paket 2").

- **⚠ Der Dialog ERFINDET keine Wahl und keine Vorgabe.** Welche Quellen und
  Ziele es gibt, ob eine gesperrt ist und WARUM, und mit welchem Wert eine
  Folgefrage startet, sagt der Server (`eintrag.optionen`, aus der reinen
  `SteuerartSatz`) — dieselbe Klasse prüft den `PUT` ein zweites Mal. Eine
  Quelle, die dieser Portal-Stand nicht kennt, wird schlicht NICHT gerendert
  statt geraten; ein Feld ohne belegte Vorgabe startet LEER.
- **Die Schale ist der Haus-`AnlegenDialog`** (Rechner: zentrierter
  Schritt-Dialog, Telefon: Vollbild-Schrittfolge, Fokus-Falle inklusive) — kein
  zweiter Dialog-Typ. Auswahlfelder sind `VpPicker`/`VpTimePicker`; ein natives
  `select`/`time` ist repo-weit verboten (`migration.test.ts`).
- **⚠ Die Schritt-Leiste hängt am WEG.** Ein Typ ohne Ziel (Schaltlast,
  SG-Ready) hat drei Schritte, eine Quelle ohne Folgefragen („Sofort") zwei —
  eine leere Seite ist keine Frage.
- **⚠ „Sofort" heißt am Ladepunkt etwas anderes als am Heizstab.** Am Ladepunkt
  ist es die Wahl „lade, sobald ein Auto steckt"; überall sonst die RÜCKNAHME
  („Ohne Steuerung durch VoltPilot — das Gerät läuft, wie es selbst eingestellt
  ist"). Dieselbe Id, zwei ehrliche Sätze; ein Wort für beides wäre an einer der
  zwei Stellen falsch.
- **⚠ Eine Zeile mit „Eigene Regel" startet OHNE Quelle** — ihre Policy lässt
  sich nicht auf eine Steuerart abbilden, und eine zu behaupten hieße, beim
  Speichern etwas zu überschreiben, was der Kunde nie gewählt hat.
- **⚠ Die FOLGEN-Karte sagt nur, was der Entwurf hergibt.** Kein „Netzstrom
  erlaubt" an einer reinen Überschuss-Quelle (dort läuft das Gerät nur mit
  gemessener Sonne), kein Box-Notnagel ohne Frist, kein „weicht vom Standard ab"
  ohne bekannten Standard. Der Frist-Satz ist WÖRTLICH `FLEX_FALLBACK_NOTE` aus
  `consumers/policy.ts` — dieselbe Zusage darf nicht an zwei Orten anders
  klingen.
- **⚠ Der PUT-Rumpf trägt nur, was die Quelle wirklich FRAGT** (`wunschAus`):
  eine mitgeschickte Preisgrenze an einer Überschuss-Quelle wäre ein verborgener
  Wert, den der Kunde nie zu sehen bekommt.
- **Eine NICHT schreibbare Zeile ist kein Knopf** (`ZeilenView.schreibbar` aus
  `optionen.schreibbar`): sie nennt den WEG, den es wirklich gibt. Ein älteres
  Backend schickt das Feld nicht — dann bleibt die Zone lesend wie in P1, nie
  ein Klick ins Leere. Die zwei `WEG_*`-Sätze stehen seither nur noch, wo
  wirklich eine Zeile nicht schreibbar ist.
- **Der Regel-Einstieg hat die VIER Verbraucher-Absichten verloren**
  (`regeln/rezepte.ts` `vorbelegungen` filtert `maschine === 'verbraucher'`):
  sie SIND die Steuerart. Sie fehlen nicht, sie sind umgezogen — und genau das
  sagt `STEUERART_STATT_REZEPT` im Dialog. **Die REZEPTE selbst bleiben**: sie
  befüllen weiterhin den Editor einer bestehenden „Eigene Regel"-Policy vor.
- **Ein VORSCHLAG zielt auf die Steuerart** (§6.1): `Vorschlag.steuerart` ist
  sein Wunsch, „Übernehmen" öffnet den Dialog damit vorbefüllt **auf der
  Folgen-Karte**. ⚠ Das ist eine argumentierte Abweichung vom Wortlaut
  („Übernehmen setzt, Anpassen öffnet"): ein Knopf, der ohne Folgen-Karte
  schreibt, wäre die eine Stelle, an der die Haus-Regel „die Folgen-Karte steht
  IMMER vor der Aktivierung" fehlte — und „Zurück" IST das Anpassen, ohne einen
  vierten Knopf, der auf dieselbe Fläche führt.
- **Der Erstbesuch-Hinweis** (`src/steuerartIntro.ts` +
  `components/SteuerartIntro.tsx`, §7.4) zählt auf, was übernommen wurde, und
  woher — je Komponente eine Zeile, plus die Rangliste und den Schluss-Satz
  „Nichts ist verloren gegangen." ⚠ Er wird **je ANLAGE** gemerkt (anders als
  der Zonen-Erklärkasten, der je ORGANISATION gilt): er zählt die Geräte DIESER
  Anlage auf, ist auf der nächsten also ein anderer Kasten. Speicher ist
  `cockpit_layout.document.seen` der ANLAGEN-Schicht — kein neuer Speicher,
  `localStorage` bleibt verboten. Ohne eine einzige steuerbare Komponente
  entsteht er GAR NICHT.

**Beweise:** `steuerartDialog.test.ts` (28) · `steuerartIntro.test.ts` (10) ·
`components/SteuerartDialog.test.tsx` (7: die Reise von „Eigene Regel" zu
„Überschuss", die gesperrte Karte MIT Grund, beide übersprungenen Schritte, das
Ladepunkt-Wort, die Vorschlags-Vorbelegung, der Server-Satz) ·
`pages/SteuerungSection.test.tsx` (41, davon der Zeilen-Klick bis zum `PUT` und
die nicht schreibbare Zeile) · `regeln/rezepte.test.ts` (17).

