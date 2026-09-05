# ALIAS-KONTINUITÄT: ein Kundenname überlebt jeden Reparatur- und Anlege-Weg

Ausgelagert aus `AGENTS.md` am 05.09.2026 (Abschnitt Nr. 27).


Live-Fall Anlage Pilsting/Herzogau, 20.08.2026 (Captain: „beim neu hinzufügen sind
die Aliase jetzt weg"). Nach dem Identitäts-Riss (Abschnitt darüber) verlor der
Kunde beim Reparieren die Namen, die er seinen Komponenten gegeben hatte. Es waren
ZWEI unabhängige Löcher, und beide sind hier geschlossen.

- **⚠ LOCH 1 — die Namens-Regel: `components/ComponentLabels.toWrite(stored, typed,
  derived)`.** Seit der Label-Hygiene (`V20260812000000`) heißt `label != NULL`
  „von einem Menschen vergeben"; die Schreibwege der Einheitsmodell-Stufen 1 und 2
  hielten sie nicht ein und schrieben den Modellnamen der Vorlage bzw. den vom
  GERÄT gemeldeten Quellennamen ungefragt in dieselbe Spalte. Die Regel in einem
  Satz: **getippt gewinnt, sonst bleibt ein vorhandener Name stehen, und ein
  abgeleiteter füllt nur einen leeren.** Ihre Datenbank-Hälfte ist
  `COALESCE(NULLIF(?::text, ''), label)` in `ComponentDefinitionRepository.applyDefinition`
  (das jetzt `Applied{version,label}` zurückgibt — die Historie hält fest, was
  WIRKLICH gespeichert wurde, statt es im Aufrufer ein zweites Mal abzuleiten) und
  in `EntityRegistryRepository.updateAdoptedPoint`. Gelöscht wird ein Name
  ausschließlich über die Umbenennen-Route des Kunden.
- **⚠ LOCH 2 — die Übernahme-Regel: `components/ComponentTakeover`** (rein, das
  `ComponentRebind`/`Tagesprotokoll`-Muster). Ein Gerät, das eine Zeile sucht,
  bekommt die VERWAISTE Zeile desselben Geräts statt einer zweiten daneben.
  Genommen wird die ERSTE Sprosse, die GENAU EINE freie Zeile trifft — trifft eine
  Sprosse mehrere, wird NICHTS entschieden und die nächste NICHT versucht (eine
  Mehrdeutigkeit auf einer starken Sprosse wird von einer schwächeren nicht
  besser): **① MaStR-Referenz → ② Anbindungs-Fingerabdruck** (die GETEILTE
  `ComponentRebind.fingerprint`, kein Zwilling) **→ ③ Marke + Modell auf einer
  BELEGT verwaisten Zeile OHNE gespeicherte Anbindung** (eine nie gepinnte ist
  frisch, nicht gestrandet; eine gespeicherte ABWEICHENDE Anbindung ist der
  Beweis, dass es ein anderes Gerät ist). FREI = kein Pin, oder ein Pin auf eine
  Kennung, die die Box nicht (mehr) meldet; meldet die Box gar nichts, gilt keine
  gepinnte Zeile als verwaist (Schweigen beweist nichts).
- **Beide Schreibwege benutzen dieselbe Regel:** `ComponentAdoptionService.resolvePoint`
  (Bestands-Übernahme, nach Pin + komponierter Zeile) und
  `ComponentService.resolveOrCreatePoint` (der Anlege-Assistent, für die Rollen
  `pv-generation`/`consumer` — Wechselrichter und Netz-Zähler haben ihre
  komponierte Zeile schon). Auf einer ÜBERNOMMENEN Zeile heißt ein leeres
  optionales Feld „nichts ändern", nie „löschen" (sonst räumte ein Anlege-Formular
  ohne kWp-Angabe die gepflegte Nennleistung und die MaStR-Referenz ab), und die
  kWp gehen nur als DIFFERENZ in die Anlagen-Summe (die Zeile steckt mit ihrem
  alten Wert schon darin) — das `adopt`-Muster.
- **Der VORSCHLAG vor dem Klick: `POST /api/v1/sites/{siteId}/component-match`**
  (`SiteComponentController`, RLS-gefenced, kein Treffer = **204**, nie ein
  Fehler). Er fährt wörtlich dieselbe Regel wie `create` danach, damit der
  Assistent sagen kann „Das ist vermutlich Ihre bisherige ‚Fronius Anlage WR1'"
  statt stillschweigend eine namenlose Parallel-Komponente anzulegen. **Er ändert
  NICHTS** — kein Schreibvorgang, kein Beleg, keine Nachricht an die Box; ein
  zweiter Fingerabdruck im Portal würde von der Server-Regel abdriften. In
  `openapi.yaml` (tag `components`).
- **⚠ BEKANNTE GRENZE, absichtlich stehen gelassen: die REIHENFOLGE der Reparatur
  ist nicht frei.** Nach einem Tausch trägt die freigegebene Doppelte KEINEN Pin
  mehr (der Re-Pin räumt ihn, wenn ihr altes Gerät nicht mehr gemeldet wird), und
  der Grundausstattungs-Zaun des Kunden-Löschens (`SiteEntityAdoptController.delete`
  + der Portal-Zwilling `komponenten.componentActions.canDelete`) verweigert dann
  das Entfernen — sie bleibt als namenlose Zeile stehen. Wer aufräumen will,
  LÖSCHT ZUERST. Den Zaun auf die plattform-komponierten Zeilen zu verengen wäre
  ein Einzeiler (die Plattform komponiert nie einen Erzeuger, ein `device_id`
  ohne Pin ist der präzise Diskriminator), ändert aber eine ausdrücklich geprüfte
  Regel eines Nachbar-Features
  (`PortalApiTest.customerSwapsCrossedAssignmentsAndDeletesTheGhostComponent`) —
  das ist ein Captain-Entscheid, kein Implementierungsdetail. Festgehalten wird
  die Grenze im Heilungs-Test, damit sie nicht wieder überrascht.
- **Die HEILUNG des schon eingetretenen Schadens: der Name ist NICHT verloren** —
  er liegt auf der verwaisten Zeile. Beide Wege holen ihn zurück, ohne dass jemand
  etwas abtippt: Doppelte LÖSCHEN, dann heilt der getaktete Abgleich die Bindung
  von selbst (kein Klick); oder erst TAUSCHEN (`swap: true`) und danach die
  freigegebene Doppelte löschen. Eine AUTOMATISCHE Verschmelzung zweier
  bestehender Komponenten wurde bewusst NICHT gebaut — sie wäre ein automatisches
  Löschen von Kundendaten und damit strikt destruktiver als ein falscher Pin
  (dieselbe Zurückhaltung wie „was nicht entschieden werden kann, wird nicht
  entschieden").
- **Beweise:** rein `ComponentLabelsTest` (3) + `ComponentTakeoverTest` (11: der
  Herzogau-Fall, MaStR schlägt alles, lebende Bindung nie, Mehrdeutigkeit
  entscheidet nichts, eine starke Sprosse lässt keine schwächere nachrücken,
  abweichende Anbindung, Rolle, Schweigen) · Testcontainers
  `ComponentAdoptionApiTest.theCustomerNameSurvivesEveryRepairPathAndTheTakeoverNeverDuplicates`
  (die drei Strecken an EINER Anlage: Auto-Rebind · „Wieder verbinden" · die
  Übernahme, dazu „keine Parallel-Komponente" und „kWp zählen nicht doppelt") +
  `theAssistantTakesOverTheOrphanedComponentInsteadOfMintingAParallelOne` (der
  Vorschlag vor dem Klick, das Speichern ohne Namensfeld, ein getippter Name
  gewinnt weiterhin) + `theStrandedCustomerNameComesBackOnBothRepairPathsWithoutRetyping`.

