# UEMS-Kostenstelle, Prozess und Messstelle → Prozess (AP-10 IP-7)

Neu am 13.09.2026. Zwei Achsen aus AP-00 E5: die **Kostenstelle ist flach**, der **Prozess hat
höchstens ein Elternteil und nur eine Ebene**. Beide bestehen von `gueltig_ab` bis `gueltig_bis`
(Tage, der letzte einschließlich — dieselbe Zeitform wie Ort und Stellung) und werden **beendet, nie
gelöscht**. Eine Messstelle gehört je Tag zu 0..n Prozessen, ohne Anteil. Konzept
`vp-uems-ap10-bilanzen` §4.2, §5.7, §8 IP-7.

| Was | Wo |
|---|---|
| Migration | `V20260913160000__uems_kostenstelle_prozess.sql` |
| Schreibweg und Regeln | `uems/KostenstelleProzessService` (+ `…Repository`, `…Abgelehnt` = geschlossener Satz) |
| Routen | `web/KostenstelleProzessController`: `…/unternehmen/kostenstellen`, `…/unternehmen/prozesse` (+ `/{id}`, `/{id}/beenden`), `GET/PUT /api/v1/messstellen/{id}/prozesse` |
| Rechte | `kostenstelle.verwalten`, `prozess.verwalten` (Zellen wie `unternehmen.bearbeiten`), Zuordnung `messstelle.bearbeiten`; lesen „keine eigene Kennung“ — Matrix-Nachtrag, keine Durchsetzung |
| Tests | `UemsKostenstelleProzessMigrationTest`, `KostenstelleProzessApiTest`, `KostenstelleProzessSchnittstelleVertragTest` |

## Was die Datenbank hält

- **Eine Ebene per Trigger** `prozess_eine_ebene`: das Elternteil hat kein Elternteil, und wer eins
  bekommt, hat keine Kinder. Das Elternteil wird `FOR SHARE` gesperrt — zwei gleichzeitige Schreiber
  können keine zweite Ebene bauen. Die App-Rolle setzt `eltern_id` nur beim Anlegen.
- **Eine Zuordnung gilt nie länger als ihr Ziel — von beiden Seiten, mit EINEM Trigger-Paar:**
  `uems_zuordnung_im_ziel(ziel, spalte, constraint)` hängt an der Zuordnung (heute
  `messstelle_prozess` → `prozess` und `prozess.eltern_id` → `prozess`);
  `uems_ziel_deckt_zuordnungen(constraint)` hängt am Ziel (`prozess`, `kostenstelle`) und lehnt ein Ende
  ab, das eine Zuordnung abschneiden würde. Welche Tabellen Zuordnungen eines Ziels sind, liest
  `uems_zuordnungen_ausserhalb()` aus **`pg_trigger`** — dieselbe Funktion füllt die 409-Liste.
- ⚠ **Die Verteilung (IP-8) hängt nur ihre Hälfte an:** `CREATE TRIGGER … EXECUTE FUNCTION
  uems_zuordnung_im_ziel('kostenstelle', 'kostenstelle_id', 'messstelle_verteilung_kostenstelle_besteht')`
  — dann gilt „ein Anteil gilt nie länger als seine Kostenstelle“ an beiden Seiten, ohne zweite Liste.
  Konvention der Zuordnungs-Tabelle: `tenant_id`, `gueltig_ab`, `gueltig_bis`, wahlweise
  `aufgehoben_am`. Die Migrationsprobe `einAnteilGiltNieLaengerAlsSeineKostenstelle` tut genau das
  gegen alle Anteile des Referenzunternehmens.
- ⚠ In PL/pgSQL setzt `EXECUTE … INTO` **kein `FOUND`** — `GET DIAGNOSTICS … = ROW_COUNT`.
- Kein DELETE für die App-Rolle; Kennzeichen je Kundenbereich eindeutig, auch nach dem Ende.

## Die drei eingelösten Stellen

1. **Bezugsgröße an Prozess/Kostenstelle** (AP-09 IP-4): Spalten `prozess_id`/`kostenstelle_id`,
   `bezugsgroesse_geltung_objekt_chk`, `bezugsgroesse_geltung_uq` und `bezugsgroesse_identitaet_bleibt`
   abgeschrieben und geweitet — BZ-1…BZ-3 passen.
2. **Routen der Bezugsgrößen** (AP-09 IP-5): `BezugsgroesseRegeln.GELTUNG_WAEHLBAR` = alle sieben;
   `geltung_nicht_waehlbar` bleibt im geschlossenen Satz des Vertrags (Regel mit Eingang `waehlbar`).
3. **`verteilung_ziel`** (AP-10 IP-5): Fremdschlüssel `(verteilung_ziel, tenant_id) → kostenstelle`.
   Die 422 `verteilung_wartet_auf_ip8` BLEIBT — sie wartet auf die Verteilung, nicht auf das Objekt.

## Fallen im Schreibweg

- **Satz ab Tag** (`PUT …/prozesse`): läuft am Tag und bleibt → dieselbe Zeile; läuft und gilt nicht
  mehr → endet am Vortag; beginnt an/nach dem Tag und passt nicht → aufgehoben (lesbar). Ein neues
  Intervall **endet mit seinem Prozess** (`endet_mit_prozess`); gleicher Satz noch einmal = nichts,
  kein Protokoll. Protokoll `prozesse_zugeordnet` in `messstelle_aenderung`.
- **Beenden**: nur vorziehen (später/gleich = 409 `bereits_beendet`), Tag vor Beginn 422, Zuordnung
  länger 409 `zuordnung_besteht` mit `zuordnungen[]` (`messstelle`/`unterprozess`) — nie still gekürzt.
- Schreibvorgänge unter der Sperre des Unternehmens; ohne Unternehmen 409 `unternehmen_nicht_angelegt`.
- Offboarding: `messstelle_prozess`, Unterprozesse, `prozess`, `kostenstelle` — nach Bezugsgrößen und
  Formel-Termen, vor `unternehmen`.
- Tests, die einen Verteilungs-Term schreiben, brauchen jetzt eine echte Kostenstelle.

## Offene Befunde (PR 717)

- **Kein Änderungsprotokoll an Kostenstelle und Prozess** (Report nennt keins): Umbenennen und Ende
  vorziehen hinterlassen keine Spur, anders als `ort_aenderung`/`bezugsgroesse_aenderung`.
- **Werte einer Bezugsgröße über das Ende ihres Prozesses/ihrer Kostenstelle hinaus**: BZ-1 an P-1,
  P-1 endet 31.12.2026 — ein Wert für März 2027 bleibt speicherbar, das Beenden meldet nichts (die
  Bezugsgröße hat keine Tage, ihre Werte schon). Entscheidung bei AP-10 IP-11 bzw. AP-09 IP-7.

**Nicht gebaut:** Verteilung (IP-8), Kostenstellen-Lesemodell (IP-11), Portal (IP-15), Durchsetzung (AP-03).
