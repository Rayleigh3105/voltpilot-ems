# Betrachtungsumfang (AP-16 IP-5)

Verbindlich: [Bewertung §9](../../contracts/v2/bewertung.md#9-umfang-ip-5-u1u2n4-r1r12),
`BewertungUmfangService`, `BewertungUmfangApiTest`.

- `bewertung_umfang` ist eine Unternehmensfassung, keine neue Bilanzgrenze. Die Anlagen
  kommen aus `anlage_standort` am Stichtag; dessen letzter Tag ist eingeschlossen.
- Eine neue Fassung markiert die Vorgängerin als abgelöst. Die Stichtagsauswahl nimmt
  die jüngste Fassung mit Beginn bis zum Tag, auch wenn später `aufgehoben_am` gesetzt
  wurde. Zukünftige Fassungen gelten noch nicht. Der Beginn darf nicht rückwärts laufen.
- Unternehmenssperre serialisiert Fassung und Protokoll; gleiche normalisierte Anfrage
  erzeugt weder Fassung noch Protokoll. GET ohne Fassung ist nur ein Vorschlag.
- IP-5 liefert Liste und Anzahl der Anlagen, keinen Bilanzzähler und keine Energiemenge.
  Andere Träger als Strom haben `mit_anteil: false`, ohne Strom ist `nenner_traeger` null.
- Standortrollen lesen eine Teilansicht; die Zahl gilt nur darin. Die Zugriffsprüfung
  bleibt am heutigen Standort, die fachliche Anlagenbindung folgt zusätzlich dem Stichtag.
- Historische Ausschlussverweise haben eine Einfügeprüfung statt eines löschsperrenden
  Anlagen-Fremdschlüssels. Offboarding ist der einzige DELETE-Weg für die vier Tabellen;
  Kinder vor Fassung und vor Standort/Unternehmen, auch gegen ältere Migrationsstände.
