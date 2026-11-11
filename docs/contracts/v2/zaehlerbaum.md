# Zählerbaum

Wo ein Zähler oder ein gemessener Verbraucher im elektrischen Baum einer Anlage hängt (Konzept
`vp-zaehlerbaum-konzept`, Captain-Entscheide E1-E5 vom 10.11.2026, alle A). Gilt für private und
gewerbliche Anlagen gleich. Gemeinsame Testvektoren: [zaehlerbaum-vectors.json](zaehlerbaum-vectors.json),
Zwillinge `ZaehlerbaumRegeln` (Java) und `zaehlerbaum.ts` (TS).

## 1. Das Modell

Eine Anlage ist ein Baum aus Zählern. Die Wurzel ist der Netzanschluss; jeder Unterzähler und
jeder gemessene Verbraucher (Heizstab, Wärmepumpe, ein Kompressor hinter einer Unterverteilung)
hängt an genau einem anderen Zähler derselben Anlage, beliebig tief. Was nicht ausdrücklich
woanders hängt, hängt an der Wurzel - jede Bestandsanlage ist am ersten Tag zeichengleich zu
heute.

Gespeichert wird die Zuordnung am GERÄT im Aufbau (`komponente_haengt_an`, tagesgenau wie
`messstelle_stellung`), für jede Anlage, auch ohne „Messen & Auswerten“ (E1 A). Für eine Anlage
mit Messen übernimmt derselbe Schreibweg die elektrische Stellung der gebundenen Messstelle
(§4).

## 2. Die Regeln (R1-R6)

1. **R1 Jede Kilowattstunde genau einmal.** Ein Kind steckt im Wert seines Elternknotens. Ein
   Rest zieht nur direkte Kinder ab; eine Summe über Ebenen hinweg gibt es nicht. Ein
   Gruppenkopf zeigt den gemessenen Wert des Elternknotens, nie eine Summe seiner Kinder.
2. **R2 Fehlt ein Wert, fehlt der Rest.** Meldet ein Kind nicht oder ist sein Wert veraltet, ist
   der Rest seines Elternknotens „nicht bestimmbar“, mit Namen und Grund; der gemessene
   Elternwert bleibt stehen. Fehlt der Elternwert, stehen die Kinder; der Elternknoten zeigt
   „–“ mit Grund, und eine Summe der Kinder darf höchstens als „mindestens …“ erscheinen.
3. **R3 Kind größer als Eltern.** Liegt der Rest unter minus Toleranz (0,2 kW), steht
   „Messwerte passen nicht zusammen (−X kW)“ am Rest des Elternknotens, nie auf 0 geklemmt.
4. **R4 Vorzeichen.** Ein Unterzähler misst seinen Zweig in Bezugsrichtung. Ohne Erzeugung oder
   Speicher darunter gilt der Betrag; Erzeugung/Speicher hinter einem Unterzähler ist ein
   späterer Schritt (außerhalb dieses Umfangs) - Erzeuger und Speicher hängen an der Wurzel.
5. **R5 Umhängen ist zeitgültig.** Tagesgenau wie die Stellung in Messen: „umgebaut am Tag X“
   beendet die alte Zuordnung am Vortag, „war schon immer so“ ersetzt sie ab ihrem Beginn und
   bleibt als aufgehobene Zeile lesbar.
6. **R6 Plausibilität beim Einhängen.** Geprüft in dieser Reihenfolge (422 `haengt_an_ungueltig`
   mit Grund):
   `wurzel_haengt_nirgends` (der Netzanschluss - Rolle `grid-meter` - bekommt nie eine
   Eltern-Komponente) → `selbst` (nie an sich selbst) → `fremde_anlage` (die Eltern-Komponente
   muss zur selben Anlage gehören) → `eltern_kein_zaehler` (die Eltern-Komponente ist ein
   Zähler: Rolle `grid-meter` oder Entitätstyp `sub-meter`) → `zyklus` (das Urteil trägt die
   Kette). Kein Eltern (`haengt_an = null`) ist immer gültig - das ist die Wurzel-Vorgabe.
7. **R7 Box.** Die Box braucht den Baum nicht: sie misst jeden Zähler wie bisher und rechnet das
   Haus wie bisher. Der Baum ist Sache von Cloud und Portal.
8. **R8 Optimierer und Steuerung.** Unverändert: der Plan rechnet mit dem Haus, nicht mit
   Unterzählern; keine Rolle, keine Regel, kein Budget ändert sich. `haengt_an` taucht nie in
   Registry-Push, Desired-State oder Optimierer-Eingang auf.

## 3. Topologie

Der Verbraucher-Knoten der Topologie (`topology-read-model.md`) trägt als Wert nur den
Haus-Wert (das Mitglied vom Typ `house-load`), nie Haus plus Mitglieder - jedes Mitglied trägt
zusätzlich `haengt_an` (die Eltern-Entität-Id oder `null` für die Wurzel). Details und Vektoren
in [topology-read-model.md](topology-read-model.md) und den gemeinsamen
[topology-vectors.json](topology-vectors.json).

## 4. Messen (UEMS)

Für eine gerätegebundene Messstelle (über die Quellenbindung `messstelle_quelle`) schreibt der
Schreibweg, der `haengt_an` setzt, im selben Schritt die elektrische Stellung der gebundenen
Messstelle mit: „Unterzähler von“ wird auf die Messstelle gesetzt, die an der Eltern-Komponente
gebunden ist (falls eine gebunden ist), ab demselben Tag. Lässt sich das nicht eintragen (z. B.
weil `MessstelleRegeln.stellungPruefen` ablehnt), ändert sich die Geräte-Zuordnung trotzdem -
eine Prüfung meldet die Abweichung, statt sie still zu korrigieren oder die Geräte-Änderung
abzulehnen. `docs/contracts/v2/messstelle.md` §6 (AP-04 E12) bleibt unverändert maßgeblich für
die Stellung selbst.

## 5. Außerhalb dieses Umfangs

Schutz je Unterverteilung (eine Sicherung je Unterverteilung) - erst dann braucht die Box den
Baum, wie heute den Anschluss eines Ladepunkts (`haus`/`eigen`). Eigener Entscheid, nicht Teil
dieses Vertrags.
