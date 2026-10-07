# Messen: geplante Messstellen (offene Messbedarfe)

Stand: Messen-Bau m2, PR4 (Konzept `data/vp-auswerten-konzept-a1`, Entscheid 9 „Messplanung nach Messen“).

## Wo und was

- Ein offener Messbedarf ist eine geplante Messstelle: die Liste `#/portfolio/messstellen` (am Standort `#/standort/{id}/messstellen`) zeigt ihn an seinem Ort nach dessen Messstellen (`GeplanteZeile` in `MessstellenPage.tsx`).
- Die reine Ableitung steht in `src/geplanteMessstellen.ts` (`geplanteAus`, `geplantHinweis`, Sätze); `messstellenListe.liste` nimmt die Reihen als `geplante` und gruppiert sie mit den Messstellen.
- Gelesen wird `GET /api/v1/unternehmen/messbedarf` (am Standort mit `?standort=`) und `GET /api/v1/unternehmen/energieeinsaetze`, nur mit `energieeinsatz.ansehen` und nur heute (mit „Stand am …“ gibt es keinen Plan).
- 403 und 404 heißen „nichts geplant“; jeder andere Fehler steht als leiser Satz mit „Erneut versuchen“ unter den Marken.
- Der Ort kommt aus `ort_ziel` (Gruppe = `ort_ziel.id`, derselbe Schlüssel wie `ortKopf`); ein Ort nur mit geplanten bekommt eine eigene Gruppe an seinem Platz im Ortsbaum (`ortReihenfolge`).
- Ein Bedarf der Fassung vor der Struktur hat nur ein Kurzzeichen als Wortlaut: kennt das Register den Ort, steht er dort, sonst unter „Kein Ort zugeordnet“ mit „Ort „G-9““ unter dem Namen.
- Ein Bedarf ohne Ort steht am Standort nicht in der Liste (die Standort-Route kennt ihn nicht), nur am Unternehmen.

## Regeln

- Die Marke „geplant“ zählt NUR die offenen Bedarfe und zeigt nur sie; jede andere Marke zeigt nur Messstellen.
  Eingelöste Messstellen sind gewöhnliche Messstellen (ohne Quelle unter „ohne Quelle“); ihr Einsatz steht auf ihrer Seite („geplant für EE-8 …“).
- Geplante zählen nicht zu den Messstellen: „22 Messstellen an 14 Orten · 2 geplant“, mit der Marke „2 geplante Messstellen“.
- Eine Frist vor dem Tag der Antwort des Registers (Uhr des Servers) ist überschritten: die Reihe steht im Ton des Hinweises, und eine Hinweiskarte („… ist noch nicht eingerichtet“, Schritt „Ansehen“) filtert auf „geplant“.
- „Einrichten“ ist derselbe Weg wie am Einsatz: `MessbedarfEinloesen` (`components/Messplanung.tsx`) öffnet den ECHTEN Messstellen-Dialog mit Ort und Größe; die erste eingerichtete Messstelle löst ein.
- Belegschutz (Vertrag `bewertung.md`): zitieren freigegebene Berichtsstände den Bedarf, lehnt der Server das Einlösen mit 409 `berichts_belege` ab.
  Die Messstelle ist dann schon eingerichtet (der Dialog speichert Schritt für Schritt) und bleibt; der Satz nennt die Stände, die Messstelle und dass der Bedarf geplant bleibt (`messbedarfAblehnung`, `einloesenAbgelehntSatz`).
  Der Satz des Servers ist der einer Komponente („Löschen ist nicht möglich — beenden Sie die Bindung“) und wird hier nie gezeigt, solange `berichtsstaende` kommt.
- Review r4 M4 (Entscheid b): die API nennt am Bedarf vorher `einloesbar` und `zitiert_von`; ein zitierter offener Bedarf (`nichtEinloesbar`) hat kein „Einrichten“, sondern den Satz mit den Ständen (`nichtEinloesbarSatz`, derselbe wie die 409), am Einsatz ebenso statt Einrichten, Bearbeiten und Verwerfen.
  Der Satz trägt `data-entscheid-schritt` (mit `tabIndex=-1`): der Schritt der Wiedervorlage landet auf ihm, nie auf „Einrichten“.
- Entscheid c (Sicherheitsnetz, auch für eine ältere API ohne die Felder): scheitert das Einlösen, merkt sich die Seite die schon angelegte Messstelle, und die Reihe bietet „MS-23 zuordnen“ statt „Einrichten“ (`zuordnenText`); der Knopf löst ohne Dialog mit derselben Messstelle ein - wiederholtes Klicken legt nie eine weitere an.
  ⚠ In der Demo zitieren vier Stände MB-1 (in der Referenzwelt ist MB-1 längst durch MS-23 eingelöst); mit einer Demo-API, die `einloesbar` kennt, steht dort der Satz statt „Einrichten“, mit einer älteren das Sicherheitsnetz.
- Eingelöst wird oft erst, wenn der Dialog schon zu ist (die Antwort kommt nach dem Schließen): die Liste liest beim Schließen UND nach der Antwort des Einlösens neu.
  Damit das zweite Lesen nicht die Anfrage vom Schließen teilt, bündelt `request` (`api.ts`) nach jeder Änderung keine vorher gestartete GET-Anfrage mehr (Lesen nach Schreiben, `apiCoalesce.test.ts`).
- „Einrichten“ braucht `energieeinsatz.verwalten` am Unternehmen UND `messstelle.bearbeiten` am Standort des Orts; ohne beides steht rechts der Strich, am Telefon nichts.
- Der Satz nach dem Einlösen („Messbedarf MB-1 ist eingelöst - MS-23 … steht jetzt in der Liste.“) bekommt den Fokus erst, wenn der Dialog zu ist: eingelöst wird schon mitten im Dialog (nach dem Ort).
- „Messbedarf erfassen“ steht im Menü ⋯ der Liste (nur heute, mit `energieeinsatz.verwalten` und mindestens einem laufenden Einsatz) und öffnet denselben Dialog wie am Einsatz.
  Erfasst, bearbeitet und verworfen wird weiter auch am Energieeinsatz; der Einsatz im Satz der Reihe ist der Verweis dorthin.
- Die Dialoge der Messplanung tragen ihre Form selbst (`.vp-mp-dialog` in `Messplanung.css`): `BewertungPage.css` ist unter Messen nicht geladen.

## Wiedervorlage

- Der Schritt „Messstelle anlegen“ (`messbedarf_frist`) springt auf `#/portfolio/messstellen?entscheid=messbedarf_frist&kennzeichen=MB-1` (`eintragSprung` in `wiedervorlage.ts`).
- Ziel ist die Reihe mit `data-entscheid="messbedarf_frist"` und `data-entscheid-kennzeichen`; `useEntscheidFokus` fokussiert „Einrichten“ bzw. „MS-23 zuordnen“ (`data-entscheid-schritt`), bei einem zitierten Bedarf den Satz mit den Ständen, ohne Recht den Verweis auf den Einsatz.
- Die Messplanung am Einsatz trägt kein Ziel mehr.

## Prüfen

- `src/geplanteMessstellen.test.ts` (rein, mit der Liste), `src/pages/MessstellenPage.test.tsx` (Abschnitt „geplante Messstellen“), `src/wiedervorlage.test.ts`.
- `e2e/geplante-messstellen.spec.ts` auf der Bühne `e2e/geplante-messstellen.html` (`?person=JW|PH`, `&plan=zwei|leer`, `&beleg=1|einmal`, `&zitiert=1`, `&langsam=1`; Routen aus `src/test/messplanungBuehne.ts`); `GEPLANT_BILDER=<Ordner>` legt die Bilder ab.
