package com.voltpilot.api.steuerlogik;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.consumers.ConsumerPolicyCompiler;
import com.voltpilot.api.consumers.ConsumerRepository;
import com.voltpilot.api.consumers.HeizstabPush;
import com.voltpilot.api.entities.EntityTypeCatalog;
import com.voltpilot.api.entities.LeadDeviceService;
import com.voltpilot.api.flows.FlowCatalog;
import com.voltpilot.api.flows.FlowClaims;
import com.voltpilot.api.repo.FlowRepository;
import com.voltpilot.api.repo.SteuerlogikRepository;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import org.springframework.stereotype.Component;

/**
 * Ein Gerät hat nie zwei Herren (Steuerlogik Stufe 3, Bericht 6.8 "Besitz"): Steuerart, Heizstab-Regler,
 * Verbraucherregel oder Regel und eine scharfe Logik schließen sich je Gerät aus. Beim Scharfschalten meldet
 * {@link #pruefe} jeden Konflikt mit Namen, statt ihn still aufzulösen; umgekehrt fragen Steuerart und Regel
 * {@link #herr} und lehnen ein Gerät ab, das einer scharfen Logik gehört.
 *
 * <p>Dazu prüft {@link #pruefe}, ob die Box das Gerät nach dieser Logik überhaupt schalten darf und kann: ein
 * steuerbarer, zum Steuern freigegebener Verbraucher (ein Typ, der nur am Simulator belegt ist, bleibt das auch für
 * eine Logik, Bericht 8.7 Punkt 4), kein Ladepunkt (Laden hat seinen eigenen Ort, Konzept e1) und kein Anteil (den
 * stellt die Box noch nicht). Ob das Gerät die Befehle ausführt, die das scharfe Artefakt verlangt (Stufe, Ein/Aus,
 * Sollwert in °C, Betriebsart; an der SG-Ready-Wärmepumpe der Kontakt, E10 = A), prüft {@code SteuerlogikService}
 * gegen den Registry-Push, wie die Box beim Annehmen.
 */
@Component
public class SteuerlogikBesitz {

    /** Ein Grund, warum eine Logik ein Gerät nicht bekommt: Gerät, Art und deutscher Satz. */
    public record Konflikt(UUID entityId, String geraet, String art, String text) {}

    /** Die Typen, die eine Logik nie schaltet: Laden hat seinen eigenen Ort. */
    static final Set<String> LADEN = Set.of("wallbox", "ev-charger");

    private final ConsumerRepository verbraucher;
    private final HeizstabPush heizstab;
    private final LeadDeviceService leadDevices;
    private final FlowRepository flows;
    private final FlowCatalog flowKatalog;
    private final SteuerlogikRepository logiken;
    private final EntityTypeCatalog typen;
    private final ObjectMapper json;

    public SteuerlogikBesitz(ConsumerRepository verbraucher, HeizstabPush heizstab, LeadDeviceService leadDevices,
            FlowRepository flows, FlowCatalog flowKatalog, SteuerlogikRepository logiken, EntityTypeCatalog typen,
            ObjectMapper json) {
        this.verbraucher = verbraucher;
        this.heizstab = heizstab;
        this.leadDevices = leadDevices;
        this.flows = flows;
        this.flowKatalog = flowKatalog;
        this.logiken = logiken;
        this.typen = typen;
        this.json = json;
    }

    /**
     * Was einer scharfen Logik entgegensteht, je Gerät aus dem Prüfbericht ({@code bericht.geraete[]} mit
     * {@code entity_id}, {@code name}, {@code ausgaenge}). Leer heißt: sie darf ihre Geräte beanspruchen.
     */
    public List<Konflikt> pruefe(UUID siteId, UUID logikId, JsonNode bericht) {
        List<Konflikt> out = new ArrayList<>();
        Map<UUID, ?> heizstaebe = heizstab.fuerBox(siteId, leadDevices.fuehrendeBox(siteId).box());
        List<SteuerlogikRepository.Besitz> andere = logiken.scharfeGeraete(siteId).stream()
                .filter(b -> !b.logikId().equals(logikId)).toList();
        List<FlowRepository.FlowVersionRow> regeln = flows.activeVersionsForSiteExcept(siteId, "edge", null);
        for (JsonNode g : bericht.path("geraete")) {
            String name = g.path("name").asText(g.path("kennung").asText());
            UUID entity = uuid(g.path("entity_id").asText());
            if (entity == null) {
                out.add(new Konflikt(null, name, "geraet_unbekannt",
                        "„" + name + "“ ist kein Gerät dieser Anlage."));
                continue;
            }
            ConsumerRepository.ConsumerRow row = verbraucher.findForSite(siteId, entity);
            if (row == null) {
                out.add(new Konflikt(entity, name, "kein_verbraucher",
                        "„" + name + "“ ist kein steuerbarer Verbraucher dieser Anlage."));
                continue;
            }
            EntityTypeCatalog.EntityType typ = typen.find(row.entityType());
            if (LADEN.contains(row.entityType())) {
                out.add(new Konflikt(entity, name, "laden",
                        "„" + name + "“ ist ein Ladepunkt; Laden hat seinen eigenen Ort (Steuerung › Laden)."));
                continue;
            }
            if (typ == null || !typ.controllable() || typ.certificationStatus() == null
                    || "simulator_only".equals(typ.certificationStatus())) {
                out.add(new Konflikt(entity, name, "nicht_freigegeben",
                        "„" + name + "“ ist als " + (typ == null ? row.entityType() : typ.label())
                                + " zum Steuern noch nicht freigegeben."));
                continue;
            }
            for (JsonNode a : g.path("ausgaenge")) {
                if ("percent".equals(a.asText())) {
                    out.add(new Konflikt(entity, name, "ausgang_offen", "Für „" + name
                            + "“ will die Logik einen Anteil stellen; das kann die Box noch nicht."));
                }
            }
            if (heizstaebe.containsKey(entity)) {
                out.add(new Konflikt(entity, name, "heizstab_regler", "„" + name
                        + "“ führt schon der Heizstab-Regler der Box (Steuerart Solar-Überschuss)."));
            } else if (verbraucher.activePolicy(siteId, entity) != null) {
                out.add(new Konflikt(entity, name, "steuerart", "Für „" + name
                        + "“ gilt eine Steuerart. Die Logik übernimmt das Gerät erst, wenn dort keine mehr gilt."));
            }
            regelVon(entity, regeln).ifPresent(regel -> out.add(new Konflikt(entity, name, "regel",
                    "„" + name + "“ wird durch die Regel „" + regel + "“ gesteuert.")));
            for (SteuerlogikRepository.Besitz b : andere) {
                if (b.entityId().equals(entity)) {
                    out.add(new Konflikt(entity, name, "logik",
                            "„" + name + "“ gehört schon der Logik „" + b.name() + "“."));
                }
            }
        }
        return out;
    }

    /**
     * Der Name der scharfen Logik, der dieses Gerät gehört - für Steuerart und Regel, die es dann nicht bekommen.
     */
    public Optional<String> herr(UUID siteId, UUID entityId) {
        return logiken.scharfeGeraete(siteId).stream().filter(b -> b.entityId().equals(entityId))
                .map(SteuerlogikRepository.Besitz::name).findFirst();
    }

    /** Eine aktive Regel (ohne den Flow der Steuerart selbst), die dieses Gerät beansprucht. */
    private Optional<String> regelVon(UUID entity, List<FlowRepository.FlowVersionRow> regeln) {
        UUID steuerart = ConsumerPolicyCompiler.generatedFlowId(entity);
        for (FlowRepository.FlowVersionRow r : regeln) {
            if (r.flowId().equals(steuerart)) continue;
            JsonNode doc;
            try {
                doc = json.readTree(r.documentJson());
            } catch (Exception e) {
                continue;
            }
            for (FlowClaims.DerivedClaim c : FlowClaims.derive(doc, flowKatalog)) {
                if (entity.toString().equals(c.entityId())) return Optional.of(r.name());
            }
        }
        return Optional.empty();
    }

    private static UUID uuid(String s) {
        try {
            return UUID.fromString(s);
        } catch (IllegalArgumentException | NullPointerException e) {
            return null;
        }
    }
}
