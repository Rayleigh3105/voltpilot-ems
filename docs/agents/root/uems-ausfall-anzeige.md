# UEMS-Ausfall-Anzeige je Standort (AP-06 IP-17)

`GET /api/v1/standorte/{standortId}/ausfall` ist die reine Lesesicht für die sichtbare
Ausfall-Anzeige. Die Route trägt den Rechte-Kommentar `messstelle.ansehen`, aber als GET kein
`@Recht`; ein fremder Standort ist durch RLS und Standort-Zaun 404.

Die Sicht liest nur die jüngste Fortschreibung offener `data_gap`-Ereignisse mit der belegten
Fehlerklasse `box_meldet_sich_nicht`. Eine gemessene Messstelle bekommt Box und Beginn über das
offene Ereignis ihrer laufenden Datenquelle. Berechnete Messstellen nennen nur die fehlenden
Eingänge der vorhandenen Register-Ableitung. Ohne Ereignis-Fakt nennt keine Fläche eine Box als
Ursache (`ausfallAnzeige.test.ts`). Standortkarte und Anlagenkopf lesen dasselbe Aggregat.

Bekannte Grenze: `LueckenMelder` bildet den Herzschlag-Fakt derzeit aus Telemetrie- und
Messwerteingängen. `device_status_seen_at` ist zwar gebaut, aber noch nicht als Eingang des Melders
angeschlossen. IP-17 leitet deshalb keine zweite Ursache her; fehlt das Ereignis, zeigt das Portal
weniger.

Prüfstellen: `StandortApiTest#a2A15AusfallAm03112026LiestNurFestgehalteneFaktenUndFremdBleibt404`,
`ausfallAnzeige.test.ts`, `RechtRoutenArchitekturTest`, `RechteKennungenDerRoutenTest` und
`SiteScopeArchitekturTest`.
