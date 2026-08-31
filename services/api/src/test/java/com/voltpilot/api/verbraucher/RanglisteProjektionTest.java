package com.voltpilot.api.verbraucher;

import static org.assertj.core.api.Assertions.assertThat;

import com.voltpilot.api.verbraucher.RanglisteProjektion.Eintrag;
import com.voltpilot.api.verbraucher.RanglisteProjektion.Kandidat;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;

/**
 * §5/§7.3: die Rangliste als Projektion auf die drei Halbordnungen, die die
 * Maschine kennt - und auf den Rang, den Paket P4 zurueckschreibt.
 */
class RanglisteProjektionTest {

    private static final UUID HEIZSTAB = UUID.fromString("00000000-0000-0000-0000-0000000000a1");
    private static final UUID PUMPE = UUID.fromString("00000000-0000-0000-0000-0000000000a2");
    private static final UUID WAERMEPUMPE = UUID.fromString("00000000-0000-0000-0000-0000000000a3");
    private static final UUID GARAGE = UUID.fromString("00000000-0000-0000-0000-0000000000b1");
    private static final UUID STELLPLATZ = UUID.fromString("00000000-0000-0000-0000-0000000000b2");
    private static final UUID CARPORT = UUID.fromString("00000000-0000-0000-0000-0000000000b3");

    /** Eine OCPP-Saeule: Ladepunkt OHNE {@code consumer_profile}. */
    private static Kandidat saeule(UUID id, String cpId) {
        return new Kandidat(RanglisteProjektion.ART_LADEPUNKT, id, cpId, null, null);
    }

    /** Eine go-e/Modbus-Wallbox: Ladepunkt MIT Profil, also rangierbar. */
    private static Kandidat wallbox(UUID id, String relation, Integer rang) {
        return new Kandidat(RanglisteProjektion.ART_LADEPUNKT, id, null, relation, rang);
    }

    private static Kandidat vb(UUID id, String relation) {
        return vb(id, relation, null);
    }

    private static Kandidat vb(UUID id, String relation, Integer rang) {
        return new Kandidat(RanglisteProjektion.ART_VERBRAUCHER, id, null, relation, rang);
    }

    private static List<String> ids(List<Eintrag> liste) {
        return liste.stream()
                .map(e -> e.entityId() == null
                        ? (RanglisteProjektion.ART_SPEICHER.equals(e.art())
                                ? RanglisteProjektion.ART_SPEICHER
                                : "gruppe" + e.mitglieder().size())
                        : e.entityId().toString())
                .toList();
    }

    @Test
    void vorgabeIstSpeicherZuerst_undJederLadepunktStehtDarunter() {
        List<Eintrag> out = RanglisteProjektion.liste(
                List.of(vb(HEIZSTAB, RanglisteProjektion.RELATION_CONSUMER_FIRST),
                        saeule(GARAGE, "cp-1"), saeule(STELLPLATZ, "cp-2")),
                true, RanglisteProjektion.STORAGE_VOR_AUTO, List.of("cp-1"));
        // Ein Verbraucher mit der Vorgabe der Spalte steht ueber dem Speicher;
        // die Vorrang-Saeule zaehlt bei „Speicher vor Auto" ausdruecklich NICHT,
        // also stehen beide Saeulen darunter - als EINE gleichrangige Zeile.
        assertThat(ids(out)).containsExactly(HEIZSTAB.toString(), "speicher", "gruppe2");
        assertThat(out.get(0).position()).isEqualTo(1);
        assertThat(out.get(2).mitglieder()).containsExactly(GARAGE, STELLPLATZ);
    }

    @Test
    void beiAutoVorSpeicherStehenNurDieVorrangSaeulenOben() {
        List<Eintrag> out = RanglisteProjektion.liste(
                List.of(vb(HEIZSTAB, RanglisteProjektion.RELATION_STORAGE_FIRST),
                        saeule(GARAGE, "cp-1"), saeule(STELLPLATZ, "cp-2")),
                true, RanglisteProjektion.AUTO_VOR_SPEICHER, List.of("cp-2"));
        assertThat(ids(out)).containsExactly(STELLPLATZ.toString(), "speicher", GARAGE.toString(),
                HEIZSTAB.toString());
    }

    @Test
    void gleichrangigeLadepunkteSindEineZeile_undDiePositionenZaehlenGeraete() {
        // Das Bild aus dem 1440-Mockup (Anmerkung 22): drei gleichrangige
        // Saeulen auf Platz 6 verbrauchen 6, 7 und 8 - die naechste Zeile steht
        // auf 9, damit „Position" dieselbe Zahl ist wie `default_service_rank`.
        List<Eintrag> out = RanglisteProjektion.liste(
                List.of(vb(HEIZSTAB, RanglisteProjektion.RELATION_CONSUMER_FIRST, 1),
                        vb(WAERMEPUMPE, RanglisteProjektion.RELATION_CONSUMER_FIRST, 2),
                        saeule(GARAGE, "cp-1"), saeule(STELLPLATZ, "cp-2"),
                        saeule(CARPORT, "cp-3"),
                        vb(PUMPE, RanglisteProjektion.RELATION_STORAGE_FIRST, 7)),
                true, null, List.of());
        assertThat(ids(out)).containsExactly(HEIZSTAB.toString(), WAERMEPUMPE.toString(),
                "speicher", "gruppe3", PUMPE.toString());
        assertThat(out.stream().map(Eintrag::position)).containsExactly(1, 2, 3, 4, 7);
        assertThat(out.get(3).mitglieder()).containsExactly(GARAGE, STELLPLATZ, CARPORT);
        assertThat(out.get(3).entityId()).as("eine Gruppe hat keine eigene Kennung").isNull();
    }

    @Test
    void eineEinzelneSaeuleIstKeineGruppe_sieTraegtIhreEigeneKennung() {
        List<Eintrag> out = RanglisteProjektion.liste(List.of(saeule(GARAGE, "cp-1")), true, null,
                List.of());
        assertThat(out.get(1).entityId()).isEqualTo(GARAGE);
        assertThat(out.get(1).mitglieder()).containsExactly(GARAGE);
    }

    @Test
    void derGespeicherteRangOrdnetInnerhalbSeinerHaelfte() {
        List<Eintrag> out = RanglisteProjektion.liste(
                List.of(vb(HEIZSTAB, RanglisteProjektion.RELATION_CONSUMER_FIRST, 3),
                        vb(WAERMEPUMPE, RanglisteProjektion.RELATION_CONSUMER_FIRST, 1),
                        vb(PUMPE, RanglisteProjektion.RELATION_CONSUMER_FIRST, 2)),
                false, null, List.of());
        assertThat(ids(out)).containsExactly(WAERMEPUMPE.toString(), PUMPE.toString(),
                HEIZSTAB.toString());
    }

    @Test
    void einVerbraucherOhneGepflegtenRangStehtUnten_undDieOrdnungBleibtStabil() {
        // Captain-Entscheid E3: neue Verbraucher unten. Untereinander behalten
        // sie die Reihenfolge ihrer Anlage-Erstellung (stabile Sortierung).
        List<Eintrag> out = RanglisteProjektion.liste(
                List.of(vb(HEIZSTAB, RanglisteProjektion.RELATION_CONSUMER_FIRST, null),
                        vb(WAERMEPUMPE, RanglisteProjektion.RELATION_CONSUMER_FIRST, 5),
                        vb(PUMPE, RanglisteProjektion.RELATION_CONSUMER_FIRST, null)),
                false, null, List.of());
        assertThat(ids(out)).containsExactly(WAERMEPUMPE.toString(), HEIZSTAB.toString(),
                PUMPE.toString());
    }

    @Test
    void eineGoeWallboxWirdWieEinVerbraucherPlatziert_dennSieHatEinProfil() {
        // ⚠ Fuer den Kunden ist sie ein „Ladepunkt", fuer die Maschine ein
        // Verbraucher: ihr `storage_relation` ist der Epsilon des
        // Co-Optimierers, und sie kennt die Quellen-Bahn des Ladeparks nicht
        // (Paket P6). Sie folgt deshalb ihrem Profil, nicht der Saeulen-Regel.
        List<Eintrag> out = RanglisteProjektion.liste(
                List.of(wallbox(GARAGE, RanglisteProjektion.RELATION_CONSUMER_FIRST, 1),
                        saeule(STELLPLATZ, "cp-2")),
                true, RanglisteProjektion.AUTO_VOR_SPEICHER, List.of("cp-2"));
        assertThat(ids(out)).containsExactly(GARAGE.toString(), STELLPLATZ.toString(), "speicher");
        assertThat(out.get(0).art()).isEqualTo(RanglisteProjektion.ART_LADEPUNKT);
    }

    @Test
    void ohneSpeicherGibtEsKeinenSpeicherEintrag() {
        List<Eintrag> out = RanglisteProjektion.liste(
                List.of(vb(PUMPE, RanglisteProjektion.RELATION_CONSUMER_FIRST),
                        saeule(GARAGE, "cp-1")),
                false, null, List.of());
        assertThat(ids(out)).containsExactly(PUMPE.toString(), GARAGE.toString());
        assertThat(out).noneMatch(e -> RanglisteProjektion.ART_SPEICHER.equals(e.art()));
    }

    @Test
    void eineLeereAnlageErgibtEineLeereListe_nichtEinenNacktenSpeicher() {
        assertThat(RanglisteProjektion.liste(List.of(), false, null, null)).isEmpty();
        // Ein Speicher ohne einen einzigen Verbraucher steht trotzdem drin - er
        // IST ein Eintrag der Liste (Captain-Entscheid E3).
        assertThat(RanglisteProjektion.liste(List.of(), true, null, null)).containsExactly(
                new Eintrag(1, RanglisteProjektion.ART_SPEICHER, null, List.of()));
    }

    @Test
    void eineVorrangKennung_dieKeineSaeuleTrifft_verschiebtNichts() {
        List<Eintrag> out = RanglisteProjektion.liste(List.of(saeule(GARAGE, "cp-1")), true,
                RanglisteProjektion.AUTO_VOR_SPEICHER, List.of("cp-gibt-es-nicht"));
        assertThat(ids(out)).containsExactly("speicher", GARAGE.toString());
    }
}
