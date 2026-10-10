package com.voltpilot.api.uems;

import com.voltpilot.api.repo.SiteRepository;
import com.voltpilot.api.uems.StandortLesemodell.Anlage;
import com.voltpilot.api.uems.StandortLesemodell.StandortAmStichtag;
import com.voltpilot.api.uems.StandortLesemodell.StandortBezug;
import com.voltpilot.api.uems.StandortLesemodell.StandorteAmStichtag;
import com.voltpilot.api.uems.StandortLesemodell.UnternehmenSicht;
import com.voltpilot.api.uems.StandortLesemodell.Zeilen;
import java.time.Instant;
import java.time.LocalDate;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

/**
 * Liest die Zeilen des Standort-Lesemodells ({@link StandortLesemodell}) — alles
 * über die mandantengebundene App-Verbindung: RLS ist der Zaun, keine Abfrage
 * trägt ein {@code tenant_id}-Prädikat. Ein fremder Standort ist deshalb schlicht
 * nicht da (die Route macht daraus 404, nie 403).
 *
 * <p>Ohne einen Standort gibt es nichts, woran ein Gebäude, eine Fläche oder
 * eine Anlagen-Zuordnung hängen könnte (zusammengesetzte Fremdschlüssel): dann
 * bleibt es bei zwei Lesezügen — so kostet das additive Feld {@code standort}
 * an {@code /overview} jeden Bestandskunden (heute: alle) fast nichts.
 */
@Service
public class StandortLesemodellService {

    private final JdbcTemplate jdbc;
    private final UnternehmenRepository unternehmen;
    private final StandortRepository standorte;
    private final OrtRepository orte;
    private final OrtZuordnungRepository ortZuordnungen;
    private final AnlageStandortRepository anlageZuordnungen;
    private final FlaecheRepository flaechen;
    private final SiteRepository sites;
    private final OrtAenderungRepository aenderungen;
    private final NetzanschlussRepository netzanschluesse;

    public StandortLesemodellService(JdbcTemplate jdbc, UnternehmenRepository unternehmen,
            StandortRepository standorte, OrtRepository orte,
            OrtZuordnungRepository ortZuordnungen, AnlageStandortRepository anlageZuordnungen,
            FlaecheRepository flaechen, SiteRepository sites, OrtAenderungRepository aenderungen,
            NetzanschlussRepository netzanschluesse) {
        this.jdbc = jdbc;
        this.unternehmen = unternehmen;
        this.standorte = standorte;
        this.orte = orte;
        this.ortZuordnungen = ortZuordnungen;
        this.anlageZuordnungen = anlageZuordnungen;
        this.flaechen = flaechen;
        this.sites = sites;
        this.aenderungen = aenderungen;
        this.netzanschluesse = netzanschluesse;
    }

    /**
     * Das Unternehmen mit den Zahlen von heute — leer, wenn es keinen
     * Kundenbereich gibt (ein Admin ohne gewählten Mandanten: RLS default-deny,
     * wie {@code /tenant-context}). Ein Kundenbereich OHNE Unternehmen-Zeile ist
     * dagegen eine Antwort mit Zustand {@code nicht_angelegt}, nie ein Fehler.
     */
    public Optional<UnternehmenSicht> unternehmen() {
        if (!kundenbereichSichtbar()) {
            return Optional.empty();
        }
        Zeilen z = zeilen();
        return Optional.of(StandortLesemodell.unternehmen(z, heute(z)));
    }

    /** Die Standorte zum Stichtag; {@code null} = heute in der Zeitzone des Unternehmens. */
    public StandorteAmStichtag standorte(LocalDate stichtag) {
        Zeilen z = zeilen();
        return StandortLesemodell.standorte(z, stichtag == null ? heute(z) : stichtag);
    }

    /** Ein Standort zum Stichtag — leer, wenn er nicht (oder einem anderen Mandanten) gehört. */
    public Optional<StandortAmStichtag> standort(UUID id, LocalDate stichtag) {
        Zeilen z = zeilen();
        return StandortLesemodell.standort(z, id, stichtag == null ? heute(z) : stichtag);
    }

    /** Je Anlage ihr Standort heute; eine Anlage ohne gültige Zuordnung fehlt. */
    public Map<UUID, StandortBezug> bezugJeAnlage() {
        List<StandortRepository.Standort> st = standorte.alle();
        if (st.isEmpty()) {
            return Map.of();
        }
        Zeilen z = zeilen(st);
        return StandortLesemodell.bezugJeAnlage(z, heute(z));
    }

    /** Der Standort einer Anlage heute, oder {@code null} (noch nicht zugeordnet). */
    public StandortBezug bezugDerAnlage(UUID siteId) {
        return bezugJeAnlage().get(siteId);
    }

    private LocalDate heute(Zeilen z) {
        return StandortLesemodell.heute(z, Instant.now());
    }

    private boolean kundenbereichSichtbar() {
        // Kein WHERE: RLS schneidet `tenant` auf die eigene Zeile (oder keine).
        return !jdbc.queryForList("SELECT id FROM tenant", UUID.class).isEmpty();
    }

    /**
     * Alle Zeilen des Mandanten — auch der Stand, auf dem die Schreibrouten urteilen: der
     * Standort (IP-4, {@link StandortService}) und die Gebäude/Bereiche (IP-5,
     * {@link OrtService}) prüfen gegen DENSELBEN Baum, den das Lesemodell zeigt.
     */
    Zeilen zeilen() {
        return zeilen(standorte.alle());
    }

    private Zeilen zeilen(List<StandortRepository.Standort> st) {
        UnternehmenRepository.Unternehmen u = unternehmen.desKundenbereichs().orElse(null);
        List<Anlage> anlagen = sites.findAll().stream()
                .map(s -> new Anlage(s.id(), s.name()))
                .toList();
        if (st.isEmpty()) {
            return new Zeilen(u, st, List.of(), List.of(), List.of(), List.of(), anlagen);
        }
        // Ein Netzanschluss hängt an einem Standort (AP-10 IP-6) — ohne Standort gibt es keine Bindung.
        List<StandortLesemodell.NetzanschlussBindung> bindungen = netzanschluesse.bindungen().stream()
                .map(b -> new StandortLesemodell.NetzanschlussBindung(b.siteId(), b.netzanschlussId(),
                        b.netzanschlussKennzeichen(), b.gueltigAb(), b.gueltigBis()))
                .toList();
        return new Zeilen(u, st, orte.alle(), ortZuordnungen.alle(), anlageZuordnungen.alle(),
                flaechen.alle(), anlagen, aenderungen.archivVerlauf("standort"), bindungen);
    }
}
