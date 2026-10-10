package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.voltpilot.api.uems.StandortLesemodell.Zeilen;
import java.io.IOException;
import java.time.LocalDate;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.junit.jupiter.api.Test;

/**
 * Das Ziel-Menü „Verschieben“ je Knoten (UEMS AP-02 IP-12, V1/V2) — rein, auf dem Szenario Ahrenberg der
 * Vektor-Datei am 20.02.2027 (Werk Ahrenberg Nord ist an dem Tag angelegt): der bisherige Elternknoten steht nie
 * zur Wahl, ein Bereich ist nie ein Ziel, ein Gebäude zieht nur zu einem Standort, und ein archivierter Knoten hat
 * kein Verschieben.
 */
class OrtAktionenVerschiebenTest {

    private static final LocalDate TAG = LocalDate.of(2027, 2, 20);

    @Test
    void einGebaeudeZiehtNurZuEinemAnderenStandort() throws IOException {
        OrtAktionen.Verschieben v = aktionen().imBaum(ort("G-2")).verschieben();
        assertThat(v.erlaubt()).isTrue();
        assertThat(v.text()).isNull();
        assertThat(v.ziele()).extracting(OrtAktionen.Ziel::art).containsOnly("standort");
        assertThat(v.ziele()).extracting(OrtAktionen.Ziel::id)
                .contains(StandortLesemodellTest.id("ST-3"))
                .doesNotContain(StandortLesemodellTest.id("ST-1"));
    }

    @Test
    void einBereichZiehtZuGebaeudenUndStandortenNieInEinenBereichUndNieZumBisherigen() throws IOException {
        OrtAktionen.Verschieben v = aktionen().imBaum(ort("B-5")).verschieben();
        assertThat(v.erlaubt()).isTrue();
        assertThat(v.ziele()).extracting(OrtAktionen.Ziel::art).containsOnly("standort", "gebaeude");
        List<UUID> ids = v.ziele().stream().map(OrtAktionen.Ziel::id).toList();
        assertThat(ids).contains(StandortLesemodellTest.id("ST-1"), StandortLesemodellTest.id("G-1"))
                .doesNotContain(StandortLesemodellTest.id("G-2"), StandortLesemodellTest.id("B-3"));
        // Standorte zuerst, dann Gebäude mit ihrem Standort.
        int ersterBau = v.ziele().stream().map(OrtAktionen.Ziel::art).toList().indexOf("gebaeude");
        assertThat(v.ziele().subList(0, ersterBau)).extracting(OrtAktionen.Ziel::art).containsOnly("standort");
        assertThat(v.ziele().subList(ersterBau, v.ziele().size())).allSatisfy(z -> assertThat(z.standortName()).isNotBlank());
    }

    @Test
    void derStandortUndEinArchivierterKnotenHabenKeinVerschieben() throws IOException {
        OrtAktionen a = aktionen();
        assertThat(a.standort("ST-1").verschieben()).isNull();
        assertThat(a.archiviert(ort("B-5")).verschieben()).isNull();
    }

    private static Zeilen zeilen() throws IOException {
        return StandortLesemodellTest.zeilen(StandortLesemodellTest.szenario("ahrenberg"), Map.of());
    }

    private static OrtAktionen aktionen() throws IOException {
        return new OrtAktionen(StandortService.baum(zeilen(), List.of()), TAG, Set.of());
    }

    private static OrtRepository.Ort ort(String kurzzeichen) throws IOException {
        return zeilen().orte().stream().filter(o -> o.kurzzeichen().equals(kurzzeichen)).findFirst().orElseThrow();
    }
}
