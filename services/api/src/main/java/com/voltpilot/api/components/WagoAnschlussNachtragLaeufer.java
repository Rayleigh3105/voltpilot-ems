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
import org.springframework.stereotype.Component;

/**
 * Der START-LÄUFER des Nachtrags „WAGO im Bestand“ (Konzept „Ein Gerät, ein Eintrag“, GE-6): bis GE-6
 * legte der WAGO-Assistent den Controller ohne Verweis auf seinen Anschluss an. Bei jedem Start der api
 * holt er je Kundenbereich {@link WagoKartenAnlage#quellenNachholen} nach — allein über die
 * {@code data_source_id}, die die Komponenten der Karten schon tragen, nie über eine Adresse. Was so
 * nicht zuzuordnen ist, bleibt unverknüpft und steht im Aufbau als „Anschluss ohne Gerät“.
 *
 * <p><b>Warum ein Start-Läufer und keine Flyway-Migration</b> (das Muster von
 * {@code BestandsuebernahmeLaeufer}): die Regel lebt an EINER Stelle in Java, die auch der Bestands-Weg
 * der Karten ({@link WagoKartenAnlage#nachtragen}) ruft; eine angewandte Migration ist unveränderlich.
 * Kein Takt: neue Controller verknüpft der Assistent selbst.
 *
 * <p><b>Die Wächter</b> wie bei den übrigen Start-Läufern: idempotent (ein Controller mit Anschluss bleibt),
 * mandantenweise mit gesetztem Kontext (Kundenbereiche zählt die BYPASSRLS-Verbindung, geschrieben wird
 * unter RLS), fehlertolerant (ein scheiternder Kundenbereich hält weder die anderen noch den Start auf) und
 * abschaltbar ({@code voltpilot.components.wago-anschluss-nachtrag.enabled}: in Produktion AN, im Testlauf
 * AUS — wer ihn prüft, ruft {@link #lauf()} selbst).
 */
@Component
public class WagoAnschlussNachtragLaeufer {

    private static final Logger log = LoggerFactory.getLogger(WagoAnschlussNachtragLaeufer.class);

    /** Was ein Lauf tat (für das Log und die Tests). */
    public record Lauf(int kundenbereiche, int verknuepft, int fehler) {}

    private final JdbcTemplate adminJdbc;
    private final WagoKartenAnlage karten;
    private final boolean enabled;

    /** Beendete Kundenbereiche lässt der Läufer aus (AP-20, E10 = A); ohne Spring gilt KEINE. */
    private BeendeteKundenbereiche beendete = BeendeteKundenbereiche.KEINE;

    @Autowired(required = false)
    void setBeendeteKundenbereiche(BeendeteKundenbereiche beendete) {
        this.beendete = beendete;
    }

    public WagoAnschlussNachtragLaeufer(@Qualifier("adminJdbcTemplate") JdbcTemplate adminJdbc,
            WagoKartenAnlage karten,
            @Value("${voltpilot.components.wago-anschluss-nachtrag.enabled:true}") boolean enabled) {
        this.adminJdbc = adminJdbc;
        this.karten = karten;
        this.enabled = enabled;
    }

    @EventListener(ApplicationReadyEvent.class)
    public void beimStart() {
        if (!enabled) {
            log.info("WAGO-Anschluss-Nachtrag abgeschaltet (voltpilot.components.wago-anschluss-nachtrag.enabled=false)");
            return;
        }
        try {
            Lauf l = lauf();
            if (l.verknuepft() > 0 || l.fehler() > 0) {
                log.info("WAGO-Anschluss-Nachtrag: {} Kundenbereich(e) betrachtet, {} Controller verknüpft, {} Fehler",
                        l.kundenbereiche(), l.verknuepft(), l.fehler());
            }
        } catch (RuntimeException e) {
            // Ein Nachtrag darf die api nie am Dienen hindern.
            log.error("WAGO-Anschluss-Nachtrag gescheitert, nichts verknüpft: {}", e.toString(), e);
        }
    }

    /** Ein Lauf über alle Kundenbereiche, ältester zuerst. Wirft nie je Kundenbereich. */
    public Lauf lauf() {
        List<UUID> kundenbereiche = adminJdbc.queryForList("SELECT id FROM tenant ORDER BY created_at, id", UUID.class);
        int verknuepft = 0;
        int fehler = 0;
        for (UUID tenant : kundenbereiche) {
            if (beendete.beendet(tenant)) continue; // Kundenbereich beendet: der Läufer lässt ihn aus
            try {
                TenantContext.set(tenant);
                int n = karten.quellenNachholen();
                verknuepft += n;
                if (n > 0) {
                    log.info("WAGO-Anschluss-Nachtrag: Kundenbereich {} — {} Controller mit ihrem Anschluss verknüpft",
                            tenant, n);
                }
            } catch (RuntimeException ex) {
                fehler++;
                log.warn("WAGO-Anschluss-Nachtrag: Kundenbereich {} gescheitert, nichts geschrieben: {}", tenant,
                        ex.toString(), ex);
            } finally {
                TenantContext.clear();
            }
        }
        return new Lauf(kundenbereiche.size(), verknuepft, fehler);
    }
}
