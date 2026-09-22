# Energetische Bewertung: reine Regeln (AP-16 IP-2, NW-1)

Verbindlich: [Bewertungsvertrag](../../contracts/v2/bewertung.md),
[Vektoren](../../contracts/v2/bewertung-vectors.json),
[Schema](../../contracts/v2/bewertung.schema.json).

Java `uems/BewertungRegeln`, TS `uemsBewertung.ts`, Python
`voltpilot_optimization/bewertung.py` rechnen jeden Vektor derselben Datei.
Die Python-Referenz stammt aus AP-16 `k_faelle.py`; Schwellenvergleiche sind gemäß
KR4 auf ungerundete Kreuzprodukte korrigiert. 9,95 % wird als 10,0 % angezeigt,
erfüllt aber K1 ≥ 10 % nicht. K2 benutzt die kumulierte Menge VOR der Zeile.

Nenner nur aus Anlagenbilanzen; eine fehlende Anlage macht ihn unbekannt, nie
kleiner. Einsatzmenge nur aus direkt zugeordneten gemessenen Messstellen:
Prozess-Summen/Verteilung zählen nicht. Ersatz ist Teil der Menge. Resthinweise
am Einsatz nicht erneut summieren: für den Umfang jeden Anlagenrest einmal.
K4 ist Wortlaut einer Person, kein maschinelles Urteil; das Modul stuft niemanden ein.
Noch keine Produktivaufrufer, Datenhaltung oder Flächen (eigene Folgepakete).

Prüfen: `BewertungVectorsTest`, `uemsBewertung.test.ts`, `tests/test_bewertung.py`.
Schema-Negativproben verwerfen Zusatzfelder und Float-Mengen. Für den gesamten
Optimierer-Lauf muss das Forecast-Paket verfügbar sein (lokal etwa
`PYTHONPATH=../forecast .venv/bin/python -m pytest -q -m 'not slow'`).
