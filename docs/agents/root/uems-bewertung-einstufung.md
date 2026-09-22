# Einstufungs-Fassungen der energetischen Bewertung

AP-16 IP-11 setzt keine Einstufung aus Zahlen. `BewertungRanglisteService` liefert nur
Urteil, Vorschlag und Herkunftsentwurf; `EnergieeinsatzEinstufungService` speichert erst
die Entscheidung einer Person mit Begründung und vollständiger Herkunft.

- Vertrag und Routen: [`docs/contracts/v2/bewertung.md`](../../contracts/v2/bewertung.md#11-einstufungs-fassungen-ip-11-f1f5)
- Datenhaltung: `V20260922237000__uems_energieeinsatz_einstufung.sql`
- Abnahme: `EnergieeinsatzEinstufungApiTest`

Fallen: Der Vorschlag ist nie eine Einstufung. Eine Rückstufung ist eine neue Fassung;
alte Fassungen bleiben lesbar. Bei Vier-Augen bleibt die bisherige Fassung bis zur
Bestätigung durch eine zweite Person wirksam. Der Historien-GET hat kein `@Recht`.
