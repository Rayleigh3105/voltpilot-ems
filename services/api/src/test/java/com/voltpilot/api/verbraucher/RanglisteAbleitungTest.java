package com.voltpilot.api.verbraucher;

import static org.assertj.core.api.Assertions.assertThat;

import com.voltpilot.api.verbraucher.RanglisteAbleitung.Ableitung;
import com.voltpilot.api.verbraucher.RanglisteAbleitung.Wunsch;
import com.voltpilot.api.verbraucher.RanglisteProjektion.Eintrag;
import com.voltpilot.api.verbraucher.RanglisteProjektion.Kandidat;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;

/**
 * §5: der SCHREIBWEG der Rangliste - und vor allem sein RUNDLAUF gegen
 * {@link RanglisteProjektion}. Beides ist rein, also braucht der Beweis weder
 * Docker noch Spring.
 */
class RanglisteAbleitungTest {

    private static final UUID HEIZSTAB = UUID.fromString("00000000-0000-0000-0000-0000000000a1");
    private static final UUID PUMPE = UUID.fromString("00000000-0000-0000-0000-0000000000a2");
    private static final UUID WAERMEPUMPE = UUID.fromString("00000000-0000-0000-0000-0000000000a3");
    private static final UUID GARAGE = UUID.fromString("00000000-0000-0000-0000-0000000000b1");
    private static final UUID STELLPLATZ = UUID.fromString("00000000-0000-0000-0000-0000000000b2");

    private static Kandidat saeule(UUID id, String cpId) {
        return new Kandidat(RanglisteProjektion.ART_LADEPUNKT, id, cpId, null, null);
    }

    private static Kandidat vb(UUID id) {
        return vb(id, RanglisteProjektion.RELATION_CONSUMER_FIRST, null);
    }

    private static Kandidat vb(UUID id, String relation, Integer rang) {
        return new Kandidat(RanglisteProjektion.ART_VERBRAUCHER, id, null, relation, rang);
    }

    private static Wunsch w(UUID id) {
        return new Wunsch(RanglisteProjektion.ART_VERBRAUCHER, id);
    }

    private static Wunsch lp(UUID id) {
        return new Wunsch(RanglisteProjektion.ART_LADEPUNKT, id);
    }

    private static final Wunsch SPEICHER = new Wunsch(RanglisteProjektion.ART_SPEICHER, null);

    /** Die Kandidaten, wie sie NACH dem Speichern aussehen. */
    private static List<Kandidat> nachher(List<Kandidat> vorher, Ableitung ab) {
        List<Kandidat> out = new ArrayList<>();
        for (Kandidat k : vorher) {
            if (!k.rankbar()) {
                out.add(k);
                continue;
            }
            out.add(new Kandidat(k.art(), k.entityId(), k.chargePointId(),
                    ab.storageRelation().getOrDefault(k.entityId(), k.storageRelation()),
                    ab.rang().getOrDefault(k.entityId(), k.rang())));
        }
        return out;
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

    // --- die drei Ableitungen -----------------------------------------------

    @Test
    void diePositionWirdDerServiceRank_undDieSeiteDesSpeichersDieRelation() {
        List<Kandidat> k = List.of(vb(HEIZSTAB), vb(PUMPE), vb(WAERMEPUMPE));
        Ableitung ab = RanglisteAbleitung.ableiten(
                List.of(w(WAERMEPUMPE), SPEICHER, w(PUMPE), w(HEIZSTAB)), k, true);
        // Der Speicher verbraucht Platz 2, also stehen die zwei unter ihm auf 3
        // und 4 - die Position zaehlt Geraete, nicht Verbraucher-Zeilen.
        assertThat(ab.rang()).containsEntry(WAERMEPUMPE, 1).containsEntry(PUMPE, 3)
                .containsEntry(HEIZSTAB, 4);
        assertThat(ab.storageRelation())
                .containsEntry(WAERMEPUMPE, RanglisteProjektion.RELATION_CONSUMER_FIRST)
                .containsEntry(PUMPE, RanglisteProjektion.RELATION_STORAGE_FIRST)
                .containsEntry(HEIZSTAB, RanglisteProjektion.RELATION_STORAGE_FIRST);
    }

    @Test
    void eineSaeuleUeberDemSpeicherSetztAutoVorSpeicher_undIstDieVorrangMenge() {
        List<Kandidat> k = List.of(vb(HEIZSTAB), saeule(GARAGE, "cp-1"), saeule(STELLPLATZ, "cp-2"));
        Ableitung ab = RanglisteAbleitung.ableiten(
                List.of(lp(GARAGE), SPEICHER, w(HEIZSTAB), lp(STELLPLATZ)), k, true);
        assertThat(ab.storagePriority()).isEqualTo(RanglisteProjektion.AUTO_VOR_SPEICHER);
        assertThat(ab.vorrangKennungen()).containsExactly("cp-1");
    }

    @Test
    void stehtKeineSaeuleOben_bleibtDieVorrangMengeUNANGETASTET() {
        // ⚠ Die Projektion liest die Menge dann gar nicht (alle Saeulen stehen
        // unten). Sie zu leeren naehme dem Kunden nur seine Vorrang-Wahl aus der
        // Ladepark-Kapsel, ohne dass die Liste etwas darueber gesagt haette.
        List<Kandidat> k = List.of(saeule(GARAGE, "cp-1"), saeule(STELLPLATZ, "cp-2"));
        Ableitung ab = RanglisteAbleitung.ableiten(
                List.of(SPEICHER, lp(GARAGE), lp(STELLPLATZ)), k, true);
        assertThat(ab.storagePriority()).isEqualTo(RanglisteProjektion.STORAGE_VOR_AUTO);
        assertThat(ab.vorrangKennungen()).isNull();
    }

    @Test
    void ohneSpeicherWirdZurSpeicherFrageNichtsGesagt_auchMitSaeulen() {
        // ⚠ Ohne Speicher steht jede Saeule zwangslaeufig „oben" - das als
        // `auto_vor_speicher` zu speichern waere eine Antwort auf eine Frage,
        // die niemand gestellt hat, und ueberschriebe die Vorrang-Wahl der
        // Ladepark-Kapsel.
        Ableitung ab = RanglisteAbleitung.ableiten(List.of(lp(GARAGE), lp(STELLPLATZ)),
                List.of(saeule(GARAGE, "cp-1"), saeule(STELLPLATZ, "cp-2")), false);
        assertThat(ab.storagePriority()).isNull();
        assertThat(ab.vorrangKennungen()).isNull();
    }

    @Test
    void ohneEineEinzigeSaeuleWirdZurSpeicherFrageNichtsGesagt() {
        Ableitung ab = RanglisteAbleitung.ableiten(List.of(SPEICHER, w(HEIZSTAB)),
                List.of(vb(HEIZSTAB)), true);
        assertThat(ab.storagePriority()).isNull();
        assertThat(ab.vorrangKennungen()).isNull();
    }

    @Test
    void eineGoeWallboxBekommtIhreRelation_nichtDieSpeicherFrageDesLadeparks() {
        // Sie hat ein Profil, faehrt also den Co-Optimierer-Epsilon; die
        // anlagenweite Speicher-Frage gehoert der OCPP-Quellenbahn (Paket P6).
        Kandidat wallbox = new Kandidat(RanglisteProjektion.ART_LADEPUNKT, GARAGE, null,
                RanglisteProjektion.RELATION_STORAGE_FIRST, null);
        Ableitung ab = RanglisteAbleitung.ableiten(List.of(lp(GARAGE), SPEICHER),
                List.of(wallbox), true);
        assertThat(ab.storageRelation())
                .containsEntry(GARAGE, RanglisteProjektion.RELATION_CONSUMER_FIRST);
        assertThat(ab.storagePriority()).as("eine go-e ist keine OCPP-Saeule").isNull();
    }

    @Test
    void einNichtGenanntesGeraetLandetUnten_stattInEinerAblehnung() {
        // Zwischen Lesen und Speichern kann eine Saeule dazugekommen sein - ein
        // Rennen darf keine Bedienung kosten (Captain-Entscheid E3).
        List<Kandidat> k = List.of(vb(HEIZSTAB), vb(PUMPE));
        Ableitung ab = RanglisteAbleitung.ableiten(List.of(w(HEIZSTAB), SPEICHER), k, true);
        assertThat(ab.storageRelation())
                .containsEntry(HEIZSTAB, RanglisteProjektion.RELATION_CONSUMER_FIRST)
                .containsEntry(PUMPE, RanglisteProjektion.RELATION_STORAGE_FIRST);
    }

    @Test
    void ohneSpeicherGibtEsKeinUntenMehr_jederIstConsumerFirst() {
        // Auch das NICHT genannte Geraet: ein `storage_first` waere eine Aussage
        // ueber einen Speicher, den es nicht gibt - und stuende still im Weg,
        // sobald einer dazukommt.
        Ableitung ab = RanglisteAbleitung.ableiten(List.of(w(HEIZSTAB), SPEICHER),
                List.of(vb(HEIZSTAB), vb(PUMPE), vb(WAERMEPUMPE)), false);
        assertThat(ab.storageRelation()).containsOnly(
                org.assertj.core.api.Assertions.entry(HEIZSTAB,
                        RanglisteProjektion.RELATION_CONSUMER_FIRST),
                org.assertj.core.api.Assertions.entry(PUMPE,
                        RanglisteProjektion.RELATION_CONSUMER_FIRST),
                org.assertj.core.api.Assertions.entry(WAERMEPUMPE,
                        RanglisteProjektion.RELATION_CONSUMER_FIRST));
    }

    // --- der Rundlauf --------------------------------------------------------

    @Test
    void derRundlaufIstExakt_gelesenGespeichertWiederGelesen() {
        List<Kandidat> k = List.of(vb(HEIZSTAB), vb(PUMPE), saeule(GARAGE, "cp-1"),
                saeule(STELLPLATZ, "cp-2"));
        // Der Kunde zieht: Saeulen nach oben, Pumpe unter den Speicher.
        List<Wunsch> wunsch = List.of(lp(GARAGE), lp(STELLPLATZ), w(HEIZSTAB), SPEICHER, w(PUMPE));
        Ableitung ab = RanglisteAbleitung.ableiten(wunsch, k, true);
        List<Eintrag> gelesen = RanglisteProjektion.liste(nachher(k, ab), true,
                ab.storagePriority(), ab.vorrangKennungen());
        // Die Normalform: rankbare oben, dann die Saeulen-Gruppe, dann der
        // Speicher, dann die rankbaren darunter.
        assertThat(ids(gelesen)).containsExactly(HEIZSTAB.toString(), "gruppe2", "speicher",
                PUMPE.toString());
    }

    @Test
    void einZweitesSpeichernDerNormalformAendertNICHTS() {
        List<Kandidat> k = List.of(vb(HEIZSTAB), vb(PUMPE), saeule(GARAGE, "cp-1"),
                saeule(STELLPLATZ, "cp-2"));
        List<Wunsch> wunsch = List.of(w(HEIZSTAB), lp(GARAGE), lp(STELLPLATZ), SPEICHER, w(PUMPE));
        Ableitung erst = RanglisteAbleitung.ableiten(wunsch, k, true);
        Ableitung zweit = RanglisteAbleitung.ableiten(wunsch, nachher(k, erst), true);
        assertThat(zweit.rang()).isEqualTo(erst.rang());
        assertThat(zweit.storageRelation()).isEqualTo(erst.storageRelation());
        assertThat(zweit.storagePriority()).isEqualTo(erst.storagePriority());
        assertThat(zweit.vorrangKennungen()).isEqualTo(erst.vorrangKennungen());
    }

    // --- Ablehnungen ---------------------------------------------------------

    @Test
    void eineLeereReihenfolgeWirdAbgelehnt() {
        assertThat(RanglisteAbleitung.pruefe(List.of(), List.of(vb(HEIZSTAB)), false))
                .containsExactly("Die Reihenfolge darf nicht leer sein.");
        assertThat(RanglisteAbleitung.pruefe(null, List.of(), false)).hasSize(1);
    }

    @Test
    void einFremdesGeraetWirdBenannt() {
        assertThat(RanglisteAbleitung.pruefe(List.of(w(PUMPE)), List.of(vb(HEIZSTAB)), false))
                .singleElement().asString().contains("gehört nicht zu dieser Anlage");
    }

    @Test
    void einDoppeltesGeraetWirdBenannt() {
        assertThat(RanglisteAbleitung.pruefe(List.of(w(HEIZSTAB), w(HEIZSTAB)),
                List.of(vb(HEIZSTAB)), false)).singleElement().asString()
                        .contains("steht mehrfach in der Reihenfolge");
    }

    @Test
    void eineUnbekannteArtWirdBenannt() {
        assertThat(RanglisteAbleitung.pruefe(List.of(new Wunsch("solarmodul", HEIZSTAB)),
                List.of(vb(HEIZSTAB)), false)).singleElement().asString()
                        .contains("Unbekannte Art");
    }

    @Test
    void ohneSpeicherPlatzGibtEsKeinObenUndUnten_alsoWirdAbgelehnt() {
        assertThat(RanglisteAbleitung.pruefe(List.of(w(HEIZSTAB)), List.of(vb(HEIZSTAB)), true))
                .singleElement().asString().contains("muss den Speicher enthalten");
        // ... und ohne Speicher an der Anlage ist genau das in Ordnung.
        assertThat(RanglisteAbleitung.pruefe(List.of(w(HEIZSTAB)), List.of(vb(HEIZSTAB)), false))
                .isEmpty();
    }

    @Test
    void derSpeicherStehtHoechstensEinmalDrin() {
        assertThat(RanglisteAbleitung.pruefe(List.of(SPEICHER, w(HEIZSTAB), SPEICHER),
                List.of(vb(HEIZSTAB)), true)).singleElement().asString()
                        .contains("Speicher steht mehrfach");
    }

    @Test
    void einGeraetOhneKennungWirdBenannt() {
        assertThat(RanglisteAbleitung.pruefe(
                List.of(new Wunsch(RanglisteProjektion.ART_VERBRAUCHER, null)),
                List.of(vb(HEIZSTAB)), false)).singleElement().asString()
                        .contains("braucht seine Kennung");
    }

    // --- was die Rangliste NICHT anfasst -------------------------------------

    @Test
    void diePflichtenBleibenUnberuehrt_dieAbleitungKenntNurVierFelder() {
        // ⚠ „Pflichten gehen immer vor der Rangliste" ist eine Eigenschaft
        // dessen, was hier NICHT entsteht: die Ableitung liefert ausschliesslich
        // Rang, Speicher-Seite und die zwei Ladepark-Felder. Sie kann keine
        // Anforderung, keine Policy und keine D2-Stufe bewegen - der Optimierer
        // deckt in Stufe 1 zuerst jede Pflicht und benutzt den Rang nur, um die
        // Pflichten UNTEREINANDER zu ordnen.
        assertThat(Ableitung.class.getRecordComponents()).extracting(java.lang.reflect
                .RecordComponent::getName)
                .containsExactly("rang", "storageRelation", "storagePriority", "vorrangKennungen",
                        "saeulenRang", "speicherRang");
    }

    // --- P6: die zwei ZAHLEN, mit denen die Box dieselbe Reihenfolge faehrt ---

    @Test
    void jedesGeraetBekommtSeinePositionUndDerSpeicherAuch() {
        // Heizstab (1) · Saeule Garage (2) · SPEICHER (3) · Pumpe (4).
        List<Kandidat> kandidaten = List.of(vb(HEIZSTAB), saeule(GARAGE, "saeule-garage"),
                vb(PUMPE));
        Ableitung ab = RanglisteAbleitung.ableiten(
                List.of(w(HEIZSTAB), lp(GARAGE), SPEICHER, w(PUMPE)), kandidaten, true);

        assertThat(ab.rang()).containsEntry(HEIZSTAB, 1).containsEntry(PUMPE, 4);
        assertThat(ab.saeulenRang()).containsExactly(java.util.Map.entry("saeule-garage", 2));
        assertThat(ab.speicherRang()).isEqualTo(3);
    }

    @Test
    void gleichrangigeSaeulenEinerSeiteTragenDIESELBEZahl() {
        // ⚠ Die Flaeche zeigt sie als EINE Zeile - der Kunde hat zwischen ihnen
        // gar keine Reihenfolge gewaehlt. Verschiedene Zahlen behaupteten eine,
        // und die Box hoerte auf, zwischen ihnen abzuwechseln.
        List<Kandidat> kandidaten = List.of(saeule(GARAGE, "saeule-garage"),
                saeule(STELLPLATZ, "saeule-stellplatz"), vb(HEIZSTAB));
        Ableitung ab = RanglisteAbleitung.ableiten(
                List.of(lp(GARAGE), lp(STELLPLATZ), SPEICHER, w(HEIZSTAB)), kandidaten, true);

        assertThat(ab.saeulenRang()).containsEntry("saeule-garage", 1)
                .containsEntry("saeule-stellplatz", 1);
        // Die Gruppe belegt trotzdem ZWEI Plaetze - die Positionen zaehlen
        // GERAETE, nicht Zeilen (die P4-Regel).
        assertThat(ab.speicherRang()).isEqualTo(3);
        assertThat(ab.rang()).containsEntry(HEIZSTAB, 4);
    }

    @Test
    void saeulenOBERHALBUndUNTERHALBTragenVerschiedeneZahlen() {
        // Genau das ist der Fall, den die Vorrang-MENGE allein nicht ausdruecken
        // kann: die Box liest die zwei Zahlen gegen `storage_rank`.
        List<Kandidat> kandidaten = List.of(saeule(GARAGE, "saeule-garage"),
                saeule(STELLPLATZ, "saeule-stellplatz"));
        Ableitung ab = RanglisteAbleitung.ableiten(
                List.of(lp(GARAGE), SPEICHER, lp(STELLPLATZ)), kandidaten, true);

        assertThat(ab.saeulenRang()).containsEntry("saeule-garage", 1)
                .containsEntry("saeule-stellplatz", 3);
        assertThat(ab.speicherRang()).isEqualTo(2);
        // ... und die alte Aussage bleibt Wort fuer Wort dieselbe.
        assertThat(ab.storagePriority()).isEqualTo(RanglisteProjektion.AUTO_VOR_SPEICHER);
        assertThat(ab.vorrangKennungen()).containsExactly("saeule-garage");
    }

    @Test
    void ohneSpeicherGibtEsKeinenSpeicherRang() {
        // ⚠ null heisst „es gibt kein Oben und Unten", nie 0: die Box faellt
        // dann auf die anlagenweite Wahl zurueck.
        Ableitung ab = RanglisteAbleitung.ableiten(List.of(lp(GARAGE)),
                List.of(saeule(GARAGE, "saeule-garage")), false);

        assertThat(ab.speicherRang()).isNull();
        assertThat(ab.saeulenRang()).containsEntry("saeule-garage", 1);
    }

    @Test
    void eineAnlageOhneSaeulenSagtUeberSaeulenrangGarNICHTS() {
        Ableitung ab = RanglisteAbleitung.ableiten(List.of(w(HEIZSTAB), SPEICHER, w(PUMPE)),
                List.of(vb(HEIZSTAB), vb(PUMPE)), true);

        assertThat(ab.saeulenRang()).isEmpty();
        assertThat(ab.speicherRang()).isEqualTo(2);
    }
}
