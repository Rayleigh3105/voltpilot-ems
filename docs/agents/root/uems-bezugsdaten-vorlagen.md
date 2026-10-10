# UEMS-Bezugsdaten: Zuordnungs-Vorlagen

AP-09 IP-14 baut `GET/POST /api/v1/bezugsdaten/vorlagen`. Eine Vorlage gehört dem
Kundenbereich; `POST` ohne `vorlage_id` legt Fassung 1 an, mit `vorlage_id` immer die
nächste Fassung. Vorhandene Fassungen werden nie geändert. Urheber und Zeitpunkt
stehen an jeder Fassung.

Die Vorschau `POST /api/v1/bezugsdaten/importe/vorschau` nimmt alternativ zum Teil
`zuordnung` den Multipart-Teil `vorlage_id`. Sie löst die aktuelle Fassung auf und
antwortet mit `vorlage: {vorlage_id, fassung, name}`. Dieser Verweis ist der
Anschlusspunkt des Import-Schreibwegs: `bezugsdaten_import.vorlage_id` und
`vorlage_fassung` müssen genau diese benutzte Fassung festhalten.

`bezugsdaten_vorlage_bezug` normalisiert die in einer Fassung genannten
Bezugsgrößen. Die Tabelle ist mandantengezäunt, hat Fremdschlüssel auf Vorlage und
Bezugsgröße und wird beim Offboarding vor `bezugsdaten_vorlage` entfernt.

Die Vertragsformen stehen in `BezugsdatenVorlageDto`, die reine OpenAPI-Prüfung in
`BezugsdatenVorlageSchnittstelleVertragTest`, die API-Abnahme in
`BezugsdatenImportVorschauApiTest#vorlageAendernIstNeueFassungUndAlterImportBleibtBeiFassungEins`.
