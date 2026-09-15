package com.voltpilot.api.fahrzeuge;

import com.voltpilot.api.chargers.ChargingConfigService;
import com.voltpilot.api.repo.DeviceChargerStatusRepository;
import com.voltpilot.api.zugriff.Geltungsbereich;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.web.dto.SiteChargingDto;
import com.voltpilot.api.web.dto.FahrzeugDto;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;

/**
 * Die FAHRZEUGE einer Anlage (Verbrauchsmanagement v1 / P7).
 *
 * <p>Es ist der schmalste denkbare Dienst: eine Ladekarte hat einen NAMEN und
 * eine STEUERART, und die Steuerart ist genau die Quellen-Bahn, die die Box
 * ohnehin je Säule fährt - eine Ebene feiner. Deshalb gibt es hier keine
 * Policy, keinen Optimierer und keine zweite Maschine.
 *
 * <p><b>⚠ Der SCHREIBWEG ist derselbe wie bei der Säule:</b> jede Änderung
 * endet in {@link ChargingConfigService#pushFor} und damit im EINEN retained
 * Dokument. Es gibt keinen zweiten Kanal zur Box.
 */
@Service
public class FahrzeugService {

    static final String UNBEKANNT = FahrzeugSteuerart.GRUND_UNBEKANNTE_KARTE;
    static final String KEIN_PSEUDONYM =
            "Das ist keine Kennung, die Ihre Box vergeben hat.";

    private final Geltungsbereich geltungsbereich;
    private final SiteVehicleRepository vehicles;
    private final DeviceChargerStatusRepository chargers;
    private final ChargingConfigService charging;

    public FahrzeugService(Geltungsbereich geltungsbereich, SiteVehicleRepository vehicles,
            DeviceChargerStatusRepository chargers, ChargingConfigService charging) {
        this.geltungsbereich = geltungsbereich;
        this.vehicles = vehicles;
        this.chargers = chargers;
        this.charging = charging;
    }

    /** Alle Karten dieser Anlage - benannt oder nicht, zuletzt gesehene zuerst. */
    public FahrzeugDto read(UUID siteId) {
        requireSite(siteId);
        Set<String> laedt = ladendeKarten(siteId);
        List<FahrzeugDto.Eintrag> out = new ArrayList<>();
        for (SiteVehicleRepository.Row r : vehicles.forSite(siteId)) {
            out.add(new FahrzeugDto.Eintrag(r.tagRef(), r.name(),
                    FahrzeugSteuerart.steuerart(r.source(), r.minKw()), r.minKw(),
                    r.firstSeenAt(), r.lastSeenAt(), r.lastChargePointId(),
                    laedt.contains(r.tagRef())));
        }
        return new FahrzeugDto(out);
    }

    /**
     * Benennt eine Karte und/oder gibt ihr eine Steuerart.
     *
     * <p>⚠ Beides ist EINZELN optional, und das ist die Bedienung: „benannt"
     * und „gesteuert" sind zwei Schritte. Wer nur den Namen vergibt, lässt die
     * Karte die Bahn ihrer Säule fahren - eine Steuerart zu erfinden, weil
     * jemand einen Namen getippt hat, wäre eine Entscheidung, die der Kunde
     * nicht getroffen hat.
     */
    public FahrzeugDto speichere(UUID siteId, String tagRef, FahrzeugSteuerart.Wunsch wunsch,
            String actor) {
        requireSite(siteId);
        if (!FahrzeugSteuerart.istPseudonym(tagRef)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, KEIN_PSEUDONYM);
        }
        List<String> fehler = FahrzeugSteuerart.pruefe(wunsch);
        if (!fehler.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, fehler.get(0));
        }
        FahrzeugSteuerart.Bahn bahn = FahrzeugSteuerart.bahn(wunsch);
        // ⚠ Der Schlüssel entscheidet, nicht sein Wert: genannt = anfassen
        // (ein leeres Wort NIMMT das Profil zurück), gar nicht genannt =
        // unberührt lassen. Siehe FahrzeugSteuerart#setztBahn.
        boolean setzeBahn = FahrzeugSteuerart.setztBahn(wunsch);
        boolean setzeName = wunsch.name() != null;
        // ⚠ Ein UPDATE, kein Upsert: benennen kann man nur, was schon einmal
        // geladen hat. Eine erfundene Zeile wäre ein Fahrzeug, das es an dieser
        // Anlage nie gab - und ein Profil darauf träfe nie ein Auto.
        boolean ok = vehicles.save(siteId, tagRef, FahrzeugSteuerart.name(wunsch.name()),
                setzeName, bahn == null ? null : bahn.source(),
                bahn == null ? null : bahn.minKw(), setzeBahn, Instant.now(), actor);
        if (!ok) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, UNBEKANNT);
        }
        pushe(siteId);
        return read(siteId);
    }

    /**
     * Nimmt das Profil zurück: die Karte fährt wieder die Bahn ihrer Säule.
     *
     * <p>⚠ Die SICHTUNG bleibt stehen - eine Rücknahme ist keine
     * Beweisvernichtung, und die Karte soll danach wieder als (unbenannte)
     * Bekannte auftauchen statt beim nächsten Herzschlag als „neu".
     */
    public FahrzeugDto entferne(UUID siteId, String tagRef, String actor) {
        requireSite(siteId);
        if (!FahrzeugSteuerart.istPseudonym(tagRef)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, KEIN_PSEUDONYM);
        }
        if (!vehicles.clearProfile(siteId, tagRef, Instant.now(), actor)) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, UNBEKANNT);
        }
        pushe(siteId);
        return read(siteId);
    }

    /**
     * Der Weg zur Box: dasselbe retained Dokument, das auch Anschlussgrenze,
     * Allowlist und Rahmen trägt. Best-effort wie dort - eine gespeicherte
     * Wahl darf nicht daran scheitern, dass der Broker gerade schweigt; das
     * nächste Dokument trägt sie nach.
     */
    private void pushe(UUID siteId) {
        UUID tenantId = TenantContext.get();
        if (tenantId != null) {
            charging.pushFor(tenantId, siteId);
        }
    }

    /**
     * Die Karten, die GERADE laden - aus dem Herzschlag, nie aus der
     * Sichtungszeit geraten. „Zuletzt gesehen vor zwei Minuten" ist keine
     * laufende Ladung.
     */
    private Set<String> ladendeKarten(UUID siteId) {
        Set<String> out = new HashSet<>();
        for (SiteChargingDto.ChargePointDto cp : chargers.forSite(siteId).chargers()) {
            if (cp.connectors() == null) {
                continue;
            }
            for (SiteChargingDto.ChargeConnectorDto con : cp.connectors()) {
                if (con.tagRef() != null && !con.tagRef().isBlank()) {
                    out.add(con.tagRef());
                }
            }
        }
        return out;
    }

    private void requireSite(UUID siteId) {
        geltungsbereich.requireSite(siteId);
    }
}
