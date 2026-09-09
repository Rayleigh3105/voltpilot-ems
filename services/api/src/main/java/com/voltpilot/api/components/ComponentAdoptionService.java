package com.voltpilot.api.components;

import com.voltpilot.api.entities.EntityObservedRepository;
import com.voltpilot.api.entities.EntityRegistryRepository;
import com.voltpilot.api.entities.EntityRegistryRepository.EntityRow;
import com.voltpilot.api.entities.EntityRegistryService;
import com.voltpilot.api.repo.AssetRepository;
import com.voltpilot.api.templates.BuiltinComponentTemplates;
import com.voltpilot.api.templates.ComponentTemplateRepository;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.web.dto.ComponentTemplateDto;
import java.time.Clock;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Die BESTANDS-ÜBERNAHME (Einheitsmodell Stufe 2, Konzept
 * vp-komponenten-einheit-h2 §4.2; Captain-Entscheid E2: sie läuft AUTOMATISCH,
 * ohne Klick): sobald eine box-verwaltete Anlage ihren Einrichtungs-Stand
 * VOLLSTÄNDIG meldet, schreibt die Plattform ihn als eigenes Soll und dreht die
 * Autorität auf {@code portal}.
 *
 * <h2>Warum das gefahrlos ist - die No-op-Eigenschaft</h2>
 *
 * <p>Die Übernahme schreibt zurück, was die Box ohnehin fährt: der Applier
 * leitet aus dem erzeugten Push exakt dieselbe {@code sources.json} und dieselbe
 * Wechselrichter-Auswahl ab, die schon laufen - er antwortet „keine Änderung"
 * ({@code Plan.SameAs}), schreibt keine Datei und veröffentlicht nichts neu.
 * Physisch passiert NICHTS; nur der Bearbeitungs-Ort wandert.
 *
 * <p><b>⚠ Die frühere Begründung war zu eng.</b> Sie lautete „weil die
 * Quellen-Kennung deterministisch aus der Transport-Identität entsteht" - und
 * {@code sources.DeterministicID} kam bewusst OHNE Migration, also trägt jede vor
 * PR 270 eingerichtete Anlage bis heute ZUFÄLLIGE Kennungen, die die Ableitung neu
 * vergab. Genau daran riss die Anlage Pilsting/Herzogau beim Update
 * edge-2026.08.5 -&gt; .10 ihre beiden Fronius-Bindungen auf. Seither behält der
 * Applier die Kennung jedes Geräts, das die Box SCHON FÄHRT; die schon gerissenen
 * Anlagen heilt {@link ComponentRebindService}.
 *
 * <p>Das gilt aber nur, wenn WIRKLICH jedes Feld zurückreist - {@code SameAs}
 * ist eine Strukturgleichheit über ALLE Felder. Deshalb trägt die Übernahme
 * Lese-Kadenz, Nennleistung und MaStR-Referenz mit, und deshalb wurde der
 * Push-Treiberblock in dieser Stufe um genau diese drei Felder ergänzt (sie
 * fehlten seit Stufe 1 - siehe {@code EntityRegistryService.driverBlock}).
 *
 * <h2>Atomar, oder gar nicht</h2>
 *
 * <ul>
 *   <li>Alle Schreibvorgänge liegen in EINER Transaktion auf dem
 *       {@code @Primary}-Datenpfad (Definitionen, Pins, Autorität, Beleg) -
 *       scheitert einer, ist die Anlage unverändert box-verwaltet.</li>
 *   <li><b>Der Push muss ANKOMMEN.</b> Wurde er versucht und ist gescheitert
 *       (Broker weg), wird die Transaktion zurückgerollt: die Anlage bleibt
 *       box-verwaltet und der nächste Takt versucht es erneut. Ein Deployment
 *       GANZ OHNE Broker ({@code mqtt_not_configured}) ist kein Zustellfehler,
 *       sondern eine Umgebungs-Tatsache - dort wird übernommen, und der retained
 *       Soll konvergiert, sobald ein Broker existiert.</li>
 *   <li><b>Die Box kann nie zwischen zwei Welten hängen.</b> Sie wird erst
 *       portal-verwaltet, wenn sie einen Push wirklich ANGEWANDT hat
 *       ({@code PortalManagedComponents}). Eine Übernahme, deren Push nie
 *       ankommt, lässt sie also vollständig bedienbar - sichtbar als
 *       {@code unreported} im Portal, nie als stiller Halbzustand.</li>
 * </ul>
 *
 * <p>Die Entscheidung selbst liegt in der reinen {@link ComponentAdoption};
 * hier steht nur, was danach geschrieben wird.
 */
@Service
public class ComponentAdoptionService {

    private static final Logger log = LoggerFactory.getLogger(ComponentAdoptionService.class);

    /** Der Urheber, den die übernommenen Fassungen tragen. */
    public static final String ACTOR = "system:uebernahme";

    /** Der Vermerk in der Fassungs-Historie - er sagt, WOHER die Definition kam. */
    private static final String NOTE = "Vom Gerät übernommen";

    /** Was ein Übernahme-Versuch ergeben hat. */
    public record Outcome(ComponentAdoption.Verdict verdict, String reason, int components) {

        public boolean adopted() {
            return verdict == ComponentAdoption.Verdict.ADOPTABLE;
        }
    }

    private final EntityRegistryRepository entityRepo;
    private final EntityObservedRepository observed;
    private final ComponentDefinitionRepository definitions;
    private final ComponentTemplateRepository templates;
    private final EntityRegistryService entityRegistry;
    private final AssetRepository assets;
    private final com.voltpilot.api.entities.EntityTypeCatalog entityTypes;
    private final Clock clock;
    private final com.fasterxml.jackson.databind.ObjectMapper mapper =
            new com.fasterxml.jackson.databind.ObjectMapper();

    /**
     * Das {@code @Autowired} ist TRAGEND (die BrokerAuthzReloader-Falle): mit
     * der paket-sichtbaren Test-Naht darunter und ohne Annotation kann Spring
     * keinen Injektions-Konstruktor wählen und die api startet gar nicht.
     */
    @org.springframework.beans.factory.annotation.Autowired
    public ComponentAdoptionService(EntityRegistryRepository entityRepo,
            EntityObservedRepository observed, ComponentDefinitionRepository definitions,
            ComponentTemplateRepository templates, EntityRegistryService entityRegistry,
            AssetRepository assets, com.voltpilot.api.entities.EntityTypeCatalog entityTypes) {
        this(entityRepo, observed, definitions, templates, entityRegistry, assets, entityTypes,
                Clock.systemUTC());
    }

    ComponentAdoptionService(EntityRegistryRepository entityRepo,
            EntityObservedRepository observed, ComponentDefinitionRepository definitions,
            ComponentTemplateRepository templates, EntityRegistryService entityRegistry,
            AssetRepository assets, com.voltpilot.api.entities.EntityTypeCatalog entityTypes,
            Clock clock) {
        this.entityRepo = entityRepo;
        this.observed = observed;
        this.definitions = definitions;
        this.templates = templates;
        this.entityRegistry = entityRegistry;
        this.assets = assets;
        this.entityTypes = entityTypes;
        this.clock = clock;
    }

    /**
     * Übernimmt die Anlage, wenn ihr gemeldetes Ist vollständig ist - sonst
     * passiert NICHTS und der Ausgang sagt ehrlich, warum.
     *
     * <p>Der Aufrufer muss den Mandanten im {@link TenantContext} gesetzt haben;
     * jeder Schreibvorgang läuft über den RLS-Pfad.
     */
    @Transactional
    public Outcome adoptIfComplete(UUID siteId) {
        ComponentAdoption.Plan plan = ComponentAdoption.decide(
                entityRepo.componentAuthority(siteId), observed.forSite(siteId),
                (brand, model) -> templates.findNewestByBrandModel(
                        BuiltinComponentTemplates.PUBLIC_KINDS, brand, model));
        if (!plan.adoptable()) {
            return new Outcome(plan.verdict(), plan.reason(), 0);
        }
        // Das Gateway MUSS auflösbar sein, sonst gäbe es niemanden, dem der Push
        // zugestellt werden könnte - und eine Autorität ohne Empfänger wäre
        // genau der Halbzustand, den diese Stufe ausschließt.
        if (entityRegistry.gatewayDeviceFor(siteId) == null) {
            return new Outcome(ComponentAdoption.Verdict.NO_REPORT,
                    "Für diese Anlage lässt sich kein eindeutiges Gerät bestimmen.", 0);
        }

        UUID tenantId = TenantContext.get();
        for (ComponentAdoption.Item item : plan.items()) {
            adoptOne(siteId, tenantId, item);
        }
        entityRepo.markComponentsAdopted(siteId, ComponentAuthority.PORTAL, clock.instant(), ACTOR);

        // Erst jetzt der Push - er trägt die soeben gedrehte Autorität, also
        // macht ihn erst diese Reihenfolge zur Übernahme statt zu einem
        // wirkungslosen box-Push.
        EntityRegistryService.PushOutcome push = entityRegistry.pushRegistryBestEffort(siteId);
        if (push.attempted() && !push.published()) {
            // Zurückgerollt: die Anlage bleibt box-verwaltet, der nächste Takt
            // versucht es erneut. Lieber gar nicht übernehmen als eine Anlage,
            // deren Soll niemand erfahren hat.
            throw new PushNotDeliveredException(siteId);
        }
        log.info("Bestands-Übernahme: Anlage {} ist jetzt portal-verwaltet ({} Komponenten)",
                siteId, plan.items().size());
        return new Outcome(plan.verdict(), null, plan.items().size());
    }

    /**
     * Der RÜCKWEG: eine Anlage wieder box-verwaltet machen.
     *
     * <p>Er existiert für den Fall, dass eine Übernahme in der Praxis klemmt -
     * ohne ihn wäre eine einmal übernommene Kundenanlage nur noch per
     * Datenbank-Eingriff zu retten. Er ändert AUSSCHLIESSLICH die Autorität:
     * die gespeicherten Definitionen bleiben stehen (sie sind der Beleg, was
     * übernommen wurde, und der Weg zurück nach vorn), und der folgende Push
     * trägt das Feld dann nicht mehr - womit der Applier auf der Box
     * strukturell nichts mehr anwendet und {@code :8484} wieder bedient.
     *
     * <p>Der Beleg-Stempel wird GELÖSCHT, damit der getaktete Abgleich die
     * Anlage erneut betrachtet - sonst wäre ein zurückgenommener Fehlschlag für
     * immer aus dem Blick.
     */
    @Transactional
    public Outcome revertToBox(UUID siteId, String actor) {
        if (!ComponentAuthority.isPortalManaged(entityRepo.componentAuthority(siteId))) {
            return new Outcome(ComponentAdoption.Verdict.NO_REPORT,
                    "Diese Anlage wird bereits am Gerät verwaltet.", 0);
        }
        entityRepo.markComponentsAdopted(siteId, ComponentAuthority.BOX, null, null);
        entityRegistry.pushRegistryBestEffort(siteId);
        log.warn("Bestands-Übernahme ZURÜCKGENOMMEN: Anlage {} wird wieder am Gerät verwaltet "
                + "(durch {})", siteId, actor);
        return new Outcome(ComponentAdoption.Verdict.ADOPTABLE, null, 0);
    }

    /**
     * Schreibt EINE übernommene Komponente: findet ihre Zeile (oder legt sie
     * an), setzt die Anbindung und legt die Fassung in der Historie ab.
     *
     * <p>Die Zeile wird in dieser Reihenfolge gesucht, und die Reihenfolge ist
     * tragend: der PIN auf die Quellen-Kennung zuerst (eine früher per Hand
     * übernommene Quelle darf keine zweite Zeile bekommen), dann die von der
     * Plattform komponierte Zeile ihrer Art (Wechselrichter und Netz-Zähler
     * existieren dort schon - die Topologie summiert je Rolle, zwei Zeilen wären
     * Doppelzählung), erst dann eine neue.
     */
    private void adoptOne(UUID siteId, UUID tenantId, ComponentAdoption.Item item) {
        ComponentTemplateDto template = item.template();
        // ⚠ Der von der BOX gemeldete Name ist aus Sicht des Portals ABGELEITET:
        // er darf einen leeren Namen füllen, aber niemals den Namen ersetzen,
        // den der Kunde seiner Komponente gegeben hat (Alias-Kontinuität,
        // Live-Fall Herzogau 20.08.2026).
        String derived = item.label() == null ? template.modelLabel() : item.label();

        UUID entityId = resolvePoint(siteId, tenantId, item, derived);
        EntityRow current = entityRepo.entityForSite(siteId, entityId);
        String label = ComponentLabels.toWrite(current == null ? null : current.label(), null,
                derived);
        String connJson = withInterval(item.connectionJson(), item.intervalS());
        String sourceKind = BuiltinComponentTemplates.KIND_CERTIFIED.equals(template.kind())
                ? BuiltinComponentTemplates.KIND_CERTIFIED : BuiltinComponentTemplates.KIND_BUILTIN;

        ComponentDefinitionRepository.Applied applied = definitions.applyDefinition(siteId,
                entityId, label, template.brand(), template.model(), template.family(),
                template.communication(), connJson, sourceKind, template.templateRef(),
                template.version());
        if (applied == null) {
            throw new IllegalStateException("adopted component vanished: " + entityId);
        }
        definitions.recordStoredVersion(tenantId, siteId, entityId, applied.version(),
                ACTOR, NOTE);
    }

    /**
     * Legt die Lese-Kadenz IN die gespeicherte Verbindung.
     *
     * <p>Das ist keine Bequemlichkeit, sondern die Angleichung an den
     * Anlege-Weg: {@code ComponentService.driverConnection} legt sie seit Stufe
     * 1 genau dort ab, und {@code EntityRegistryService.driverBlock} HEBT sie
     * von dort auf die Treiber-Ebene, wo die Box sie liest. Schriebe die
     * Übernahme sie woandershin, hätte dieselbe Anlage je nach Entstehungsweg
     * eine andere Kadenz - und die übernommene verlöre die gepflegte.
     *
     * <p>Die Kopie in der Verbindung ist harmlos: die Box ignoriert unbekannte
     * Verbindungsfelder, und ihre Quellen-Identität hängt nicht daran.
     */
    private String withInterval(String connectionJson, Integer intervalS) {
        if (intervalS == null || intervalS <= 0) {
            return connectionJson;
        }
        try {
            com.fasterxml.jackson.databind.JsonNode node = mapper.readTree(connectionJson);
            if (!node.isObject()) {
                return connectionJson;
            }
            ((com.fasterxml.jackson.databind.node.ObjectNode) node).put("interval_s", intervalS);
            return mapper.writeValueAsString(node);
        } catch (Exception e) {
            // Eine unlesbare Verbindung kann es hier nicht geben (sie kam als
            // JSON aus der Datenbank) - und wenn doch, wird sie unverändert
            // durchgereicht statt verworfen.
            return connectionJson;
        }
    }

    /**
     * ⚠ Die ROLLE eines {@code measurement_point} folgt dem v1-Vokabular
     * ({@code battery-hybrid}/{@code pv-generation}/{@code grid-meter}), NICHT
     * dem des Assistenten (dort heißt der Wechselrichter {@code inverter}).
     *
     * <p>Nur die eine Stelle unterscheidet sich, und genau sie ist wichtig: die
     * DB-Bedingung {@code control = FALSE OR role = 'battery-hybrid'} und jede
     * Rollen-Abfrage des Bestands lesen dieses Vokabular. Die FASSUNG in
     * {@code component_definition} behält dagegen die Assistenten-Rolle - dort
     * schreibt der Anlege-Weg sie ebenso, und beide Wege müssen dieselbe
     * Historie erzeugen.
     */
    private static String pointRole(String entityType, String assistantRole) {
        return "battery-hybrid".equals(entityType) ? "battery-hybrid" : assistantRole;
    }

    /** Die Zeile, in die diese übernommene Komponente gehört. */
    private UUID resolvePoint(UUID siteId, UUID tenantId, ComponentAdoption.Item item,
            String label) {
        String role = pointRole(item.entityType(), item.role());
        if (item.edgeSourceId() != null) {
            EntityRow pinned = entityRepo.pointByEdgeSource(siteId, item.edgeSourceId());
            if (pinned != null) {
                entityRepo.updateAdoptedPoint(pinned.id(), role,
                        ComponentLabels.toWrite(pinned.label(), null, label),
                        item.capacityKwp(), item.registryUnitId());
                ensureEntityConfig(pinned, item);
                return pinned.id();
            }
        }
        UUID composed = entityRepo.firstEntityOfType(siteId, item.entityType());
        if (composed != null && reusableComposedRow(siteId, composed, item)) {
            if (item.edgeSourceId() != null) {
                entityRepo.setEdgeSource(composed, item.edgeSourceId());
            }
            return composed;
        }
        // ⚠ Die VERWAISTE Zeile desselben Geräts übernehmen, statt eine zweite
        // daneben anzulegen (Live-Fall Herzogau, 20.08.2026). Ohne diese Sprosse
        // strandete der Kundenname („Fronius Anlage WR1") auf der alten Zeile,
        // die neue trug den vom Gerät gemeldeten Namen - und die kWp der Anlage
        // zählten doppelt. Die Regel entscheidet nur EINDEUTIGE Fälle; sonst
        // bleibt es beim Anlegen und der manuelle Weg („Wieder verbinden").
        UUID takeover = ComponentTakeover.match(takeoverCandidates(siteId),
                reportedSourceIds(siteId),
                new ComponentTakeover.Incoming(role, item.template().brand(),
                        item.template().model(), item.template().communication(),
                        item.connectionJson(), item.registryUnitId()),
                mapper);
        if (takeover != null) {
            EntityRow row = entityRepo.entityForSite(siteId, takeover);
            // ⚠ Auf einer ÜBERNOMMENEN Zeile heißt ein NICHT gemeldetes Feld
            // „nichts ändern", nie „löschen": kWp und MaStR-Referenz sind vom
            // BETREIBER gepflegte Stammdaten, und eine Box, die sie nicht
            // (mehr) meldet, ist kein Grund, sie zu verlieren.
            java.math.BigDecimal kwp = item.capacityKwp() != null || row == null
                    ? item.capacityKwp() : row.capacityKwp();
            String mastr = item.registryUnitId() != null || row == null
                    ? item.registryUnitId() : row.registryUnitId();
            log.warn("Bestands-Übernahme: das gemeldete Gerät {} der Anlage {} wird auf die "
                    + "verwaiste Komponente {} (\"{}\") übernommen statt neu angelegt",
                    item.edgeSourceId(), siteId, takeover, row == null ? null : row.label());
            // Die kWp NUR als Differenz - die Zeile steckt mit ihrem alten Wert
            // schon in der Anlagen-Summe (das `adopt`-Muster).
            if (ComponentService.ROLE_ERZEUGER.equals(item.role()) && row != null) {
                java.math.BigDecimal delta = orZero(kwp).subtract(orZero(row.capacityKwp()));
                if (delta.signum() != 0) {
                    assets.addPvCapacity(tenantId, siteId, delta);
                }
            }
            entityRepo.updateAdoptedPoint(takeover, role,
                    ComponentLabels.toWrite(row == null ? null : row.label(), null, label),
                    kwp, mastr);
            if (item.edgeSourceId() != null) {
                entityRepo.setEdgeSource(takeover, item.edgeSourceId());
            }
            if (row != null) {
                ensureEntityConfig(row, item);
            }
            return takeover;
        }
        if (ComponentService.ROLE_INVERTER.equals(item.role())) {
            // Ohne komponierte battery-hybrid-Zeile fehlt der Anlage der
            // Speicher-Stammsatz, aus dem sie entsteht - genau wie der
            // Anlege-Weg lehnt die Übernahme das ab, statt eine Zeile zu
            // erfinden, die der Rest des Systems aus dem Asset komponiert.
            // ALLES ODER NICHTS: die Ausnahme rollt die ganze Übernahme zurück.
            throw new NotAdoptableException("Für diese Anlage ist noch kein Wechselrichter "
                    + "angelegt. Bitte tragen Sie zuerst die Eckdaten des Speichers ein.");
        }
        UUID created = entityRepo.createAdoptedPoint(tenantId, siteId, role, label, false,
                item.template().brand(), item.capacityKwp(), item.registryUnitId(),
                item.edgeSourceId());
        // Eine neu entstandene Erzeuger-Zeile bringt ihre kWp in die
        // Anlagen-Summe ein - dieselbe Buchführung wie beim Anlege-Weg und der
        // U2-Übernahme; ohne sie wüchse die Anlage still um eine Erzeugung, die
        // in keiner Summe steht.
        if (ComponentService.ROLE_ERZEUGER.equals(item.role())) {
            assets.addPvCapacity(tenantId, siteId, item.capacityKwp());
        }
        entityRepo.setEntityConfig(created, item.entityType(),
                ComponentDefaults.capabilities(mapper, entityTypes, item.entityType(),
                        item.role()),
                ComponentDefaults.guards(mapper, item.role(), item.capacityKwp()));
        return created;
    }

    /** Alle Zeilen der Anlage, wie die Übernahme-Regel sie sieht. */
    private java.util.List<ComponentTakeover.Existing> takeoverCandidates(UUID siteId) {
        java.util.List<ComponentTakeover.Existing> out = new java.util.ArrayList<>();
        for (EntityRow row : entityRepo.pointsForSite(siteId)) {
            out.add(new ComponentTakeover.Existing(row.id(), row.role(), row.brand(), row.model(),
                    row.communication(), row.connectionJson(), row.registryUnitId(),
                    row.edgeSourceId()));
        }
        return out;
    }

    /** Die Quellen-Kennungen, die die Box GERADE meldet. */
    private java.util.Set<String> reportedSourceIds(UUID siteId) {
        java.util.Set<String> out = new java.util.LinkedHashSet<>();
        for (EntityObservedRepository.ObservedRow row : observed.forSite(siteId)) {
            if ("local".equals(row.source()) && row.entityId() != null
                    && row.entityId().startsWith("local:")) {
                out.add(row.entityId().substring("local:".length()));
            }
        }
        return out;
    }

    private static java.math.BigDecimal orZero(java.math.BigDecimal v) {
        return v == null ? java.math.BigDecimal.ZERO : v;
    }

    /**
     * Ob die von der Plattform komponierte Zeile dieser Art wirklich die
     * gemeinte ist. Sie ist es NICHT, wenn sie schon an eine ANDERE Quelle
     * gepinnt ist oder bereits eine Anbindung trägt - dann gehört sie einem
     * anderen Gerät, und die gemeldete Quelle bekommt ihre eigene Zeile.
     */
    private boolean reusableComposedRow(UUID siteId, UUID pointId,
            ComponentAdoption.Item item) {
        EntityRow row = entityRepo.entityForSite(siteId, pointId);
        if (row == null) {
            return false;
        }
        if (row.connectionJson() != null && !row.connectionJson().isBlank()) {
            return false;
        }
        return row.edgeSourceId() == null || row.edgeSourceId().equals(item.edgeSourceId());
    }

    /**
     * Eine gepinnte Zeile kann aus der U2-Übernahme stammen und schon eine
     * Entitäts-Konfiguration tragen; fehlt sie, wird sie hier ergänzt - eine
     * Komponente ohne Fähigkeiten wäre auf jeder Fläche unsichtbar.
     */
    private void ensureEntityConfig(EntityRow row, ComponentAdoption.Item item) {
        if (row.entityType() != null && !row.entityType().isBlank()) {
            return;
        }
        entityRepo.setEntityConfig(row.id(), item.entityType(),
                ComponentDefaults.capabilities(mapper, entityTypes, item.entityType(),
                        item.role()),
                ComponentDefaults.guards(mapper, item.role(), item.capacityKwp()));
    }

    /**
     * Die Anlage lässt sich (noch) nicht übernehmen, und das steht erst beim
     * SCHREIBEN fest (die reine Regel kennt die Datenbank nicht). Sie rollt die
     * Transaktion zurück - alles oder nichts - und wird vom Aufrufer in einen
     * ehrlichen Ausgang übersetzt.
     */
    public static class NotAdoptableException extends RuntimeException {
        public NotAdoptableException(String reason) {
            super(reason);
        }
    }

    /**
     * Ein nicht zugestellter Push. Sie rollt die Übernahme zurück und ist
     * deshalb bewusst UNGEPRÜFT - der getaktete Abgleich fängt sie ab und
     * versucht es beim nächsten Mal erneut.
     */
    public static class PushNotDeliveredException extends RuntimeException {
        public PushNotDeliveredException(UUID siteId) {
            super("Übernahme von Anlage " + siteId + " zurückgerollt: der Soll-Stand konnte "
                    + "nicht an das Gerät zugestellt werden");
        }
    }
}
