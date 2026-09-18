package com.voltpilot.api.uems;

import com.voltpilot.api.metrics.UemsLaeuferMelder;
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
import org.springframework.core.annotation.Order;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

/**
 * Der START-LÄUFER des Umstiegs „Bestand → Zustand“ der Funktionen (UEMS AP-01 IP-2): bei jedem
 * Start der api geht er einmal über alle Kundenbereiche und wendet {@link FunktionBestandService}
 * an — nach einem Deploy trägt so jede steuernde Bestandsanlage ihre Teilnahme „aktiv
 * (übernommen)“ und ihr Standort die Funktion „Steuern &amp; Optimieren“ (A11), ohne Handgriff.
 *
 * <p><b>Warum ein Start-Läufer und keine Füllung in der Migration</b> (das Muster von
 * {@link BestandsuebernahmeLaeufer}): die Regel ist Vertrag mit einem TS-Zwilling
 * ({@link FunktionZustandAbleitung#bestand}) — eine SQL-Fassung wäre eine zweite Wahrheit; und
 * die Standorte, an denen die Funktion hängt, legt erst der Start-Läufer der Standorte an, NACH
 * allen Migrationen.
 *
 * <p><b>Warum {@code @Order(BestandsuebernahmeLaeufer.ORDER + 1)}</b>: ohne Angabe ist die
 * Reihenfolge zweier {@link ApplicationReadyEvent}-Hörer nicht zugesagt; ein Lauf vor der
 * Standort-Übernahme fände beim ersten Start keinen einzigen Standort. Er kennt die
 * Standort-Übernahme dafür nicht (kein Ereignis, kein Verweis) — und keinen Publisher.
 *
 * <p><b>Die Wächter</b> wie beim Standort-Läufer: idempotent (die Regel fragt nach vorhandenen
 * Teilnahmen), mandantenweise mit gesetztem Kontext (Kundenbereiche zählt die BYPASSRLS-Verbindung,
 * jeder Schreibzug läuft unter RLS, je Kundenbereich EINE Transaktion), fehlertolerant (ein
 * scheiternder Kundenbereich hält weder die anderen noch den Start auf) und abschaltbar
 * ({@code voltpilot.uems.funktion-bestand.enabled}: in Produktion AN, im Testlauf AUS — wer ihn
 * prüft, ruft {@link #lauf()} selbst).
 */
@Component
public class FunktionBestandLaeufer {

    private static final Logger log = LoggerFactory.getLogger(FunktionBestandLaeufer.class);

    /** Was ein Lauf tat (für das Log und die Tests). */
    public record Lauf(int kundenbereiche, int funktionenAngelegt, int funktionenNachgezogen, int teilnahmenAktiv,
            int teilnahmenEingerichtet, int fehler) {

        /** Ein zweiter Lauf: {@code false}. */
        public boolean geaendert() {
            return funktionenAngelegt > 0 || funktionenNachgezogen > 0 || teilnahmenAktiv > 0
                    || teilnahmenEingerichtet > 0;
        }
    }

    private final JdbcTemplate adminJdbc;
    private final FunktionBestandService dienst;

    /**
     * AP-14 IP-9: der Betriebs-Melder (§3.5, Schicht „Übernahme“). Nachgereicht statt in den
     * Konstruktor gelegt, damit kein bestehender Aufrufer sich ändert; {@link UemsLaeuferMelder#STUMM}
     * hält ihn ohne Spring UND in den Minimal-Kontexten der Wiring-Tests gültig (darum
     * {@code required = false}). Melden darf einen Lauf NIE brechen — der Melder schluckt alles.
     */
    private UemsLaeuferMelder melder = UemsLaeuferMelder.STUMM;

    @Autowired(required = false)
    void melder(UemsLaeuferMelder melder) {
        this.melder = melder;
    }

    private final boolean enabled;

    public FunktionBestandLaeufer(@Qualifier("adminJdbcTemplate") JdbcTemplate adminJdbc,
            FunktionBestandService dienst,
            @Value("${voltpilot.uems.funktion-bestand.enabled:true}") boolean enabled) {
        this.adminJdbc = adminJdbc;
        this.dienst = dienst;
        this.enabled = enabled;
    }

    @EventListener(ApplicationReadyEvent.class)
    @Order(BestandsuebernahmeLaeufer.ORDER + 1)
    public void beimStart() {
        if (!enabled) {
            log.info("UEMS-Umstieg der Funktionen abgeschaltet (voltpilot.uems.funktion-bestand.enabled=false)");
            return;
        }
        try {
            Lauf l = lauf();
            melder.bestandGelaufen(UemsLaeuferMelder.BESTAND_FUNKTION, l.kundenbereiche(), l.fehler());
            if (l.geaendert() || l.fehler() > 0) {
                log.info("UEMS-Umstieg der Funktionen: {} Kundenbereich(e) betrachtet, {} Funktion(en) angelegt, "
                        + "{} nachgezogen, {} Teilnahme(n) aktiv, {} eingerichtet, {} Fehler", l.kundenbereiche(),
                        l.funktionenAngelegt(), l.funktionenNachgezogen(), l.teilnahmenAktiv(),
                        l.teilnahmenEingerichtet(), l.fehler());
            }
        } catch (RuntimeException e) {
            // Ein Umstieg darf die api nie am Dienen hindern.
            melder.fehler(UemsLaeuferMelder.BESTAND_FUNKTION);
            log.error("UEMS-Umstieg der Funktionen gescheitert, nichts übernommen: {}", e.toString(), e);
        }
    }

    /** Ein Lauf über alle Kundenbereiche, ältester zuerst. Wirft nie je Kundenbereich. */
    public Lauf lauf() {
        List<UUID> kundenbereiche = adminJdbc.queryForList("SELECT id FROM tenant ORDER BY created_at, id", UUID.class);
        int angelegt = 0;
        int nachgezogen = 0;
        int aktiv = 0;
        int eingerichtet = 0;
        int fehler = 0;
        for (UUID tenant : kundenbereiche) {
            try {
                TenantContext.set(tenant);
                FunktionBestandService.Ergebnis e = dienst.uebernehmen();
                angelegt += e.funktionenAngelegt();
                nachgezogen += e.funktionenNachgezogen();
                aktiv += e.teilnahmenAktiv();
                eingerichtet += e.teilnahmenEingerichtet();
                if (e.geaendert()) {
                    log.info("UEMS-Umstieg der Funktionen: Kundenbereich {} — {} Teilnahme(n) aktiv, {} eingerichtet "
                            + "(übernommen)", tenant, e.teilnahmenAktiv(), e.teilnahmenEingerichtet());
                }
            } catch (RuntimeException ex) {
                fehler++;
                log.warn("UEMS-Umstieg der Funktionen: Kundenbereich {} gescheitert, nichts geschrieben: {}", tenant,
                        ex.toString(), ex);
            } finally {
                TenantContext.clear();
            }
        }
        return new Lauf(kundenbereiche.size(), angelegt, nachgezogen, aktiv, eingerichtet, fehler);
    }
}
