package com.voltpilot.api.consumers;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.entities.EntityRegistryRepository;
import com.voltpilot.api.entities.EntityRegistryService;
import com.voltpilot.api.kundenbereich.BeendeteKundenbereiche;
import com.voltpilot.api.tenant.TenantContext;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * Trägt bestehenden Heizstäben ihre Schreibfähigkeit nach (Live-Fall „Zuhause“, 02.11.2026).
 *
 * <p>Bis zum 02.11.2026 legte der Anlege-Weg einen Heizstab über eine Ausgangsmenge mit NUR
 * Messkanälen an ({@code capabilities} ohne {@code actuate}, {@code control = false}). Die Box las
 * ihn als „nur messen“, fand dafür keine Bilanzrolle und lehnte den GANZEN Push der Anlage ab -
 * der Stab wurde nie wirksam, und jede weitere Änderung der Anlage blieb auf der Box aus. Ein
 * solcher Stab heilt sich nicht von selbst: sein Push ist retained, und der Kunde hat keinen Weg,
 * der die Fähigkeiten nachschreibt.
 *
 * <p>Deshalb EINMAL beim Start der API ({@link ApplicationReadyEvent}, Muster
 * {@code V2SiteBackfillRunner}): jeder Heizstab mit Ausgangsmenge, dem {@code actuate} oder
 * {@code control} fehlt, bekommt Fähigkeiten und Schutzgrenzen aus {@link HeizstabGeraet} - dieselbe
 * Regel wie beim Anlegen, keine zweite Wahrheit in SQL - und seine Anlage einen neuen Push.
 * Idempotent (nach dem Lauf gibt es keinen Kandidaten mehr), je Anlage eine eigene Transaktion unter
 * ihrem Mandanten; ein Fehler hält die API nicht auf. Aus wie {@code HeizstabNachholen}: ein
 * verlorener Push holt der nächste nach. Kill-Switch: {@code voltpilot.heizstab.nachtrag.enabled}.
 */
@Component
public class HeizstabFaehigkeitenNachtrag {

    private static final Logger log = LoggerFactory.getLogger(HeizstabFaehigkeitenNachtrag.class);
    private static final ObjectMapper JSON = new ObjectMapper();

    private final JdbcTemplate adminJdbc;
    private final HeizstabGeraet heizstab;
    private final EntityRegistryRepository entityRepo;
    private final ObjectProvider<EntityRegistryService> registry;
    private final TransactionTemplate tx;
    private final boolean enabled;

    /** Beendete Kundenbereiche lässt der Läufer aus (AP-20, E10 = A); ohne Spring gilt KEINE. */
    private BeendeteKundenbereiche beendete = BeendeteKundenbereiche.KEINE;

    @Autowired(required = false)
    void setBeendeteKundenbereiche(BeendeteKundenbereiche beendete) {
        this.beendete = beendete;
    }

    public HeizstabFaehigkeitenNachtrag(@Qualifier("adminJdbcTemplate") JdbcTemplate adminJdbc,
            HeizstabGeraet heizstab, EntityRegistryRepository entityRepo,
            ObjectProvider<EntityRegistryService> registry, PlatformTransactionManager transaktionen,
            @Value("${voltpilot.heizstab.nachtrag.enabled:true}") boolean enabled) {
        this.adminJdbc = adminJdbc;
        this.heizstab = heizstab;
        this.entityRepo = entityRepo;
        this.registry = registry;
        this.tx = new TransactionTemplate(transaktionen);
        this.tx.setPropagationBehavior(TransactionDefinition.PROPAGATION_REQUIRES_NEW);
        this.enabled = enabled;
    }

    @EventListener(ApplicationReadyEvent.class)
    public void beimStart() {
        if (!enabled) {
            log.info("Heizstab-Nachtrag abgeschaltet (voltpilot.heizstab.nachtrag.enabled=false)");
            return;
        }
        try {
            lauf();
        } catch (RuntimeException e) {
            log.error("Heizstab-Nachtrag beim Start fehlgeschlagen - die API läuft weiter: {}", e.toString(), e);
        }
    }

    /** Ein Lauf über alle Mandanten; die Kennungen der nachgetragenen Heizstäbe. */
    public List<UUID> lauf() {
        record Zeile(UUID tenantId, UUID siteId, UUID id, String connection) {}
        List<Zeile> zeilen = adminJdbc.query(
                "SELECT tenant_id, site_id, id, connection_json::text AS c FROM measurement_point "
                        + "WHERE entity_type = ? AND communication = 'shelly_http' "
                        + "AND connection_json IS NOT NULL AND jsonb_exists(connection_json, 'channels') "
                        + "AND (capabilities IS NULL OR capabilities->'actuate' IS NULL "
                        + "OR jsonb_array_length(capabilities->'actuate') = 0 OR control = FALSE) "
                        + "ORDER BY created_at, id",
                (rs, i) -> new Zeile(rs.getObject("tenant_id", UUID.class), rs.getObject("site_id", UUID.class),
                        rs.getObject("id", UUID.class), rs.getString("c")),
                HeizstabGeraet.TYP);
        List<UUID> nachgetragen = new ArrayList<>();
        Map<UUID, UUID> anlagen = new LinkedHashMap<>();
        UUID vorher = TenantContext.get();
        try {
            for (Zeile z : zeilen) {
                if (beendete.beendet(z.tenantId())) continue; // Kundenbereich beendet: der Läufer lässt ihn aus
                Map<String, Object> conn = lies(z.connection());
                if (conn == null || !HeizstabAusgaenge.istMenge(conn) || HeizstabAusgaenge.fehler(conn) != null) {
                    continue;
                }
                TenantContext.set(z.tenantId());
                tx.executeWithoutResult(s -> {
                    entityRepo.setEntityConfig(z.id(), HeizstabGeraet.TYP, heizstab.capabilities(conn),
                            heizstab.guards(conn));
                    entityRepo.setControl(z.id(), true);
                });
                nachgetragen.add(z.id());
                anlagen.putIfAbsent(z.siteId(), z.tenantId());
            }
            EntityRegistryService r = registry.getIfAvailable();
            if (r != null) {
                for (Map.Entry<UUID, UUID> a : anlagen.entrySet()) {
                    TenantContext.set(a.getValue());
                    tx.executeWithoutResult(s -> r.pushRegistryBestEffort(a.getKey()));
                }
            }
        } finally {
            if (vorher == null) {
                TenantContext.clear();
            } else {
                TenantContext.set(vorher);
            }
        }
        if (!nachgetragen.isEmpty()) {
            log.info("Heizstab-Nachtrag: {} Heizstab/Heizstäbe mit Schreibfähigkeit versehen, {} Anlage(n) neu gepusht",
                    nachgetragen.size(), anlagen.size());
        }
        return nachgetragen;
    }

    private static Map<String, Object> lies(String json) {
        try {
            @SuppressWarnings("unchecked")
            Map<String, Object> m = json == null ? null : JSON.readValue(json, Map.class);
            return m;
        } catch (Exception e) {
            return null;
        }
    }
}
