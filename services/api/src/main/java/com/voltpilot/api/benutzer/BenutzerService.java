package com.voltpilot.api.benutzer;

import com.fasterxml.jackson.annotation.JsonProperty;
import com.voltpilot.api.admin.KeycloakAdminClient;
import com.voltpilot.api.admin.KeycloakAdminClient.KeycloakUser;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.ProtokollAkteur;
import com.voltpilot.api.uems.RechteAbleitung.Konto;
import com.voltpilot.api.uems.RechteAbleitung.KontoZustand;
import com.voltpilot.api.uems.RechteAbleitung.Rolle;
import com.voltpilot.api.zugriff.ZugriffAenderung;
import com.voltpilot.api.zugriff.ZugriffContext;
import com.voltpilot.api.zugriff.ZugriffContext.Zugang;
import com.voltpilot.api.zugriff.ZugriffRepository;
import com.voltpilot.api.zugriff.ZugriffRepository.BenutzerSpiegel;
import com.voltpilot.api.zugriff.ZugriffRepository.NeueZuweisung;
import java.time.Instant;
import java.time.LocalDate;
import java.util.List;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

@Service
public class BenutzerService {
    /** {@code gueltig_bis}: wahlfrei der letzte Tag (einschließlich) — nur bei Einsicht (AP-19 Folge IP-13, RE3). */
    public record Anlage(String username, String email, String vorname, String nachname, String rolle,
            List<UUID> standorte, @JsonProperty("gueltig_bis") String gueltigBis) {}
    public record Benutzer(String sub, String anzeigename, String email, String zustand) {}
    public record Angelegt(Benutzer benutzer, Startpasswort startpasswort) {}

    private final KeycloakAdminClient keycloak;
    private final StartpasswortKonten konten;
    private final ZugriffRepository zugriffe;
    private final ZugriffAenderung aenderung;
    private final JdbcTemplate jdbc;
    private final TransactionTemplate tx;

    public BenutzerService(KeycloakAdminClient keycloak, StartpasswortKonten konten, ZugriffRepository zugriffe,
            ZugriffAenderung aenderung, JdbcTemplate jdbc, PlatformTransactionManager transactions) {
        this.keycloak = keycloak;
        this.konten = konten;
        this.zugriffe = zugriffe;
        this.aenderung = aenderung;
        this.jdbc = jdbc;
        this.tx = new TransactionTemplate(transactions);
    }

    public Angelegt anlegen(Anlage anlage, ProtokollAkteur akteur) {
        kundenadministrator();
        return tx.execute(status -> anlegen(anlage, akteur, false));
    }

    /** Nur der explizite Plattformweg darf den allerersten Kundenadministrator anlegen. */
    public Angelegt erster(UUID tenant, Anlage anlage, ProtokollAkteur akteur) {
        UUID vorher = TenantContext.get();
        try {
            TenantContext.set(tenant);
            return tx.execute(status -> {
                jdbc.queryForObject("SELECT pg_advisory_xact_lock(hashtext(?))",
                        Object.class, "uems-erster-benutzer:" + tenant);
                if (!keycloak.listUsersForTenant(tenant).isEmpty()
                        || Boolean.TRUE.equals(jdbc.queryForObject("SELECT EXISTS (SELECT 1 FROM benutzer "
                                + "WHERE tenant_id = ?)", Boolean.class, tenant))) {
                    throw new BenutzerFehler(403, "recht_fehlt",
                            "Weitere Benutzer legt der Kundenadministrator an.");
                }
                return anlegen(new Anlage(anlage.username(), anlage.email(), anlage.vorname(), anlage.nachname(),
                        Rolle.KUNDENADMINISTRATOR.code(), List.of(), null), akteur, true);
            });
        } finally {
            if (vorher == null) TenantContext.clear(); else TenantContext.set(vorher);
        }
    }

    private Angelegt anlegen(Anlage a, ProtokollAkteur akteur, boolean erster) {
        // Serialize before creating the external account, including against tenant teardown.
        aenderung.sperreKundenbereich();
        if (!zugriffe.kundenbereichVorhanden()) throw nichtGefunden();
        if (a == null || a.username() == null || a.username().isBlank() || a.username().length() > 255
                || a.email() == null || !a.email().matches("[^\\s@]+@[^\\s@]+\\.[^\\s@]+")) {
            throw new BenutzerFehler(400, "anfrage_ungueltig", "Benutzername und E-Mail-Adresse sind erforderlich.");
        }
        Rolle rolle;
        try { rolle = Rolle.vonCode(a.rolle()); }
        catch (RuntimeException ex) { throw new BenutzerFehler(400, "anfrage_ungueltig", "Bitte wählen Sie eine Rolle."); }
        if (rolle == null || rolle == Rolle.UNTERSTUETZER || rolle == Rolle.VOLTPILOT_BETRIEB) {
            throw new BenutzerFehler(400, "anfrage_ungueltig", "Bitte wählen Sie eine Kundenrolle.");
        }
        List<UUID> standorte = a.standorte() == null ? List.of() : a.standorte().stream().distinct().toList();
        if (rolle.jeStandort() && standorte.isEmpty()) {
            throw new BenutzerFehler(422, "standort_fehlt", "Bitte wählen Sie mindestens einen Standort.");
        }
        if (!rolle.jeStandort() && !standorte.isEmpty()) {
            throw new BenutzerFehler(400, "anfrage_ungueltig", "Diese Rolle gilt im ganzen Unternehmen.");
        }
        List<UUID> sichtbar = zugriffe.standorte().stream().map(ZugriffRepository.StandortEintrag::id).toList();
        if (!sichtbar.containsAll(standorte)) throw nichtGefunden();
        // Vor dem Keycloak-Konto: eine abgelehnte Frist hinterlässt kein Konto.
        LocalDate bis = erster ? null : Befristung.lesen(a.gueltigBis(), rolle, aenderung);
        StartpasswortKonten.Angelegt neu;
        try {
            neu = konten.kunde(TenantContext.get(), a.username().trim(), a.email().trim(), a.vorname(), a.nachname());
        } catch (KeycloakAdminClient.KeycloakAdminException e) {
            if (e.status() == 409 && keycloak.findByEmail(a.email()).filter(k ->
                    !TenantContext.get().toString().equals(k.tenantId())).isPresent()) {
                throw new BenutzerFehler(409, "email_fremder_kundenbereich",
                        "Diese E-Mail-Adresse ist bereits einem anderen Kundenbereich zugeordnet. Als Unterstützung gewähren?");
            }
            throw e;
        }
        KeycloakUser konto = neu.konto();
        String name = ((konto.firstName() == null ? "" : konto.firstName()) + " "
                + (konto.lastName() == null ? "" : konto.lastName())).trim();
        if (name.isBlank()) name = konto.username();
        zugriffe.benutzerSpiegeln(new BenutzerSpiegel(konto.id(), Konto.BENUTZER, name, konto.email(), KontoZustand.ANGELEGT));
        if (erster) {
            // Kein bestehendes Konto, dessen Rechte verändert werden könnten. Kein E12-Ereignis veröffentlichen.
            zugriffe.zuweisen(NeueZuweisung.unternehmensweit(konto.id(), rolle, Instant.now(),
                    zugriffe.kundenbereichKopf().zeitzone(), akteur.sub()), name, akteur, null);
        } else if (rolle.jeStandort()) {
            for (UUID standort : standorte) aenderung.zuweisen(konto.id(), rolle, standort, null, akteur);
        } else {
            aenderung.zuweisen(konto.id(), rolle, null, bis, null, akteur);
        }
        return new Angelegt(new Benutzer(konto.id(), name, konto.email(), "angelegt"), neu.startpasswort());
    }

    public Angelegt neuVergeben(String sub, ProtokollAkteur akteur) {
        kundenadministrator();
        return tx.execute(status -> {
            BenutzerSpiegel spiegel = zugriffe.spiegel(sub).filter(b -> b.konto() == Konto.BENUTZER
                    && b.zustand() != KontoZustand.ENTFERNT).orElseThrow(BenutzerService::nichtGefunden);
            KeycloakUser konto = keycloak.getUser(sub);
            if (!TenantContext.get().toString().equals(konto.tenantId())) throw nichtGefunden();
            Startpasswort passwort = konten.neu(sub);
            zugriffe.kontoProtokoll("startpasswort_neu", sub, spiegel.anzeigename(), akteur);
            return new Angelegt(new Benutzer(sub, spiegel.anzeigename(), spiegel.email(), spiegel.zustand().code()), passwort);
        });
    }

    private static void kundenadministrator() {
        var z = ZugriffContext.get();
        if (z == null || z.konto() != Konto.BENUTZER || z.zugang() != Zugang.KONTO
                || !(z.bestandskonto() || z.zuweisungen().stream().anyMatch(x -> x.rolle() == Rolle.KUNDENADMINISTRATOR))) {
            throw new BenutzerFehler(403, "recht_fehlt", "Nur der Kundenadministrator kann Benutzer anlegen oder ein Startpasswort neu vergeben.");
        }
    }

    private static BenutzerFehler nichtGefunden() {
        return new BenutzerFehler(404, "nicht_gefunden", "Benutzer oder Standort nicht gefunden.");
    }
}
