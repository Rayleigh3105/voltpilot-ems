# Übungen des Betreibers (AP-20 IP-19)

Eine Wiederherstellung zählt nur mit Übung und Artefakt (BT1). Ein Alarm, der nie ausgelöst
wurde, ist nicht geliefert (NR8). Dieser Ordner hält beides fest: je Übung eine Datei
`U-JJJJ-nn.json` nach [`../uebung.schema.json`](../uebung.schema.json), das Artefakt daneben im
Ordner `U-JJJJ-nn/`. **Der Betreiber fährt die Übung, die Crew trägt sie ein und liest nur
Zählungen und Dauern** (AP-14 E3). Betreiber-Dokument, nie auf einer Kundenfläche (G2).

Heute steht hier keine Übung. Z-015 bleibt `offen`, L-003 `in_arbeit` (Stand 25.09.2026).

| Übung | Wann | Beleg für | Artefakt |
|---|---|---|---|
| Rückweg-Übung (AP-14 NW-8) | **vor dem Rollout** (BT2, Tor G1), danach alle sechs Monate (BT1, Startwert E11 = A) | Z-015 „Wiederherstellung geübt“ | `rueckweg.json` aus `tools/generalprobe/rueckweg.sh` |
| Q15 „WAL-Archiv läuft“ | vor dem Rollout (Tor G1 M-1b) | Z-015, zusammen mit der Rückweg-Übung | keines: Wort des Betreibers im Stand-Blatt, Punkt `q15_wal_archiv` |
| Alarm-Übung `VoltPilotSicherungZuAlt` | nach dem gitops-Merge der Regel | L-003 (NR8) | `zustellung.txt`: die angekommene Meldung, wörtlich |

Die nächste Übung ist **beim Abruf** fällig, gerechnet vom Datum der letzten durchgeführten.
Kein Läufer, keine Nachricht.

## Rückweg-Übung und Q15

1. Q15 lesen: `tools/betriebsabfragen/bestand-vor-uems.sql` (Teil C) und auf der VM
   `/srv/docker/voltpilot/tools/backup/vp-db-backup-check.sh`. Beides ohne Befund, dann im
   Stand-Blatt `q15_wal_archiv` mit `bestaetigt: ja`, `am:`, `durch:` und `beleg:` setzen (Form und
   Beispiel in [`tools/freigabe/freigabe-stand.example.yaml`](../../../tools/freigabe/freigabe-stand.example.yaml)).
2. Rückweg fahren, wie [`tools/generalprobe/README.md`](../../../tools/generalprobe/README.md) es
   beschreibt (`rueckweg.sh … --output /BETREIBER/rueckweg.json`). Nur eine wiederhergestellte
   Kopie, nie die Produktion.
3. `rueckweg.json` an die Crew geben. Die Datei trägt nur Zählungen und Dauern.
4. Die Crew legt sie als `U-JJJJ-nn/rueckweg.json` ab und füllt
   [`vorlage-wiederherstellung.json`](vorlage-wiederherstellung.json) als `U-JJJJ-nn.json` aus.
   `zustand` und `ergebnis` schreibt sie so, wie die Datei sie trägt; die Prüfsumme mit
   `shasum -a 256`.
5. `python3 tools/bewertung/uebungen.py --stand <stand-blatt>` rechnet das Ergebnis am Artefakt
   nach und zeigt die Zeile der Betreiber-Liste, etwa
   `U-2026-01 · Wiederherstellung · 21 min · Zählungen gleich · 05.10.2026 · Betreiber · nächste fällig 05.04.2027`.
   Dieselbe `rueckweg.json` belegt im Tor-Prüfer NW-8 (`--generalprobe`).

`durchgefuehrt` heißt: `exit_code` 0, Flyway-Stand und Q01 bytegleich, Dauer bekannt. Alles andere
ist `fehlgeschlagen`. Auch eine fehlgeschlagene Übung wird eingetragen; sie belegt nichts.

## Alarm-Übung `VoltPilotSicherungZuAlt` (NR8)

Voraussetzung: Export auf der VM eingerichtet
([Sicherungsalter als Metrik](../../backup-restore.md#sicherungsalter-als-metrik-ap-20-ip-19)) und
die Regel in gitops gemergt und ausgerollt
([Vorschlag](../vorschlaege/gitops/README.md)). Die Übung fasst keine Sicherung an. Sie lässt
nur die Metrik für eine Viertelstunde „keine Sicherung“ sagen.

```bash
# auf 192.168.178.128, als root
systemctl stop vp-db-backup-metrics.timer
install -d -m 0755 /tmp/vp-uebung-leer
/srv/docker/voltpilot/tools/backup/vp-db-backup-metrics.sh --backup-dir /tmp/vp-uebung-leer
# nach 10 min + einem Scrape: zwei Zeilen VoltPilotSicherungZuAlt (teil basis und wal,
# zustand keine) kommen beim Empfänger an; die Meldung wörtlich sichern
systemctl start vp-db-backup-metrics.service   # schreibt sofort den echten Stand
systemctl start vp-db-backup-metrics.timer
rmdir /tmp/vp-uebung-leer
# die Entwarnung abwarten und ihre Ankunftszeit notieren
```

Die angekommene Meldung wird `U-JJJJ-nn/zustellung.txt`, die Übung
[`vorlage-alarm.json`](vorlage-alarm.json). Erst mit dieser Übung ist L-003 behoben (RF-06), mit dem
Stand des gitops-Merges als Nachweis.
