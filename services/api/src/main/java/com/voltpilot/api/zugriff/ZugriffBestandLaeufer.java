package com.voltpilot.api.zugriff;

import com.voltpilot.api.admin.KeycloakAdminClient;
import com.voltpilot.api.admin.KeycloakAdminClient.KeycloakAdminException;
import com.voltpilot.api.admin.KeycloakAdminClient.KeycloakUser;
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
 * Der Start-Lauf der Rechte-Bestandsübernahme (UEMS AP-03 IP-2, E12): je Kundenbereich die Konten aus Keycloak
 * holen und {@link ZugriffBestand#uebernehmen} geben — jeder Kundenbenutzer ohne je eine Zuweisung wird
 * Kundenadministrator.
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
 *       erreichbar, endet der Lauf mit EINER Meldung, und der nächste Start versucht es wieder.</li>
 *   <li><b>abschaltbar</b> — {@code voltpilot.uems.zugriff-bestand.enabled}: in Produktion AN (application.yml,
 *       „ein Flag hat die Vorgabe AN"), im Testlauf AUS (surefire). Wer ihn prüft, ruft {@link #lauf()}
 *       selbst. Der Schalter nimmt nur den Start-Lauf, nie das Anlage-Ereignis.</li>
 * </ul>
 */
@Component
public class ZugriffBestandLaeufer {

    private static final Logger log = LoggerFactory.getLogger(ZugriffBestandLaeufer.class);

    /** Was ein Lauf tat (für das Log und die Tests). */
    public record Lauf(int kundenbereiche, int konten, int benutzerNeu, int zuweisungenNeu, int fehler) {

        public boolean geaendert() {
            return benutzerNeu > 0 || zuweisungenNeu > 0;
        }
    }

    private final JdbcTemplate adminJdbc;
    private final KeycloakAdminClient keycloak;
    private final ZugriffBestand bestand;
    private final boolean enabled;

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
        Thread.ofVirtual().name("uems-zugriff-bestand").start(this::imHintergrund);
    }

    private void imHintergrund() {
        try {
            Lauf l = lauf();
            if (l.geaendert() || l.fehler() > 0) {
                log.info("UEMS-Bestandsübernahme der Zugriffe: {} Kundenbereich(e), {} Konto/Konten, {} Spiegel neu, "
                        + "{} Kundenadministrator(en) zugewiesen, {} Fehler", l.kundenbereiche(), l.konten(),
                        l.benutzerNeu(), l.zuweisungenNeu(), l.fehler());
            }
        } catch (RuntimeException e) {
            // Eine Übernahme darf die api nie am Dienen hindern.
            log.error("UEMS-Bestandsübernahme der Zugriffe gescheitert: {}", e.toString(), e);
        }
    }

    /** Ein Lauf über alle Kundenbereiche, ältester zuerst. Wirft nie je Kundenbereich. */
    public Lauf lauf() {
        List<UUID> kundenbereiche = adminJdbc.queryForList("SELECT id FROM tenant ORDER BY created_at, id", UUID.class);
        int konten = 0;
        int neu = 0;
        int zuweisungen = 0;
        int fehler = 0;
        for (UUID tenant : kundenbereiche) {
            List<KeycloakUser> liste;
            try {
                liste = keycloak.listUsersForTenant(tenant);
            } catch (KeycloakAdminException e) {
                fehler++;
                log.warn("UEMS-Zugriff: Keycloak lehnt die Konten des Kundenbereichs {} ab: {}", tenant, e.getMessage());
                continue;
            } catch (RuntimeException e) {
                fehler++;
                log.warn("UEMS-Zugriff: Keycloak nicht erreichbar, der Lauf endet und der nächste Start versucht es "
                        + "wieder: {}", e.toString());
                break;
            }
            try {
                TenantContext.set(tenant);
                ZugriffBestand.Ergebnis e = bestand.uebernehmen(liste);
                konten += e.konten();
                neu += e.benutzerNeu();
                zuweisungen += e.zuweisungenNeu();
            } catch (RuntimeException e) {
                fehler++;
                log.error("UEMS-Zugriff: Bestandsübernahme für Kundenbereich {} gescheitert, nichts übernommen: {}",
                        tenant, e.toString(), e);
            } finally {
                TenantContext.clear();
            }
        }
        return new Lauf(kundenbereiche.size(), konten, neu, zuweisungen, fehler);
    }
}
