package com.voltpilot.api.verbraucher;

import static org.assertj.core.api.Assertions.assertThat;

import com.voltpilot.api.verbraucher.RanglisteProjektion.Eintrag;
import com.voltpilot.api.verbraucher.RanglisteProjektion.Kandidat;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;

/** §7.3: die initiale Rangliste - die Vereinigung dreier Halbordnungen. */
class RanglisteProjektionTest {

    private static final UUID HEIZSTAB = UUID.fromString("00000000-0000-0000-0000-0000000000a1");
    private static final UUID PUMPE = UUID.fromString("00000000-0000-0000-0000-0000000000a2");
    private static final UUID GARAGE = UUID.fromString("00000000-0000-0000-0000-0000000000b1");
    private static final UUID STELLPLATZ = UUID.fromString("00000000-0000-0000-0000-0000000000b2");

    private static Kandidat lp(UUID id, String cpId) {
        return new Kandidat(RanglisteProjektion.ART_LADEPUNKT, id, cpId, null);
    }

    private static Kandidat vb(UUID id, String relation) {
        return new Kandidat(RanglisteProjektion.ART_VERBRAUCHER, id, null, relation);
    }

    private static List<String> ids(List<Eintrag> liste) {
        return liste.stream()
                .map(e -> e.entityId() == null ? RanglisteProjektion.ART_SPEICHER
                        : e.entityId().toString())
                .toList();
    }

    @Test
    void vorgabeIstSpeicherZuerst_undJederLadepunktStehtDarunter() {
        List<Eintrag> out = RanglisteProjektion.initial(
                List.of(vb(HEIZSTAB, null), lp(GARAGE, "cp-1"), lp(STELLPLATZ, "cp-2")), true,
                RanglisteProjektion.STORAGE_VOR_AUTO, List.of("cp-1"));
        // Ein Verbraucher OHNE gepflegte Beziehung gilt als consumer_first (die
        // Vorgabe der Spalte), also steht er ueber dem Speicher; die Vorrang-
        // Saeule zaehlt bei „Speicher vor Auto" ausdruecklich NICHT.
        assertThat(ids(out)).containsExactly(HEIZSTAB.toString(), "speicher", GARAGE.toString(),
                STELLPLATZ.toString());
        assertThat(out.get(0).position()).isEqualTo(1);
        assertThat(out.get(3).position()).isEqualTo(4);
    }

    @Test
    void beiAutoVorSpeicherStehenNurDieVorrangSaeulenOben_inIhrerReihenfolge() {
        List<Eintrag> out = RanglisteProjektion.initial(
                List.of(vb(HEIZSTAB, "storage_first"), lp(GARAGE, "cp-1"), lp(STELLPLATZ, "cp-2")),
                true, RanglisteProjektion.AUTO_VOR_SPEICHER, List.of("cp-2", "cp-1"));
        assertThat(ids(out)).containsExactly(STELLPLATZ.toString(), GARAGE.toString(), "speicher",
                HEIZSTAB.toString());
    }

    @Test
    void ohneSpeicherGibtEsKeinenSpeicherEintrag() {
        List<Eintrag> out = RanglisteProjektion.initial(List.of(vb(PUMPE, null), lp(GARAGE, "cp-1")),
                false, null, List.of());
        assertThat(ids(out)).containsExactly(PUMPE.toString(), GARAGE.toString());
        assertThat(out).noneMatch(e -> RanglisteProjektion.ART_SPEICHER.equals(e.art()));
    }

    @Test
    void eineLeereAnlageErgibtEineLeereListe_nichtEinenNacktenSpeicher() {
        assertThat(RanglisteProjektion.initial(List.of(), false, null, null)).isEmpty();
        // Ein Speicher ohne einen einzigen Verbraucher steht trotzdem drin - er
        // IST ein Eintrag der Liste (Captain-Entscheid E3).
        assertThat(RanglisteProjektion.initial(List.of(), true, null, null))
                .containsExactly(new Eintrag(1, RanglisteProjektion.ART_SPEICHER, null));
    }

    @Test
    void eineVorrangKennung_dieKeineSaeuleTrifft_verschiebtNichts() {
        List<Eintrag> out = RanglisteProjektion.initial(List.of(lp(GARAGE, "cp-1")), true,
                RanglisteProjektion.AUTO_VOR_SPEICHER, List.of("cp-gibt-es-nicht"));
        assertThat(ids(out)).containsExactly("speicher", GARAGE.toString());
    }

    @Test
    void einLadepunktOhneOcppKennung_zBeineGoeWallbox_stehtBeiDenUebrigen() {
        List<Eintrag> out = RanglisteProjektion.initial(
                List.of(lp(GARAGE, null), lp(STELLPLATZ, "cp-2")), true,
                RanglisteProjektion.AUTO_VOR_SPEICHER, List.of("cp-2"));
        assertThat(ids(out)).containsExactly(STELLPLATZ.toString(), "speicher", GARAGE.toString());
    }

    @Test
    void diePositionenSindLueckenlosUndBeginnenBei1() {
        List<Eintrag> out = RanglisteProjektion.initial(
                List.of(vb(HEIZSTAB, null), vb(PUMPE, "storage_first"), lp(GARAGE, "cp-1")), true,
                null, List.of());
        assertThat(out.stream().map(Eintrag::position)).containsExactly(1, 2, 3, 4);
    }
}
