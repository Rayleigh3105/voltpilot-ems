# UEMS-Übersicht „Ziele und Maßnahmen“ (AP-18 IP-19, F1–F3, W7, E5 = A)

Neu am 24.09.2026: `VerbesserungUebersichtController` → `uems/VerbesserungUebersicht`, DTO
`web/dto/VerbesserungUebersichtDto`; Portal `verbesserungUebersicht.ts` (reines Bild) +
`components/VerbesserungUebersichtKarte.tsx`, Katalog-Eintrag `ziele-massnahmen` in beiden `anwendungen/catalog.json`.
Keine Migration, kein Läufer, kein Ereignis, keine Nachricht.

| Route | Recht | Was |
|---|---|---|
| `GET /api/v1/verbesserung/uebersicht` | `verbesserung.ansehen` (Kommentar, kein `@Recht`) | Zähler aus R9 (`auffaelligkeiten_offen` … `messbedarfe_ueberfaellig`), `faellig[]` je überfälliger Maßnahme/Abweichung bzw. Energieziel mit fälliger Bewertung (`satz` = §5.9 „Überfällig“, beim Energieziel `null`), am längsten fällig zuerst |

⚠ **Rechnet nichts selbst:** Maßnahmen und Energieziele kommen aus `MassnahmeService.liste` bzw.
`EnergiezielService.liste` (deren `frist`), Abweichung und Messbedarf gehen durch `VerbesserungRegeln.frist`. Abruf-Tag
= `KennzahlService.jetzt()` in der Zeitzone des Unternehmens — Tests stellen die Uhr mit `uhrStellen`, nie ein
Parameter. ⚠ **W7:** der Messbedarf (AP-16) wird nur über `MessbedarfService.alle(null)` gelesen (sein Zaun); der
Vertrag kennt keine Frist-Art `messbedarf`, er läuft durch die Art `abweichung` (Tag, offen solange `offen`).
⚠ **Zaun:** RLS `site_scope` + Kennzahl lesbar (auch beim Energieziel, obwohl dessen Register nur RLS nimmt); ein Anstoß
zählt nur mit sichtbarem Vorgang. Außerhalb zählt nichts — die Route hat keine ID, also kein 404.
⚠ **Portal:** die Kachel erscheint nur am Unternehmen und nur, wenn ein AP-18-Vorgang etwas verlangt (R13); ein
überfälliger Messbedarf allein öffnet sie nicht. Sprung: jeder fällige Vorgang auf seine Seite (`energiezielRoute`,
`massnahmeRoute`, `abweichungRoute`; `verbesserungUebersicht.ts#sprungDerZeile`). Nachweis: `VerbesserungUebersichtApiTest`
(R9, W7, R13, Zaun), `VerbesserungUebersichtSchnittstelleVertragTest`, `VerbesserungUebersichtKarte.test.tsx`.
