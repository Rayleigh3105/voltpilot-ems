package com.voltpilot.api.uems;

import com.voltpilot.api.entities.EntityRegistryService;
import com.voltpilot.api.tenant.TenantContext;
import java.time.Clock;
import java.time.Instant;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/** Fällige Übergaben; im Test AUS, Produktion AN. Keine Edge-Änderung. */
@Component
@ConditionalOnProperty(name="voltpilot.uems.uebergabe.enabled", havingValue="true", matchIfMissing=true)
public class UebergabeLaeufer {
    private static final Logger LOG = LoggerFactory.getLogger(UebergabeLaeufer.class);
    private final UebergabeAufgaben aufgaben;
    private final EntityRegistryService registry;
    private final Clock uhr;
    public UebergabeLaeufer(UebergabeAufgaben aufgaben, EntityRegistryService registry,
            ObjectProvider<Clock> uhr) {
        this.aufgaben = aufgaben;
        this.registry = registry;
        this.uhr = uhr.getIfAvailable(Clock::systemUTC);
    }
    @Scheduled(fixedDelayString="${voltpilot.uems.uebergabe.interval-ms:1000}",
            initialDelayString="${voltpilot.uems.uebergabe.initial-delay-ms:30000}")
    public void takt() {
        Instant jetzt = uhr.instant();
        var vorher = TenantContext.get();
        try {
            for (var a : aufgaben.faellig(jetzt)) {
                TenantContext.set(a.tenant());
                try { registry.pushRegistryBestEffort(a.site(), jetzt); }
                catch (RuntimeException e) { LOG.warn("Übergabe {} ausstehend: {}", a.site(), e.toString()); }
            }
        } catch (RuntimeException e) {
            LOG.warn("Übergabe-Takt fehlgeschlagen: {}", e.toString());
        } finally {
            if (vorher == null) TenantContext.clear(); else TenantContext.set(vorher);
        }
    }
}
