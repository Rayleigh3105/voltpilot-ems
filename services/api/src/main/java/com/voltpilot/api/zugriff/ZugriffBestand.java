package com.voltpilot.api.zugriff;

import com.voltpilot.api.admin.KeycloakAdminClient.KeycloakUser;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.ProtokollAkteur;
import com.voltpilot.api.uems.RechteAbleitung.Konto;
import com.voltpilot.api.uems.RechteAbleitung.KontoZustand;
import com.voltpilot.api.uems.RechteAbleitung.Rolle;
import com.voltpilot.api.zugriff.ZugriffRepository.BenutzerSpiegel;
import com.voltpilot.api.zugriff.ZugriffRepository.NeueZuweisung;
import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.MeterRegistry;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneId;
import java.util.List;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.event.EventListener;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * Die BESTANDSÜBERNAHME der Rechte (UEMS AP-03 IP-2, Captain-Entscheid E12 = A): jeder heutige Kundenbenutzer
 * wird Kundenadministrator, unternehmensweit — auch die Träger der Realm-Rollen {@code admin} und
 * {@code site-admin} (sie tragen dasselbe {@code tenant_id}-Attribut). <b>Niemand verliert dadurch Zugriff</b>:
 * das ist die Eigenschaft, auf der jedes spätere Durchsetzungs-Paket ab seinem Merge scharf sein darf (W11).
 *
 * <p><b>Die Regel, zeichengleich für beide Wege.</b> Für jedes Konto des Kundenbereichs:
 * <ol>
 *   <li>der Spiegel {@code benutzer} entsteht, wenn es ihn noch nicht gibt (Anzeigename aus Vor- und
 *       Nachname, sonst dem Benutzernamen; Zustand {@code aktiv}, bei einem deaktivierten Konto
 *       {@code gesperrt} — die Zuweisung bleibt dann, wirkt aber nicht, §4.8);</li>
 *   <li>hatte das Konto hier NIE eine Zuweisung, bekommt es genau eine: Kundenadministrator, mandantenweit,
 *       gültig ab jetzt, unbefristet — protokolliert als {@code zuweisen} mit dem Urheber „Bestandsübernahme"
 *       ({@link ProtokollAkteur#bestandsuebernahme()}) und dem Grund {@value #GRUND}.</li>
 * </ol>
 * „Nie" statt „keine wirksame": eine beendete Zuweisung bleibt beendet — wem der Kundenadministrator den
 * Zugriff entzogen hat, dem gibt kein späterer Lauf ihn zurück. Ein zweiter Lauf schreibt nichts.
 *
 * <p><b>Die zwei Wege.</b> Der Start-Lauf ({@link ZugriffBestandLaeufer}) geht über jedes Konto, das Keycloak
 * je Kundenbereich kennt. Ein Konto, das danach entsteht (Selbstregistrierung, Admin-Konsole), kommt über
 * {@link KundenbenutzerAngelegt} sofort dazu — ein ZUSATZ zum bestehenden Anlageweg und darum isoliert: ein
 * Fehler hier wird geloggt und gezählt ({@value #ZAEHLER}{@code {ergebnis="fehler"}}), die Anlage des Kontos
 * gelingt wie vorher, und der nächste Start holt die Zuweisung nach.
 *
 * <p>Je Kundenbereich EINE Transaktion unter einer Beratungssperre, damit Start-Lauf und Anlage-Ereignis
 * dasselbe Konto nicht zweimal zuweisen (die Exklusion der Tabelle wäre die Wand dahinter).
 */
@Service
public class ZugriffBestand {

    private static final Logger log = LoggerFactory.getLogger(ZugriffBestand.class);

    /** Der Grund im Zugriffsprotokoll. */
    public static final String GRUND = "Bestandsübernahme";

    /** Prometheus: {@code voltpilot_zugriff_bestand_total}, Tag {@code ergebnis} = zugewiesen | fehler. */
    public static final String ZAEHLER = "voltpilot_zugriff_bestand";

    /** Die Zone des Vertrags, wenn der Kundenbereich (noch) kein Unternehmen hat. */
    private static final ZoneId VORGABE_ZONE = ZoneId.of("Europe/Berlin");

    private final ZugriffRepository zugriffe;
    private final JdbcTemplate jdbc;
    private final TransactionTemplate transaktion;
    private final Counter zugewiesen;
    private final Counter fehler;
    private volatile Clock uhr = Clock.systemUTC();

    public ZugriffBestand(ZugriffRepository zugriffe, JdbcTemplate jdbc, PlatformTransactionManager transactionManager,
            MeterRegistry metriken) {
        this.zugriffe = zugriffe;
        this.jdbc = jdbc;
        this.transaktion = new TransactionTemplate(transactionManager);
        this.zugewiesen = Counter.builder(ZAEHLER).tag("ergebnis", "zugewiesen")
                .description("Kundenbenutzer, die die Bestandsübernahme zum Kundenadministrator machte")
                .register(metriken);
        this.fehler = Counter.builder(ZAEHLER).tag("ergebnis", "fehler")
                .description("Gescheiterte Übernahmen eines neu angelegten Kundenbenutzers")
                .register(metriken);
    }

    /** Nur für Tests: die Uhr, an der „gültig ab" hängt. */
    void uhrStellen(Clock uhr) {
        this.uhr = uhr;
    }

    /** Was eine Übernahme tat. Ein zweiter Lauf: {@link #geaendert()} {@code false}. */
    public record Ergebnis(int konten, int benutzerNeu, int zuweisungenNeu) {

        public boolean geaendert() {
            return benutzerNeu > 0 || zuweisungenNeu > 0;
        }
    }

    /**
     * Übernimmt die Konten in den Kundenbereich des {@link TenantContext} — in EINER Transaktion. Ein Konto
     * eines anderen Kundenbereichs wird übergangen, nie hier eingetragen.
     */
    public Ergebnis uebernehmen(List<KeycloakUser> konten) {
        UUID tenant = TenantContext.get();
        if (tenant == null) {
            throw new IllegalStateException("Die Bestandsübernahme braucht einen Kundenbereich (TenantContext)");
        }
        Ergebnis e = transaktion.execute(status -> {
            jdbc.queryForList("SELECT pg_advisory_xact_lock(hashtext(?))::text", String.class,
                    "uems-zugriff-bestand:" + tenant);
            ZoneId zone = zeitzone(tenant);
            Instant jetzt = uhr.instant();
            int betrachtet = 0;
            int neu = 0;
            int zuweisungen = 0;
            for (KeycloakUser k : konten) {
                if (k == null || k.id() == null || k.id().isBlank() || !tenant.toString().equals(k.tenantId())) {
                    continue;
                }
                betrachtet++;
                String sub = k.id().trim();
                String name = anzeigename(k);
                if (zugriffe.benutzerSpiegeln(new BenutzerSpiegel(sub, Konto.BENUTZER, name, email(k),
                        k.enabled() ? KontoZustand.AKTIV : KontoZustand.GESPERRT))) {
                    neu++;
                }
                if (!zugriffe.hatJeEineZuweisung(sub)) {
                    zugriffe.zuweisen(NeueZuweisung.unternehmensweit(sub, Rolle.KUNDENADMINISTRATOR, jetzt, zone, null),
                            name, ProtokollAkteur.bestandsuebernahme(), GRUND);
                    zuweisungen++;
                }
            }
            return new Ergebnis(betrachtet, neu, zuweisungen);
        });
        zugewiesen.increment(e.zuweisungenNeu());
        return e;
    }

    /**
     * Das neu angelegte Konto sofort übernehmen — isoliert: wirft nie, der Anlageweg bleibt, wie er war.
     * Der {@link TenantContext} des Aufrufers (etwa der Mandanten-Umschalter des Plattform-Admins) wird
     * danach wiederhergestellt.
     */
    @EventListener
    public void beiAnlage(KundenbenutzerAngelegt ereignis) {
        UUID vorher = TenantContext.get();
        try {
            TenantContext.set(ereignis.tenantId());
            uebernehmen(List.of(ereignis.konto()));
        } catch (RuntimeException ex) {
            fehler.increment();
            log.error("UEMS-Zugriff: das neue Konto im Kundenbereich {} blieb ohne Zuweisung; der nächste Start "
                    + "holt sie nach: {}", ereignis.tenantId(), ex.toString(), ex);
        } finally {
            if (vorher == null) {
                TenantContext.clear();
            } else {
                TenantContext.set(vorher);
            }
        }
    }

    private ZoneId zeitzone(UUID tenant) {
        List<String> zonen = jdbc.queryForList("SELECT zeitzone FROM unternehmen WHERE tenant_id = ?", String.class,
                tenant);
        return zonen.isEmpty() ? VORGABE_ZONE : ZoneId.of(zonen.get(0));
    }

    static String anzeigename(KeycloakUser k) {
        String voll = ((k.firstName() == null ? "" : k.firstName().trim()) + " "
                + (k.lastName() == null ? "" : k.lastName().trim())).trim();
        if (!voll.isEmpty()) {
            return voll;
        }
        if (k.username() != null && !k.username().isBlank()) {
            return k.username().trim();
        }
        return k.id().trim();
    }

    private static String email(KeycloakUser k) {
        return k.email() == null || k.email().isBlank() ? null : k.email().trim();
    }
}
