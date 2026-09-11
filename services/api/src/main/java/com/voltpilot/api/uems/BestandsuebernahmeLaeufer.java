package com.voltpilot.api.uems;

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
import org.springframework.stereotype.Component;

/**
 * Der START-LÄUFER der Bestandsübernahme der Standorte (UEMS AP-02 IP-9): bei jedem Start der
 * api geht er einmal über alle Kundenbereiche und wendet {@link BestandsuebernahmeService} an —
 * nach einem Deploy hat so jeder Bestandskunde mit genau einer Anlage seinen Standort (A5) und
 * jeder mit mehreren seine Vorschläge (A6), ohne Handgriff.
 *
 * <p><b>Warum ein Start-Läufer und keine Flyway-Migration</b> (das Muster von
 * {@code V2SiteBackfillRunner} und {@code ComponentAdoptionRunner}): die Regel lebt in Java
 * und ist Vertrag mit einem TS-Zwilling ({@link BestandsuebernahmeAbleitung}); eine SQL-
 * Fassung wäre eine zweite Wahrheit, und eine angewandte Migration ist unveränderlich.
 * Protokoll und Kurzzeichen haben ihre EINE Stelle in Java ({@link OrtProtokoll},
 * {@link OrtKurzzeichen}). Und der Lauf muss abschaltbar sein, ohne eine Migration zu
 * überspringen.
 *
 * <p><b>Warum kein Takt.</b> Übernommen wird der BESTAND: eine Anlage, die danach entsteht,
 * nimmt ihren Standort beim Anlegen ({@code POST /api/v1/sites}, vorbelegt bei genau einem).
 * Nur ein Kundenbereich ohne jeden Standort, der seine erste Anlage anlegt, wartet bis zum
 * nächsten Start — bis dahin ist die Anlage „noch nicht zugeordnet", wie heute. Kein
 * {@code @Scheduled}, also keine Takt-Falle in gecachten Testkontexten.
 *
 * <p><b>Die Wächter.</b>
 * <ul>
 *   <li><b>idempotent</b> — die Regel fragt nach dem, was schon da ist: ein zweiter Lauf
 *       schreibt nichts (auch nicht, wenn der Kunde den automatischen Standort archiviert hat —
 *       die Rücknahme bleibt stehen).</li>
 *   <li><b>mandantenweise mit gesetztem Kontext</b> — die Kundenbereiche zählt die BYPASSRLS-
 *       Verbindung (das {@code TenantRepository}-Muster), jeder SCHREIBZUG läuft über die
 *       RLS-Verbindung mit dem Mandanten im {@link TenantContext}, je Kundenbereich in EINER
 *       Transaktion.</li>
 *   <li><b>fehlertolerant</b> — ein Kundenbereich, der scheitert, wird protokolliert und
 *       beim nächsten Start wieder versucht; er hält weder die anderen noch den Start auf.</li>
 *   <li><b>abschaltbar</b> — {@code voltpilot.uems.bestandsuebernahme.enabled}: in Produktion
 *       AN (application.yml, die Hausregel „ein Flag hat die Vorgabe AN"), im Testlauf AUS
 *       (surefire-Systemeigenschaft): in den Testklassen mit Dev-Saat ({@code local}-Profil)
 *       bekämen deren Bestandskunden sonst schon beim Start einen Standort. Wer ihn prüft,
 *       ruft {@link #lauf()} ausdrücklich. Der Schalter nimmt nur den Start-Lauf, nie den
 *       Dienst.</li>
 * </ul>
 */
@Component
public class BestandsuebernahmeLaeufer {

    private static final Logger log = LoggerFactory.getLogger(BestandsuebernahmeLaeufer.class);

    /** Was ein Lauf tat (für das Log und die Tests). */
    public record Lauf(int kundenbereiche, int standorteAngelegt, int zuordnungen, int vorschlaege,
            int fehler) {

        /** Ein zweiter Lauf: {@code false}. */
        public boolean geaendert() {
            return standorteAngelegt > 0 || zuordnungen > 0 || vorschlaege > 0;
        }
    }

    private final JdbcTemplate adminJdbc;
    private final BestandsuebernahmeService dienst;
    private final boolean enabled;

    public BestandsuebernahmeLaeufer(@Qualifier("adminJdbcTemplate") JdbcTemplate adminJdbc,
            BestandsuebernahmeService dienst,
            @Value("${voltpilot.uems.bestandsuebernahme.enabled:true}") boolean enabled) {
        this.adminJdbc = adminJdbc;
        this.dienst = dienst;
        this.enabled = enabled;
    }

    @EventListener(ApplicationReadyEvent.class)
    public void beimStart() {
        if (!enabled) {
            log.info("UEMS-Bestandsübernahme der Standorte abgeschaltet "
                    + "(voltpilot.uems.bestandsuebernahme.enabled=false)");
            return;
        }
        try {
            Lauf l = lauf();
            if (l.geaendert() || l.fehler() > 0) {
                log.info("UEMS-Bestandsübernahme: {} Kundenbereich(e) betrachtet, {} Standort(e) angelegt, "
                        + "{} Zuordnung(en), {} Vorschlag/Vorschläge, {} Fehler", l.kundenbereiche(),
                        l.standorteAngelegt(), l.zuordnungen(), l.vorschlaege(), l.fehler());
            }
        } catch (RuntimeException e) {
            // Eine Übernahme darf die api nie am Dienen hindern.
            log.error("UEMS-Bestandsübernahme gescheitert, nichts übernommen: {}", e.toString(), e);
        }
    }

    /** Ein Lauf über alle Kundenbereiche, ältester zuerst. Wirft nie je Kundenbereich. */
    public Lauf lauf() {
        List<UUID> kundenbereiche = adminJdbc.queryForList(
                "SELECT id FROM tenant ORDER BY created_at, id", UUID.class);
        int standorte = 0;
        int zuordnungen = 0;
        int vorschlaege = 0;
        int fehler = 0;
        for (UUID tenant : kundenbereiche) {
            try {
                TenantContext.set(tenant);
                BestandsuebernahmeService.Ergebnis e = dienst.uebernehmen();
                if (e.standortId() != null) {
                    standorte++;
                    log.info("UEMS-Bestandsübernahme: Kundenbereich {} — Standort {} angelegt (Entwurf, "
                            + "Adresse fehlt), Anlage {} zugeordnet ab {}", tenant, e.standortId(),
                            e.plan().zuordnung().anlage(), e.plan().zuordnung().gueltigAb());
                }
                zuordnungen += e.zuordnungen();
                vorschlaege += e.vorschlaege();
                if (e.vorschlaege() > 0) {
                    log.info("UEMS-Bestandsübernahme: Kundenbereich {} — {} Vorschlag/Vorschläge ({})", tenant,
                            e.vorschlaege(), e.plan().grund().code());
                }
            } catch (RuntimeException ex) {
                fehler++;
                log.warn("UEMS-Bestandsübernahme: Kundenbereich {} gescheitert, nichts geschrieben: {}", tenant,
                        ex.toString(), ex);
            } finally {
                TenantContext.clear();
            }
        }
        return new Lauf(kundenbereiche.size(), standorte, zuordnungen, vorschlaege, fehler);
    }
}
