# Die Speicher-Kachel nennt ihre QUELLE (P6 Speiser-Bindung)

Die Portal-Hälfte des Pakets P6 (Konzept `vp-deye-diybms-luecke-l5` §3.2b,
Captain-Entscheid E6 (a)). Der Server-Teil steht in
`../root/die-speiser-bindung-p6-die-eigene-batter.md`.

## Die Frage im Assistenten (`BatterieAssistent`, Schritt 3)

„Wozu gehört diese Batterie?" steht als eigener, abgesetzter Block direkt unter
dem Ladestands-Schritt — weil sie darüber entscheidet, WESSEN Ladestand dabei
herauskommt. Drei Kacheln (`bindung-unbound` / `bindung-feeds_inverter` /
`bindung-standalone`), Vorgabe **ungebunden**, mit dem Satz „VoltPilot ordnet
sie NICHT von selbst zu".

Der Speiser-Weg zeigt danach einen `VpPicker` mit den Speicher-Wechselrichtern
der Anlage (`speicherZiele` über `api.siteComponents`, ohne die selbst
angebundenen Batterien — eine Batterie an eine Batterie zu hängen wäre eine
Schleife). Hat die Anlage keinen, ist die Tür GESPERRT und ehrlich benannt
(„Diese Anlage hat noch keinen Speicher-Wechselrichter") statt lautlos zu
fehlen — die Form der Rezept-Galerie.

Die Regeln wohnen im reinen `batterieAnschluss.ts` (`bindungFehler`,
`bindungsKanaele`, `bindungWort`, `ladestandVon`) und sind Zwillinge der
Server-Regeln; `speicherRumpf` schickt den `binding`-Block IMMER mit — auch als
`unbound`, denn ein fehlender Block hiesse „nicht gefragt", und eine einmal
gelöste Bindung liesse sich sonst nie wieder lösen.

## Die Anzeige

- **Cockpit-Kachel** (`adaptiveLive.storageTile` → `livePuls` → `LivePuls.tsx`):
  `socQuelle` = „Ladestand von: &lt;Batterie&gt;" — NUR, wenn der Ladestand von
  einem anderen Gerät kommt als die Kilowatt der Kachel. Ein Hybrid, der seinen
  eigenen meldet, bekommt die Zeile nicht: sie wäre eine Wiederholung des
  Kachel-Namens. Daneben `grenzen` („max. 22 A laden · Entladen gesperrt").
- **Geräteseite** (`geraetGesicht.speicherKacheln` aus
  `GesichtInput.speicherKnoten`): der gebundene Ladestand gewinnt über das
  Schweigen des Wechselrichters, mit „Ladestand von: …" als Wort; „Laden (BMS)"
  / „Entladen (BMS)" stehen als eigene Kacheln daneben.

⚠ **Nebenbei behoben:** die P5d-HERKUNFT („berechnet: Kennlinie") wurde bisher
unter den FLUSS-Mitgliedern des Speicher-Knotens gesucht. Eine gebundene
Batterie ist keines — ihre Kilowatt bleiben beim Wechselrichter —, also kam ein
gerechneter Ladestand ungekennzeichnet an der Kachel an. Gefragt wird jetzt die
Entität aus `soc_source`; die Mitglieder bleiben der Rückfall.
