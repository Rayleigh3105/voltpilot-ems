package com.voltpilot.api.command;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.voltpilot.api.history.HistoryRange;
import java.time.LocalDate;
import java.util.Set;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/**
 * Die REINEN Regeln der Befehls-Suche (Geräteseiten Revision B §6) - ohne
 * Docker, ohne Spring, ohne Uhr aus dem Nichts.
 *
 * <p>Geprüft wird genau das, was eine Fläche nicht selbst entscheiden darf:
 * welches Wort gilt, wie weit ein Fenster reichen darf und welcher Speicher bei
 * einer Filter-Kombination überhaupt noch gefragt werden muss.
 */
class CommandFilterTest {

    private static final LocalDate HEUTE = LocalDate.of(2026, 8, 21);

    @Test
    @DisplayName("Ein leerer Filter zeigt alles - und fragt beide Speicher")
    void leererFilter() {
        CommandFilter.Filter f = CommandFilter.parse(null, null, null);
        assertThat(f.isEmpty()).isTrue();
        assertThat(f.includesLog()).isTrue();
        assertThat(f.includesRegister()).isTrue();
        assertThat(CommandFilter.Filter.NONE.isEmpty()).isTrue();
    }

    @Test
    @DisplayName("Komma-Liste, Leerraum und Gross-/Kleinschreibung sind egal")
    void toleranteEingabe() {
        CommandFilter.Filter f = CommandFilter.parse(" Batterie , REGISTER ", "portal",
                "abweichend");
        assertThat(f.streams()).containsExactlyInAnyOrder("batterie", "register");
        assertThat(f.sources()).containsExactly("portal");
        assertThat(f.results()).containsExactly("abweichend");
    }

    /**
     * ⚠ Ein unbekanntes Wort wird BENANNT abgelehnt, nie still verworfen: ein
     * ignorierter Filter zeigte MEHR Zeilen als verlangt und läse sich als „es
     * gibt keine weiteren" - die gefährlichere der beiden Auskünfte.
     */
    @Test
    @DisplayName("Ein unbekanntes Wort ist eine Ablehnung, die das Vokabular NENNT")
    void unbekanntesWortWirdAbgelehnt() {
        assertThatThrownBy(() -> CommandFilter.parse("speicher", null, null))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("Befehlsart")
                .hasMessageContaining("speicher")
                .hasMessageContaining("batterie");
        assertThatThrownBy(() -> CommandFilter.parse(null, "irgendwo", null))
                .hasMessageContaining("Herkunft");
        assertThatThrownBy(() -> CommandFilter.parse(null, null, "gruen"))
                .hasMessageContaining("Ergebnis");
    }

    @Test
    @DisplayName("Nur `register` gewählt: der Halteperioden-Speicher wird gar nicht gefragt")
    void nurRegister() {
        CommandFilter.Filter f = CommandFilter.parse("register", null, null);
        assertThat(f.includesRegister()).isTrue();
        assertThat(f.includesLog()).isFalse();
        assertThat(f.logStreams()).isEmpty();
    }

    @Test
    @DisplayName("Ohne `register` gewählt: der Journal-Speicher wird gar nicht gefragt")
    void ohneRegister() {
        CommandFilter.Filter f = CommandFilter.parse("batterie,abregelung", null, null);
        assertThat(f.includesLog()).isTrue();
        assertThat(f.includesRegister()).isFalse();
        assertThat(f.logStreams()).containsExactlyInAnyOrder("batterie", "abregelung");
    }

    /**
     * Die zwei Ergebnis-Vokabulare beantworten verschiedene Fragen („hält das
     * Gerät den Befehl" gegen „ist der eine Schreibvorgang angekommen"), also
     * schliesst ein Filter aus dem einen den anderen Speicher aus.
     */
    @Test
    @DisplayName("Ein Halteperioden-Ergebnis kann keine Register-Zeile treffen - und umgekehrt")
    void ergebnisVokabulareTrennenDieSpeicher() {
        CommandFilter.Filter nurUrteil = CommandFilter.parse(null, null, "abweichend,notaus");
        assertThat(nurUrteil.includesLog()).isTrue();
        assertThat(nurUrteil.includesRegister()).isFalse();
        assertThat(nurUrteil.logResults()).containsExactlyInAnyOrder("abweichend", "notaus");
        assertThat(nurUrteil.registerResults()).isEmpty();

        CommandFilter.Filter nurAusgang = CommandFilter.parse(null, null, "keine_quittung");
        assertThat(nurAusgang.includesLog()).isFalse();
        assertThat(nurAusgang.includesRegister()).isTrue();
        assertThat(nurAusgang.registerResults()).containsExactly("keine_quittung");
    }

    @Test
    @DisplayName("`fremdeinfluss` und `notaus` sind KEINE Rücklese-Urteile")
    void fremdeinflussUndNotausSindEigeneWoerter() {
        assertThat(CommandFilter.VERDICT_WORDS)
                .doesNotContain(CommandFilter.RESULT_FREMDEINFLUSS, CommandFilter.RESULT_NOTAUS);
        assertThat(CommandFilter.LOG_RESULTS)
                .contains(CommandFilter.RESULT_FREMDEINFLUSS, CommandFilter.RESULT_NOTAUS);
        assertThat(CommandFilter.VERDICT_WORDS).hasSize(5);
    }

    @Test
    @DisplayName("Der Zeitraum: Tag, Woche und Monat - ein Jahr überschreitet die Aufbewahrung")
    void zeitraeume() {
        assertThat(CommandFilter.RANGES).containsExactlyInAnyOrder(HistoryRange.DAY,
                HistoryRange.WEEK, HistoryRange.MONTH);
        assertThat(CommandFilter.RANGES).doesNotContain(HistoryRange.YEAR);
    }

    @Test
    @DisplayName("Ein eigener Zeitraum schliesst den BIS-Tag ein")
    void eigenerZeitraumSchliesstDenBisTagEin() {
        HistoryRange.Window w = CommandFilter.window(HistoryRange.DAY, null,
                LocalDate.of(2026, 8, 10), LocalDate.of(2026, 8, 12), HEUTE);
        assertThat(w.from()).isEqualTo(LocalDate.of(2026, 8, 10)
                .atStartOfDay(HistoryRange.ZONE).toInstant());
        // Der 12. gehört DAZU - ein Fenster, das um 00:00 des Bis-Tages endete,
        // liesse den ganzen gewählten Tag aussen vor.
        assertThat(w.to()).isEqualTo(LocalDate.of(2026, 8, 13)
                .atStartOfDay(HistoryRange.ZONE).toInstant());
    }

    @Test
    @DisplayName("Ein halber eigener Zeitraum und ein verdrehter werden abgelehnt")
    void unvollstaendigerZeitraum() {
        assertThatThrownBy(() -> CommandFilter.window(HistoryRange.DAY, null,
                LocalDate.of(2026, 8, 10), null, HEUTE))
                .hasMessageContaining("Anfang und Ende");
        assertThatThrownBy(() -> CommandFilter.window(HistoryRange.DAY, null,
                LocalDate.of(2026, 8, 12), LocalDate.of(2026, 8, 10), HEUTE))
                .hasMessageContaining("Ende liegt vor dem Anfang");
    }

    /**
     * ⚠ Die Grenze ist die Aufbewahrung selbst. Ein Fenster davor fände nichts
     * und läse sich als „damals wurde nichts geschickt" - eine entlastende
     * Aussage über eine Zeit, die gelöscht ist.
     */
    @Test
    @DisplayName("Weiter zurück als die Aufbewahrung wird ABGELEHNT, nie still gekappt")
    void aufbewahrungIstDieGrenze() {
        assertThat(CommandFilter.MAX_DAYS_BACK).isEqualTo(90);
        LocalDate gerade = HEUTE.minusDays(89);
        assertThat(CommandFilter.window(HistoryRange.DAY, gerade, null, null, HEUTE)).isNotNull();
        assertThatThrownBy(() -> CommandFilter.window(HistoryRange.DAY, HEUTE.minusDays(91), null,
                null, HEUTE)).hasMessageContaining("90 Tage");
        assertThatThrownBy(() -> CommandFilter.window(HistoryRange.DAY, null,
                HEUTE.minusDays(120), HEUTE, HEUTE)).hasMessageContaining("90 Tage");
    }

    @Test
    @DisplayName("Der Deckel: Vorgabe, Obergrenze und eine benannte Ablehnung")
    void deckel() {
        assertThat(CommandFilter.limit(null)).isEqualTo(CommandFilter.DEFAULT_LIMIT);
        assertThat(CommandFilter.limit(42)).isEqualTo(42);
        assertThatThrownBy(() -> CommandFilter.limit(0)).hasMessageContaining("1 und");
        assertThatThrownBy(() -> CommandFilter.limit(CommandFilter.MAX_LIMIT + 1))
                .hasMessageContaining(String.valueOf(CommandFilter.MAX_LIMIT));
    }

    @Test
    @DisplayName("Der Cursor bleibt im Fenster und ist ohne Angabe sein Ende")
    void cursor() {
        var ende = LocalDate.of(2026, 8, 21).atStartOfDay(HistoryRange.ZONE).toInstant();
        assertThat(CommandFilter.before(null, ende)).isEqualTo(ende);
        assertThat(CommandFilter.before(ende.plusSeconds(3600), ende)).isEqualTo(ende);
        assertThat(CommandFilter.before(ende.minusSeconds(60), ende))
                .isEqualTo(ende.minusSeconds(60));
    }

    @Test
    @DisplayName("Das Vokabular deckt genau die Wörter ab, die eine Zeile je trägt")
    void vokabular() {
        assertThat(CommandFilter.STREAMS).containsExactlyInAnyOrder("batterie", "abregelung",
                "verbraucher", "ladepunkt", "register");
        assertThat(CommandFilter.SOURCES).containsExactlyInAnyOrder("cloud_abgeleitet", "geraet",
                "portal");
        assertThat(CommandFilter.RESULTS).containsAll(Set.of("bestaetigt", "abweichend",
                "keine_antwort", "prueft", "unbestaetigt", "fremdeinfluss", "notaus",
                "uebernommen", "nicht_uebernommen", "keine_quittung"));
    }
}
