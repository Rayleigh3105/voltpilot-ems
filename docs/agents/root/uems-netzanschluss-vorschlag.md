# Netzanschluss: vorverknüpfter Anlegevorschlag

Entscheid vom 16.09.2026: vorhandene Anlage und Beginn ihrer Standortzuordnung
vorauswählen; Name „Netzanschluss <Anlagenname>“ und nächste freie NA-Kennzeichen
vorschlagen. Vertragsdaten ergänzt der Kunde. Die acht Preis-/Grenz-/Freigabespalten
an `site` liefern **keine** eindeutigen Anschluss-Stammdaten; insbesondere ist
`max_feed_in_kw` keine vereinbarte Bezugsleistung. `strompreis_ct_kwh` wurde schon
mit V20260708010000 entfernt. Kein Preisumzug (W9).

- `NetzanschlussVorschlagService`: `GET …/netzanschluesse/vorschlaege` liest nur;
  die aktive Messfunktion wird über `FunktionService.misstAktiv` aus genau denselben Fakten wie
  `GET /funktionen` abgeleitet — beim regulären Kundenweg nie aus dem gespeicherten `funktion.zustand`;
  ein historisch gespeichertes `aktiv` bleibt nur als Bestandsschutz gültig. Dazu heutige
  Standortzuordnung und keine frühere wirksame
  (auch beendete/geplante) Bindung. Eine aufgehobene Bindung schließt nicht aus.
  Keine Kennzeichenreservierung, kein stiller Anschluss, kein Schreibzugriff auf `site`.
- `POST …/vorschlaege/{anlageId}/uebernehmen`: unter derselben Unternehmenssperre
  wie manuelles Anlegen/Binden erneut prüfen, dann `NetzanschlussService.anlegen`
  und `.binden` in EINER Transaktion. Fehler rollen Anschluss, Kennzeichen,
  Protokoll und Entscheidung zurück. Wiederholung oder veralteter Vorschlag: 409.
- `POST …/vorschlaege/{anlageId}/verwerfen`: Entscheidung je Anlage merken;
  danach nicht mehr vorschlagen, auch nach Umzug. Manuelles Anlegen bleibt möglich.
  V20260916210000: leere Tabelle mit RLS/FORCE, nur SELECT/INSERT; Site-Löschung
  entfernt die Entscheidung per CASCADE. Mandanten-Offboarding berücksichtigt sie.
- Alle drei Routen brauchen `netzanschluss.verwalten` (GET im Dienst, POST über
  `@Recht`); Rückwirkung zusätzlich
  `aenderung.rueckwirkend` und Begründung. Fremdes Objekt: 404.
- `NetzanschlussVorschlaege` im bestehenden Standort-Reiter nur mit Recht;
  `NetzanschlussDialog` zeigt Ergänzen und Bindung gemeinsam. Messung bleibt im
  Vorschlag leer und ist Pflicht nach `felder`; andere Vertragsangaben freiwillig.
  Bindungsbeginn ist änderbar, **kein** Bestehensdatum des Anschlusses.
- Route/DTO: `docs/contracts/openapi.yaml`; Regeln unverändert in
  [Netzanschluss](uems-netzanschluss.md), Portalbasis in
  [Netzanschlüsse am Standort](uems-netzanschluss-portal.md).

Prüfen: `NetzanschlussApiTest` (Ahrenberg, vollständiger Site-Vorher/Nachher-Vergleich,
Wiederholung, Verwerfen, Rückrollen, Betriebskunde/Mandantenzaun),
`NetzanschlussSchnittstelleVertragTest`, sechs Migrationsnachbarn.
Portal: `apiNetzanschluss`, `netzanschlussListe`, `e2e/netzanschluesse.spec.ts`
(375/1440, zweimal); gemeinsame Flüsse: `standort-ebenen`, `energiebilanz`, `telefonleiste`.
