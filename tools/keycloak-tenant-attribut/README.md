# keycloak-tenant-attribut

Betreiber-Skripte, um das Keycloak-Attribut `tenant_id` von Kundenkonten zu prüfen und, wo eindeutig belegt, zu reparieren.
Ohne dieses Attribut trägt das Token keinen `tenant_id`-Claim; der Kundenbereich bleibt leer, RLS liefert nichts, jede mandantengebundene Schreibroute scheitert.
Hintergrund und Laborbefunde: `firstmate/data/vp-tenant-attribut-diagnose/report.md`.

## Dateien

| Datei | Zweck |
|---|---|
| `tenant-attribut.sh` | Einstieg, alle Unterbefehle; Kopf erklärt Umgebung und Aufruf |
| `tenant_attribut.py` | Auswertung (nur Python-Standardbibliothek), spricht selbst mit niemandem |
| `db-wahrheit.sql` | DB-Teil des Sweep, rein lesend, Muster `tools/betriebsabfragen` |
| `keycloak-dump-zeitlinie.sql` | Zeitlinie aus der Keycloak-DB (Tages-Dumps oder laufend), rein lesend |

## Schnellweg für den Betreiber

Auf k3s-1, in diesem Ordner (python3 genügt, kein jq nötig):

```sh
./tenant-attribut.sh anmelden            # zeigt den kcadm-Anmeldebefehl; kcadm fragt das Passwort selbst
./tenant-attribut.sh profil              # Exit 0 gut, 1 Fehler, 3 kritisch
./tenant-attribut.sh profil-angleichen   # nur wenn profil nicht 0: zeigt die Abweichung; danach mit --ausfuehren
VP_DB_URL='...BYPASSRLS-Rolle...' ./tenant-attribut.sh sweep      # nur lesend: befund.txt, befund.csv, plan.csv
./tenant-attribut.sh reparatur tenant-attribut-<Zeit>/plan.csv    # Trockenlauf
./tenant-attribut.sh reparatur tenant-attribut-<Zeit>/plan.csv --ausfuehren
./tenant-attribut.sh token <benutzername>  # Beleg: tenant_id im Token, wie das Portal es bekäme
./tenant-attribut.sh aufraeumen          # kcadm-Anmeldung aus dem Pod entfernen
```

**Reparatur-Vorgabe ist der Trockenlauf.** `reparatur <plan.csv>` zeigt ohne `--ausfuehren` nur, was gesetzt würde; erst der zusätzliche Schalter `--ausfuehren` schreibt.

## Vorbedingungen

- **Reihenfolge ist Pflicht:** erst `profil` / `profil-angleichen`, dann `sweep`/`reparatur` mit Attributen; sonst meldet kcadm Erfolg und Keycloak verwirft den Wert.
- **Keine Geheimnisse:** Das Skript fragt nie nach Passwörtern; kcadm meldet sich vorher selbst im Pod an. Clients werden nur mit `--fields id,clientId` gelesen; Tokens erscheinen nur als Beispiel-Token-Inhalt (Claims, keine Signatur, kein Geheimnis).
- **Personendaten:** `befund.txt`, `befund.csv`, `db.csv` und `token/` enthalten Namen und E-Mail-Adressen; sie bleiben beim Betreiber (umask 077).
- **Nur `tenant_id`:** Die Reparatur ändert genau dieses eine Attribut; keine Rollen, kein Löschen, kein Überschreiben eines vorhandenen anderen Werts.
- **Mehrere Keycloak-Replikate:** kcadm merkt die Anmeldung je Pod; das Skript warnt, dann `KC_ZIEL=pod/<name>` setzen.
- **DB-Zugriff für `sweep`:** `VP_DB_URL` wie bei den Betriebsabfragen (`tools/betriebsabfragen/README.md`), Rolle mit BYPASSRLS.

Einzelheiten, Schritte und Rückwege stehen in Abschnitt 4 von `firstmate/data/vp-tenant-attribut-diagnose/report.md`.
