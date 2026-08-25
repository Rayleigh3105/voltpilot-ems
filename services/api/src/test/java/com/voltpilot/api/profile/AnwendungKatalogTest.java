package com.voltpilot.api.profile;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.flows.FlowCatalog;
import com.voltpilot.api.profile.AnwendungKatalog.Anwendung;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Set;
import org.junit.jupiter.api.Test;

/**
 * Der EINE Anwendungs-Katalog: die Regeln der Ressource selbst plus die zwei
 * Kopplungen, die man beim Anfassen zerstören könnte (die byte-gleiche
 * Portal-Kopie und die katalog-abgeleiteten gated Knotentypen).
 *
 * <p>Rein; läuft immer (kein Docker, keine DB).
 */
class AnwendungKatalogTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private final AnwendungKatalog katalog = new AnwendungKatalog(MAPPER);

    @Test
    void theShelfIsTheVisibleEntriesInTheirCanonicalOrder() {
        assertThat(katalog.regal().stream().map(Anwendung::id)).containsExactly("monitoring",
                "speicher-fahrplan", "ueberschuss", "verbraucher", "marktvermarktung",
                "lastspitzenkappung", "atypische-netznutzung", "lastmanagement");
        // Die reservierten Einträge stehen im Katalog, aber NICHT im Regal - ein
        // Schalter, der nichts bewirken kann, wäre eine Zusage, die niemand
        // einlöst.
        assertThat(katalog.alle().stream().map(Anwendung::id))
                .contains("eigene-auswertung", "berichte");
        assertThat(katalog.find("eigene-auswertung").sichtbar()).isFalse();
        assertThat(katalog.find("berichte").sichtbar()).isFalse();
    }

    @Test
    void everyEntryUsesTheClosedVocabularyAndTheClassRules() {
        for (Anwendung a : katalog.alle()) {
            assertThat(a.klasse()).as(a.id())
                    .isIn("basis", "regel", "geschaeft", "reserviert");
            assertThat(a.kategorie()).as(a.id())
                    .isIn("basis", "steuerung", "geschaeft", "auswertung");
            assertThat(a.preset().privat()).as(a.id())
                    .isIn("an", "angeboten", "verborgen", "abgeleitet");
            assertThat(a.preset().gewerbe()).as(a.id())
                    .isIn("an", "angeboten", "verborgen", "abgeleitet");
            assertThat(a.label()).as(a.id()).isNotBlank();
            assertThat(a.nutzen()).as(a.id()).isNotBlank();
            // Eine Basis-Anwendung hat keinen Schalter, eine reservierte keine Zeile.
            assertThat(a.abschaltbar()).as(a.id() + " abschaltbar")
                    .isEqualTo(!AnwendungKatalog.KLASSE_BASIS.equals(a.klasse()));
            assertThat(a.sichtbar()).as(a.id() + " sichtbar")
                    .isEqualTo(!AnwendungKatalog.KLASSE_RESERVIERT.equals(a.klasse()));
            // Nur eine Geschäfts-Anwendung trägt Strategie-Knoten oder Starter.
            if (!AnwendungKatalog.KLASSE_GESCHAEFT.equals(a.klasse())) {
                assertThat(a.strategieKnoten()).as(a.id()).isNull();
                assertThat(a.starter()).as(a.id()).isNull();
            }
            // Eine Regel-Anwendung trägt ihren ehrlichen Leer-Zustand.
            if (AnwendungKatalog.KLASSE_REGEL.equals(a.klasse())) {
                assertThat(a.leerZustand()).as(a.id()).isNotBlank();
            }
        }
    }

    @Test
    void everyRequirementCarriesItsOwnHonestSentence() {
        for (Anwendung a : katalog.alle()) {
            for (AnwendungKatalog.Voraussetzung v : a.voraussetzungen()) {
                assertThat(v.id()).as(a.id()).isNotBlank();
                assertThat(v.label()).as(a.id() + "/" + v.id()).isNotBlank();
                assertThat(v.blockedReason()).as(a.id() + "/" + v.id()).isNotBlank();
            }
        }
        // Nur die atypische Netznutzung trägt einen IMMER geltenden Satz - ihre
        // Ökonomie ist nicht gebaut (E5b).
        assertThat(katalog.alle().stream().filter(a -> a.blockedReasonImmer() != null)
                .map(Anwendung::id)).containsExactly("atypische-netznutzung");
    }

    @Test
    void ranksAreUniqueAndIdsAreStable() {
        List<Integer> raenge = katalog.alle().stream().map(Anwendung::rang).toList();
        assertThat(raenge).doesNotHaveDuplicates().isSorted();
        // Die vier Geschäfts-Anwendungen behalten ihre Ids - sie sind zugleich
        // die M0-ModeKinds und die Schlüssel in site_profile_state.
        assertThat(katalog.find(AnwendungKatalog.MARKTVERMARKTUNG)).isNotNull();
        assertThat(katalog.find(AnwendungKatalog.LASTSPITZENKAPPUNG)).isNotNull();
        assertThat(katalog.find(AnwendungKatalog.ATYPISCHE_NETZNUTZUNG)).isNotNull();
        assertThat(katalog.find(AnwendungKatalog.LASTMANAGEMENT)).isNotNull();
        assertThat(katalog.find("gibt-es-nicht")).isNull();
        assertThat(katalog.find(null)).isNull();
    }

    @Test
    void gatedNodeTypesStayDerivedFromTheFlowCatalog() {
        FlowCatalog flows = new FlowCatalog(MAPPER);
        // Eine Anwendung öffnet GENAU ihren eigenen Strategie-Knoten, und den nur,
        // wenn der Flow-Katalog ihn wirklich gated nennt.
        assertThat(AnwendungKatalog.gatedNodeTypes(
                katalog.find(AnwendungKatalog.MARKTVERMARKTUNG), flows))
                        .containsExactly("vp.strategy.market");
        assertThat(AnwendungKatalog.gatedNodeTypes(
                katalog.find(AnwendungKatalog.LASTSPITZENKAPPUNG), flows))
                        .containsExactly("vp.strategy.peakshaving");
        // Lastmanagement ist SCHUTZ, keine Marktteilnahme - es gibt nichts
        // freizuschalten. Dasselbe gilt für jede Basis- und Regel-Anwendung.
        assertThat(AnwendungKatalog.gatedNodeTypes(
                katalog.find(AnwendungKatalog.LASTMANAGEMENT), flows)).isEmpty();
        assertThat(AnwendungKatalog.gatedNodeTypes(
                katalog.find(AnwendungKatalog.UEBERSCHUSS), flows)).isEmpty();
        assertThat(AnwendungKatalog.gatedNodeTypes(
                katalog.find(AnwendungKatalog.MONITORING), flows)).isEmpty();
        assertThat(AnwendungKatalog.gatedNodeTypes(null, flows)).isEmpty();
    }

    @Test
    void thePortalCopyIsByteIdentical() throws Exception {
        Path api = Path.of("src", "main", "resources", "anwendungen", "catalog.json");
        Path portal = Path.of("..", "..", "frontend", "portal", "src", "anwendungen",
                "catalog.json");
        assertThat(Files.readString(portal))
                .as("die Portal-Kopie ist byte-gleich - beide zusammen ändern")
                .isEqualTo(Files.readString(api));
    }

    @Test
    void theSettingsPointerAgreesWithTheDeclaredSettings() {
        for (Anwendung a : katalog.alle()) {
            if (a.einstellungen().isEmpty()) {
                continue;
            }
            assertThat(a.einstellungenVerweis()).as(a.id()).isNotBlank();
        }
        // Die zwei Geschäfts-Anwendungen mit Einstellungen sind die einzigen
        // heutigen Träger; die Regel-Anwendungen zeigen in die Regel-Welt.
        assertThat(katalog.find(AnwendungKatalog.MARKTVERMARKTUNG).einstellungen())
                .containsExactly("speicherschonung", "netzladen", "anzulegender-wert",
                        "stromtarif");
        assertThat(katalog.find(AnwendungKatalog.LASTSPITZENKAPPUNG).einstellungen())
                .containsExactly("leistungspreis", "abrechnung-leistung", "lastspitzen-reserve");
        assertThat(katalog.find(AnwendungKatalog.UEBERSCHUSS).einstellungenVerweis())
                .isEqualTo("regeln");
    }

    @Test
    void theBuildingBlocksNameOnlyKnownSurfaceIds() {
        Set<String> blocks = Set.of("status", "lade-budget", "peak-band", "erloes-komposition",
                "energiefluss", "handel", "eigenverbrauch", "geraete-automatik",
                "toolbox-pointer");
        Set<String> views = Set.of("ladevorgaenge", "live", "geraete", "telemetrie-historie",
                "wetter", "erloes-historie", "fahrplan", "marktpreise", "prognosequalitaet",
                "lastspitzen", "flow-editor");
        Set<String> streams = Set.of("eigenverbrauchswert", "einspeisung", "handel", "lastspitzen",
                "automation");
        // Ein PORTFOLIO-Beitrag nennt unmittelbar einen Baustein der
        // Kunden-Fläche - dort gibt es keine Blockschicht darunter (Stufe 4).
        Set<String> portfolio = katalog.bausteine(AnwendungKatalog.FLAECHE_PORTFOLIO).stream()
                .map(AnwendungKatalog.Baustein::id).collect(java.util.stream.Collectors.toSet());
        for (Anwendung a : katalog.alle()) {
            assertThat(blocks).as(a.id()).containsAll(a.bausteine().cockpit());
            assertThat(views).as(a.id()).containsAll(a.bausteine().ansichten());
            assertThat(portfolio).as(a.id()).containsAll(a.bausteine().portfolio());
            if (a.bausteine().geldstrom() != null) {
                assertThat(streams).as(a.id()).contains(a.bausteine().geldstrom());
            }
        }
    }

    @Test
    void everyPortfolioBuildingBlockIsContributedByAtLeastOneApplication() {
        // Ein Baustein, den keine Anwendung beisteuert, könnte auf der
        // Kunden-Fläche nie erscheinen - er wäre toter Katalog.
        for (AnwendungKatalog.Baustein b
                : katalog.bausteine(AnwendungKatalog.FLAECHE_PORTFOLIO)) {
            assertThat(katalog.beigesteuertVon(b.id())).as(b.id()).isNotEmpty();
        }
    }

    // -- Die PRESETS (Anwendungs-Programm Stufe 2) --------------------------

    @Test
    void thereAreExactlyTheTwoProfilesEachWithSentenceAndTonality() {
        assertThat(katalog.presets().stream().map(AnwendungKatalog.Profil::id))
                .containsExactly(AnwendungKatalog.PROFIL_PRIVAT, AnwendungKatalog.PROFIL_GEWERBE);
        for (AnwendungKatalog.Profil p : katalog.presets()) {
            assertThat(p.label()).as(p.id()).isNotBlank();
            // Der „wir starten mit …"-Satz ist die ganze Erklärung der Karte -
            // ein leeres Feld wäre eine Karte ohne Aussage.
            assertThat(p.satz()).as(p.id()).isNotBlank();
            assertThat(p.tonalitaet()).as(p.id()).isIn("sparen", "verdienen");
        }
        assertThat(katalog.isProfil("privat")).isTrue();
        assertThat(katalog.isProfil("betreiber")).isFalse();
        assertThat(katalog.isProfil(null)).isFalse();
        assertThat(katalog.profil("quatsch")).isNull();
    }

    @Test
    void everyEntryCarriesAPresetValueForBothProfilesFromTheClosedVocabulary() {
        Set<String> werte = Set.of("an", "angeboten", "verborgen", "abgeleitet");
        for (Anwendung a : katalog.alle()) {
            assertThat(a.preset().privat()).as(a.id()).isIn(werte);
            assertThat(a.preset().gewerbe()).as(a.id()).isIn(werte);
            assertThat(a.preset().fuer(AnwendungKatalog.PROFIL_PRIVAT))
                    .as(a.id()).isEqualTo(a.preset().privat());
            assertThat(a.preset().fuer(AnwendungKatalog.PROFIL_GEWERBE))
                    .as(a.id()).isEqualTo(a.preset().gewerbe());
            // Ein unbekanntes Profil hat keinen Wert - es wird nie geraten.
            assertThat(a.preset().fuer("betreiber")).as(a.id()).isNull();
        }
    }

    @Test
    void thePreselectionIsDerivedFromTheEntriesAndNeverNamesABasicApplication() {
        assertThat(katalog.vorauswahl(AnwendungKatalog.PROFIL_PRIVAT))
                .containsExactly(AnwendungKatalog.UEBERSCHUSS, AnwendungKatalog.VERBRAUCHER);
        assertThat(katalog.vorauswahl(AnwendungKatalog.PROFIL_GEWERBE))
                .containsExactly(AnwendungKatalog.MARKTVERMARKTUNG,
                        AnwendungKatalog.LASTSPITZENKAPPUNG);
        assertThat(katalog.vorauswahl(null)).isEmpty();
        assertThat(katalog.vorauswahl("betreiber")).isEmpty();
        // Die zwei Basis-Anwendungen stehen im Katalog auf „an" - und trotzdem
        // NICHT in der Vorauswahl: sie laufen ohnehin und haben gar keinen
        // Schalter, ein Vorschlag wäre eine Handlung, die der Server ablehnt.
        assertThat(katalog.find(AnwendungKatalog.MONITORING).preset().privat()).isEqualTo("an");
        for (String profil : List.of(AnwendungKatalog.PROFIL_PRIVAT,
                AnwendungKatalog.PROFIL_GEWERBE)) {
            for (String id : katalog.vorauswahl(profil)) {
                assertThat(katalog.find(id).abschaltbar()).as(id).isTrue();
                assertThat(katalog.find(id).sichtbar()).as(id).isTrue();
                assertThat(katalog.find(id).istBasis()).as(id).isFalse();
            }
        }
    }

    @Test
    void everyPortfolioBuildingBlockDocumentsItsAggregationRuleAndNoOtherOneDoes() {
        // Anwendungs-Programm Stufe 4: die Zusammenfassung über die Anlagen
        // eines Kunden ist eine BEHAUPTUNG, also muss jeder Portfolio-Baustein
        // sagen, WIE er sie bildet - und das aus einem GESCHLOSSENEN Vokabular,
        // in dem ein ungewichtetes Prozent-Mittel gar nicht vorkommt.
        List<String> arten = List.of("summe", "gewichtet", "je_anlage");
        int portfolio = 0;
        for (AnwendungKatalog.Baustein b : katalog.bausteine(null)) {
            if (AnwendungKatalog.FLAECHE_PORTFOLIO.equals(b.flaeche())) {
                portfolio++;
                assertThat(b.aggregation()).as(b.id()).isIn(arten);
                // Der Satz ist Pflicht: eine Art ohne Begründung wäre eine
                // Kennzahl, deren Ehrlichkeit niemand nachlesen kann.
                assertThat(b.aggregationRegel()).as(b.id()).isNotBlank();
            } else {
                // Ein Cockpit-Baustein zeigt EINE Anlage - er fasst nichts
                // zusammen, und eine Regel dort wäre eine erfundene Aussage.
                assertThat(b.aggregation()).as(b.id()).isNull();
                assertThat(b.aggregationRegel()).as(b.id()).isNull();
            }
        }
        assertThat(portfolio).isGreaterThanOrEqualTo(8);
    }

    @Test
    void theWeightedRuleIsUsedExactlyWhereAPercentageWouldOtherwiseLie() {
        // Der Ladestand ist der EINE Portfolio-Wert, der ein Mittel ist - und
        // er trägt sein Gewicht (die Kapazität). Jede andere Kachel summiert
        // oder zählt je Anlage; eine zweite „gewichtet"-Kachel wäre ein Hinweis
        // darauf, dass jemand einen Prozentsatz gemittelt hat.
        List<String> gewichtet = katalog.bausteine(AnwendungKatalog.FLAECHE_PORTFOLIO).stream()
                .filter(b -> "gewichtet".equals(b.aggregation()))
                .map(AnwendungKatalog.Baustein::id)
                .toList();
        assertThat(gewichtet).containsExactly("speicher");
    }

    @Test
    void aReservedEntryIsNeverPreselected() {
        // Ein Schalter, den es nicht gibt, kann auch nicht vorgeschlagen werden.
        for (String profil : List.of(AnwendungKatalog.PROFIL_PRIVAT,
                AnwendungKatalog.PROFIL_GEWERBE)) {
            assertThat(katalog.vorauswahl(profil))
                    .doesNotContain(AnwendungKatalog.EIGENE_AUSWERTUNG, AnwendungKatalog.BERICHTE);
        }
    }
}
