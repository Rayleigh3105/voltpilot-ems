package com.voltpilot.api.components;

import com.voltpilot.api.kundenbereich.BeendeteKundenbereiche;
import com.voltpilot.api.tenant.TenantContext;
import java.util.List;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * Der AUSLÖSER der Bestands-Übernahme (Einheitsmodell Stufe 2, Captain-Entscheid
 * E2 „automatisch, kein Klick"): er betrachtet regelmäßig jede noch
 * box-verwaltete Anlage und übernimmt sie, sobald ihr gemeldetes Ist vollständig
 * ist. WAS übernommen wird, entscheidet allein {@link ComponentAdoptionService};
 * hier steht nur, WANN gefragt wird.
 *
 * <p><b>Warum ein Takt und kein Herzschlag-Haken.</b> Der naheliegende Weg wäre
 * der Status-Zuhörer, der das Ist ohnehin einliest - er ist aber der HEISSE Pfad
 * (alle ~15 s je Gerät), und eine Übernahme schreibt Definitionen und
 * veröffentlicht retained. Ein eigener Zuhörer wiederum bräuchte ein NEUES
 * {@code @ConditionalOnProperty}-Flag, das im gitops-Repo nachgezogen werden
 * muss - sonst liefe er in prod nachweislich nie (die dokumentierte
 * OTA-Listener-Falle). Der Takt braucht weder Broker noch neues Pflicht-Flag und
 * ist damit genau das Muster, das {@code V2SiteBackfillRunner} für die
 * Auto-Komposition schon trägt.
 *
 * <p><b>Er ist billig.</b> Die Kandidatenabfrage ist ein winziger Scan über
 * {@code site} nach nicht-portal-verwalteten Zeilen; eine übernommene Anlage
 * fällt danach dauerhaft heraus. Übrig bleiben die Anlagen, deren Box (noch)
 * keine Verbindungen meldet - genau die, auf die gewartet wird.
 *
 * <p><b>Replica-Singleton wie die MQTT-Zuhörer</b> (heute 1 api-Replica): jeder
 * Schritt ist idempotent; bei mehreren Replicas gäbe es höchstens doppelte
 * Log-Zeilen, nie eine doppelte Übernahme (die zweite sähe die Anlage bereits
 * portal-verwaltet).
 *
 * <p>Das Aufzählen der Anlagen ist mandanten-übergreifend und läuft deshalb über
 * die BYPASSRLS-Rolle ({@code adminJdbcTemplate}, das
 * {@code TenantRepository}-Muster); jeder SCHREIBVORGANG läuft über den
 * RLS-gefenceten Dienst mit dem Mandanten der Anlage im {@link TenantContext} -
 * genau wie ein Admin über den {@code X-Tenant-Id}-Umschalter.
 */
@Component
public class ComponentAdoptionRunner {

    private static final Logger log = LoggerFactory.getLogger(ComponentAdoptionRunner.class);

    /** Eine zu betrachtende Anlage. */
    record Candidate(UUID siteId, UUID tenantId, String name) {}

    /** Was ein Lauf getan hat (für Log + Tests). */
    public record RunSummary(int considered, int adopted, int waiting, int failed) {}

    /** Was ein Heil-Lauf getan hat (für Log + Tests). */
    public record RebindSummary(int considered, int rebound, int failed) {}

    private final JdbcTemplate adminJdbc;
    private final ComponentAdoptionService adoption;
    private final ComponentRebindService rebind;
    private final boolean enabled;
    private final boolean reconcileEnabled;

    /** Beendete Kundenbereiche lässt der Läufer aus (AP-20, E10 = A); ohne Spring gilt KEINE. */
    private BeendeteKundenbereiche beendete = BeendeteKundenbereiche.KEINE;

    @Autowired(required = false)
    void setBeendeteKundenbereiche(BeendeteKundenbereiche beendete) {
        this.beendete = beendete;
    }

    /**
     * Das {@code @Autowired} ist TRAGEND (die BrokerAuthzReloader-Falle): mit
     * einer zweiten, paket-sichtbaren Test-Naht und ohne Annotation kann Spring
     * keinen Injektions-Konstruktor wählen und die api startet gar nicht.
     */
    @org.springframework.beans.factory.annotation.Autowired
    public ComponentAdoptionRunner(@Qualifier("adminJdbcTemplate") JdbcTemplate adminJdbc,
            ComponentAdoptionService adoption, ComponentRebindService rebind,
            @Value("${voltpilot.components.adoption.enabled:true}") boolean enabled,
            @Value("${voltpilot.components.adoption.reconcile-enabled:true}")
            boolean reconcileEnabled) {
        this.adminJdbc = adminJdbc;
        this.adoption = adoption;
        this.rebind = rebind;
        this.enabled = enabled;
        this.reconcileEnabled = reconcileEnabled;
    }

    @EventListener(ApplicationReadyEvent.class)
    public void onApplicationReady() {
        if (!enabled) {
            log.info("Bestands-Übernahme abgeschaltet "
                    + "(voltpilot.components.adoption.enabled=false)");
            return;
        }
        runQuietly("boot");
    }

    /**
     * Der getaktete Abgleich. Er ist der eigentliche Auslöser: eine Bestandsbox
     * meldet ihre Verbindungen erst, nachdem sie aktualisiert wurde - also
     * irgendwann NACH dem letzten api-Start.
     *
     * <p><b>Beide Schalter, und das ist kein Gürtel-und-Hosenträger:</b> Springs
     * {@code @EnableScheduling} ist GLOBAL - sobald irgendeine andere
     * Konfiguration es einschaltet, wäre diese Methode auch dann getaktet, wenn
     * ihre eigene Konfiguration gar nicht existiert. Im Testlauf liefe sie damit
     * gegen gestoppte Testcontainer (die dokumentierte {@code @Scheduled}-Falle).
     */
    @Scheduled(fixedDelayString = "${voltpilot.components.adoption.interval-ms:300000}",
            initialDelayString = "${voltpilot.components.adoption.interval-ms:300000}")
    public void reconcile() {
        if (!enabled || !reconcileEnabled) {
            return;
        }
        runQuietly("reconcile");
    }

    private void runQuietly(String trigger) {
        healQuietly(trigger);
        try {
            RunSummary summary = run();
            if (summary.adopted() > 0 || summary.failed() > 0) {
                log.info("Bestands-Übernahme ({}): {} Anlage(n) betrachtet, {} übernommen, "
                                + "{} warten noch, {} fehlgeschlagen", trigger,
                        summary.considered(), summary.adopted(), summary.waiting(),
                        summary.failed());
            }
        } catch (RuntimeException e) {
            // Eine Übernahme darf weder die api am Ausliefern hindern noch den
            // Zeitgeber-Thread töten - das beendete die Selbstheilung still.
            log.error("Bestands-Übernahme ({}) fehlgeschlagen, alle Anlagen bleiben unverändert: "
                    + "{}", trigger, e.toString(), e);
        }
    }

    /** Betrachtet jede box-verwaltete Anlage; wirft nie je Anlage. */
    public RunSummary run() {
        List<Candidate> candidates = pending();
        int adopted = 0;
        int waiting = 0;
        int failed = 0;
        for (Candidate c : candidates) {
            if (beendete.beendet(c.tenantId())) continue; // Kundenbereich beendet: der Läufer lässt ihn aus
            try {
                TenantContext.set(c.tenantId());
                ComponentAdoptionService.Outcome outcome = adoption.adoptIfComplete(c.siteId());
                if (outcome.adopted()) {
                    adopted++;
                    log.info("Bestands-Übernahme: Anlage {} (\"{}\") übernommen - {} Komponenten "
                            + "werden ab jetzt im Portal gepflegt", c.siteId(), c.name(),
                            outcome.components());
                } else {
                    waiting++;
                }
            } catch (ComponentAdoptionService.NotAdoptableException e) {
                // Eine Bedingung, die erst beim Schreiben feststeht (z. B. der
                // fehlende Speicher-Stammsatz). Kein Fehlschlag, sondern ein
                // WARTEN - die Anlage ist unverändert box-verwaltet.
                waiting++;
                log.info("Bestands-Übernahme: Anlage {} (\"{}\") wartet noch: {}", c.siteId(),
                        c.name(), e.getMessage());
            } catch (ComponentAdoptionService.PushNotDeliveredException e) {
                failed++;
                log.warn("Bestands-Übernahme: Anlage {} bleibt am Gerät verwaltet: {}", c.siteId(),
                        e.toString());
                // UEMS AP-06 W7: hat eine Box den Push schon, stellt erst das sie zurück.
                adoption.nachAbbruchZurueckstellen(c.siteId(), e);
            } catch (RuntimeException e) {
                failed++;
                log.warn("Bestands-Übernahme: Anlage {} bleibt am Gerät verwaltet: {}", c.siteId(),
                        e.toString());
            } finally {
                TenantContext.clear();
            }
        }
        return new RunSummary(candidates.size(), adopted, waiting, failed);
    }

    /**
     * Der HEIL-Lauf: gerissene Geräte-Bindungen wiederherstellen.
     *
     * <p>Er läuft VOR der Übernahme und für JEDE Anlage - auch die schon
     * portal-verwalteten, denn genau dort ist der Riss entstanden (Anlage
     * Pilsting/Herzogau, Update edge-2026.08.5 -&gt; .10). Ein Fehlschlag darf
     * die Übernahme nie aufhalten: beide sind unabhängige Selbstheilungen.
     */
    private void healQuietly(String trigger) {
        try {
            RebindSummary summary = heal();
            if (summary.rebound() > 0 || summary.failed() > 0) {
                log.info("Geräte-Bindungen ({}): {} Anlage(n) mit verwaistem Pin betrachtet, "
                        + "{} Bindung(en) wiederhergestellt, {} fehlgeschlagen", trigger,
                        summary.considered(), summary.rebound(), summary.failed());
            }
        } catch (RuntimeException e) {
            log.error("Wiederherstellung der Geräte-Bindungen ({}) fehlgeschlagen, alle "
                    + "Zuordnungen bleiben unverändert: {}", trigger, e.toString(), e);
        }
    }

    /** Betrachtet jede Anlage mit verwaistem Pin; wirft nie je Anlage. */
    public RebindSummary heal() {
        List<Candidate> candidates = withOrphanedPins();
        int rebound = 0;
        int failed = 0;
        for (Candidate c : candidates) {
            if (beendete.beendet(c.tenantId())) continue; // Kundenbereich beendet: der Läufer lässt ihn aus
            try {
                TenantContext.set(c.tenantId());
                rebound += rebind.rebindOrphanedPins(c.siteId()).rebound();
            } catch (RuntimeException e) {
                failed++;
                log.warn("Geräte-Bindungen: Anlage {} bleibt unverändert: {}", c.siteId(),
                        e.toString());
            } finally {
                TenantContext.clear();
            }
        }
        return new RebindSummary(candidates.size(), rebound, failed);
    }

    /**
     * Anlagen, auf denen mindestens eine Komponente an eine Kennung gepinnt ist,
     * die KEIN gemeldetes Gerät mehr trägt - und deren Box überhaupt etwas
     * meldet.
     *
     * <p>Die zweite Bedingung ist kein Detail: eine Box, die (noch) nichts
     * meldet - offline, älterer Stand -, hat keine verwaisten Pins, sondern
     * unbekannte. Sie hier zu betrachten wäre ein Lauf über die halbe Flotte,
     * der nie etwas tun kann.
     */
    List<Candidate> withOrphanedPins() {
        return adminJdbc.query(
                "SELECT DISTINCT s.id, s.tenant_id, s.name, s.created_at FROM site s "
                        + "JOIN measurement_point mp ON mp.site_id = s.id "
                        + "  AND mp.edge_source_id IS NOT NULL "
                        + "WHERE EXISTS (SELECT 1 FROM entity_observed_state o "
                        + "  JOIN device d ON d.id = o.device_id AND d.ausgebaut_am IS NULL "
                        + "  WHERE o.site_id = s.id AND o.source = 'local') "
                        + "AND NOT EXISTS (SELECT 1 FROM entity_observed_state o2 "
                        + "  JOIN device d2 ON d2.id = o2.device_id AND d2.ausgebaut_am IS NULL "
                        + "  WHERE o2.site_id = s.id AND o2.source = 'local' "
                        + "  AND o2.entity_id = 'local:' || mp.edge_source_id) "
                        + "ORDER BY s.created_at, s.id",
                (rs, n) -> new Candidate(rs.getObject("id", UUID.class),
                        rs.getObject("tenant_id", UUID.class), rs.getString("name")));
    }

    /**
     * Die noch box-verwalteten Anlagen, älteste zuerst (deterministisch).
     *
     * <p>{@code IS DISTINCT FROM 'portal'} statt {@code = 'box'}: die
     * Autoritäts-Regel des Hauses lautet „alles, was nicht wörtlich
     * {@code portal} ist, ist box" - eine {@code NULL} oder ein Wert aus einer
     * neueren Fassung muss hier genauso betrachtet werden.
     */
    List<Candidate> pending() {
        return adminJdbc.query(
                "SELECT id, tenant_id, name FROM site "
                        + "WHERE component_authority IS DISTINCT FROM 'portal' "
                        + "ORDER BY created_at, id",
                (rs, n) -> new Candidate(rs.getObject("id", UUID.class),
                        rs.getObject("tenant_id", UUID.class), rs.getString("name")));
    }
}
