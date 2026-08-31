package com.voltpilot.api.verbraucher;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.chargers.ChargerComponentComposer;
import com.voltpilot.api.chargers.ChargingConfigService;
import com.voltpilot.api.consumers.ConsumerPolicyActivationService;
import com.voltpilot.api.consumers.ConsumerPolicyActivationService.ActivationOutcome;
import com.voltpilot.api.consumers.ConsumerRepository;
import com.voltpilot.api.consumers.ConsumerRepository.ConsumerRow;
import com.voltpilot.api.consumers.ConsumerService;
import com.voltpilot.api.entities.EntityRegistryRepository;
import com.voltpilot.api.entities.EntityRegistryRepository.EntityRow;
import com.voltpilot.api.entities.EntityTypeCatalog;
import com.voltpilot.api.entities.EntityTypeCatalog.EntityType;
import com.voltpilot.api.history.HistoryRange;
import com.voltpilot.api.profile.UsageProfileService;
import com.voltpilot.api.repo.SiteRepository;
import com.voltpilot.api.topology.TopologyDeriver;
import com.voltpilot.api.web.dto.SiteDto;
import java.math.BigDecimal;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;

/**
 * Der SCHREIBPFAD der Steuerart (Konzept
 * {@code vp-verbrauchsmgmt-konzept-v1} §4.4/§3.3, Paket P2).
 *
 * <p><b>⚠ ES ENTSTEHT KEINE ZWEITE MASCHINE.</b> Er stellt ein
 * {@code consumer_profile} sicher, schreibt die Requirement-Projektion
 * ({@link SteuerartDokument}) als NEUE Policy-Fassung und aktiviert sie ueber
 * den BESTEHENDEN Pfad ({@code ConsumerPolicyActivationService}) - mit dessen
 * Kompilierung, dessen V-5-Anspruchspruefung, dessen Flag-Toren und dessen
 * Audit-Spur. Die Steuerart ist eine OBERFLAECHE auf der Policy-Maschine.
 *
 * <p><b>⚠ „Sofort" NIMMT ZURUECK, statt eine leere Policy zu schreiben.</b> Das
 * Schema verlangt {@code minItems: 1}; §3.3 sagt fuer diese Quelle „keine
 * Anforderung". Also laeuft „Sofort" ueber den flag-UNABHAENGIGEN Stopppfad
 * ({@code deactivate}), der die aktive Fassung stilllegt UND das retained
 * Artefakt zurueckzieht - die Haus-Regel „Flag aus ≠ gestoppt". Die Projektion
 * liest das danach als {@code sofort} (Regel 2), der Rundlauf schliesst sich.
 *
 * <p><b>⚠ Der OCPP-Ladepunkt ({@code ev-charger}) ist seit P5 schreibbar - ueber
 * ZWEI Wege, EINEN Schreibpfad.</b> Seine QUELLE faehrt die Quellen-Bahn der
 * Box ({@code charging-config.charge_points[].source}); sein ZIEL und die
 * Quelle „Guenstige Stunden" laufen ueber dieselbe Policy-Maschine wie bei
 * jedem anderen Verbraucher und erreichen die Saeule ueber die Arbiter-Bruecke
 * K3. Welcher Weg zustaendig ist, entscheidet die QUELLE - sie ist exklusiv:
 *
 * <ul>
 *   <li>{@code sofort} → Bahn {@code schnell}, keine Policy (die aktive wird
 *       zurueckgenommen).</li>
 *   <li>{@code ueberschuss} → Bahn {@code nur_sonne} bzw. {@code sonne_zuerst}
 *       (+ Mindestleistung). Ohne Ziel gibt es KEIN Dokument - die Bahn allein
 *       IST die Steuerart, und sie zusaetzlich als
 *       {@code site.pv_surplus_kw}-Regel zu schreiben waere dieselbe Aussage
 *       zweimal.</li>
 *   <li>{@code guenstig} → Bahn {@code schnell} (die Quelle sagt ausdruecklich
 *       „Netzstrom, wenn er billig ist" - eine Sonnen-Bahn daneben liesse sie
 *       nie greifen) + die Preis-Policy.</li>
 * </ul>
 *
 * <p>Ein ZIEL kommt in jedem Fall aus der Policy - die Bahn kennt keine Frist.
 *
 * <p><b>⚠ Bewusst KEIN {@code @Transactional} um den ganzen Vorgang.</b> Der
 * Entwurf wird gespeichert, DANN aktiviert - genau die Reihenfolge, die die
 * bestehende Flaeche seit Inkrement 4 faehrt. Eine umschliessende Transaktion
 * wuerde eine abgelehnte Aktivierung (Compiler weg, Flag aus, fremder
 * Anspruch) den ENTWURF mit zurueckrollen; er soll aber stehen bleiben, und
 * genau das sagt die Antwort dann auch.
 */
@Service
public class SteuerartService {

    /**
     * Der Satz, mit dem ein OCPP-Ladepunkt OHNE eingetragene Kennung seinen
     * fehlenden Schreibweg nennt.
     *
     * <p>⚠ Er gilt seit P5 nur noch fuer den einen Fall, in dem die Bahn
     * wirklich nicht erreichbar ist: eine komponierte Saeule, die in der
     * Allowlist der Anlage (noch) nicht steht - dann gibt es keine Zeile, auf
     * die {@code charge_points[].source} geschrieben werden koennte.
     */
    public static final String OCPP_OHNE_KENNUNG =
            "Diese Ladesäule ist im Portal noch nicht eingetragen — tragen Sie sie im "
            + "Ladepark ein, dann lässt sich ihre Steuerart hier stellen.";

    /** Was der Schreibvorgang bewirkt hat - die Antwort des Endpunkts. */
    public record Ergebnis(Steuerart steuerart, boolean aktiv, String grund, String nachricht,
            boolean verteilt, Integer policyVersion) {}

    private final SiteRepository sites;
    private final EntityRegistryRepository entities;
    private final EntityTypeCatalog catalog;
    private final ConsumerRepository consumers;
    private final ConsumerService consumerService;
    private final ConsumerPolicyActivationService activation;
    private final UsageProfileService profiles;
    private final SteuerartPreisVorgabe preise;
    private final ChargingConfigService charging;
    private final ObjectMapper mapper;

    public SteuerartService(SiteRepository sites, EntityRegistryRepository entities,
            EntityTypeCatalog catalog, ConsumerRepository consumers,
            ConsumerService consumerService, ConsumerPolicyActivationService activation,
            UsageProfileService profiles, SteuerartPreisVorgabe preise,
            ChargingConfigService charging, ObjectMapper mapper) {
        this.sites = sites;
        this.entities = entities;
        this.catalog = catalog;
        this.consumers = consumers;
        this.consumerService = consumerService;
        this.activation = activation;
        this.profiles = profiles;
        this.preise = preise;
        this.charging = charging;
        this.mapper = mapper;
    }

    // -----------------------------------------------------------------------
    // Der Kontext (die Fakten, an denen jede Wahl haengt)
    // -----------------------------------------------------------------------

    /**
     * Die Fakten EINER Komponente. {@code rows}/{@code site} bringt der
     * Aufrufer mit, damit das Lese-Aggregat sie nicht je Zeile neu holt.
     */
    public SteuerartSatz.Kontext kontext(EntityRow row, ConsumerRow profil, SiteDto site,
            boolean hatPv, BigDecimal preisVorgabe) {
        return new SteuerartSatz.Kontext(row.entityType(),
                profil != null ? profil.ratedPowerKw() : row.capacityKwp(),
                profil == null ? null : profil.minPowerKw(),
                profil == null ? null : profil.confirmationChannel(),
                site == null ? null : site.tarifArt(), hatPv, preisVorgabe);
    }

    /**
     * Hat diese Anlage eine Erzeugung? Die EINE Ableitung
     * ({@link UsageProfileService#measuredRoles}) - capability-basiert, nie
     * kategorie-basiert (MIG §4: die naive Fassung meldete auf jeder
     * Hybrid-Anlage {@code false}).
     */
    public boolean hatPv(List<EntityRow> rows) {
        for (EntityRow row : rows) {
            if (profiles.measuredRoles(row).contains(TopologyDeriver.ROLE_PV)) {
                return true;
            }
        }
        return false;
    }

    /** Die Preis-Vorgabe der Anlage (E7) - {@code null}, wenn es keine gibt. */
    public BigDecimal preisVorgabe(UUID siteId) {
        return preise.fuerAnlage(siteId, Instant.now());
    }

    // -----------------------------------------------------------------------
    // Der Schreibpfad
    // -----------------------------------------------------------------------

    /**
     * Setzt die Steuerart EINER Komponente.
     *
     * @param actor der Urheber fuer die Audit-Spur (das JWT-Subject)
     */
    public Ergebnis setze(UUID siteId, UUID entityId, SteuerartWunsch wunsch, String actor) {
        // EINMAL geholt: die Zeile der Komponente UND die PV-Frage der Anlage
        // stehen in derselben Liste (kein zweiter Scan auf dem Schreibpfad).
        List<EntityRow> rows = entities.entitiesForSite(siteId);
        EntityRow row = entity(rows, entityId);
        boolean ocpp = ChargerComponentComposer.TYPE_EV_CHARGER.equals(row.entityType());
        EntityType type = catalog.find(row.entityType());
        if (type == null || !"consumer".equals(type.category()) || !type.controllable()) {
            throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY,
                    "Diese Komponente lässt sich nicht steuern.");
        }

        // Erst das Profil - ohne es gibt es weder Nennleistung noch
        // Nachweiskanal, und beide entscheiden, was ueberhaupt waehlbar ist.
        ConsumerRow profil = consumerService.ensureProfile(siteId, row);
        SiteDto site = sites.findById(siteId);
        SteuerartSatz.Kontext k = kontext(row, profil, site, hatPv(rows), preisVorgabe(siteId));

        List<String> fehler = SteuerartSatz.pruefe(k, wunsch);
        if (!fehler.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, fehler.get(0));
        }

        // Die Folgefragen, die im PROFIL wohnen (§3.2): Mindestlaufzeit und -
        // nur bei der SG-Ready-Freigabe - die Sperrzeit danach.
        consumerService.updateZyklus(siteId, entityId, sekunden(wunsch.mindestlaufzeitMinuten()),
                sekunden(wunsch.sperrzeitMinuten()));

        // P5: an einer OCPP-Säule fährt die QUELLE die Bahn der Box - sie wird
        // dort geschrieben und deshalb NICHT als Policy-Anforderung.
        boolean quelleFaehrtDieBox = false;
        if (ocpp) {
            quelleFaehrtDieBox = schreibeBahn(siteId, entityId, row, wunsch);
        }
        ObjectNode dokument = SteuerartDokument.dokument(entityId.toString(),
                HistoryRange.ZONE.getId(), wunsch, k, quelleFaehrtDieBox);
        if (dokument == null) {
            return sofort(siteId, entityId, actor);
        }
        var draft = consumerService.savePolicyDraft(siteId, entityId, dokument, actor);
        ActivationOutcome outcome = activation.activate(siteId, entityId, actor);
        return new Ergebnis(steuerart(siteId, entityId), outcome.activated(),
                outcome.reason(), outcome.message(), outcome.published(),
                outcome.policyVersion() != null ? outcome.policyVersion() : draft.version());
    }

    /**
     * Schreibt die QUELLEN-BAHN einer OCPP-Säule (P5) und sagt, ob sie die
     * Quelle damit trägt.
     *
     * <p><b>⚠ Die Bahn wird IMMER geschrieben</b>, auch für „Günstige Stunden"
     * und „Sofort" - dort auf {@code schnell}. Ohne das behielte eine Säule,
     * die vorher auf „Nur Sonnenstrom" stand, ihre Sonnen-Bahn, und die neue
     * Quelle könnte nie greifen: die Bahn deckelt unabhängig von jeder Policy.
     *
     * @return true, wenn die Bahn die Quelle trägt (dann schreibt das Dokument
     *         sie nicht noch einmal) - false bei „Günstige Stunden", deren
     *         Fenster nur die Policy kennt
     */
    private boolean schreibeBahn(UUID siteId, UUID entityId, EntityRow row,
            SteuerartWunsch wunsch) {
        String chargePointId = entities.chargePointIdsByEntity(siteId).get(entityId);
        if (chargePointId == null || chargePointId.isBlank()) {
            throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY, OCPP_OHNE_KENNUNG);
        }
        String quelle = wunsch == null ? null : wunsch.quelle();
        String bahn;
        BigDecimal minKw = null;
        if (SteuerartProjektion.QUELLE_UEBERSCHUSS.equals(quelle)) {
            // ⚠ Die Vorgabe ist „pausieren" = nur Sonnenstrom: sie ist die
            // engere der beiden und damit die, die niemanden überrascht.
            boolean mindest = SteuerartProjektion.MODUS_MINDESTLEISTUNG
                    .equals(wunsch.ueberschussModus());
            bahn = mindest ? SteuerartProjektion.POLICY_SONNE_ZUERST
                    : SteuerartProjektion.POLICY_NUR_SONNE;
            minKw = mindest ? wunsch.mindestleistungKw() : null;
        } else {
            bahn = SteuerartProjektion.POLICY_SCHNELL;
        }
        charging.setChargePointSource(siteId, chargePointId, bahn,
                minKw == null ? null : minKw.doubleValue());
        return !SteuerartProjektion.QUELLE_GUENSTIG.equals(quelle);
    }

    /**
     * „Sofort laufen": die aktive Fassung wird zurueckgenommen. Ohne aktive
     * Fassung ist das ein NO-OP mit einem ehrlichen Satz statt eines 409 - der
     * Kunde hat gewaehlt, was ohnehin schon gilt, und das ist kein Fehler.
     */
    private Ergebnis sofort(UUID siteId, UUID entityId, String actor) {
        if (consumers.activePolicy(siteId, entityId) == null) {
            return new Ergebnis(Steuerart.quelleOnly(SteuerartProjektion.QUELLE_SOFORT,
                    SteuerartProjektion.HERKUNFT_OHNE), true, null,
                    "Dieses Gerät läuft bereits, wie es selbst entscheidet.", false, null);
        }
        var stop = activation.deactivate(siteId, entityId, actor);
        return new Ergebnis(Steuerart.quelleOnly(SteuerartProjektion.QUELLE_SOFORT,
                SteuerartProjektion.HERKUNFT_OHNE), true, null, stop.message(), stop.published(),
                null);
    }

    /** Die Steuerart, wie sie NACH dem Schreiben gilt - immer die Projektion. */
    private Steuerart steuerart(UUID siteId, UUID entityId) {
        var aktiv = consumers.activePolicy(siteId, entityId);
        return SteuerartProjektion.projiziere(
                aktiv == null ? null : lies(aktiv.documentJson()), false, null);
    }

    private JsonNode lies(String json) {
        if (json == null || json.isBlank()) {
            return null;
        }
        try {
            return mapper.readTree(json);
        } catch (Exception e) {
            // Ein unlesbares Dokument ist keine Steuerart - die Projektion liest
            // es dann als „ohne Policy", genau wie im Lese-Aggregat.
            return null;
        }
    }

    private static EntityRow entity(List<EntityRow> rows, UUID entityId) {
        for (EntityRow row : rows) {
            if (row.id().equals(entityId)) {
                return row;
            }
        }
        throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Komponente nicht gefunden.");
    }

    private static Integer sekunden(Integer minuten) {
        return minuten == null ? null : minuten * 60;
    }
}
