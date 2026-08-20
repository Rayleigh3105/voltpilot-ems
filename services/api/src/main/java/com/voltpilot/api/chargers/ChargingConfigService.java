package com.voltpilot.api.chargers;

import com.voltpilot.api.repo.DeviceChargerStatusRepository;
import com.voltpilot.api.repo.SiteRepository;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.web.dto.ChargingConfigDto;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

/**
 * Die Lastmanagement-Konfiguration einer Anlage: die Anschlussgrenze und welche
 * Säulen Vorrang haben (Lastmanagement Stufe 3, PR 12).
 *
 * <p><b>Es entsteht kein zweiter Verteiler.</b> Gespeichert wird nur, was der
 * Kunde WÜNSCHT; gerechnet und durchgesetzt wird auf der Box - die
 * Anschlussgrenze ist eine physische Grenze, ihr Wächter darf nicht am WAN
 * hängen (Konzept E1). Der Weg ist der etablierte: Zeile → retained Dokument →
 * die Box übernimmt es in ihre Einstellungen (PATCH: was das Portal nicht
 * nennt, behält sie).
 *
 * <p><b>Was das Portal NICHT besitzt</b>, und zwar bewusst: Sicherheitsabstand,
 * Mindestleistung und die höchste bekannte Gebäudelast bleiben Einstellungen
 * der Box (die Mockups nennen sie „Von VoltPilot eingerichtet"). Der
 * Aktivieren-Dialog fragt genau die EINE Zahl ab, die dem Kunden gehört und
 * ohne die gar nichts geht.
 *
 * <p>Der Push ist BEST-EFFORT (das {@code EntityRegistryService}-Muster): eine
 * gespeicherte Grenze wird nie wegen eines Broker-Ausfalls abgelehnt. Der
 * ehrliche Ort dafür ist die Antwort - sie sagt, ob das Dokument hinausging.
 */
@Service
public class ChargingConfigService {

    private static final Logger log = LoggerFactory.getLogger(ChargingConfigService.class);

    /**
     * Die Obergrenze der Plausibilität. Sie ist absichtlich weit (ein
     * DC-Ladepark hängt an einem Mittelspannungs-Anschluss) und fängt nur den
     * Tippfehler ab, der aus 277 kW 277000 macht.
     */
    private static final double MAX_GRID_LIMIT_KW = 100_000;

    private final SiteRepository sites;
    private final ChargingConfigRepository configs;
    private final DeviceChargerStatusRepository chargers;
    private final ObjectProvider<ChargingConfigPublisher> publisher;

    public ChargingConfigService(SiteRepository sites, ChargingConfigRepository configs,
            DeviceChargerStatusRepository chargers,
            ObjectProvider<ChargingConfigPublisher> publisher) {
        this.sites = sites;
        this.configs = configs;
        this.chargers = chargers;
        this.publisher = publisher;
    }

    /** Die gepflegte Konfiguration (leer = noch nichts gepflegt). */
    public ChargingConfigDto read(UUID siteId) {
        requireSite(siteId);
        return configs.forSite(siteId);
    }

    /**
     * Speichert die Konfiguration und schickt sie an jedes Gerät der Anlage.
     *
     * <p>PATCH-Semantik: ein abwesendes Feld BEHÄLT den gespeicherten Wert -
     * ein Dialog, der nur den Vorrang stellt, darf die Anschlussgrenze nicht
     * löschen.
     */
    @Transactional
    public ChargingConfigDto save(UUID siteId, Double gridLimitKw, List<String> priorities,
            String actor) {
        requireSite(siteId);
        UUID tenantId = TenantContext.get();
        if (gridLimitKw != null) {
            if (gridLimitKw.isNaN() || !(gridLimitKw > 0) || gridLimitKw > MAX_GRID_LIMIT_KW) {
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                        "Die Anschlussgrenze muss eine Leistung größer 0 kW sein.");
            }
            configs.saveGridLimit(tenantId, siteId, gridLimitKw, actor);
        }
        List<String> cleaned = priorities == null ? null : clean(siteId, priorities);
        if (cleaned != null) {
            configs.replacePriorities(tenantId, siteId, cleaned);
        }
        ChargingConfigDto saved = configs.forSite(siteId);
        push(tenantId, siteId, saved);
        return saved;
    }

    /**
     * Schickt die gespeicherte Konfiguration an jedes Gerät der Anlage.
     *
     * <p>An JEDES, nicht nur an das mit den Ladesäulen: welches Gerät das CSMS
     * fährt, weiß nur die Box selbst, und eine Box ohne Ladepunkte übernimmt
     * eine Anschlussgrenze folgenlos (ihr Budget verteilt sie an niemanden).
     * Raten wäre die schlechtere Hälfte.
     */
    void push(UUID tenantId, UUID siteId, ChargingConfigDto config) {
        ChargingConfigPublisher pub = publisher.getIfAvailable();
        if (pub == null) {
            log.debug("no charging-config publisher configured - nothing pushed for site {}",
                    siteId);
            return;
        }
        Instant now = Instant.now();
        for (UUID deviceId : configs.deviceIds(siteId)) {
            pub.publish(tenantId, siteId, deviceId, config.gridLimitKw(),
                    config.priorityChargePointIds(), now);
        }
    }

    /**
     * Die Vorrang-Liste, gesäubert: Leerzeichen weg, Duplikate weg,
     * Reihenfolge stabil. Eine unbekannte ChargePointId wird ABGELEHNT statt
     * still gespeichert - sie wäre ein Vorrang für eine Säule, die es nicht
     * gibt, und niemand fände den Tippfehler je wieder.
     */
    private List<String> clean(UUID siteId, List<String> raw) {
        Set<String> known = new LinkedHashSet<>();
        for (var c : chargers.forSite(siteId).chargers()) {
            known.add(c.chargePointId());
        }
        List<String> out = new ArrayList<>();
        for (String id : raw) {
            String v = id == null ? "" : id.trim();
            if (v.isEmpty() || out.contains(v)) {
                continue;
            }
            if (!known.contains(v)) {
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                        "Diese Anlage kennt keine Ladesäule \"" + v + "\". Vorrang lässt sich "
                                + "nur für eine Säule vergeben, die sich schon gemeldet hat.");
            }
            out.add(v);
        }
        return out;
    }

    private void requireSite(UUID siteId) {
        if (!sites.existsForCurrentTenant(siteId)) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Anlage nicht gefunden.");
        }
    }
}
