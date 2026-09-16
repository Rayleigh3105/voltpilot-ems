package com.voltpilot.api.topology;

import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.MessstelleService;
import com.voltpilot.api.uems.OrtProtokoll;
import com.voltpilot.api.uems.ProtokollAkteur;
import com.voltpilot.api.web.dto.RollenDto;
import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.MeterRegistry;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

/** Zusatz zum bestehenden Schreibweg: Anlagenprotokoll im eigenen Savepoint (AP-02 Muster). */
@Service
public class RollenProtokoll {
    private static final Logger log = LoggerFactory.getLogger(RollenProtokoll.class);
    private final OrtProtokoll protokoll;
    private final Counter fehler;

    public RollenProtokoll(OrtProtokoll protokoll, MeterRegistry metriken) {
        this.protokoll = protokoll;
        this.fehler = metriken.counter("voltpilot_rollen_protokoll", "ergebnis", "fehler");
    }

    @Transactional(propagation = Propagation.NESTED)
    public void schreiben(UUID site, UUID entity, String rolle, String art,
            RollenDto.Wert alt, RollenDto.Wert neu, ProtokollAkteur wer) {
        Instant jetzt = Instant.now();
        protokoll.eintragen(TenantContext.get(), "anlage", site, art,
                seite(entity, rolle, alt), seite(entity, rolle, neu),
                jetzt.atZone(MessstelleService.ZEITZONE).toLocalDate(), MessstelleService.ZEITZONE, jetzt, wer);
    }

    private static Map<String, Object> seite(UUID entity, String rolle, RollenDto.Wert wert) {
        Map<String, Object> seite = new LinkedHashMap<>();
        seite.put("entity_id", entity);
        seite.put("rolle", rolle);
        seite.put("wert", wert);
        return seite;
    }

    public void fehlgeschlagen(UUID site, RuntimeException e) {
        fehler.increment();
        log.error("Rollenänderung an Anlage {} gespeichert, Protokoll konnte nicht geschrieben werden", site, e);
    }
}
