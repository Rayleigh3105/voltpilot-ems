# Mehrere Boxen je Standort und Anlage

Ein Standort und eine Anlage können mehrere aktive VoltPilot-Boxen haben. Die Identität der
Box ist `device`; eine Datenquelle nennt ihre zuständige Box getrennt davon. Anlagenweite
Aufgaben verwenden die eine führende Box aus `FuehrendeBoxAbleitung`: gespeicherte Wahl,
sonst Speicher-Box, sonst einzige Box, sonst keine. Listenreihenfolge ist nie ein Ersatz für
diese Ableitung.

## Lesemodelle

- `/api/v1/devices` liefert `fuehrtAnlage` für die Kundenfläche. Verbindung folgt der
  Status-Ankunft in `device.device_status_seen_at`; nur bis zum ersten Status-Herzschlag gilt
  die letzte Telemetrie-Ankunft als Bestandsschutz.
- `Standort › Boxen` und die Box-Seite ordnen Quell-Rückmeldung und Budget über
  `zustaendige_box` zu. Details und Leerzustände stehen in [Box-Übersicht](uems-box-uebersicht.md).
- `GET /api/v1/admin/fleet` bleibt ein einziger, mit dem vorhandenen Plattform-Admin-Recht
  geschützter Cross-Tenant-Read. `sites[]` sind die Anlagen-Gruppen; ihr additives `boxes[]`
  trägt je aktive Box Identität, Rolle, letzte Meldung und die beiden vorhandenen
  Versionsblöcke. Anlagenwerte wie Plan, Quellen-Summe und Pflege-Signale werden nicht als
  Box-Werte ausgegeben.

Der Admin-Read verwendet keinen Kunden-Umschalter und bekommt als lesende Route kein `@Recht`.
Die BYPASSRLS-Verbindung bleibt auf `AdminFleetRepository` begrenzt und schreibt nichts.

## Software und Fähigkeiten

Die einzige Laufzeittabelle im Portal ist `BOX_FAEHIGKEITEN` in `boxUebersicht.ts`, gepinnt
gegen `docs/contracts/v2/edge-capabilities.json`. Kunden-Boxseite und Admin-Flotte rufen beide
`uemsDatenquelle.faehigkeiten` mit dieser Tabelle auf. Kein Aufrufer pflegt eine zweite Liste.
Ein unbekannter oder nicht registrierter Stand beweist keine Fähigkeit; die Fläche zeigt die
fehlenden Fähigkeiten. Die Release-Ordnung kommt ausschließlich aus `release_seq`.

## Nachweise

`AdminApiTest.adminFleetAggregatesEveryTenantServerSideAndStaysRoleGated` pinnt zwei Boxen in
einer Anlage samt getrennter Version und führender Rolle. `adminFleet.test.ts` prüft die reine
Gruppierung und Fähigkeitsableitung; `PlattformUebersichtPage.test.tsx` sowie
`e2e/admin-flotte.spec.ts` prüfen die gebaute Admin-Fläche.
