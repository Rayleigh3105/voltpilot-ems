package com.voltpilot.api.mispel;

import com.fasterxml.jackson.databind.PropertyNamingStrategies;
import com.fasterxml.jackson.databind.annotation.JsonNaming;
import com.voltpilot.api.mispel.AusschliesslichkeitsPruefer.Ergebnis;
import com.voltpilot.api.mispel.AusschliesslichkeitsPruefer.Jahr;
import com.voltpilot.api.mispel.AusschliesslichkeitsPruefer.Monat;
import com.voltpilot.api.mispel.AusschliesslichkeitsPruefungRepository.Anlage;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.stereotype.Service;

/**
 * MiSpeL MP-2 (W1 = D): der Ausschließlichkeits-Prüfer als Auswertung für den Betreiber — je Anlage die Monate und
 * das Kalenderjahr, für die Flotte die Jahreswerte jeder Anlage mit Speicher. Nur lesend; keine Steuerung (die strenge
 * Variante ist MP-45), keine Oberfläche. Die Rechnung steht in {@link AusschliesslichkeitsPruefer}.
 */
@Service
public class AusschliesslichkeitsPruefungService {

    /** Woher die Viertelstunden stammen — in jeder Antwort, damit niemand sie für eine Mengenbestimmung hält. */
    public static final String WERTE = "geraetewerte_vorlaeufig";

    /** Was die Zahlen sind, in einem Satz mit Fundstelle. */
    public static final String LESART = "Viertelstunden, in denen der Speicher Strom verbrauchte, während am"
            + " Netzanschluss gleichzeitig Netzbezug bestand (A1 S. 11), und die Menge Netzstrom im Speicher nach"
            + " Speichervorrang (1)¼ = MIN [ Z1NB¼ ; Z2V¼ ], (9) = ∑M (1)¼ (§ 21 Abs. 4 S. 3 EnFG, A1 S. 14–15, S. 33–34);"
            + " die Netzeinspeisung aus dem Speicher (2)¼ = MIN [ Z1NE¼ ; Z2E¼ ], (11) = ∑M (2)¼ (§ 21 Abs. 4 S. 4 EnFG,"
            + " A1 S. 15–16, S. 34–35).";

    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record OffeneFrage(String frage, String text, String fundstelle) {}

    /** Die Fragen, die der Prüfer bewusst nicht entscheidet. */
    public static final List<OffeneFrage> OFFENE_FRAGEN = List.of(
            new OffeneFrage("toleranz", "Die Festlegung nennt keine Toleranz je Viertelstunde; zeitgleich heißt"
                    + " „innerhalb des jeweiligen 15-Minuten-Intervalls“. Gezählt wird streng ab 0 kWh; die Staffel"
                    + " zeigt nur, was bei einer Schwelle übrig bliebe.", "A1 S. 11; A1 S. 8, Abschn. 1 „Zeitgleichheit“"),
            new OffeneFrage("speichervorrang_ausschliesslichkeit", "Ob der Speichervorrang (§ 21 Abs. 4 S. 3 EnFG) auch"
                    + " für die Ausschließlichkeitsoption (§ 19 Abs. 3a EEG) gilt, ist eine Rechtsfrage (Rechtsanfrage"
                    + " W1). Die Zahl der Viertelstunden hängt davon nicht ab; die Menge (9) ist die Zuordnung nach"
                    + " Speichervorrang.", "A1 S. 11; A1 S. 14–15, Abschn. 2.1.5"),
            new OffeneFrage("rechtsfolge", "Nach der Beschreibung der BNetzA entfällt bei Netzstrom im Speicher die"
                    + " Förderfähigkeit der Netzeinspeisung aus dem (Mischstrom-)Speicher nach der"
                    + " Ausschließlichkeitsoption für das gesamte Kalenderjahr. Ob ein Netzbetreiber deshalb Förderung"
                    + " zurückfordern kann, klärt die Rechtsanfrage (W1 = D); bis dahin lädt der EEG-Modus weiter nach"
                    + " FK3.", "A1 S. 11"),
            new OffeneFrage("messwerte", "Gerätewerte der Box (Verdichtung telemetry_rollup_15m), keine mess- und"
                    + " eichrechtskonformen Viertelstundenwerte des Messstellenbetreibers: eine Einordnung, keine"
                    + " Bestimmung förder- oder umlagerelevanter Mengen.", "T S. 28; § 21 Abs. 4 S. 2 EnFG"));

    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record AnlagePruefung(Anlage anlage, int jahr, Instant stand, String werte, String lesart,
            Jahr ergebnisJahr, List<Monat> monate, List<OffeneFrage> offeneFragen) {}

    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record FlottenZeile(Anlage anlage, Jahr ergebnisJahr) {}

    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record FlottenPruefung(int jahr, Instant stand, String werte, String lesart, List<FlottenZeile> anlagen,
            List<OffeneFrage> offeneFragen) {}

    private final AusschliesslichkeitsPruefungRepository repo;

    public AusschliesslichkeitsPruefungService(AusschliesslichkeitsPruefungRepository repo) {
        this.repo = repo;
    }

    /** Eine Anlage, ein Kalenderjahr bis {@code stand}; leer, wenn es die Anlage nicht gibt. */
    public Optional<AnlagePruefung> anlage(UUID siteId, int jahr, Instant stand) {
        return repo.anlage(siteId).map(a -> {
            Ergebnis e = pruefe(a, jahr, stand);
            return new AnlagePruefung(a, jahr, stand, WERTE, LESART, e.jahr(), e.monate(), OFFENE_FRAGEN);
        });
    }

    /** Jede Anlage mit erfasstem Speicher, ein Kalenderjahr bis {@code stand}; je Anlage eine Abfrage. */
    public FlottenPruefung flotte(int jahr, Instant stand) {
        List<FlottenZeile> zeilen = repo.anlagenMitSpeicher().stream()
                .map(a -> new FlottenZeile(a, pruefe(a, jahr, stand).jahr())).toList();
        return new FlottenPruefung(jahr, stand, WERTE, LESART, zeilen, OFFENE_FRAGEN);
    }

    private Ergebnis pruefe(Anlage a, int jahr, Instant stand) {
        Instant von = AusschliesslichkeitsPruefer.jahresbeginn(jahr);
        Instant bis = AusschliesslichkeitsPruefer.jahresbeginn(jahr + 1);
        return AusschliesslichkeitsPruefer.pruefe(jahr, repo.viertelstunden(a.siteId(), von, bis), stand);
    }
}
