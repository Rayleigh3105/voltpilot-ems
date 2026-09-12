package com.voltpilot.api.uems;

import com.voltpilot.api.components.ComponentDefinitionRepository;
import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.MeterRegistry;
import java.time.Instant;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

/**
 * Die MARKE „Zähler gewechselt“ im Komponenten-Verlauf (UEMS AP-04 IP-17, §5.5) —
 * {@code component_change_event} der Art {@code device_replaced}, additiv neben der vollständigen
 * Fassungs-Historie.
 *
 * <p><b>Ein Zusatz, nie eine Bedingung.</b> Sie steht bewusst in einem EIGENEN Bean und schreibt in
 * einem EIGENEN Savepoint ({@link Propagation#NESTED}, Muster aus AP-04 IP-11): in der Transaktion
 * des Wechsels hätte jede Ausnahme hier die GEMEINSAME Transaktion rollback-only gemacht — und
 * damit den Wechsel des Kunden scheitern lassen, auch wenn der Aufrufer sie fängt. Im Savepoint
 * rollt nur die Marke zurück; {@link ZaehlerwechselService} fängt, meldet über
 * {@link #fehlgeschlagen} (Log + Zähler
 * {@code voltpilot_zaehlerwechsel_marke_total{ergebnis="fehler"}}) und schreibt den Wechsel fertig.
 *
 * <p>Ein eigenes Bean, weil ein Selbstaufruf innerhalb desselben Beans am Proxy vorbeiginge — dann
 * gäbe es den Savepoint gar nicht.
 *
 * <p>Wie der {@code family_changed}-Marker ist auch dieser ein ZEITPUNKT, niemals ein Auftrag zur
 * rückwirkenden Neudekodierung: die Werte vor dem Wechsel bleiben dem alten Einbau zugeordnet.
 */
@Service
public class ZaehlerwechselMarke {

    private static final Logger log = LoggerFactory.getLogger(ZaehlerwechselMarke.class);

    /** Die Art im Vokabular von {@code component_change_event} (CHECK in V20260912120000). */
    public static final String ART = "device_replaced";

    /** Prometheus: {@code voltpilot_zaehlerwechsel_marke_total}, Tag {@code ergebnis}. */
    static final String ZAEHLER = "voltpilot_zaehlerwechsel_marke";

    private final ComponentDefinitionRepository definitionen;
    private final Counter fehler;

    public ZaehlerwechselMarke(ComponentDefinitionRepository definitionen, MeterRegistry metriken) {
        this.definitionen = definitionen;
        this.fehler = Counter.builder(ZAEHLER)
                .description("Marken „Zähler gewechselt“ im Komponenten-Verlauf, die nicht geschrieben "
                        + "werden konnten (der Wechsel selbst ist trotzdem gelaufen)")
                .tag("ergebnis", "fehler")
                .register(metriken);
    }

    /** Schreibt die Marke — im eigenen Savepoint. Wirft sie, ist NUR sie zurückgerollt. */
    @Transactional(propagation = Propagation.NESTED)
    public void schreiben(UUID tenantId, UUID siteId, UUID entityId, String vorher, String nachher,
            Instant zeitpunkt, String subject) {
        Integer revision = definitionen.definitionVersion(siteId, entityId);
        definitionen.recordEvent(tenantId, siteId, entityId, revision == null ? 1 : revision, ART, zeitpunkt,
                vorher, nachher, subject, "Zähler gewechselt: " + vorher + " → " + nachher
                        + "; frühere Messwerte bleiben " + vorher + " zugeordnet.");
    }

    /** Meldet eine gescheiterte Marke: laut ins Log und in den Zähler. Wirft nie. */
    public void fehlgeschlagen(UUID entityId, String vorher, String nachher, RuntimeException ursache) {
        log.error("Marke „Zähler gewechselt“ der Komponente {} NICHT geschrieben ({} → {}) — der Wechsel ist "
                + "trotzdem gelaufen: {}", entityId, vorher, nachher, ursache.toString(), ursache);
        fehler.increment();
    }
}
