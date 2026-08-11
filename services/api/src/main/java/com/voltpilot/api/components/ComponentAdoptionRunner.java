package com.voltpilot.api.components;

import com.voltpilot.api.tenant.TenantContext;
import java.util.List;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
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

    private final JdbcTemplate adminJdbc;
    private final ComponentAdoptionService adoption;
    private final boolean enabled;
    private final boolean reconcileEnabled;

    /**
     * Das {@code @Autowired} ist TRAGEND (die BrokerAuthzReloader-Falle): mit
     * einer zweiten, paket-sichtbaren Test-Naht und ohne Annotation kann Spring
     * keinen Injektions-Konstruktor wählen und die api startet gar nicht.
     */
    @org.springframework.beans.factory.annotation.Autowired
    public ComponentAdoptionRunner(@Qualifier("adminJdbcTemplate") JdbcTemplate adminJdbc,
            ComponentAdoptionService adoption,
            @Value("${voltpilot.components.adoption.enabled:true}") boolean enabled,
            @Value("${voltpilot.components.adoption.reconcile-enabled:true}")
            boolean reconcileEnabled) {
        this.adminJdbc = adminJdbc;
        this.adoption = adoption;
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
