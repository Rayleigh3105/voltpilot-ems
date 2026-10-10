package com.voltpilot.api.unterstuetzung;

import com.voltpilot.api.kundenbereich.BeendeteKundenbereiche;
import com.voltpilot.api.metrics.UemsLaeuferMelder;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.unterstuetzung.UnterstuetzungService.Lauf;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * Der TAKT der Unterstützung (UEMS AP-03 IP-8, §4.7 „Runner, minütlich"): trägt abgelaufene Gewährungen ins
 * Protokoll ein ({@code ablaufen}, A4 „endete durch Zeitablauf") und erinnert 7 Tage vor dem Ende (E6).
 *
 * <p><b>Er ist die Sichtbarkeit, nicht die Sicherung.</b> Der Zugang endet ohne ihn: {@code zugriff_zeitraum}
 * schließt jede Zeile mit ihrem {@code endet_am}, und {@code ZugriffKontextLader} stellt diese Frage bei JEDER
 * Anfrage neu (IP-4). Ein ausgefallener Läufer ist darum ein fehlender Protokolleintrag und ein ausgebliebener
 * Hinweis — nie ein offener Zugang. Genau das macht ihn nachholbar: sein nächster Takt findet alles, was
 * zwischendurch abgelaufen ist, und der Teil-Index auf {@code unterstuetzung_hinweis} verhindert, dass er
 * zweimal meldet.
 *
 * <p><b>⚠ Wie jeder {@code @Scheduled} ist er im TESTLAUF AUS</b> (surefire-Systemeigenschaft) und in
 * PRODUKTION AN ({@code application.yml}, {@code matchIfMissing}) — dieselbe Form wie Lücken, Endgültigkeit
 * und Verdichtung. Wer ihn prüft, ruft {@link UnterstuetzungService#lauf} selbst; dass die AUSGELIEFERTE
 * Vorgabe AN ist, prüft {@code UnterstuetzungWiringTest} an der echten {@code application.yml}.
 *
 * <p>Er wirft nie: ein Fehlschlag wird protokolliert, der Kundenbereich übersprungen und beim nächsten Takt
 * erneut versucht — jede Meldung ist wiederholbar.
 */
@Component
@ConditionalOnProperty(name = "voltpilot.uems.unterstuetzung.enabled", havingValue = "true", matchIfMissing = true)
public class AblaufLaeufer {

    private static final Logger log = LoggerFactory.getLogger(AblaufLaeufer.class);

    private final JdbcTemplate adminJdbc;
    private final UnterstuetzungService dienst;

    /**
     * AP-14 IP-9: der Betriebs-Melder (§3.5, Schicht „Läufer“). Nachgereicht statt in den Konstruktor
     * gelegt, damit kein bestehender Aufrufer sich ändert; {@link UemsLaeuferMelder#STUMM} hält ihn
     * ohne Spring UND in den Minimal-Kontexten der Wiring-Tests gültig (darum
     * {@code required = false}). Melden darf einen Lauf NIE brechen — der Melder schluckt alles.
     */
    private UemsLaeuferMelder melder = UemsLaeuferMelder.STUMM;

    @Autowired(required = false)
    void melder(UemsLaeuferMelder melder) {
        this.melder = melder;
    }

    /** Beendete Kundenbereiche lässt der Läufer aus (AP-20, E10 = A); ohne Spring gilt KEINE. */
    private BeendeteKundenbereiche beendete = BeendeteKundenbereiche.KEINE;

    @Autowired(required = false)
    void setBeendeteKundenbereiche(BeendeteKundenbereiche beendete) {
        this.beendete = beendete;
    }

    public AblaufLaeufer(@Qualifier("adminJdbcTemplate") JdbcTemplate adminJdbc, UnterstuetzungService dienst) {
        this.adminJdbc = adminJdbc;
        this.dienst = dienst;
    }

    /**
     * Minütlich — die Frist, die das Konzept nennt: der Banner soll nicht lange stehen bleiben, nachdem die
     * Unterstützung abgelaufen ist. Teuer ist der Takt nicht: er liest je Kundenbereich einen Teil-Index.
     */
    @Scheduled(fixedDelayString = "${voltpilot.uems.unterstuetzung.interval-ms:60000}",
            initialDelayString = "${voltpilot.uems.unterstuetzung.initial-delay-ms:45000}")
    public void takt() {
        try {
            lauf(Instant.now());
            melder.gelaufen(UemsLaeuferMelder.UNTERSTUETZUNG);
        } catch (RuntimeException e) {
            melder.fehler(UemsLaeuferMelder.UNTERSTUETZUNG);
            log.warn("UEMS-Unterstützung: Takt übersprungen: {}", e.toString());
        }
    }

    /** Ein Takt über alle Kundenbereiche, ältester zuerst. Wirft nie je Kundenbereich. */
    public Lauf lauf(Instant jetzt) {
        List<UUID> kundenbereiche = adminJdbc.queryForList("SELECT id FROM tenant ORDER BY created_at, id", UUID.class);
        int abgelaufen = 0;
        int erinnert = 0;
        for (UUID tenant : kundenbereiche) {
            if (beendete.beendet(tenant)) continue; // Kundenbereich beendet: der Läufer lässt ihn aus
            try {
                TenantContext.set(tenant);
                Lauf l = dienst.lauf(jetzt);
                abgelaufen += l.abgelaufen();
                erinnert += l.erinnert();
            } catch (RuntimeException e) {
                log.error("UEMS-Unterstützung: Takt für Kundenbereich {} gescheitert, nichts eingetragen: {}",
                        tenant, e.toString(), e);
            } finally {
                TenantContext.clear();
            }
        }
        Lauf gesamt = new Lauf(abgelaufen, erinnert);
        if (gesamt.geaendert()) {
            log.info("UEMS-Unterstützung: {} abgelaufen, {} Erinnerung(en) über {} Kundenbereich(e)", abgelaufen,
                    erinnert, kundenbereiche.size());
        }
        return gesamt;
    }
}
