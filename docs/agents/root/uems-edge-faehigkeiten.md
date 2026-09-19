# Box-Fähigkeiten (AP-06 IP-18)

[Vertrag, Semantik und Mischbetrieb](../../contracts/v2/edge-supports.md).

- `BoxFaehigkeiten.kann` ist der Cloud-Einstieg für „kann Box X Fähigkeit Y?“;
  gemeldet ODER laut Versions-Tabelle, RLS-gebunden. Keine eigenen Versionsvergleiche.
- `assignment_effective_at` ist bekannt, aber lokal nicht gebaut und wird nicht gemeldet.
  Quellenübergabe zum Zeitpunkt ist heute Cloud-Verhalten, keine lokale Fähigkeit.
- `measurement_sample_provenance` verspricht die gebaute 2.1-Herkunft, keinen neuen Messplan.
- `events` (seit AP-07 IP-19) verspricht den gebauten Ereignis-Weg `…/v2/events`, nicht das
  ganze Vokabular: sechs Box-Arten, kein `clock_jump` · [Box-Seite](uems-box-ereignisse.md).
- `automation_paused_until_revoked` wird gemeldet, weil `entities.Registry` das Feld liest und
  `Paused` die Ruhe tatsächlich bis zum Widerruf hält. Der gemeinsame Go-Test koppelt beides.
- `edge-supports-vectors.json`: Go `cloud/edge_supports_test.go`, Java
  `EdgeSupportsListenerTest`, TS `edgeSupportsVectors.test.ts` gemeinsam prüfen.
  Die bestehenden `data-source-vectors.json`-Leser prüfen weiterhin die Tabellenregel.
- Status 1.0 und Laufzeitversion unverändert; das Paket schneidet kein Edge-Release.
