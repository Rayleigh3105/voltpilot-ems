package com.voltpilot.api.verbraucher;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.chargers.ChargerComponentComposer;
import com.voltpilot.api.chargers.ChargingConfigRepository;
import com.voltpilot.api.consumers.ConsumerFulfillmentReader;
import com.voltpilot.api.consumers.ConsumerRepository;
import com.voltpilot.api.consumers.ConsumerRepository.ConsumerRow;
import com.voltpilot.api.consumers.ConsumerRepository.PolicyRow;
import com.voltpilot.api.consumers.ConsumerRequirementLedger;
import com.voltpilot.api.entities.EntityRegistryRepository;
import com.voltpilot.api.entities.EntityRegistryRepository.EntityRow;
import com.voltpilot.api.entities.EntityTypeCatalog;
import com.voltpilot.api.entities.EntityTypeCatalog.EntityType;
import com.voltpilot.api.flows.FlowService;
import com.voltpilot.api.repo.ConsumerRequirementStateRepository;
import com.voltpilot.api.repo.DeviceChargerStatusRepository;
import com.voltpilot.api.repo.SiteRepository;
import com.voltpilot.api.web.dto.ChargingConfigDto;
import com.voltpilot.api.web.dto.ConsumerFulfillmentDto;
import com.voltpilot.api.web.dto.SiteChargingDto;
import com.voltpilot.api.web.dto.SiteDto;
import com.voltpilot.api.web.dto.VerbraucherDto;
import com.voltpilot.api.web.dto.VerbraucherDto.Eintrag;
import com.voltpilot.api.web.dto.VerbraucherDto.Ladepunkte;
import com.voltpilot.api.web.dto.VerbraucherDto.Optionen;
import com.voltpilot.api.web.dto.VerbraucherDto.RanglisteEintrag;
import com.voltpilot.api.web.dto.VerbraucherDto.Rahmen;
import com.voltpilot.api.web.dto.VerbraucherDto.Wahl;
import java.math.BigDecimal;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

/**
 * Die Zone „Verbraucher" der Steuerungsseite (Konzept
 * {@code vp-verbrauchsmgmt-konzept-v1} §6, Paket P1) - EIN Lese-Aggregat.
 *
 * <p><b>Es entsteht kein Schreibpfad und kein neues Format.</b> Der Dienst
 * komponiert ausschliesslich aus dem Bestand: die aktive {@code consumer_policy}
 * (→ {@link SteuerartProjektion}), die Quellen-Wahl der Box in
 * {@code site_charging_config} (§7.2), der {@code chargers}-Herzschlag
 * (Ladepark-Rahmen, §4.2) und die Ansprueche der AKTIVEN Flows (die „N Regeln"
 * einer Zeile). Alle Lesepfade laufen ueber die RLS-gefencten
 * {@code @Primary}-Repositories; die Mandanten-Fence sitzt wie ueberall im
 * Controller.
 *
 * <p><b>⚠ Kein N+1.</b> Jede Grundlage wird EINMAL je Anlage geholt
 * ({@code activePoliciesForSite}, {@code listForSiteByEntity},
 * {@code chargePointIdsByEntity}, {@code entityStrategies}); danach ist es nur
 * noch {@code Map.get} - das Muster von {@code AdminFleetController.fleet()}.
 *
 * <p><b>⚠ Ein Ladepunkt ist EIN Ding fuer den Kunden</b> (Captain-Entscheid):
 * die OCPP-Saeule ({@code ev-charger}, von der Plattform komponiert, ohne
 * {@code consumer_profile}) UND die go-e/Modbus-Wallbox ({@code wallbox}, mit
 * Profil) stehen im selben Abschnitt und tragen dieselben Steuerart-Woerter.
 * Nur die OCPP-Saeule folgt dem ANLAGEN-STANDARD - ihre Quelle faehrt die
 * Quellen-Bahn der Box; eine go-e kennt den Ladepark heute nicht (Paket P6).
 */
@Service
public class VerbraucherService {

    private static final Logger log = LoggerFactory.getLogger(VerbraucherService.class);

    /** Der Katalog-Typ einer go-e/Modbus-Wallbox - ein Ladepunkt ohne OCPP. */
    public static final String TYPE_WALLBOX = "wallbox";

    private final ConsumerRepository consumers;
    private final EntityRegistryRepository entities;
    private final EntityTypeCatalog catalog;
    private final DeviceChargerStatusRepository chargers;
    private final ChargingConfigRepository chargingConfig;
    private final ConsumerRequirementStateRepository ledger;
    private final FlowService flows;
    private final SiteRepository sites;
    private final SteuerartService steuerarten;
    private final JdbcTemplate jdbc;
    private final ObjectMapper mapper;

    public VerbraucherService(ConsumerRepository consumers, EntityRegistryRepository entities,
            EntityTypeCatalog catalog, DeviceChargerStatusRepository chargers,
            ChargingConfigRepository chargingConfig, ConsumerRequirementStateRepository ledger,
            FlowService flows, SiteRepository sites, SteuerartService steuerarten,
            JdbcTemplate jdbc, ObjectMapper mapper) {
        this.consumers = consumers;
        this.entities = entities;
        this.catalog = catalog;
        this.chargers = chargers;
        this.chargingConfig = chargingConfig;
        this.ledger = ledger;
        this.flows = flows;
        this.sites = sites;
        this.steuerarten = steuerarten;
        this.jdbc = jdbc;
        this.mapper = mapper;
    }

    /** true = dieser Katalog-Typ ist fuer den Kunden ein „Ladepunkt". */
    public static boolean istLadepunkt(String entityType) {
        return ChargerComponentComposer.TYPE_EV_CHARGER.equals(entityType)
                || TYPE_WALLBOX.equals(entityType);
    }

    public VerbraucherDto forSite(UUID siteId) {
        Instant now = Instant.now();
        SiteChargingDto charging = chargers.forSite(siteId);
        ChargingConfigDto config = chargingConfig.forSite(siteId);
        Rahmen rahmen = LadeparkRahmen.aus(charging.budget(), config.gridLimitKw());

        // Der Anlagen-Standard: die Quellen-Wahl der Box, mit ihrer eigenen
        // Mindestleistung (§7.2). Ist NICHT gepflegt, gilt „Schnell laden" -
        // der neutrale Wert, mit dem eine nie gefragte Anlage arbeitet.
        BigDecimal minPowerKw = charging.budget() == null || charging.budget().minPowerKw() == null
                ? null : BigDecimal.valueOf(charging.budget().minPowerKw());
        Steuerart standard = SteuerartProjektion.anlagenStandard(config.surplusPolicy(), minPowerKw);

        Map<UUID, PolicyRow> policies = consumers.activePoliciesForSite(siteId);
        Map<UUID, ConsumerRow> profile = new HashMap<>();
        for (ConsumerRow row : consumers.listForSite(siteId)) {
            profile.put(row.entityId(), row);
        }
        Map<UUID, String> chargePointIds = entities.chargePointIdsByEntity(siteId);
        // P5: die STEUERART je Säule. Sie steht in der Allowlist (die Quelle,
        // die die Box für GENAU diese Säule fährt) und schlägt den
        // Anlagen-Standard - eine Säule, die schweigt, folgt ihm weiter.
        Map<String, ChargingConfigDto.AllowedChargePointDto> saeulen = new HashMap<>();
        for (ChargingConfigDto.AllowedChargePointDto cp : config.chargePoints()) {
            saeulen.put(cp.chargePointId(), cp);
        }
        // P2: die Fakten, an denen JEDE Wahl haengt - EINMAL je Anlage geholt
        // (die Preis-Vorgabe ist eine einzige Quantil-Abfrage, die PV-Frage
        // laeuft ueber dieselben Entitaets-Zeilen wie die Schleife darunter).
        List<EntityRow> zeilen = entities.entitiesForSite(siteId);
        boolean hatVerbraucher = zeilen.stream().anyMatch(this::steuerbar);
        // ⚠ Beide Zusatz-Abfragen laufen NUR, wenn diese Anlage ueberhaupt einen
        // steuerbaren Verbraucher hat: die Preis-Vorgabe ist ein Quantil ueber
        // sieben Tage Preise, und auf einer Anlage ohne Verbraucher gaebe es
        // keinen Leser dafuer.
        SiteDto anlage = hatVerbraucher ? sites.findById(siteId) : null;
        boolean hatPv = hatVerbraucher && steuerarten.hatPv(zeilen);
        BigDecimal preisVorgabe = hatVerbraucher ? steuerarten.preisVorgabe(siteId) : null;
        Map<UUID, List<ConsumerRequirementLedger.Row>> aufgaben = ledger.listForSiteByEntity(siteId);
        Map<String, List<FlowService.EntityStrategyDto>> ansprueche = strategien(siteId);

        List<Eintrag> out = new ArrayList<>();
        List<RanglisteProjektion.Kandidat> kandidaten = new ArrayList<>();
        Map<UUID, String> namen = new LinkedHashMap<>();
        int ladepunkte = 0;
        int standardFolger = 0;

        for (EntityRow row : zeilen) {
            if (!steuerbar(row)) {
                continue;
            }
            boolean ladepunkt = istLadepunkt(row.entityType());
            boolean ocpp = ChargerComponentComposer.TYPE_EV_CHARGER.equals(row.entityType());
            String chargePointId = chargePointIds.get(row.id());
            PolicyRow policy = policies.get(row.id());
            // ⚠ Die Quelle einer OCPP-Säule kommt aus IHRER Zeile, nicht aus
            // dem Anlagen-Standard: seit P5 kann der Kunde sie je Säule
            // wählen, und der Standard gilt nur, solange sie schweigt.
            Steuerart lane = standard;
            if (ocpp && chargePointId != null) {
                ChargingConfigDto.AllowedChargePointDto cp = saeulen.get(chargePointId);
                lane = SteuerartProjektion.saeulenSteuerart(cp == null ? null : cp.source(),
                        cp != null && cp.minKw() != null ? BigDecimal.valueOf(cp.minKw())
                                : minPowerKw,
                        standard);
            }
            Steuerart steuerart = SteuerartProjektion.projiziere(dokument(policy), ocpp, lane);
            if (ladepunkt) {
                ladepunkte++;
                if (SteuerartProjektion.HERKUNFT_STANDARD.equals(steuerart.herkunft())) {
                    standardFolger++;
                }
            }
            ConsumerRow p = profile.get(row.id());
            String name = anzeigeName(row.label(), chargePointId);
            namen.put(row.id(), name == null ? "" : name);
            out.add(new Eintrag(row.id(), name, row.entityType(),
                    catalog.labelFor(row.entityType()), ladepunkt, chargePointId, steuerart,
                    ansprueche.getOrDefault(row.id().toString(), List.of()).size(),
                    fortschritt(aufgaben.get(row.id()), now),
                    p == null ? null : p.enabled(),
                    optionen(row, p, anlage, hatPv, preisVorgabe, steuerart)));
            kandidaten.add(kandidat(row.id(), ladepunkt, chargePointId, p));
        }

        List<RanglisteEintrag> rangliste = rangliste(
                RanglisteProjektion.liste(kandidaten, hatSpeicher(siteId), config.storagePriority(),
                        config.priorityChargePointIds()),
                namen);

        return new VerbraucherDto(List.copyOf(out),
                new Ladepunkte(ladepunkte > 0 ? standard : null, standardFolger, ladepunkte, rahmen),
                List.copyOf(rangliste));
    }

    /**
     * Die waehlbaren Steuerarten EINER Zeile (P2) - aus der reinen
     * {@link SteuerartSatz}, derselben Klasse, die der Schreibpfad ein zweites
     * Mal fragt.
     *
     * <p><b>⚠ Seit P5 ist auch ein OCPP-Ladepunkt schreibbar.</b> Seine QUELLE
     * faehrt weiterhin die Quellen-Bahn der Box (sie wird als
     * {@code charge_points[].source} verteilt), sein ZIEL laeuft ueber die
     * Policy-Maschine und erreicht die Saeule ueber die Arbiter-Bruecke K3 -
     * zwei Wege, EIN Schreibpfad ({@code SteuerartService.setze}).
     */
    private Optionen optionen(EntityRow row, ConsumerRow profil, SiteDto anlage, boolean hatPv,
            BigDecimal preisVorgabe, Steuerart aktuell) {
        SteuerartSatz.Kontext k =
                steuerarten.kontext(row, profil, anlage, hatPv, preisVorgabe);
        SteuerartSatz.Vorgaben v = SteuerartSatz.vorgaben(k);
        return new Optionen(true, null,
                wahlen(SteuerartSatz.quellen(k)),
                wahlen(SteuerartSatz.ziele(k, aktuell == null ? null : aktuell.quelle())),
                new VerbraucherDto.Vorgaben(v.schwelleKw(), v.preisgrenzeCtKwh(),
                        v.mindestlaufzeitMinuten(), v.sperrzeitMinuten(), v.fenster(),
                        v.zielUhrzeit(), v.zielTage(), v.zielEnergieKwh(),
                        v.zielLaufzeitMinuten(), v.zielFensterStunden()));
    }

    private static List<Wahl> wahlen(List<SteuerartSatz.Option> optionen) {
        List<Wahl> out = new ArrayList<>();
        for (SteuerartSatz.Option o : optionen) {
            out.add(new Wahl(o.id(), o.gesperrt(), o.grund()));
        }
        return List.copyOf(out);
    }

    /**
     * Die Kandidaten der Rangliste - GENAU die Menge, die {@link #forSite}
     * zeigt. Der Schreibweg ({@link RanglisteService}) holt sie hierueber, weil
     * eine zweite Auswahl den Rundlauf „gelesene Liste → gespeichert → wieder
     * gelesen" zerreissen wuerde.
     */
    List<RanglisteProjektion.Kandidat> kandidatenFuer(UUID siteId) {
        Map<UUID, ConsumerRow> profile = new HashMap<>();
        for (ConsumerRow row : consumers.listForSite(siteId)) {
            profile.put(row.entityId(), row);
        }
        Map<UUID, String> chargePointIds = entities.chargePointIdsByEntity(siteId);
        List<RanglisteProjektion.Kandidat> out = new ArrayList<>();
        for (EntityRow row : entities.entitiesForSite(siteId)) {
            if (!steuerbar(row)) {
                continue;
            }
            out.add(kandidat(row.id(), istLadepunkt(row.entityType()),
                    chargePointIds.get(row.id()), profile.get(row.id())));
        }
        return List.copyOf(out);
    }

    /** Zaehlt diese Entitaet als steuerbarer Verbraucher der Zone? */
    private boolean steuerbar(EntityRow row) {
        EntityType type = catalog.find(row.entityType());
        return type != null && "consumer".equals(type.category()) && type.controllable();
    }

    /**
     * <b>⚠ {@code storageRelation} ist der RANKBAR-Marker</b> (siehe
     * {@link RanglisteProjektion}): die Spalte ist NOT NULL, ein {@code null}
     * heisst also genau „diese Komponente hat kein {@code consumer_profile}"
     * und ist damit nicht einzeln rangierbar.
     */
    private static RanglisteProjektion.Kandidat kandidat(UUID entityId, boolean ladepunkt,
            String chargePointId, ConsumerRow profil) {
        return new RanglisteProjektion.Kandidat(
                ladepunkt ? RanglisteProjektion.ART_LADEPUNKT
                        : RanglisteProjektion.ART_VERBRAUCHER,
                entityId, chargePointId, profil == null ? null : profil.storageRelation(),
                profil == null ? null : profil.defaultServiceRank());
    }

    /** Die Zeilen der Rangliste - die Namen kennt der Server schon. */
    private List<RanglisteEintrag> rangliste(List<RanglisteProjektion.Eintrag> eintraege,
            Map<UUID, String> namen) {
        List<RanglisteEintrag> out = new ArrayList<>();
        for (RanglisteProjektion.Eintrag e : eintraege) {
            List<VerbraucherDto.Mitglied> mitglieder = new ArrayList<>();
            for (UUID id : e.mitglieder()) {
                mitglieder.add(new VerbraucherDto.Mitglied(id, namen.getOrDefault(id, "")));
            }
            String name = RanglisteProjektion.ART_SPEICHER.equals(e.art()) ? SPEICHER_NAME
                    : e.entityId() == null ? null : namen.getOrDefault(e.entityId(), "");
            out.add(new RanglisteEintrag(e.position(), e.art(), e.entityId(), name,
                    List.copyOf(mitglieder)));
        }
        return List.copyOf(out);
    }

    /** Der Speicher heisst in der Rangliste beim Namen, den er ueberall traegt. */
    static final String SPEICHER_NAME = "Speicher";

    /**
     * Der Anzeigename: der vergebene Name, sonst die OCPP-Kennung, sonst nichts.
     *
     * <p>Die Kennung ist bewusst NICHT als {@code label} gespeichert (die
     * Alias-Invariante des Hauses: {@code label != NULL} heisst „von einem
     * Menschen vergeben"), also faellt die ANZEIGE darauf zurueck - genau wie
     * {@code ladepunkte.chargerName} im Portal und der Lesepfad der Ladepunkte.
     */
    static String anzeigeName(String label, String chargePointId) {
        String l = label == null ? "" : label.trim();
        if (!l.isEmpty()) {
            return l;
        }
        return chargePointId == null || chargePointId.isBlank() ? null : chargePointId;
    }

    private ConsumerFulfillmentDto.Task fortschritt(List<ConsumerRequirementLedger.Row> rows,
            Instant now) {
        return ConsumerFulfillmentReader.aktuelle(rows, now);
    }

    private JsonNode dokument(PolicyRow policy) {
        if (policy == null || policy.documentJson() == null) {
            return null;
        }
        try {
            return mapper.readTree(policy.documentJson());
        } catch (Exception e) {
            // Ein unlesbares Dokument ist keine Steuerart - und kein Grund, die
            // ganze Zone zu verlieren. Die Projektion faellt dann auf „ohne
            // Policy" zurueck, was die Zeile ehrlich als „Sofort" liest.
            log.warn("Policy der Komponente {} ist unlesbar: {}", policy.entityId(), e.toString());
            return null;
        }
    }

    /**
     * Die Ansprueche der AKTIVEN Flows je Komponente. Fail-soft: eine Anlage,
     * deren Flow-Dokumente gerade nicht lesbar sind, verliert die ZAHL ihrer
     * Regeln - nicht ihre Zone.
     */
    private Map<String, List<FlowService.EntityStrategyDto>> strategien(UUID siteId) {
        try {
            // ⚠ OHNE die generierten Verbraucher-Flows: einer davon IST die
            // Steuerart dieser Zeile, keine Regel daneben (P2). Die Zahl
            // beantwortet „was greift ZUSAETZLICH?".
            return flows.entityStrategies(siteId, false);
        } catch (RuntimeException e) {
            log.warn("Regel-Ansprueche der Anlage {} nicht lesbar: {}", siteId, e.toString());
            return Map.of();
        }
    }

    /**
     * Hat die Anlage einen Speicher? Genau die Abfrage, mit der
     * {@code ConsumerService.siteHasStorage} dieselbe Frage beantwortet - eine
     * zweite Ableitung waere eine zweite Wahrheit.
     */
    boolean hatSpeicher(UUID siteId) {
        Integer n = jdbc.queryForObject(
                "SELECT count(*) FROM asset WHERE site_id = ? AND type = 'battery'", Integer.class,
                siteId);
        return n != null && n > 0;
    }
}
