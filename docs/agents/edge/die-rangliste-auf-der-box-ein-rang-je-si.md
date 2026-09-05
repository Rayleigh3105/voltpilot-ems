# Die RANGLISTE auf der Box: EIN Rang je Sitzung, EINE Menge zweimal gelesen (P6)

Ausgelagert aus `edge-app/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 86).


Cloud-Seite, Migration und die Trennung „wirkt sofort / braucht das Release":
root `AGENTS.md` „Verbrauchsmanagement v1 - Paket 6". Was HIER gelten muss:

- **⚠ `Session.Rank == 0` IST DIE KOMPATIBILITAETS-ZUSAGE DES GANZEN PAKETS.**
  Ohne einen einzigen Rang verteilt `lastmgmt.Decide` byte-identisch wie vor P6
  - festgenagelt von `TestWithoutASingleRankTheAllocationIsByteForBytePreP6`
  (ueber-abonnierte Vorrang-Menge, vier Rotations-Epochen, plus die Gegenprobe,
  dass der ungerankte Rest sehr wohl rotiert). Wer die Gruppierung anfasst,
  faehrt diesen Test.
- **⚠ GLEICHE RAENGE SIND GLEICHRANGIG, und sie ROTIEREN.** Die Flaeche zeigt
  die Saeulen EINER Seite des Speichers als EINE Zeile, der Kunde hat zwischen
  ihnen also gar keine Reihenfolge gewaehlt; verschiedene Zahlen behaupteten
  eine, und die Box hoerte auf, zwischen ihnen abzuwechseln. `rankGroups`
  rotiert deshalb JEDE Gruppe - mit GENAU EINER Ausnahme: die alte
  Vorrang-Menge (`rankLegacyPriority`) rotiert NICHT, denn genau das war ihr
  Verhalten vor P6.
- **⚠ ZWEI LANE-ZAEHLER, BEIDE bei jeder Zuteilung dekrementiert.** Die
  Ueberschuss-Bahn der Saeulen UNTER dem Speicher ist eine TEILMENGE der Bahn
  darueber (`belowLane ⊆ aboveLane`) - zwei unabhaengige Toepfe waeren dieselbe
  Sonne zweimal ausgegeben. `takeSource` zieht deshalb von beiden ab, und
  `sourceRest` liefert je Sitzung die KLEINERE, die sie erreichen darf.
- **`BeforeStorage(rank, storageRank, site)` ist die EINE Regel** und faellt
  ohne beide Zahlen auf die anlagenweite `storage_priority` zurueck - also auf
  exakt das Verhalten vor P6. Sie wird in `ocppSessions` EINMAL je Sitzung
  ausgewertet; `carsBeforeStorageKw` benutzt dieselbe Regel fuer die
  Speicher-Klemme, damit Verteilung und Klemme nie auseinanderlaufen.
- Die Raenge reisen im BESTEHENDEN retained `charging-config`-Dokument
  (`charge_points[].rank`, top-level `storage_rank`); ein UNPLAUSIBLER Rang
  wird verworfen (0 = ungerankt), ein unplausibler `storage_rank` laesst den
  gespeicherten stehen - die PATCH-Disziplin dieses Pfads.

