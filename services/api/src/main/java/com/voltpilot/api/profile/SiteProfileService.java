package com.voltpilot.api.profile;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.chargers.ChargingConfigRepository;
import com.voltpilot.api.flows.FlowCatalog;
import com.voltpilot.api.flows.FlowService;
import com.voltpilot.api.flows.FlowTemplateService;
import com.voltpilot.api.profile.AnwendungKatalog.Anwendung;
import com.voltpilot.api.profile.AnwendungKatalog.Voraussetzung;
import com.voltpilot.api.profile.UsageProfileDeriver.Signals;
import com.voltpilot.api.repo.FlowGatedNodeRepository;
import com.voltpilot.api.repo.FlowRepository;
import com.voltpilot.api.repo.FlowRepository.FlowVersionRow;
import com.voltpilot.api.repo.SiteProfileStateRepository;
import com.voltpilot.api.repo.SiteRepository;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.web.dto.SiteDto;
import com.voltpilot.api.web.dto.SiteProfilesDto;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

/**
 * Das ANWENDUNGS-Regal einer Anlage (Portal v3 M3, erweitert um den EINEN
 * Anwendungs-Katalog, Zielbild {@code vp-portal-zielbild-anwendungen} Stufe 1):
 * dieser Dienst verheiratet den GESPEICHERTEN Kundenwillen
 * ({@link SiteProfileStateRepository}) mit den Ableitungs-Signalen
 * ({@link UsageProfileService}) zum Regal-Read-Model und führt die zwei
 * Übergänge aus.
 *
 * <p><b>Alles Beschreibende kommt aus {@link AnwendungKatalog}</b> — Label,
 * Nutzen, Voraussetzungen samt ihren Sperr-Sätzen, Bausteine, Einstellungen,
 * Starter. Die REGELN (was aktiviert von selbst, welche Voraussetzung ist
 * erfüllt) leben rein in {@link AnwendungDerivation} und sind gegen die
 * Portal-Zwillinge über {@code docs/contracts/v2/anwendung-vectors.json}
 * gepinnt. Es gibt keine Hand-Tabelle mehr in dieser Klasse.
 *
 * <p><b>Jede schaltbare Anwendung ist ein direkter Kundenschalter.</b> Es gibt
 * keinen Zustand „angefragt" und keine VoltPilot-Anfragewand (Owner-Entscheid).
 * Was ein Einschalten TUT, hängt an der KLASSE der Anwendung:
 * <ul>
 *   <li><b>basis</b> — nicht schaltbar. Ein Schaltversuch ist ein 400 mit
 *       deutschem Grund; die Anwendung läuft ohnehin.</li>
 *   <li><b>regel</b> — der Schalter speichert nur die ABSICHT: kein Gate wird
 *       geöffnet, kein Starter gesät. Eingeschaltet ohne eine einzige
 *       Kunden-Regel liest die Karte den ehrlichen Leer-Zustand des Katalogs
 *       mit dem Einstieg in „Komponenten &amp; Regeln" — der Server erfindet
 *       keine Regel.</li>
 *   <li><b>geschaeft</b> — wie bisher: (a) genau die gated Knotentypen DIESER
 *       Anwendung freischalten, (b) ihren Starter säen, (c) {@code an}
 *       speichern. Ausschalten legt ihre Flows still, schließt die Knoten
 *       wieder und speichert {@code aus}, damit ein erneut abgeleitetes Signal
 *       sie nicht stillschweigend wiederbelebt.</li>
 * </ul>
 *
 * <p><b>Das Tor wird geöffnet, nie vorgetäuscht</b> (BUILD.md §4.9): die
 * Freischaltung ist eine autorisierte, protokollierte Server-Wirkung einer
 * ausdrücklichen Kundenhandlung — geschrieben über den RLS-gefencten
 * App-Datenpfad für die EIGENE Anlage des Aufrufers. Der Aktivierungspfad prüft
 * sie weiterhin nach, das Lastspitzen-Konfigurations-Tor bindet unverändert,
 * und die Schutzkette der Box / §14a / EEG bleibt unberührt.
 */
@Service
public class SiteProfileService {

    private static final Logger log = LoggerFactory.getLogger(SiteProfileService.class);

    private static final String ORIGIN_MASTERDATA = "masterdata";
    private static final String ORIGIN_FLOW = "flow";

    private final SiteRepository sites;
    private final SiteProfileStateRepository states;
    private final UsageProfileService usageProfiles;
    private final FlowGatedNodeRepository gatedNodes;
    private final FlowRepository flows;
    private final FlowService flowService;
    private final FlowTemplateService templates;
    private final FlowCatalog catalog;
    private final AnwendungKatalog anwendungen;
    private final ObjectMapper mapper;
    private final ChargingConfigRepository chargingConfigs;

    public SiteProfileService(SiteRepository sites, SiteProfileStateRepository states,
            UsageProfileService usageProfiles, FlowGatedNodeRepository gatedNodes,
            FlowRepository flows, FlowService flowService, FlowTemplateService templates,
            FlowCatalog catalog, AnwendungKatalog anwendungen, ObjectMapper mapper,
            ChargingConfigRepository chargingConfigs) {
        this.sites = sites;
        this.states = states;
        this.usageProfiles = usageProfiles;
        this.gatedNodes = gatedNodes;
        this.flows = flows;
        this.flowService = flowService;
        this.templates = templates;
        this.catalog = catalog;
        this.anwendungen = anwendungen;
        this.mapper = mapper;
        this.chargingConfigs = chargingConfigs;
    }

    // -- read ---------------------------------------------------------------

    /** The shelf of a site, or null when RLS hides it (=&gt; 404). */
    public SiteProfilesDto profiles(UUID siteId) {
        SiteDto site = sites.findById(siteId);
        if (site == null) {
            return null;
        }
        return shelf(siteId, site);
    }

    private SiteProfilesDto shelf(UUID siteId, SiteDto site) {
        UsageProfileService.PlantSignals plant = usageProfiles.plantSignals(siteId, site);
        Map<String, String> stored = states.findBySite(siteId);
        Set<String> enabled = gatedNodes.enabledNodeTypes(siteId);
        FlowIndex index = indexFlows(siteId);
        AnwendungDerivation.Input in = derivationInput(site, plant, index);

        List<SiteProfilesDto.Profile> cards = new ArrayList<>();
        for (Anwendung a : anwendungen.regal()) {
            String state = stored.get(a.id());
            boolean derived = AnwendungDerivation.derivedActive(a.id(), in);
            boolean active = SiteProfileStateRepository.STATE_AUS.equals(state) ? false
                    : SiteProfileStateRepository.STATE_AN.equals(state) || derived;
            List<SiteProfilesDto.Requirement> requirements = requirements(a, in);
            FlowVersionRow flow = index.byNodeType.get(a.strategieKnoten());
            List<String> gated = List.copyOf(AnwendungKatalog.gatedNodeTypes(a, catalog));
            cards.add(new SiteProfilesDto.Profile(a.id(), a.label(), state, derived, active,
                    unlocks(a), requirements, active ? blockedReason(a, requirements, in) : null,
                    active ? (flow != null ? ORIGIN_FLOW : ORIGIN_MASTERDATA) : null,
                    flow == null ? null
                            : new SiteProfilesDto.FlowRef(flow.flowId().toString(), flow.name()),
                    gated, gated.isEmpty() || enabled.containsAll(gated)));
        }
        return new SiteProfilesDto(cards);
    }

    // -- write --------------------------------------------------------------

    /**
     * Toggle one application. Returns the recomputed shelf; a foreign/unknown
     * site is a 404 through RLS, an unknown application/state a 400, and a
     * BASIS application (which has no switch at all) an honest 400.
     */
    @Transactional
    public SiteProfilesDto setState(UUID siteId, String profileId, String state) {
        SiteDto site = sites.findById(siteId);
        if (site == null) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Anlage nicht gefunden.");
        }
        Anwendung anwendung = anwendungen.find(profileId);
        // Eine reservierte Anwendung wird gar nicht angeboten - sie ist für
        // einen Aufrufer nicht von einer unbekannten zu unterscheiden, und das
        // ist richtig so: es gibt sie noch nicht.
        if (anwendung == null || !anwendung.sichtbar()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "Unbekanntes Profil: " + profileId + ".");
        }
        if (!anwendung.abschaltbar()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "„" + anwendung.label() + "“ ist immer an und lässt sich nicht "
                            + "abschalten.");
        }
        if (!SiteProfileStateRepository.STATE_AN.equals(state)
                && !SiteProfileStateRepository.STATE_AUS.equals(state)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "state muss \"an\" oder \"aus\" sein.");
        }
        UUID tenantId = TenantContext.get();
        if (SiteProfileStateRepository.STATE_AN.equals(state)) {
            switchOn(siteId, tenantId, anwendung, site);
        } else {
            switchOff(siteId, tenantId, anwendung);
        }
        states.upsert(tenantId, siteId, anwendung.id(), state);
        return shelf(siteId, site);
    }

    private void switchOn(UUID siteId, UUID tenantId, Anwendung anwendung, SiteDto site) {
        if (anwendung.istRegel()) {
            // Eine REGEL-Anwendung hat keine freien Knoten zu öffnen und keinen
            // Starter zu säen - ihr Inhalt sind die Regeln, die der Kunde selbst
            // baut. Der Schalter ist reine Absicht; die Karte sagt danach
            // ehrlich, dass noch keine Regel existiert (blockedReason).
            return;
        }
        // OPEN(O1, BUILD.md §8 / M3-profile.md): the toggle is INTENT. A bare
        // customer switch must not start UNCONTRACTED market participation, so
        // the market strategy is only really opened when the site actually has
        // market access - a dynamic tariff and/or Direktvermarktung, the same
        // master data the surface derivation and the optimizer's pricing layer
        // read. Without it the application still switches on (and says so
        // honestly via blockedReason), but its gated node stays closed and no
        // starter flow is seeded, so NOTHING trades. Toggling NEVER writes that
        // master data - a tariff or a DV contract is a real-world fact, entered
        // on the Vergütung form. If the owner answers O1 with "an explicit
        // contract flag is required", this ONE condition changes.
        if (AnwendungKatalog.MARKTVERMARKTUNG.equals(anwendung.id()) && !hasMarketAccess(site)) {
            log.info("Marktoptimierung switched on for site {} without market access - "
                    + "intent stored, gated node NOT opened, no starter flow seeded", siteId);
            return;
        }
        for (String nodeType : AnwendungKatalog.gatedNodeTypes(anwendung, catalog)) {
            gatedNodes.upsert(tenantId, siteId, nodeType, true);
        }
        if (anwendung.starter() != null) {
            FlowTemplateService.AutoStartOutcome outcome =
                    templates.autoStart(siteId, tenantId, anwendung.starter());
            if (!outcome.created()) {
                // already_has_flow / no_battery are honest, expected outcomes -
                // the card surfaces them, they never fail the toggle.
                log.debug("auto-start for anwendung {} on site {} skipped: {}", anwendung.id(),
                        siteId, outcome.reason());
            }
        }
    }

    private void switchOff(UUID siteId, UUID tenantId, Anwendung anwendung) {
        if (anwendung.strategieKnoten() == null) {
            // Eine Anwendung OHNE Strategie-Knoten (Regel-Anwendungen,
            // Lastmanagement) hat keinen Flow, den man stilllegen könnte, und
            // nichts freigeschaltetes, das man schließen müsste - der
            // gespeicherte Zustand IST die ganze Abschaltung. Beim
            // Lastmanagement bleibt die SCHUTZ-Wirkung auf der Box: sie hört
            // nicht auf, den Anschluss zu bewachen, weil eine Karte auf "aus"
            // steht. Und eine Kunden-REGEL wird nie von einem Regal-Schalter
            // stillgelegt - sie gehört dem Kunden, nicht der Anwendung.
            return;
        }
        for (FlowVersionRow row : flows.versionsForSite(siteId)) {
            if ("active".equals(row.lifecycle()) && carries(row, anwendung.strategieKnoten())) {
                flowService.deactivate(siteId, row.flowId());
            }
        }
        for (String nodeType : AnwendungKatalog.gatedNodeTypes(anwendung, catalog)) {
            gatedNodes.upsert(tenantId, siteId, nodeType, false);
        }
    }

    // -- derivation ---------------------------------------------------------

    /**
     * Die Eingabe der reinen Ableitung — die Schnittmenge dessen, was Server
     * und Portal beide besitzen. Genau diese Felder stehen in den geteilten
     * Vektoren ({@code anwendung-vectors.json}).
     */
    private AnwendungDerivation.Input derivationInput(SiteDto site,
            UsageProfileService.PlantSignals plant, FlowIndex index) {
        Signals signals = plant.signals();
        Set<String> activeNodeTypes = new LinkedHashSet<>(signals.activeStrategyNodeTypes());
        activeNodeTypes.addAll(index.nodeTypes);
        return new AnwendungDerivation.Input(signals.hasStorage(), signals.hasPv(),
                signals.hasControllableConsumer(), signals.hasChargePoint(), plant.hasMeasurement(),
                signals.hasLeistungspreis(),
                chargingConfigs.forSite(site.id()).gridLimitKw() != null, activeNodeTypes,
                index.hasCustomerRule, site.plantKind(), site.tarifArt(), site.netzladenErlaubt());
    }

    /** Market access = a dynamic tariff and/or Direktvermarktung (see OPEN(O1)). */
    private boolean hasMarketAccess(SiteDto site) {
        return "dynamisch".equals(site.tarifArt()) || "direktvermarktung".equals(site.plantKind());
    }

    /** Die Voraussetzungs-Chips: Label aus dem Katalog, Urteil aus der Regel. */
    private List<SiteProfilesDto.Requirement> requirements(Anwendung a,
            AnwendungDerivation.Input in) {
        List<SiteProfilesDto.Requirement> chips = new ArrayList<>();
        for (Voraussetzung v : a.voraussetzungen()) {
            chips.add(new SiteProfilesDto.Requirement(v.label(),
                    AnwendungDerivation.requirementMet(v.id(), in)));
        }
        return chips;
    }

    /**
     * Der ehrliche deutsche Satz für eine EINGESCHALTETE Anwendung, die noch
     * nicht voll läuft — konkret über das, was fehlt, nie eine Aufforderung.
     * Reihenfolge: ein IMMER geltender Satz (Ökonomie nicht gebaut) schlägt
     * alles; sonst gewinnt die ERSTE unerfüllte Voraussetzung mit ihrem eigenen
     * Satz; sonst — nur bei einer Regel-Anwendung und nur BELEGT — der
     * Leer-Zustand.
     */
    private String blockedReason(Anwendung a, List<SiteProfilesDto.Requirement> requirements,
            AnwendungDerivation.Input in) {
        if (a.blockedReasonImmer() != null) {
            return a.blockedReasonImmer();
        }
        for (int i = 0; i < requirements.size(); i++) {
            if (!requirements.get(i).met()) {
                String reason = a.voraussetzungen().get(i).blockedReason();
                return reason != null ? reason : "Für diese Anwendung fehlt noch eine Voraussetzung.";
            }
        }
        // Nur wenn die Anlage NACHWEISLICH keine einzige Kunden-Regel trägt,
        // darf der Leer-Zustand behauptet werden. Gibt es irgendeine, wissen
        // wir nicht, ob sie zu DIESER Anwendung gehört - dann wird nichts
        // behauptet (der Server erfindet nichts).
        if (a.istRegel() && a.leerZustand() != null && !in.hasCustomerRule()) {
            return a.leerZustand();
        }
        return null;
    }

    /** What switching this application on adds to the surface (M0 manifests). */
    private SiteProfilesDto.Unlocks unlocks(Anwendung a) {
        return new SiteProfilesDto.Unlocks(a.bausteine().ansichten(), a.bausteine().cockpit(),
                a.bausteine().geldstrom());
    }

    /** Was die AKTIVEN Flows dieser Anlage über sie verraten. */
    private static final class FlowIndex {
        /** Alle Knotentypen aktiver Flows. */
        final Set<String> nodeTypes = new LinkedHashSet<>();
        /** Erster aktiver Flow je Knotentyp (für die „Flow öffnen"-Affordanz). */
        final Map<String, FlowVersionRow> byNodeType = new LinkedHashMap<>();
        /** ≥ 1 aktiver Flow OHNE Strategie-Knoten = eine Kunden-Regel. */
        boolean hasCustomerRule;
    }

    private FlowIndex indexFlows(UUID siteId) {
        FlowIndex index = new FlowIndex();
        for (FlowVersionRow row : flows.versionsForSite(siteId)) {
            if (!"active".equals(row.lifecycle())) {
                continue;
            }
            boolean strategy = false;
            for (String type : nodeTypes(row)) {
                index.nodeTypes.add(type);
                index.byNodeType.putIfAbsent(type, row);
                if (type != null && type.startsWith("vp.strategy.")) {
                    strategy = true;
                }
            }
            if (!strategy) {
                index.hasCustomerRule = true;
            }
        }
        return index;
    }

    private boolean carries(FlowVersionRow row, String nodeType) {
        return nodeTypes(row).contains(nodeType);
    }

    private List<String> nodeTypes(FlowVersionRow row) {
        List<String> types = new ArrayList<>();
        if (row.documentJson() == null) {
            return types;
        }
        try {
            JsonNode doc = mapper.readTree(row.documentJson());
            for (JsonNode node : doc.path("nodes")) {
                types.add(node.path("type").asText());
            }
        } catch (Exception e) {
            log.warn("flow document {} unreadable, skipped: {}", row.flowId(), e.getMessage());
        }
        return types;
    }
}
