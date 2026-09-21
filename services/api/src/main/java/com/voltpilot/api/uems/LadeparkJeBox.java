package com.voltpilot.api.uems;

import com.voltpilot.api.uems.SteuerungsverbundRepository.MitgliedZeile;
import com.voltpilot.api.uems.SteuerungsverbundRepository.VerbundZeile;
import com.voltpilot.api.uems.SteuerungsverbundVokabular.Rolle;
import com.voltpilot.api.uems.SteuerungsverbundVokabular.Stufe;
import java.time.Clock;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.stereotype.Component;

/**
 * Die Boxen einer Anlage, an die ihr Ladepark-Dokument JE BOX reist (UEMS AP-15 IP-16, P6, W6, E4 = A).
 *
 * <p>Nur eine Anlage mit Gemeinsamer Steuerung in {@code anteile_aktiv} oder {@code angehalten} hat eine Verteilung:
 * angehalten heißt „die Anteile bleiben in Kraft“ (Konzept §3.9, §5.5), also halten die mitsteuernden Boxen ihren
 * Anteil weiter und ihre Ladepunkte dürfen nicht verwaisen. Jede andere Anlage — Bestand ohne Verbund, S0 bis S2 —
 * bekommt {@link Optional#empty()} und damit das eine Dokument von heute, Byte für Byte (NW-6, R22).
 *
 * <p>Der Anteil einer Box reist NUR im Anteils-Dokument (Y1): die Box rechnet ihr Ladebudget als Minimum aus heute
 * und Anteil (IP-19). Das Ladepark-Dokument trägt je Box die Netzgrenze der Anlage — sie kann dort nur verengen.
 */
@Component
public class LadeparkJeBox {

    /** Stufe und steuernde Boxen, die führende zuerst. {@code scharf} = die 422 „zweite Box“ fällt (§3.9 S3). */
    public record Verteilung(Stufe stufe, List<UUID> boxen) {

        public boolean scharf() {
            return stufe == Stufe.ANTEILE_AKTIV;
        }

        public UUID fuehrende() {
            return boxen.get(0);
        }
    }

    private final SteuerungsverbundRepository verbuende;
    private final Clock clock = Clock.systemUTC();

    public LadeparkJeBox(SteuerungsverbundRepository verbuende) {
        this.verbuende = verbuende;
    }

    /** Die Verteilung der Anlage — leer ohne Gemeinsame Steuerung in {@code anteile_aktiv}/{@code angehalten}. */
    public Optional<Verteilung> derAnlage(UUID siteId) {
        Optional<VerbundZeile> v = verbuende.derAnlage(siteId);
        if (v.isEmpty() || (v.get().stufe() != Stufe.ANTEILE_AKTIV && v.get().stufe() != Stufe.ANGEHALTEN)) {
            return Optional.empty();
        }
        // Mitglieder sind nur führend oder mitsteuernd (T6), die führende steht vorn.
        List<MitgliedZeile> mitglieder = verbuende.mitglieder(v.get().id(), clock.instant());
        if (mitglieder.isEmpty() || mitglieder.get(0).rolle() != Rolle.FUEHRT) {
            return Optional.empty(); // ohne führende Box wird nie geraten — wie heute bei mehreren belegten Boxen
        }
        return Optional.of(new Verteilung(v.get().stufe(),
                mitglieder.stream().map(MitgliedZeile::deviceId).toList()));
    }
}
