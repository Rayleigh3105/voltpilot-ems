# Summenwerte am Gerät (H-7/H-8/H-10)

Die Karte `frontend/portal/src/components/GeraetSummenwerte.tsx` löst die frühere
PV-Karte ab. Der alte Export `GeraetPvProduktion` ist nur ein kompatibler Verweis.
`summenwertEinstieg` in `geraetSeite.ts` hängt nicht an der PV-Rolle. Die physische
Geräteseite übergibt alle zugehörigen Komponenten-IDs; gleiche Messstellen stehen
einmal auf der Karte. Box, Port und Transport sind dafür keine Identität.

- `GET /api/v1/sites/{siteId}/komponenten/{entityId}/summenwerte` liefert
  `{messstelle, rolle, wert}[]`, auch ohne Rolle. Kandidaten aus den Formel-Termen
  werden gegen die auf main gespeicherten Formeln geprüft, einschließlich
  verschachtelter Summen. Archivierte Summen fehlen. Fremde Geräte/Anlagen: 404.
- `RolleAendernDialog` nutzt den Anlagen-PUT zum Setzen/Wechseln und den Geräte-DELETE
  zum Entziehen. Der Netzwert-Konflikt verlangt ausdrückliches `ersetzen`. Größe
  und Richtung bestimmen die verfügbaren Rollen; der Server prüft sie erneut.
  Ein Entzug entfernt seit H-11 alle Halter derselben Summe in der Anlage/Rolle
  gemeinsam; die Messstelle und ihre Werte bleiben bestehen.
- Die Öffnen-Funktion verwendet `useSummenwertAssistent` aus dem
  [gemeinsamen H-5/H-6-Assistenten](uems-summenwert-assistent.md).
  `onGespeichert` lädt nur neu und schließt den Fertig-Schritt nicht.
- Schreibwege verwenden wie die vorhandenen Kundenpfade Anmeldung und Mandanten-RLS.
  Die AP-03-Rechte-Weiche und zeitgültige Formel-Fassungen sind auf main nicht
  vorhanden. Deshalb gibt es hier keinen Menüpunkt „Formel ändern ab Tag“.
  `Modal` hält den Fokus; beim Öffnen aus dem Menü wird dessen bleibender
  Auslöser ausdrücklich fokussiert (auch für iOS).
- `GET /api/v1/sites/{siteId}/aenderungen` liest das vorhandene Anlagenjournal im
  gemeinsamen `ProtokollDialog`. `AenderungSatz` nennt gespeicherte Alt-/Neunamen;
  Kanalkennungen werden nicht als Kundenwörter ausgegeben. Keine zweite Historie.
- `POST /api/v1/messstellen/berechnet` nimmt optional
  `rolle: {entity_id, role, ersetzen?}`. Die Zielanlage kommt aus der Komponente,
  sie wird unter Mandanten-RLS geprüft. Die Komponente muss zu den gelesenen
  Geräten gehören; die Rolle wird allen beteiligten Geräten zugeordnet. Anlage,
  Terme und Rolle stehen in **einer Transaktion**; Ablehnung lässt keine
  neue Messstelle zurück. Der `ObjectProvider` für den Rollendienst vermeidet den
  Konstruktorzyklus zum Formel-Leseweg.
- `EntityRegistryService.deleteEntity` entfernt Rollen-Zuordnungen vor jedem
  Löschzweig, auch wenn PV-/Netz-Messpunkte als v1-Stammdaten erhalten bleiben.
  Weitere Nutzer: Admin-, Adoption-, Verbraucher-, Eigenbau- und Batterie-Wege.
  Vollständig gelöschte Messpunkte haben zusätzlich den vorhandenen FK-CASCADE.

Prüfen: `MessstelleFormelApiTest`, `SiteRollenApiTest`,
`AenderungsprotokollApiTest`, `AenderungSatzTest`, `EntityRegistryServiceTest`;
Portal `geraetSeite.test.ts`, `GeraetSeiteSection.test.tsx`, Karten-/Dialogtests,
`copy.test.ts`, Typecheck/Build. Browser: `summenwert`, `summenwert-hybrid`,
`summenwert-geraetkarte`; Screenshots mit abgeschlossenen Animationen bei 375/1440 px.
