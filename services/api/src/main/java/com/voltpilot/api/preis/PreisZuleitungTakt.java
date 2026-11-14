package com.voltpilot.api.preis;

import com.voltpilot.api.kundenbereich.BeendeteKundenbereiche;
import com.voltpilot.api.tenant.TenantContext;
import java.time.Instant;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * Der 15-Minuten-Takt der Preis-Zuleitung: zu jeder Slotgrenze bekommt die
 * führende Box jeder berechtigten Anlage den aktuellen Börsenpreis retained
 * auf {@code …/v2/price} ({@link PreisZuleitungPublisher}; Berechtigung und
 * Slot: {@link PreisZuleitung} - die EINE Wahrheit, die auch das Portal
 * liest).
 *
 * <p>Enumeration cross-tenant über das BYPASSRLS-{@code adminJdbcTemplate},
 * die Bewertung je Anlage mit gebundenem {@link TenantContext} (der
 * RLS-Pfad) - das {@code SelfconsumptionFlowSweepRunner}-Muster. Beendete
 * Kundenbereiche lässt der Takt aus. Eine Anlage ohne gespeicherten Preis
 * für „jetzt" bekommt NICHTS: der letzte Stand läuft auf der Box über seine
 * Frische ab und die Preis-Bedingung ist ehrlich unbekannt.
 *
 * <p><b>⚠ Wie jeder {@code @Scheduled} ist er im TESTLAUF AUS</b> (surefire-
 * Systemeigenschaft {@code voltpilot.preiszuleitung.enabled=false}) und in
 * Produktion AN ({@code matchIfMissing}) - dieselbe Form wie
 * {@code AutomatikLaeufer}. Ein Fehler je Anlage bricht nie den Takt.
 */
@Component
@org.springframework.boot.autoconfigure.condition.ConditionalOnProperty(
        name = "voltpilot.preiszuleitung.enabled", havingValue = "true", matchIfMissing = true)
public class PreisZuleitungTakt {

    private static final Logger log = LoggerFactory.getLogger(PreisZuleitungTakt.class);

    /** Was ein Takt getan hat (Protokoll + Tests). */
    public record TaktErgebnis(int anlagen, int gespeist, int ohnePreis, int fehlgeschlagen) {}

    private record Zeile(UUID siteId, UUID tenantId, String zone, String tarifArt) {}

    private final JdbcTemplate adminJdbc;
    private final PreisZuleitung dienst;
    private final ObjectProvider<PreisZuleitungPublisher> publisher;

    /** Beendete Kundenbereiche lässt der Takt aus (AP-20); ohne Spring gilt KEINE. */
    private BeendeteKundenbereiche beendete = BeendeteKundenbereiche.KEINE;

    @Autowired(required = false)
    void setBeendeteKundenbereiche(BeendeteKundenbereiche beendete) {
        this.beendete = beendete;
    }

    /** Das {@code @Autowired} ist tragend (die Zwei-Konstruktoren-Falle). */
    @Autowired
    public PreisZuleitungTakt(@Qualifier("adminJdbcTemplate") JdbcTemplate adminJdbc,
            PreisZuleitung dienst, ObjectProvider<PreisZuleitungPublisher> publisher) {
        this.adminJdbc = adminJdbc;
        this.dienst = dienst;
        this.publisher = publisher;
    }

    /** Sekunde 10 jeder Viertelstunde: innerhalb des 5-Minuten-Slacks des Vertrags. */
    @Scheduled(cron = "${voltpilot.preiszuleitung.cron:10 0/15 * * * *}", zone = "UTC")
    public void tick() {
        try {
            TaktErgebnis e = run(Instant.now());
            if (e.fehlgeschlagen() > 0) {
                log.warn("Preis-Zuleitung: {} von {} Anlagen fehlgeschlagen ({} gespeist, {} ohne Preis)",
                        e.fehlgeschlagen(), e.anlagen(), e.gespeist(), e.ohnePreis());
            }
        } catch (RuntimeException e) {
            log.error("Preis-Zuleitung: Takt fehlgeschlagen, nächster Slot holt auf: {}", e.toString(), e);
        }
    }

    /** Ein Takt; {@code now} explizit für Tests. */
    public TaktErgebnis run(Instant now) {
        PreisZuleitungPublisher pub = publisher.getIfAvailable();
        if (pub == null) {
            return new TaktErgebnis(0, 0, 0, 0);
        }
        List<Zeile> zeilen = adminJdbc.query(
                "SELECT id, tenant_id, bidding_zone, tarif_art FROM site ORDER BY id",
                (rs, n) -> new Zeile(rs.getObject("id", UUID.class),
                        rs.getObject("tenant_id", UUID.class), rs.getString("bidding_zone"),
                        rs.getString("tarif_art")));
        // Der Slot je Zone einmal (öffentliche Marktdaten, kein Mandantenbezug).
        Map<String, PreisZuleitung.PricePoint> slotJeZone = new HashMap<>();
        int gespeist = 0;
        int ohnePreis = 0;
        int fehlgeschlagen = 0;
        for (Zeile z : zeilen) {
            if (z.tenantId() == null || beendete.beendet(z.tenantId())) {
                continue;
            }
            try {
                TenantContext.set(z.tenantId());
                try {
                    PreisZuleitung.Stand stand = dienst.stand(z.siteId(), z.zone(), z.tarifArt());
                    if (!stand.aktiv()) {
                        continue;
                    }
                    if (!slotJeZone.containsKey(z.zone())) {
                        slotJeZone.put(z.zone(), dienst.aktuellerSlot(z.zone(), now));
                    }
                    PreisZuleitung.PricePoint slot = slotJeZone.get(z.zone());
                    if (slot == null) {
                        ohnePreis++;
                        continue;
                    }
                    if (pub.publish(z.tenantId(), z.siteId(), stand.box(), slot, z.zone(), now)) {
                        gespeist++;
                    } else {
                        fehlgeschlagen++;
                    }
                } finally {
                    TenantContext.clear();
                }
            } catch (RuntimeException e) {
                fehlgeschlagen++;
                log.warn("Preis-Zuleitung: Anlage {} fehlgeschlagen: {}", z.siteId(), e.toString());
            }
        }
        return new TaktErgebnis(zeilen.size(), gespeist, ohnePreis, fehlgeschlagen);
    }
}
