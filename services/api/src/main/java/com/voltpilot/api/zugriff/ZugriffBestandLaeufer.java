package com.voltpilot.api.zugriff;

import com.voltpilot.api.admin.KeycloakAdminClient;
import com.voltpilot.api.admin.KeycloakAdminClient.KeycloakAdminException;
import com.voltpilot.api.admin.KeycloakAdminClient.KeycloakUser;
import com.voltpilot.api.kundenbereich.BeendeteKundenbereiche;
import com.voltpilot.api.metrics.UemsLaeuferMelder;
import com.voltpilot.api.tenant.TenantContext;
import jakarta.annotation.PreDestroy;
import java.time.Duration;
import java.util.ArrayList;
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
 * Der Start-Lauf der Rechte-Bestandsübernahme (UEMS AP-03 IP-2, E12): je Kundenbereich die Konten aus Keycloak
 * holen und {@link ZugriffBestand#bestandAbschliessen} geben — jeder Kundenbenutzer ohne je eine Zuweisung wird
 * Kundenadministrator.
 *
 * <p><b>Er setzt den STICHTAG</b> (Befund E12, {@code V20260916060000}): er ist der Einzige, der die VOLLSTÄNDIGE
 * Kontenliste eines Kundenbereichs sieht, und darum der Einzige, der sagen darf „hier ist alles übernommen".
 * Danach ist ein Kundenkonto ohne Zuweisung ein NEUES Konto und sieht nichts. Meldet Keycloak so viele Konten,
 * wie die Abfrage höchstens holt ({@link KeycloakAdminClient#MAX_KONTEN_JE_KUNDENBEREICH}), kann die Liste
 * abgeschnitten sein — dann übernimmt der Lauf, setzt aber KEINEN Stichtag: lieber die Regel einen Start länger
 * als ein ausgesperrtes Bestandskonto.
 *
 * <p><b>Warum ein Start-Lauf und keine Flyway-Migration</b> (das Muster von {@code BestandsuebernahmeLaeufer}):
 * die Kundenbenutzer stehen in Keycloak, nicht in der Datenbank — eine Migration kennt sie nicht.
 *
 * <p><b>Die Wächter.</b>
 * <ul>
 *   <li><b>idempotent</b> — ein zweiter Lauf schreibt nichts; ein entzogener Zugriff kommt nie zurück.</li>
 *   <li><b>mandantenweise mit gesetztem Kontext</b> — die Kundenbereiche zählt die BYPASSRLS-Verbindung, jeder
 *       Schreibzug läuft über die RLS-Verbindung im {@link TenantContext}, je Kundenbereich EINE
 *       Transaktion.</li>
 *   <li><b>blockiert den Start nie</b> — der Lauf geht in einem eigenen (virtuellen) Thread: Keycloak ist ein
 *       anderes System, und ein hängender Aufruf darf weder die übrigen Start-Hörer noch den Dienst
 *       aufhalten. Weist Keycloak einen Kundenbereich ab, geht es mit dem nächsten weiter; ist Keycloak nicht
 *       erreichbar, endet der Versuch mit EINER Meldung.</li>
 *   <li><b>wiederholt, bis er einmal gelang</b> (Befund B2 der Produktionsprüfung 09.10.2026) - jeder
 *       Kundenbereich, der scheiterte (Keycloak weg, abgewiesen, Übernahme gescheitert), kommt nach einer Pause
 *       wieder dran: {@link #ERSTE_PAUSE}, dann doppelt so lang bis {@link #LAENGSTE_PAUSE}. Nur diese
 *       Kundenbereiche, nie ein gelungener: ein Wiederholungsversuch tut genau, was ein gelungener erster Lauf
 *       getan hätte, nur später - kein Recht darüber hinaus. Bis dahin trägt die Bestandsregel E12 jedes
 *       Bestandskonto (Anfrage und {@code /me}); ohne Wiederholung bliebe der Stichtag bis zum nächsten Neustart
 *       offen.</li>
 *   <li><b>abschaltbar</b> — {@code voltpilot.uems.zugriff-bestand.enabled}: in Produktion AN (application.yml,
 *       „ein Flag hat die Vorgabe AN"), im Testlauf AUS (surefire). Wer ihn prüft, ruft {@link #lauf()}
 *       selbst. Der Schalter nimmt nur den Start-Lauf, nie das Anlage-Ereignis.</li>
 * </ul>
 */
@Component
public class ZugriffBestandLaeufer {

    private static final Logger log = LoggerFactory.getLogger(ZugriffBestandLaeufer.class);

    /**
     * Was ein Lauf tat (für das Log und die Tests).
     *
     * @param stichtageNeu Kundenbereiche, deren Bestand dieser Lauf abgeschlossen hat (Befund E12)
     * @param offen Kundenbereiche, die ein weiterer Versuch braucht: gescheitert oder nach dem Abbruch nicht erreicht
     */
    public record Lauf(int kundenbereiche, int konten, int benutzerNeu, int zuweisungenNeu, int fehler,
            int stichtageNeu, List<UUID> offen) {

        public Lauf(int kundenbereiche, int konten, int benutzerNeu, int zuweisungenNeu, int fehler) {
            this(kundenbereiche, konten, benutzerNeu, zuweisungenNeu, fehler, 0, List.of());
        }

        public boolean geaendert() {
            return benutzerNeu > 0 || zuweisungenNeu > 0;
        }
    }

    /** Die Pause vor dem ersten Wiederholungsversuch; jede weitere verdoppelt sich bis {@link #LAENGSTE_PAUSE}. */
    static final Duration ERSTE_PAUSE = Duration.ofSeconds(30);

    /** Länger wartet der Läufer nie zwischen zwei Versuchen. */
    static final Duration LAENGSTE_PAUSE = Duration.ofMinutes(5);

    /** Wie der Läufer zwischen zwei Versuchen wartet; Tests geben eine eigene. */
    @FunctionalInterface
    interface Pause {
        void warten(Duration dauer) throws InterruptedException;
    }

    private final JdbcTemplate adminJdbc;
    private final KeycloakAdminClient keycloak;
    private final ZugriffBestand bestand;
    private volatile Pause pause = Thread::sleep;
    private volatile Thread hintergrund;

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

    /** Beendete Kundenbereiche lässt der Läufer aus (AP-20, E10 = A); ohne Spring gilt KEINE. */
    private BeendeteKundenbereiche beendete = BeendeteKundenbereiche.KEINE;

    @Autowired(required = false)
    void setBeendeteKundenbereiche(BeendeteKundenbereiche beendete) {
        this.beendete = beendete;
    }

    public ZugriffBestandLaeufer(@Qualifier("adminJdbcTemplate") JdbcTemplate adminJdbc, KeycloakAdminClient keycloak,
            ZugriffBestand bestand, @Value("${voltpilot.uems.zugriff-bestand.enabled:true}") boolean enabled) {
        this.adminJdbc = adminJdbc;
        this.keycloak = keycloak;
        this.bestand = bestand;
        this.enabled = enabled;
    }

    @EventListener(ApplicationReadyEvent.class)
    public void beimStart() {
        if (!enabled) {
            log.info("UEMS-Bestandsübernahme der Zugriffe abgeschaltet (voltpilot.uems.zugriff-bestand.enabled=false)");
            return;
        }
        starten();
    }

    /** Startet den Lauf samt Wiederholungen im Hintergrund - der Schalter ist {@link #beimStart}s Sache. */
    Thread starten() {
        Thread t = Thread.ofVirtual().name("uems-zugriff-bestand").start(this::imHintergrund);
        hintergrund = t;
        return t;
    }

    /** Beim Herunterfahren: eine wartende Wiederholung endet, statt gegen geschlossene Verbindungen zu laufen. */
    @PreDestroy
    void beenden() {
        Thread t = hintergrund;
        if (t != null) {
            t.interrupt();
        }
    }

    void pauseStellen(Pause pause) {
        this.pause = pause;
    }

    private void imHintergrund() {
        List<UUID> nur = null; // null = alle Kundenbereiche
        Duration warte = ERSTE_PAUSE;
        while (true) {
            List<UUID> offen;
            try {
                Lauf l = nur == null ? lauf() : laufFuer(nur);
                // Gescheitert heißt: braucht einen weiteren Versuch - auch die nach einem Abbruch nicht erreichten.
                melder.bestandGelaufen(UemsLaeuferMelder.BESTAND_RECHTE, l.kundenbereiche(), l.offen().size());
                if (l.geaendert() || l.fehler() > 0 || l.stichtageNeu() > 0) {
                    log.info("UEMS-Bestandsübernahme der Zugriffe: {} Kundenbereich(e), {} Konto/Konten, {} Spiegel "
                            + "neu, {} Kundenadministrator(en) zugewiesen, {} Bestand/Bestände abgeschlossen, {} Fehler",
                            l.kundenbereiche(), l.konten(), l.benutzerNeu(), l.zuweisungenNeu(), l.stichtageNeu(),
                            l.fehler());
                }
                offen = l.offen();
            } catch (RuntimeException e) {
                // Eine Übernahme darf die api nie am Dienen hindern; ohne Ergebnis bleibt alles offen.
                melder.fehler(UemsLaeuferMelder.BESTAND_RECHTE);
                log.error("UEMS-Bestandsübernahme der Zugriffe gescheitert: {}", e.toString(), e);
                offen = nur;
            }
            if (offen != null && offen.isEmpty()) {
                return;
            }
            log.warn("UEMS-Bestandsübernahme der Zugriffe: {} Kundenbereich(e) offen, nächster Versuch in {} s",
                    offen == null ? "alle" : offen.size(), warte.toSeconds());
            try {
                pause.warten(warte);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return;
            }
            nur = offen;
            Duration doppelt = warte.multipliedBy(2);
            warte = doppelt.compareTo(LAENGSTE_PAUSE) > 0 ? LAENGSTE_PAUSE : doppelt;
        }
    }

    /** Ein Lauf über alle Kundenbereiche, ältester zuerst. Wirft nie je Kundenbereich. */
    public Lauf lauf() {
        return laufFuer(adminJdbc.queryForList("SELECT id FROM tenant ORDER BY created_at, id", UUID.class));
    }

    /** Ein Lauf über genau diese Kundenbereiche, in dieser Folge - die Wiederholung der offenen. */
    private Lauf laufFuer(List<UUID> kundenbereiche) {
        List<UUID> offen = new ArrayList<>();
        int konten = 0;
        int neu = 0;
        int zuweisungen = 0;
        int fehler = 0;
        int stichtage = 0;
        for (UUID tenant : kundenbereiche) {
            if (beendete.beendet(tenant)) continue; // Kundenbereich beendet: der Läufer lässt ihn aus
            List<KeycloakUser> liste;
            try {
                liste = keycloak.listUsersForTenant(tenant);
            } catch (KeycloakAdminException e) {
                fehler++;
                offen.add(tenant);
                log.warn("UEMS-Zugriff: Keycloak lehnt die Konten des Kundenbereichs {} ab: {}", tenant, e.getMessage());
                continue;
            } catch (RuntimeException e) {
                fehler++;
                // Dieser und jeder noch nicht erreichte Kundenbereich kommt mit dem nächsten Versuch.
                offen.addAll(kundenbereiche.subList(kundenbereiche.indexOf(tenant), kundenbereiche.size()));
                log.warn("UEMS-Zugriff: Keycloak nicht erreichbar, der Versuch endet und wird wiederholt: {}",
                        e.toString());
                break;
            }
            // Der Stichtag (Befund E12) sagt: DIESER Bestand ist vollständig übernommen. Eine an der Obergrenze
            // abgeschnittene Liste beweist das nicht — dann wird nur übernommen, und die Regel gilt weiter.
            boolean vollstaendig = liste.size() < KeycloakAdminClient.MAX_KONTEN_JE_KUNDENBEREICH;
            if (!vollstaendig) {
                log.warn("UEMS-Zugriff: Keycloak meldet für Kundenbereich {} {} Konten - die Liste kann abgeschnitten "
                        + "sein, der Bestand bleibt offen (kein Stichtag)", tenant, liste.size());
            }
            try {
                TenantContext.set(tenant);
                ZugriffBestand.Ergebnis e = vollstaendig
                        ? bestand.bestandAbschliessen(liste, ZugriffBestand.HERKUNFT_LAUF)
                        : bestand.uebernehmen(liste);
                konten += e.konten();
                neu += e.benutzerNeu();
                zuweisungen += e.zuweisungenNeu();
                if (e.stichtagNeu()) {
                    stichtage++;
                }
            } catch (RuntimeException e) {
                fehler++;
                offen.add(tenant);
                log.error("UEMS-Zugriff: Bestandsübernahme für Kundenbereich {} gescheitert, nichts übernommen: {}",
                        tenant, e.toString(), e);
            } finally {
                TenantContext.clear();
            }
        }
        return new Lauf(kundenbereiche.size(), konten, neu, zuweisungen, fehler, stichtage, List.copyOf(offen));
    }
}
