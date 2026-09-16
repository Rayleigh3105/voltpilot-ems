package com.voltpilot.api.benutzer;

import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.ProtokollAkteur;
import com.voltpilot.api.uems.RechteAbleitung.Konto;
import com.voltpilot.api.uems.RechteAbleitung.Rolle;
import com.voltpilot.api.zugriff.*;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.List;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

/** Kundenverwaltung ausschließlich über die RLS-Verbindung; keine Keycloak- oder Plattformliste. */
@Service
public class BenutzerVerwaltung {
    public record Zuweisung(UUID id, String rolle, UUID standort_id, String standort_name,
            String gueltig_ab, String gueltig_bis) {}
    public record Eintrag(String sub, String anzeigename, String email, String zustand, List<Zuweisung> zuweisungen) {}
    public record Wechsel(List<UUID> bisher, String rolle, List<UUID> standorte) {}
    public record Protokoll(long id, String zeit, String betroffener, String aktion, String rolle,
            String standort, String urheber, String grund) {}
    private final JdbcTemplate jdbc;
    private final ZugriffRepository zugriffe;
    private final ZugriffAenderung aenderung;
    private final RechtPruefung rechte;

    public BenutzerVerwaltung(JdbcTemplate jdbc, ZugriffRepository zugriffe, ZugriffAenderung aenderung, RechtPruefung rechte) {
        this.jdbc = jdbc; this.zugriffe = zugriffe; this.aenderung = aenderung; this.rechte = rechte;
    }

    public List<Eintrag> liste() {
        lesen();
        return jdbc.query("SELECT sub, anzeigename, email, zustand FROM benutzer WHERE tenant_id = ? "
                + "AND konto = 'benutzer' AND zustand <> 'entfernt' ORDER BY anzeigename, sub",
                (rs, n) -> new Eintrag(rs.getString("sub"), rs.getString("anzeigename"), rs.getString("email"),
                        rs.getString("zustand"), zugriffe.zuweisungen(rs.getString("sub")).stream()
                                .filter(z -> z.beendetAm() == null && (z.endetAm() == null || z.endetAm().isAfter(Instant.now())))
                                .map(z -> new Zuweisung(z.id(), z.rolle().code(), z.standortId(), z.standortName(),
                                        z.gueltigAb().toString(), z.gueltigBis() == null ? null : z.gueltigBis().toString())).toList()),
                TenantContext.get());
    }

    public void wechseln(String sub, Wechsel w, ProtokollAkteur akteur) {
        schreiben();
        if (w == null || w.bisher() == null || w.standorte() == null || w.bisher().contains(null)
                || w.standorte().contains(null)) throw new BenutzerFehler(400, "anfrage_ungueltig", "Bitte prüfen Sie die Angaben.");
        Rolle rolle;
        try { rolle = Rolle.vonCode(w.rolle()); }
        catch (RuntimeException e) { throw new BenutzerFehler(400, "anfrage_ungueltig", "Bitte wählen Sie eine Rolle."); }
        if (rolle == null || rolle == Rolle.UNTERSTUETZER || rolle == Rolle.VOLTPILOT_BETRIEB)
            throw new BenutzerFehler(400, "anfrage_ungueltig", "Bitte wählen Sie eine Kundenrolle.");
        aenderung.ersetzen(sub, w.bisher(), rolle, w.standorte(), akteur);
    }

    public void beenden(String sub, boolean entfernen, ProtokollAkteur akteur) {
        schreiben();
        aenderung.kontoBeenden(sub, entfernen, akteur);
    }

    public List<Protokoll> protokoll(Instant von, Instant bis) {
        schreiben();
        rechte.pruefen("zugriffsprotokoll.lesen", RechtZiel.UNTERNEHMEN, null, null);
        if (!von.isBefore(bis) || java.time.Duration.between(von, bis).compareTo(java.time.Duration.ofDays(366)) > 0)
            throw new BenutzerFehler(400, "zeitraum_ungueltig", "Bitte wählen Sie einen Zeitraum von höchstens einem Jahr.");
        return jdbc.query("SELECT p.id, p.created_at, p.betroffener_name, p.aktion, p.rolle, s.name AS standort, "
                + "p.actor_name, p.grund FROM zugriff_protokoll p LEFT JOIN standort s "
                + "ON s.tenant_id = p.tenant_id AND s.id = p.standort_id "
                + "WHERE p.tenant_id = ? AND p.created_at >= ? AND p.created_at < ? ORDER BY p.created_at DESC, p.id DESC LIMIT 1001",
                (rs, n) -> new Protokoll(rs.getLong("id"), rs.getObject("created_at", OffsetDateTime.class).toInstant().toString(),
                        rs.getString("betroffener_name"), rs.getString("aktion"), rs.getString("rolle"), rs.getString("standort"),
                        rs.getString("actor_name"), rs.getString("grund")), TenantContext.get(), von.atOffset(ZoneOffset.UTC), bis.atOffset(ZoneOffset.UTC));
    }

    private void lesen() {
        var z = ZugriffContext.get();
        if (z == null || z.konto() != Konto.BENUTZER || z.zugang() != ZugriffContext.Zugang.KONTO
                || !(z.bestandskonto() || z.zuweisungen().stream().anyMatch(a -> a.rolle() == Rolle.KUNDENADMINISTRATOR
                        || a.rolle() == Rolle.ENERGIEMANAGER)))
            throw new BenutzerFehler(403, "recht_fehlt", "Die Benutzerliste sehen Kundenadministratoren und Energiemanager.");
    }
    private void schreiben() {
        lesen();
        rechte.pruefen("benutzer.verwalten", RechtZiel.UNTERNEHMEN, null, null);
    }
}
