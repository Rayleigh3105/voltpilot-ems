package com.voltpilot.api.components;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.entities.EntityObservedRepository;
import com.voltpilot.api.entities.EntityRegistryRepository;
import com.voltpilot.api.entities.EntityRegistryRepository.EntityRow;
import com.voltpilot.api.entities.EntityRegistryService;
import com.voltpilot.api.probe.ProbeResult;
import com.voltpilot.api.repo.AssetRepository;
import com.voltpilot.api.repo.MeasurementPointRepository;
import com.voltpilot.api.repo.RegisterWriteEventRepository;
import com.voltpilot.api.repo.SiteRepository;
import com.voltpilot.api.templates.BuiltinComponentTemplates;
import com.voltpilot.api.templates.ComponentTemplateRepository;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.web.dto.ComponentDefinitionDto;
import com.voltpilot.api.web.dto.ComponentMatchDto;
import com.voltpilot.api.web.dto.ComponentTemplateDto;
import com.voltpilot.api.web.dto.SaveComponentRequest;
import com.voltpilot.api.web.dto.SiteComponentsDto;
import java.math.BigDecimal;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

/**
 * Der EINE Anlege-Weg, serverseitig (Einheitsmodell Stufe 1, Konzept
 * vp-komponenten-einheit-h2 Teil 4): eine Komponente entsteht aus einer VORLAGE
 * plus ihrer Verbindung, bekommt eine ROLLE, und wird versioniert gespeichert.
 *
 * <p>Die Regeln, die hier und nur hier leben - jede einzelne, weil ihr Fehlen
 * eine belegte Fehlerklasse wäre:
 *
 * <ul>
 *   <li><b>Nur auf einer portal-verwalteten Anlage.</b> Auf einer Bestandsanlage
 *       (box-verwaltet, Stufe 2) würde ein gespeichertes Soll NIE wirken - ein
 *       Speichern, das folgenlos bleibt, ist schlimmer als eine ehrliche
 *       Ablehnung, die sagt, wo es heute geht.</li>
 *   <li><b>Verbindungstest-PFLICHT.</b> Das Soll IST seit dieser Stufe der
 *       Lesepfad; ein Tippfehler in der IP macht die Anlage blind. Genau diese
 *       Klasse fängt ein Test ab, also gibt es kein Blind-Soll
 *       ({@link ComponentConnectionReceipts}).</li>
 *   <li><b>Höchstens EIN Netz-Zähler je Anlage.</b> Bis heute prüfte das nur das
 *       Frontend der Box ({@code static/sources.js}); ein zweiter Zähler ließe
 *       die Topologie das Netz doppelt zählen.</li>
 *   <li><b>Genau EIN Wechselrichter.</b> Er ist die {@code battery-hybrid}-Zeile
 *       der Anlage - die Auto-Komposition legt sie an, dieser Weg füllt ihre
 *       Anbindung. Ein zweiter wäre auf der Box nicht entscheidbar (der Applier
 *       lehnt ihn dort noch einmal ab).</li>
 *   <li><b>Marke/Modell/Familie/Kommunikationsart kommen aus der VORLAGE</b>,
 *       nie aus dem Rumpf. Ein Client kann damit keine widersprüchliche Anbindung
 *       speichern - dieselbe Garantie, die die Box mit ihrer Katalog-
 *       Normalisierung gibt.</li>
 * </ul>
 *
 * <p>Alles läuft über den RLS-Pfad: eine fremde Anlage ist 404, bevor irgendetwas
 * geschrieben wird, und ein Portal-Admin erreicht jede Anlage über den
 * {@code X-Tenant-Id}-Umschalter wie bei jeder Kunden-Route.
 */
@Service
public class ComponentService {

    /** Die Rollen, die der Assistent anbietet. */
    public static final String ROLE_INVERTER = "inverter";
    public static final String ROLE_ERZEUGER = "pv-generation";
    public static final String ROLE_NETZ = "grid-meter";
    public static final String ROLE_CONSUMER = "consumer";

    private static final Set<String> ROLES =
            Set.of(ROLE_INVERTER, ROLE_ERZEUGER, ROLE_NETZ, ROLE_CONSUMER);

    /** Die Entitätstypen, die zu den vier Rollen gehören. */
    private static final Map<String, String> ROLE_ENTITY_TYPE = Map.of(
            ROLE_INVERTER, "battery-hybrid",
            ROLE_ERZEUGER, "producer",
            ROLE_NETZ, "grid-meter");

    private static final String SOURCE_KIND_BUILTIN = "builtin";
    private static final String SOURCE_KIND_CERTIFIED = "certified";

    private final SiteRepository sites;
    private final MeasurementPointRepository points;
    private final EntityRegistryRepository entityRepo;
    /** Nur zum LESEN, was die Box gerade meldet - die Übernahme-Regel braucht es. */
    private final EntityObservedRepository observed;
    private final EntityRegistryService entityRegistry;
    private final ComponentDefinitionRepository definitions;
    private final ComponentApplyRepository applyState;
    private final ComponentTemplateRepository templates;
    private final ComponentConnectionReceipts receipts;
    private final AssetRepository assets;
    private final ObjectMapper mapper = new ObjectMapper();

    public ComponentService(SiteRepository sites, MeasurementPointRepository points,
            EntityRegistryRepository entityRepo, EntityRegistryService entityRegistry,
            ComponentDefinitionRepository definitions, ComponentApplyRepository applyState,
            ComponentTemplateRepository templates, ComponentConnectionReceipts receipts,
            AssetRepository assets, EntityObservedRepository observed) {
        this.sites = sites;
        this.points = points;
        this.entityRepo = entityRepo;
        this.observed = observed;
        this.entityRegistry = entityRegistry;
        this.definitions = definitions;
        this.applyState = applyState;
        this.templates = templates;
        this.receipts = receipts;
        this.assets = assets;
    }

    // ---- Lesen ------------------------------------------------------------

    /** Die Komponenten dieser Anlage samt Soll/Ist-Stand. */
    public SiteComponentsDto list(UUID siteId) {
        requireSite(siteId);
        String authority = ComponentAuthority.of(definitions.componentAuthority(siteId));
        String soll = entityRepo.registryRevision(siteId);
        ComponentApplyRepository.ApplyState ist = applyState.forSite(siteId);

        String applied = ist == null ? null : ist.appliedRevision();
        List<SiteComponentsDto.ComponentRowDto> rows = new ArrayList<>();
        for (EntityRow row : entityRepo.entitiesForSite(siteId)) {
            rows.add(toRow(row, soll, applied));
        }
        return new SiteComponentsDto(authority, soll, applied,
                ist == null ? null : ist.appliedAt(),
                ist == null ? null : ist.refusedRevision(),
                ist == null ? null : ist.refusedReason(),
                definitions.componentsAdoptedAt(siteId), rows);
    }

    /** Die Fassungen EINER Komponente, neueste zuerst. */
    public List<ComponentDefinitionDto> versions(UUID siteId, UUID entityId) {
        requireSite(siteId);
        requireComponent(siteId, entityId);
        return definitions.versions(siteId, entityId);
    }

    // ---- Schreiben --------------------------------------------------------

    /**
     * Legt eine Komponente an. Beim Wechselrichter und beim Netz-Zähler wird die
     * SCHON EXISTIERENDE, von der Plattform komponierte Zeile befüllt statt eine
     * zweite anzulegen - die Topologie summiert je Rolle, zwei Zeilen wären
     * Doppelzählung.
     */
    @Transactional
    public SiteComponentsDto create(UUID siteId, SaveComponentRequest req, String subject) {
        requireSite(siteId);
        requirePortalManaged(siteId);
        String role = requireRole(req.role());
        ComponentTemplateDto template = requireTemplate(req.templateRef());
        TestedConnection tested = requireTestedConnection(siteId, req, template);

        UUID tenantId = TenantContext.get();
        UUID entityId = resolveOrCreatePoint(siteId, tenantId, role, req, template);
        writeDefinition(siteId, tenantId, entityId, role, req, template, tested, subject,
                "Angelegt");
        entityRegistry.pushRegistryBestEffort(siteId);
        return list(siteId);
    }

    /**
     * Ändert die Anbindung einer bestehenden Komponente - eine NEUE Fassung, mit
     * der alten weiterhin abrufbar. Der Verbindungstest ist auch hier Pflicht:
     * eine Änderung kann eine laufende Anlage genauso blind machen wie eine
     * Erstanlage.
     */
    @Transactional
    public SiteComponentsDto update(UUID siteId, UUID entityId, SaveComponentRequest req,
            String subject) {
        requireSite(siteId);
        requirePortalManaged(siteId);
        EntityRow existing = requireComponent(siteId, entityId);
        String role = requireRole(req.role());
        if (!sameRole(role, existing)) {
            // Die Rolle einer Komponente zu wechseln hieße, sie in einen anderen
            // Teil der Energiebilanz zu verschieben - das ist ein Löschen plus
            // ein Anlegen, kein Bearbeiten, und darf nicht als eine Fassung
            // durchgehen.
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                    "Die Art dieser Komponente lässt sich nicht ändern. Bitte legen Sie sie neu an.");
        }
        ComponentTemplateDto template = requireTemplate(req.templateRef());
        TestedConnection tested = requireTestedConnection(siteId, req, template);

        writeDefinition(siteId, TenantContext.get(), entityId, role, req, template, tested,
                subject, "Verbindung geändert");
        entityRegistry.pushRegistryBestEffort(siteId);
        return list(siteId);
    }

    /**
     * Setzt eine Komponente auf eine frühere Fassung zurück - der Ein-Klick-Weg
     * aus einem falschen Soll heraus (Risiko 2 des Konzepts).
     *
     * <p>Er SCHREIBT eine neue Fassung mit dem alten Inhalt statt eine zu
     * löschen: „was lief letzte Woche" bleibt beantwortbar, und der Weg zurück
     * ist derselbe Weg wie jede andere Änderung.
     *
     * <p>Ein Verbindungstest wird hier NICHT verlangt, und das ist Absicht: diese
     * Verbindung war schon einmal gespeichert und hat damals ihren Test bestanden.
     * Einen zweiten zu erzwingen hieße, den Rückweg aus einem Fehler genau dann zu
     * versperren, wenn das Gerät gerade nicht antwortet - also im Notfall.
     */
    @Transactional
    public SiteComponentsDto rollback(UUID siteId, UUID entityId, int version, String subject) {
        requireSite(siteId);
        requirePortalManaged(siteId);
        requireComponent(siteId, entityId);
        ComponentDefinitionDto old = definitions.version(siteId, entityId, version);
        if (old == null) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND,
                    "Diese Fassung gibt es nicht.");
        }
        ComponentDefinitionRepository.Applied applied = definitions.applyDefinition(siteId,
                entityId, old.label(), old.brand(), old.model(), old.family(),
                old.communication(), old.connection(), old.sourceKind(), old.templateRef(),
                old.templateVersion());
        if (applied == null) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Komponente nicht gefunden.");
        }
        definitions.recordVersion(TenantContext.get(), siteId, entityId, applied.version(),
                old.role(), applied.label(), old.brand(), old.model(), old.family(),
                old.communication(), old.connection(), old.sourceKind(), old.templateRef(),
                old.templateVersion(), subject, "Zurück auf Fassung " + version);
        entityRegistry.pushRegistryBestEffort(siteId);
        return list(siteId);
    }

    // ---- Regeln -----------------------------------------------------------

    private void requireSite(UUID siteId) {
        if (!sites.existsForCurrentTenant(siteId)) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Anlage nicht gefunden.");
        }
    }

    /**
     * Auf einer box-verwalteten Anlage wird hier NICHT geschrieben. Der Satz
     * nennt den Zustand, nicht nur die Ablehnung - und verspricht nichts über
     * einen Zeitpunkt.
     */
    private void requirePortalManaged(UUID siteId) {
        if (!ComponentAuthority.isPortalManaged(definitions.componentAuthority(siteId))) {
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                    "Die Geräte dieser Anlage werden derzeit direkt am Gerät verwaltet. "
                            + "Änderungen nehmen Sie dort vor.");
        }
    }

    private String requireRole(String raw) {
        String role = raw == null ? "" : raw.trim();
        if (!ROLES.contains(role)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "Diese Art von Komponente wird nicht unterstützt.");
        }
        return role;
    }

    private ComponentTemplateDto requireTemplate(String ref) {
        return templates.findNewestByRef(BuiltinComponentTemplates.PUBLIC_KINDS,
                        ref == null ? "" : ref.trim())
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.BAD_REQUEST,
                        "Dieses Gerät kennen wir nicht."));
    }

    /**
     * Die geprüfte Verbindung: die Felder, die gespeichert werden, plus - wenn
     * der Test einen Kanal als fehlend ausgewiesen UND der Kunde ihn abgenickt
     * hat - dieser Kanal. {@code null} = ein vollständiger Test.
     */
    private record TestedConnection(Map<String, Object> fields, String missingChannel) {
    }

    /**
     * Die Verbindungstest-Pflicht. Ohne einen gültigen Beleg für GENAU diese
     * Anlage, Vorlage und Verbindung wird nichts gespeichert.
     *
     * <p><b>Der eine Ausnahmeweg, und warum er die Pflicht nicht aufweicht</b>
     * (Live-Fall Mühlfeldweg 2, 21.08.2026): ein Gerät kann ANTWORTEN und
     * trotzdem einen Kanal schuldig bleiben - eine Eigenbau-Batterie ohne
     * gekoppeltes BMS meldet dauerhaft SoC 0. Die Pflicht existiert gegen das
     * Blind-Soll, gegen den Tippfehler in der IP; genau das hat dieser Test
     * beantwortet. Es wird also nichts geglaubt, was nicht gemessen wurde -
     * gespeichert wird eine Anlage, von der wir WISSEN, dass sie erreichbar ist
     * und welcher Kanal ihr fehlt.
     *
     * <p>Zwei Dinge müssen dafür zusammenkommen, und beide entscheidet der
     * SERVER: der Beleg muss den Kanal als fehlend ausweisen (das kommt aus dem
     * Testergebnis der Box), und der Kunde muss GENAU DIESEN Kanal abgenickt
     * haben. Eine Zustimmung zu einem anderen Kanal gilt nicht, und eine
     * Zustimmung ohne Befund erst recht nicht.
     */
    private TestedConnection requireTestedConnection(UUID siteId, SaveComponentRequest req,
            ComponentTemplateDto template) {
        Map<String, Object> connection =
                req.connection() == null ? Map.of() : new LinkedHashMap<>(req.connection());
        if (connection.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "Es fehlen die Verbindungsdaten des Geräts.");
        }
        // ⚠ Ein Client darf die Server-Stempel NIE selbst mitschicken: sie sind
        // der Beleg, nicht die Eingabe. Sie werden hier entfernt, bevor der
        // Fingerabdruck gebildet wird - sonst hinge die Pflicht an einem Feld,
        // das der Aufrufer frei erfindet.
        SERVER_OWNED_CONNECTION_KEYS.forEach(connection::remove);
        // ⚠ VOR dem Fingerabdruck geprüft, damit ein unsinniges Paar nicht erst
        // die Verbindungstest-Pflicht auslöst: die Ablehnung soll den echten
        // Grund nennen („Die Spannungen müssen zwischen …"), nicht das
        // Folgeproblem („Bitte prüfen Sie zuerst die Verbindung").
        requireUsableVoltageBounds(connection);
        if (!receipts.has(siteId, template.templateRef(), connection)) {
            throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY,
                    "Bitte prüfen Sie zuerst die Verbindung zu diesem Gerät - erst danach lässt "
                            + "sie sich speichern.");
        }
        String missing = receipts.overrideChannel(siteId, template.templateRef(), connection);
        if (missing == null) {
            return new TestedConnection(connection, null);
        }
        String accepted = req.acceptMissingChannel() == null ? "" : req.acceptMissingChannel().trim();
        if (!missing.equals(accepted)) {
            throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY,
                    "Der Verbindungstest war unvollständig: " + channelLabel(missing)
                            + " fehlt. Bitte bestätigen Sie ausdrücklich, dass diese Komponente "
                            + "ohne diesen Wert betrieben werden soll.");
        }
        return new TestedConnection(connection, missing);
    }

    /**
     * Die Spannungs-Eckpunkte der Ladestand-SCHÄTZUNG, falls welche mitkommen.
     *
     * <p>Geprüft VOR dem Fingerabdruck der Verbindungstest-Pflicht, damit eine
     * Ablehnung den echten Grund nennt („Die Spannungen müssen zwischen …")
     * statt des Folgeproblems („Bitte prüfen Sie zuerst die Verbindung"). Die
     * Regel selbst steht in {@link SocFromVoltageBounds} - inklusive der
     * Begründung, warum sie DREIMAL lebt.
     */
    public void requireUsableVoltageBounds(Map<String, Object> connection) {
        String refusal = SocFromVoltageBounds.refusal(connection);
        if (refusal != null) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, refusal);
        }
    }

    /**
     * Die Felder, die AUSSCHLIESSLICH der Server in die gespeicherte Verbindung
     * schreibt: das Decoder-Opt-in und sein Beleg. Sie reisen zur Box mit, aber
     * sie kommen nie aus einem Request-Körper.
     */
    private static final List<String> SERVER_OWNED_CONNECTION_KEYS =
            List.of("allow_missing_soc", "reading_override");

    /** Der Kanal in Kundensprache. Ein unbekannter Kanal wird NIE erfunden. */
    private static String channelLabel(String channel) {
        return ProbeResult.Finding.CHANNEL_SOC.equals(channel) ? "der Ladestand" : "ein Messwert";
    }

    private EntityRow requireComponent(UUID siteId, UUID entityId) {
        EntityRow row = entityRepo.entityForSite(siteId, entityId);
        if (row == null) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Komponente nicht gefunden.");
        }
        return row;
    }

    /**
     * Findet die Zeile, in die diese Komponente gehört - oder legt sie an.
     *
     * <p>Wechselrichter und Netz-Zähler sind PLATTFORM-KOMPONIERT: die
     * Auto-Komposition legt sie beim Geräte-Claim an, dieser Weg füllt ihre
     * Anbindung. Erzeuger und Verbraucher entstehen hier neu.
     */
    private UUID resolveOrCreatePoint(UUID siteId, UUID tenantId, String role,
            SaveComponentRequest req, ComponentTemplateDto template) {
        String entityType = ROLE_ENTITY_TYPE.get(role);

        // Wechselrichter und Netz-Zähler sind PLATTFORM-KOMPONIERT: die
        // Auto-Komposition legt sie beim Geräte-Claim an, dieser Weg füllt ihre
        // Anbindung. Eine zweite Zeile wäre Doppelzählung (die Topologie
        // summiert je Rolle).
        //
        // ⚠ Die 0-1-Regel hängt an der ANBINDUNG, nicht an der Existenz der
        // Zeile: die komponierte Zeile ist noch KEIN eingerichtetes Gerät, ein
        // Zähler MIT Anbindung ist einer. Nur so lässt sich der erste Zähler
        // anlegen UND der zweite abweisen.
        if (ROLE_INVERTER.equals(role) || ROLE_NETZ.equals(role)) {
            UUID existing = entityRepo.firstEntityOfType(siteId, entityType);
            if (existing != null) {
                EntityRow row = entityRepo.entityForSite(siteId, existing);
                if (row != null && row.connectionJson() != null
                        && !row.connectionJson().isBlank()) {
                    throw new ResponseStatusException(HttpStatus.CONFLICT,
                            ROLE_INVERTER.equals(role)
                                    ? "Diese Anlage hat bereits einen Wechselrichter. Bitte "
                                            + "bearbeiten Sie ihn statt einen zweiten anzulegen."
                                    : "Diese Anlage hat bereits einen Netz-Zähler. Es ist nur "
                                            + "einer möglich.");
                }
                return existing;
            }
            if (ROLE_INVERTER.equals(role)) {
                // Ohne komponierte Zeile fehlt der Anlage der Speicher-Stammsatz,
                // aus dem sie entsteht. Das ist eine Aussage über die
                // Reihenfolge des Einrichtens, kein Fehler des Kunden.
                throw new ResponseStatusException(HttpStatus.CONFLICT,
                        "Für diese Anlage ist noch kein Wechselrichter angelegt. Bitte tragen Sie "
                                + "zuerst die Eckdaten Ihres Speichers ein.");
            }
        }
        if (ROLE_NETZ.equals(role) && points.countByRole(siteId, ROLE_NETZ) > 0) {
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                    "Diese Anlage hat bereits einen Netz-Zähler. Es ist nur einer möglich.");
        }

        BigDecimal capacity = ROLE_ERZEUGER.equals(role) ? req.capacityKwp() : null;

        // ⚠ Erst die VERWAISTE Zeile desselben Geräts suchen, dann anlegen
        // (Alias-Kontinuität, Live-Fall Herzogau 20.08.2026). „Komponente
        // hinzufügen" legte bisher IMMER eine neue Zeile an - auch wenn genau
        // dieses Gerät daneben verwaist lag. Das Ergebnis war eine namenlose
        // Parallel-Komponente, während der Kundenname auf der alten Zeile
        // strandete. Die Regel entscheidet nur EINDEUTIGE Fälle.
        UUID takeover = findTakeover(siteId, role, template, req);
        if (takeover != null) {
            EntityRow row = entityRepo.entityForSite(siteId, takeover);
            // ⚠ Auf einer ÜBERNOMMENEN Zeile heißt ein leeres optionales Feld
            // „nichts ändern", nie „löschen" - dieselbe Regel wie beim Namen.
            // Sonst räumte ein Anlege-Formular ohne kWp-Angabe die gepflegte
            // Nennleistung und die MaStR-Referenz des Kunden ab.
            BigDecimal kwp = capacity != null || row == null ? capacity : row.capacityKwp();
            String mastr = row == null ? null : row.registryUnitId();
            if (ROLE_ERZEUGER.equals(role) && row != null) {
                // Nur die DIFFERENZ - die Zeile steckt mit ihrem alten Wert
                // schon in der Anlagen-Summe.
                BigDecimal delta = orZero(kwp).subtract(orZero(row.capacityKwp()));
                if (delta.signum() != 0) {
                    assets.addPvCapacity(tenantId, siteId, delta);
                }
            }
            // ⚠ Der Name folgt der EINEN Regel: getippt gewinnt, sonst bleibt
            // der Kundenname stehen - ein leer gelassenes Namensfeld darf ihn
            // nie durch den Modellnamen der Vorlage ersetzen.
            entityRepo.updateAdoptedPoint(takeover, role,
                    ComponentLabels.toWrite(row == null ? null : row.label(), req.label(),
                            template.modelLabel()),
                    kwp, mastr);
            if (row != null && (row.entityType() == null || row.entityType().isBlank())
                    && entityType != null) {
                entityRepo.setEntityConfig(takeover, entityType,
                        ComponentDefaults.capabilities(mapper, role),
                        ComponentDefaults.guards(mapper, role, req.capacityKwp()));
            }
            return takeover;
        }

        UUID id = points.create(tenantId, siteId, role,
                ComponentLabels.toWrite(null, req.label(), template.modelLabel()),
                template.brand(), template.model(), capacity, null);
        if (ROLE_ERZEUGER.equals(role)) {
            assets.addPvCapacity(tenantId, siteId, capacity);
        }
        if (entityType != null) {
            entityRepo.setEntityConfig(id, entityType,
                    ComponentDefaults.capabilities(mapper, role),
                    ComponentDefaults.guards(mapper, role, req.capacityKwp()));
        }
        return id;
    }

    /**
     * Der VORSCHLAG vor dem Klick: welche vorhandene Komponente dieses Gerät
     * übernehmen würde. Genau dieselbe Regel, die {@link #create} danach fährt -
     * die Fläche kann also nichts anderes ankündigen, als hinterher passiert.
     *
     * @return die Komponente, oder {@code null} wenn eine neue entstünde
     */
    public ComponentMatchDto match(UUID siteId, String rawRole, String templateRef,
            Map<String, Object> connection) {
        requireSite(siteId);
        String role = requireRole(rawRole);
        ComponentTemplateDto template = requireTemplate(templateRef);
        UUID hit = findTakeover(siteId, role, template,
                new SaveComponentRequest(templateRef, null, role, connection, null, null, null));
        if (hit == null) {
            return null;
        }
        EntityRow row = entityRepo.entityForSite(siteId, hit);
        if (row == null) {
            return null;
        }
        boolean orphaned = row.edgeSourceId() != null && !row.edgeSourceId().isBlank();
        return new ComponentMatchDto(row.id(), row.label(), row.role(), row.brand(), row.model(),
                orphaned);
    }

    /**
     * Die EINE verwaiste Komponente, in die dieses Gerät gehört - oder
     * {@code null}. Der Zaun ist bewusst eng: nur die Rollen, die dieser Weg
     * überhaupt neu anlegt (Wechselrichter und Netz-Zähler haben ihre
     * komponierte Zeile schon), und nur ein EINDEUTIGER Treffer.
     */
    private UUID findTakeover(UUID siteId, String role, ComponentTemplateDto template,
            SaveComponentRequest req) {
        if (!ROLE_ERZEUGER.equals(role) && !ROLE_CONSUMER.equals(role)) {
            return null;
        }
        List<ComponentTakeover.Existing> candidates = new java.util.ArrayList<>();
        for (EntityRow row : entityRepo.pointsForSite(siteId)) {
            candidates.add(new ComponentTakeover.Existing(row.id(), row.role(), row.brand(),
                    row.model(), row.communication(), row.connectionJson(), row.registryUnitId(),
                    row.edgeSourceId()));
        }
        return ComponentTakeover.match(candidates, reportedSourceIds(siteId),
                new ComponentTakeover.Incoming(role, template.brand(), template.model(),
                        template.communication(), writeJson(req.connection()), null),
                mapper);
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

    private static BigDecimal orZero(BigDecimal v) {
        return v == null ? BigDecimal.ZERO : v;
    }

    /** Schreibt die geltende Anbindung + ihre Fassung in die Historie. */
    private void writeDefinition(UUID siteId, UUID tenantId, UUID entityId, String role,
            SaveComponentRequest req, ComponentTemplateDto template,
            TestedConnection tested, String subject, String defaultNote) {
        String connJson = writeJson(driverConnection(tested, req, subject));
        String sourceKind = SOURCE_KIND_CERTIFIED.equals(template.kind())
                ? SOURCE_KIND_CERTIFIED : SOURCE_KIND_BUILTIN;
        EntityRow stored = entityRepo.entityForSite(siteId, entityId);
        String label = ComponentLabels.toWrite(stored == null ? null : stored.label(), req.label(),
                template.modelLabel());
        ComponentDefinitionRepository.Applied applied = definitions.applyDefinition(siteId,
                entityId, label, template.brand(), template.model(), template.family(),
                template.communication(), connJson, sourceKind, template.templateRef(),
                template.version());
        if (applied == null) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Komponente nicht gefunden.");
        }
        String note = req.note() == null || req.note().isBlank() ? defaultNote : req.note().trim();
        definitions.recordVersion(tenantId, siteId, entityId, applied.version(), role,
                applied.label(), template.brand(), template.model(), template.family(),
                template.communication(), connJson, sourceKind, template.templateRef(),
                template.version(), subject, note);
    }

    /**
     * Baut den {@code connection}-Block, den der Registry-Push als
     * {@code driver.connection} an die Box weiterreicht. Die Rolle und die
     * Zusatzfakten (kWp, Lese-Abstand) reisen MIT - der Applier braucht sie, um
     * daraus einen Quellen-Eintrag zu bauen, und sie stehen bewusst nicht in
     * einem zweiten Kanal.
     */
    private Map<String, Object> driverConnection(TestedConnection tested,
            SaveComponentRequest req, String subject) {
        Map<String, Object> out = new LinkedHashMap<>(tested.fields());
        if (req.intervalS() != null && req.intervalS() > 0) {
            out.put("interval_s", req.intervalS());
        }
        if (tested.missingChannel() != null) {
            // Das Opt-in, das die Box wirklich BRAUCHT: ohne es verwirft ihr
            // Decoder jede Lesung dieser Anlage und die Komponente bliebe für
            // immer „wartet auf erste Daten".
            out.put("allow_missing_soc", true);
            // Und der BELEG daneben - wer, wann, was fehlte. Er wohnt in der
            // Definition (das `switch.freigabe`-Muster der Stufe 4), also trägt
            // die Fassungs-Historie ihn ohne Zutun mit: „womit wurde diese
            // Komponente angelegt" ist eine Frage an die Fassung.
            Map<String, Object> proof = new LinkedHashMap<>();
            proof.put("channel", tested.missingChannel());
            proof.put("accepted_at", Instant.now().toString());
            proof.put("accepted_by", subject == null ? "" : subject);
            proof.put("origin", origin());
            out.put("reading_override", proof);
        }
        return out;
    }

    /**
     * Die HERKUNFT des Klicks, ausschließlich aus den validierten Realm-Rollen
     * des Tokens - nie aus dem Rumpf (das {@code RegisterWriteService.Actor}
     * -Muster). Ein Kunde kann keine VoltPilot-Herkunft behaupten und umgekehrt.
     */
    private static String origin() {
        Authentication auth = SecurityContextHolder.getContext().getAuthentication();
        boolean admin = auth != null && auth.getAuthorities().stream()
                .anyMatch(a -> "ROLE_platform-admin".equals(a.getAuthority()));
        return admin ? RegisterWriteEventRepository.ORIGIN_VOLTPILOT
                : RegisterWriteEventRepository.ORIGIN_CUSTOMER;
    }

    /**
     * Ob die Rolle des Rumpfs DIESELBE Komponente meint wie die gespeicherte
     * Zeile.
     *
     * <p>⚠ Ein reiner Zeichenvergleich reicht nicht, und das war ein echter
     * Sackgassen-Defekt: der Assistent spricht die VIER Kunden-Rollen
     * ({@code inverter} …), eine PLATTFORM-KOMPONIERTE Zeile trägt aber ihren
     * Entitätstyp als Rolle ({@code battery-hybrid}). Ein Wechselrichter ließ
     * sich damit nie bearbeiten - jedes {@code PUT} endete im 409 „die Art lässt
     * sich nicht ändern", obwohl niemand etwas ändern wollte. Aufgefallen ist es
     * am WEG ZURÜCK aus der „ohne Ladestand"-Ausnahme, der genau dieses PUT ist.
     *
     * <p>Der Zaun bleibt eng: verglichen wird gegen die gespeicherte Rolle ODER
     * ihre EINE Übersetzung ({@code ROLE_ENTITY_TYPE}); eine echte Umwidmung
     * (Erzeuger → Verbraucher) ist weiterhin ein Konflikt.
     */
    private static boolean sameRole(String role, EntityRow existing) {
        String stored = existing.role();
        if (role.equals(stored)) {
            return true;
        }
        String entityType = ROLE_ENTITY_TYPE.get(role);
        return entityType != null
                && (entityType.equals(stored) || entityType.equals(existing.entityType()));
    }

    private SiteComponentsDto.ComponentRowDto toRow(EntityRow row, String soll, String applied) {
        return new SiteComponentsDto.ComponentRowDto(row.id(), row.role(), row.entityType(),
                row.label(), row.brand(), row.model(), row.family(), row.communication(),
                row.connectionJson(), row.sourceKind(), row.templateRef(), row.templateVersion(),
                row.definitionVersion(), row.capacityKwp(), row.edgeSourceId(),
                syncStatus(soll, applied));
    }

    /**
     * Soll gegen Ist, ohne zu raten.
     *
     * <ul>
     *   <li>{@code unreported} - die Box hat sich zur Geräte-Konfiguration nie
     *       geäußert (ältere Software, oder noch kein Herzschlag). „Unbekannt",
     *       nie „nicht angekommen".</li>
     *   <li>{@code in_sync} - die angewandte Revision IST die komponierte.</li>
     *   <li>{@code pending} - es liegt eine neuere Fassung an, die die Box noch
     *       nicht angewandt hat.</li>
     * </ul>
     *
     * <p><b>⚠ Öffentlich, weil die Flotten-Sicht der Stufe 6 sie MITBENUTZT</b>
     * ({@code AdminComponentFleetController}). Dieselbe Frage darf nicht zwei
     * Antworten haben - eine zweite Ableitung im Admin-Aggregat wäre genau die
     * Doppeldeutigkeit, gegen die das ganze Einheitsmodell gebaut ist (das
     * {@code worstStatus}-Muster, nur richtig herum: EINE Stelle statt zweier
     * wortgleicher Kopien).
     */
    public static String syncStatus(String soll, String applied) {
        if (applied == null || applied.isBlank()) {
            return "unreported";
        }
        if (soll == null || soll.isBlank()) {
            return "unreported";
        }
        return soll.equals(applied) ? "in_sync" : "pending";
    }

    private String writeJson(Object value) {
        try {
            return mapper.writeValueAsString(value);
        } catch (Exception e) {
            throw new IllegalStateException("cannot serialize component definition", e);
        }
    }

}
