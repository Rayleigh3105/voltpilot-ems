package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.io.InputStream;
import java.math.BigDecimal;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import java.util.stream.StreamSupport;
import org.junit.jupiter.api.Test;
import org.yaml.snakeyaml.Yaml;

/**
 * Die erwartete Kadenz als zeitgültige Tatsache (UEMS AP-07 IP-10, Entscheid E9) — rein, ohne
 * Docker und ohne Spring.
 *
 * <p>Bewiesen wird:
 *
 * <ul>
 *   <li><b>Die Vorgabe-Kette.</b> Fassung → Mess-Selektion → Katalog → 300 s, mit der Herkunft je
 *       Glied; die drei hinteren Glieder sind die Ableitung von VOR diesem Paket, Zeichen für
 *       Zeichen — solange keine Fassung eingetragen ist, ändert sich für keine bestehende Fläche
 *       etwas.</li>
 *   <li><b>Eine Kadenz-Änderung gilt AB ihrem Zeitpunkt und nicht rückwärts.</b> Die neue Fassung
 *       beendet die dort geltende genau dort; was davor liegt, behält seine alte Erwartung — auch
 *       eine rückwirkend eingetragene reißt nur ihr eigenes Stück heraus.</li>
 *   <li><b>A15 (Kadenz als Fakt: Abdeckung ohne Auffüllung).</b> Die Zahl dieses Pakets, gefüttert
 *       in den schon gebauten Verbrauchsvertrag ({@link VerbrauchRegeln}, AP-08 IP-1), ergibt für
 *       MS-01 „85 von 90 · 94 %" — nie 100 %, nie ein erfundener Wert — und die fehlenden 50 s sind
 *       eine Lücke, weil sie über 2 × Kadenz liegen.</li>
 *   <li>das geschlossene Ablehnungs-Vokabular in fester Prüfreihenfolge, und dass es mit
 *       {@code openapi.yaml} übereinstimmt.</li>
 * </ul>
 *
 * <p>Die Zahlen kommen aus dem Referenzunternehmen ({@code uems-referenzunternehmen.json}): MS-01
 * liest mit {@code kadenz_s} 10, MS-11 mit 60. MS-21 (Gas, „monatlich (manuelle Ablesung, AP-09)")
 * trägt dort ausdrücklich KEINE Zahl und hat keine Quellenbindung — ihre Abdeckung „1 von 1" ist
 * die Hälfte von A15, die AP-09 (Ablesung) und IP-12 (Verdichtung) gehört, nicht diesem Paket.
 */
class KadenzRegelnTest {

    private static final Path CONTRACTS = Path.of("..", "..", "docs", "contracts");
    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final Instant JETZT = Instant.parse("2027-03-03T12:00:00Z");

    // ------------------------------------------------------------- Vorgabe-Kette

    @Test
    void dieVorgabeKetteIstFassungDannAuswahlDannKatalogDannDreihundert() {
        assertThat(KadenzRegeln.wirksam(10, 60, 300))
                .isEqualTo(new KadenzRegeln.Wirksam(10, KadenzRegeln.Herkunft.FASSUNG));
        assertThat(KadenzRegeln.wirksam(null, 60, 300))
                .isEqualTo(new KadenzRegeln.Wirksam(60, KadenzRegeln.Herkunft.AUSWAHL));
        assertThat(KadenzRegeln.wirksam(null, null, 300))
                .isEqualTo(new KadenzRegeln.Wirksam(300, KadenzRegeln.Herkunft.KATALOG));
        assertThat(KadenzRegeln.wirksam(null, null, null))
                .isEqualTo(new KadenzRegeln.Wirksam(KadenzRegeln.VORGABE_S, KadenzRegeln.Herkunft.VORGABE));
        assertThat(KadenzRegeln.VORGABE_S).isEqualTo(300);
    }

    @Test
    void eineFassungAusserhalbDerDrahtSchrankenWirdUebergangenNieZurechtgebogen() {
        for (Integer daneben : Arrays.asList(0, -1, 86401, null)) {
            assertThat(KadenzRegeln.wirksam(daneben, 60, 300))
                    .isEqualTo(new KadenzRegeln.Wirksam(60, KadenzRegeln.Herkunft.AUSWAHL));
        }
        assertThat(KadenzRegeln.imRahmen(1)).isTrue();
        assertThat(KadenzRegeln.imRahmen(86400)).isTrue();
        assertThat(KadenzRegeln.imRahmen(86401)).isFalse();
    }

    /** Die Schranken sind DIE des Drahtvertrags — nie eine eigene zweite Zahl. */
    @Test
    void dieSchrankenSindDieDesDrahtvertrags() throws IOException {
        JsonNode draht = MAPPER.readTree(CONTRACTS.resolve("v2")
                .resolve("mqtt-measurement-config.schema.json").toFile());
        JsonNode kadenz = draht.at("/$defs/selection/properties/cadence_s");
        assertThat(kadenz.get("minimum").asInt()).isEqualTo(KadenzRegeln.KLEINSTE_S);
        assertThat(kadenz.get("maximum").asInt()).isEqualTo(KadenzRegeln.GROESSTE_S);
    }

    // ------------------------------------------------------- Geltung ab Zeitpunkt

    @Test
    void eineAenderungGiltAbIhremZeitpunktUndNichtRueckwaerts() {
        Instant beginn = Instant.parse("2024-03-12T00:00:00Z");
        Instant ab = Instant.parse("2027-03-03T09:00:00Z");
        KadenzRegeln.Fassung eins = new KadenzRegeln.Fassung("1", 60, beginn, null);
        KadenzRegeln.Urteil u = KadenzRegeln.neueFassung(new KadenzRegeln.Eingang(beginn, null,
                List.of(eins), 10, ab, JETZT));

        assertThat(u.ok()).isTrue();
        assertThat(u.gueltigAb()).isEqualTo(ab);
        assertThat(u.gueltigBis()).isNull();
        assertThat(u.beendet()).isEqualTo(new KadenzRegeln.Beendet("1", ab));
        assertThat(u.rueckwirkend()).isTrue();

        // Der Zustand danach: davor 60 s, ab 09:00 10 s — die Vergangenheit behält ihre Erwartung.
        List<KadenzRegeln.Fassung> danach = List.of(new KadenzRegeln.Fassung("1", 60, beginn, ab),
                new KadenzRegeln.Fassung("2", 10, ab, null));
        assertThat(KadenzRegeln.fassungAm(danach, ab.minusSeconds(1)).erwartetS()).isEqualTo(60);
        assertThat(KadenzRegeln.fassungAm(danach, ab).erwartetS()).isEqualTo(10);
        assertThat(KadenzRegeln.fassungAm(danach, JETZT).erwartetS()).isEqualTo(10);
        assertThat(KadenzRegeln.fassungAm(danach, beginn.minusSeconds(60))).isNull();
    }

    @Test
    void eineFassungDazwischenReisstNurIhrEigenesStueckHeraus() {
        Instant beginn = Instant.parse("2027-01-01T00:00:00Z");
        Instant zweite = Instant.parse("2027-02-01T00:00:00Z");
        Instant dazwischen = Instant.parse("2027-01-15T00:00:00Z");
        List<KadenzRegeln.Fassung> bestand = List.of(
                new KadenzRegeln.Fassung("1", 60, beginn, zweite),
                new KadenzRegeln.Fassung("2", 10, zweite, null));

        KadenzRegeln.Urteil u = KadenzRegeln.neueFassung(new KadenzRegeln.Eingang(beginn, null, bestand,
                30, dazwischen, JETZT));
        assertThat(u.ok()).isTrue();
        assertThat(u.beendet()).isEqualTo(new KadenzRegeln.Beendet("1", dazwischen));
        assertThat(u.gueltigBis()).isEqualTo(zweite);
    }

    @Test
    void einEndeDerBindungDeckeltDieNeueFassung() {
        Instant beginn = Instant.parse("2027-01-01T00:00:00Z");
        Instant ende = Instant.parse("2027-04-01T00:00:00Z");
        Instant ab = Instant.parse("2027-03-01T00:00:00Z");
        KadenzRegeln.Urteil u = KadenzRegeln.neueFassung(new KadenzRegeln.Eingang(beginn, ende, List.of(),
                30, ab, JETZT));
        assertThat(u.ok()).isTrue();
        assertThat(u.gueltigBis()).isEqualTo(ende);
    }

    // ------------------------------------------------------------------ Vokabular

    @Test
    void dasVokabularUrteiltInFesterReihenfolge() {
        Instant beginn = Instant.parse("2027-01-01T00:00:00Z");
        Instant ende = Instant.parse("2027-04-01T00:00:00Z");
        List<KadenzRegeln.Fassung> eine = List.of(new KadenzRegeln.Fassung("1", 60, beginn, null));

        assertThat(fehler(beginn, ende, eine, null, beginn.plusSeconds(3600)))
                .isEqualTo(KadenzRegeln.Fehler.KADENZ_UNGUELTIG);
        assertThat(fehler(beginn, ende, eine, 86401, beginn.plusSeconds(3600)))
                .isEqualTo(KadenzRegeln.Fehler.KADENZ_UNGUELTIG);
        assertThat(fehler(beginn, ende, eine, 10, beginn.plusSeconds(30)))
                .isEqualTo(KadenzRegeln.Fehler.ZEITPUNKT_UNGUELTIG);
        assertThat(fehler(beginn, ende, eine, 10, beginn.minusSeconds(60)))
                .isEqualTo(KadenzRegeln.Fehler.VOR_BEGINN);
        assertThat(fehler(beginn, ende, eine, 10, ende))
                .isEqualTo(KadenzRegeln.Fehler.NACH_ENDE);
        assertThat(fehler(beginn, ende, eine, 10, beginn))
                .isEqualTo(KadenzRegeln.Fehler.BEGINN_BELEGT);
        assertThat(fehler(beginn, ende, eine, 60, beginn.plusSeconds(3600)))
                .isEqualTo(KadenzRegeln.Fehler.UNVERAENDERT);
        // Der Beginn der Bindung selbst ist erlaubt, solange dort noch keine Fassung steht.
        assertThat(KadenzRegeln.neueFassung(new KadenzRegeln.Eingang(beginn, ende, List.of(), 10, beginn,
                JETZT)).ok()).isTrue();
    }

    @Test
    @SuppressWarnings("unchecked")
    void dieFehlerCodesSindDieDerRegelnUndDieDerSchnittstelle() throws IOException {
        try (InputStream in = Files.newInputStream(CONTRACTS.resolve("openapi.yaml"))) {
            Map<String, Object> openapi = new Yaml().load(in);
            Map<String, Object> schemas = (Map<String, Object>) ((Map<String, Object>) openapi
                    .get("components")).get("schemas");
            Map<String, Object> schema = (Map<String, Object>) schemas.get("KadenzFehler");
            Map<String, Object> code = (Map<String, Object>) ((Map<String, Object>) schema
                    .get("properties")).get("code");
            assertThat((List<String>) code.get("enum")).containsExactlyElementsOf(KadenzAbgelehnt.CODES);
        }
        assertThat(KadenzAbgelehnt.CODES.subList(0, KadenzRegeln.Fehler.values().length))
                .containsExactlyElementsOf(Arrays.stream(KadenzRegeln.Fehler.values())
                        .map(KadenzRegeln.Fehler::code).toList());
    }

    // ------------------------------------------------------------------------ A15

    /**
     * A15 — MS-01 (10 s, 90 je Viertelstunde) erhält in 10:00–10:15 nur 85 Werte: „85 von 90 ·
     * 94 %", nie 100 %, kein erfundener Wert; die fehlenden 50 s liegen über 2 × Kadenz und sind
     * deshalb eine Lücke (der Melder dafür ist IP-9, die SCHWELLE steht schon im
     * Verbrauchsvertrag).
     */
    @Test
    void a15DieKadenzAlsFaktGibtDieAbdeckungOhneAufzufuellen() throws IOException {
        int kadenzS = kadenzAusDerReferenz("MS-01");
        assertThat(kadenzS).isEqualTo(10);
        Duration kadenz = Duration.ofSeconds(kadenzS);
        Instant von = Instant.parse("2026-11-03T10:00:00Z");
        Instant bis = von.plus(15, ChronoUnit.MINUTES);

        // 90 erwartete Messzeiten, fünf davon (10:05:00–10:05:40) kommen nie an.
        List<VerbrauchRegeln.Rohwert> werte = new ArrayList<>();
        for (int i = 0; i < 90; i++) {
            Instant t = von.plusSeconds((long) i * kadenzS);
            if (i >= 30 && i < 35) {
                continue;
            }
            werte.add(new VerbrauchRegeln.Rohwert(t, new BigDecimal("12.5"), true));
        }
        assertThat(werte).hasSize(85);

        VerbrauchRegeln.Ergebnis e = VerbrauchRegeln.momentanwerte(werte, von, bis, kadenz, false);
        assertThat(e.erwartet()).isEqualTo(90);
        assertThat(e.erhalten()).isEqualTo(85);
        assertThat(e.abdeckungProzent()).isEqualTo(94);
        assertThat(e.zustand()).isEqualTo(VerbrauchRegeln.UNVOLLSTAENDIG);

        // Die Lücke: 50 s Loch > 2 × 10 s. Dieselbe Schwelle in beiden Verträgen.
        assertThat(50L).isGreaterThan(VerbrauchRegeln.LUECKE_FAKTOR * kadenzS);
        assertThat(VerbrauchRegeln.LUECKE_FAKTOR).isEqualTo(ZustandAbleitung.LUECKE_FAKTOR);

        // Mit der ALTEN Fassung (60 s) hätte derselbe Zeitraum eine andere Erwartung — genau
        // deshalb ist die Kadenz zeitgültig und wird zum Zeitpunkt geholt, nie „jetzt".
        VerbrauchRegeln.Ergebnis alt = VerbrauchRegeln.momentanwerte(werte, von, bis,
                Duration.ofSeconds(60), false);
        assertThat(alt.erwartet()).isEqualTo(15);
    }

    /** MS-21 (Gas, monatlich) trägt in der Referenz ausdrücklich KEINE Zahl — nichts wird geraten. */
    @Test
    void eineManuellAbgeleseneMessstelleHatKeineKadenzZahl() throws IOException {
        JsonNode ms21 = messstelle("MS-21");
        assertThat(ms21.get("kadenz_s").isNull()).isTrue();
        assertThat(ms21.get("kadenz_beschreibung").asText()).contains("monatlich");
        assertThat(ms21.get("fuehrende_quelle")).isEmpty();
    }

    // ---------------------------------------------------------------------- Gerüst

    private static KadenzRegeln.Fehler fehler(Instant beginn, Instant ende,
            List<KadenzRegeln.Fassung> bestand, Integer erwartetS, Instant ab) {
        return KadenzRegeln.neueFassung(new KadenzRegeln.Eingang(beginn, ende, bestand, erwartetS, ab, JETZT))
                .fehler();
    }

    private static int kadenzAusDerReferenz(String kennzeichen) throws IOException {
        return messstelle(kennzeichen).get("kadenz_s").asInt();
    }

    private static JsonNode messstelle(String kennzeichen) throws IOException {
        JsonNode referenz = MAPPER.readTree(CONTRACTS.resolve("v2")
                .resolve("uems-referenzunternehmen.json").toFile());
        return StreamSupport.stream(referenz.get("messstellen").spliterator(), false)
                .filter(m -> kennzeichen.equals(m.get("kennzeichen").asText())).findFirst().orElseThrow();
    }
}
