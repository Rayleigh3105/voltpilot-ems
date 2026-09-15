package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.voltpilot.api.uems.MessstelleWerteRegeln.Abgelehnt;
import com.voltpilot.api.uems.MessstelleWerteRegeln.Bindung;
import com.voltpilot.api.uems.MessstelleWerteRegeln.Deckung;
import com.voltpilot.api.uems.MessstelleWerteRegeln.Form;
import com.voltpilot.api.uems.MessstelleWerteRegeln.Grund;
import com.voltpilot.api.uems.MessstelleWerteRegeln.OhneZahl;
import com.voltpilot.api.uems.MessstelleWerteRegeln.Raster;
import com.voltpilot.api.uems.MessstelleWerteRegeln.Reihe;
import com.voltpilot.api.uems.MessstelleWerteRegeln.Schritt;
import com.voltpilot.api.uems.MessstelleWerteRegeln.Zeitraum;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.yaml.snakeyaml.Yaml;

/**
 * Die reinen Regeln des Lese-Modells „Werte je Messstelle“ (AP-08 IP-9): wie die Anfrage gelesen
 * wird, welche Schritte ein Zeitraum hat — auch am 25- und am 23-Stunden-Tag — und welche Reihe einen
 * Schritt beantworten darf. Rein; kein Spring, keine Datenbank.
 */
class MessstelleWerteRegelnTest {

    private static final ZoneId BERLIN = ZoneId.of("Europe/Berlin");
    private static final UUID K5 = UUID.fromString("00000000-0000-0000-0000-0000000000a5");
    private static final UUID K8 = UUID.fromString("00000000-0000-0000-0000-0000000000a8");

    // ================================================================= Anfrage streng lesen

    @Test
    void einUnbekanntesRasterIstEineBenannteAblehnungMitFeld() {
        abgelehnt(() -> MessstelleWerteRegeln.form("woche", "2026-11-03", "2026-11-03", null), "raster",
                Grund.RASTER_UNBEKANNT);
        abgelehnt(() -> MessstelleWerteRegeln.form(null, "2026-11-03", "2026-11-03", null), "raster", Grund.FEHLT);
        assertThat(Raster.woerter()).containsExactly("viertelstunde", "stunde", "tag", "monat", "jahr");
    }

    @Test
    void vonUndBisSindPflichtUndEinTagDenEsNichtGibtIstKeinTag() {
        abgelehnt(() -> MessstelleWerteRegeln.form("tag", null, "2026-11-03", null), "von", Grund.FEHLT);
        abgelehnt(() -> MessstelleWerteRegeln.form("tag", "2026-11-03", " ", null), "bis", Grund.FEHLT);
        abgelehnt(() -> MessstelleWerteRegeln.form("tag", "2026-02-30", "2026-03-01", null), "von", Grund.FORM);
        abgelehnt(() -> MessstelleWerteRegeln.form("tag", "2026-11-03", "2026-13-01", null), "bis", Grund.FORM);
        // Ein Zeitpunkt ohne Versatz ist mehrdeutig (die doppelte Stunde) — keine stille Wahl.
        abgelehnt(() -> MessstelleWerteRegeln.form("stunde", "2026-10-25T02:00:00", "2026-10-25T03:00:00+01:00",
                null), "von", Grund.FORM);
    }

    @Test
    void dieVersionIstEineGanzeZahlAbEins() {
        abgelehnt(() -> MessstelleWerteRegeln.form("tag", "2026-11-03", "2026-11-03", "0"), "version",
                Grund.VERSION_UNGUELTIG);
        abgelehnt(() -> MessstelleWerteRegeln.form("tag", "2026-11-03", "2026-11-03", "zwei"), "version",
                Grund.VERSION_UNGUELTIG);
        assertThat(MessstelleWerteRegeln.form("tag", "2026-11-03", "2026-11-03", "2").version()).isEqualTo(2);
        assertThat(MessstelleWerteRegeln.form("tag", "2026-11-03", "2026-11-03", null).version()).isNull();
    }

    @Test
    void vonMussVorBisLiegen() {
        abgelehnt(() -> zeitraum("tag", "2026-11-04", "2026-11-03"), "bis", Grund.VON_NICHT_VOR_BIS);
        abgelehnt(() -> zeitraum("stunde", "2026-11-03T17:00:00+01:00", "2026-11-03T17:00:00+01:00"), "bis",
                Grund.VON_NICHT_VOR_BIS);
    }

    @Test
    void einZeitpunktNebenDemRasterWirdNieGerundet() {
        abgelehnt(() -> zeitraum("viertelstunde", "2026-11-03T14:10:00+01:00", "2026-11-03T15:00:00+01:00"), "von",
                Grund.NICHT_IM_RASTER);
        abgelehnt(() -> zeitraum("stunde", "2026-11-03T14:00:00+01:00", "2026-11-03T14:45:00+01:00"), "bis",
                Grund.NICHT_IM_RASTER);
        abgelehnt(() -> zeitraum("tag", "2026-11-03T01:00:00+01:00", "2026-11-04"), "von", Grund.NICHT_IM_RASTER);
        abgelehnt(() -> zeitraum("monat", "2026-11-03", "2026-11-30"), "von", Grund.NICHT_IM_RASTER);
        abgelehnt(() -> zeitraum("monat", "2026-11-01", "2026-11-29"), "bis", Grund.NICHT_IM_RASTER);
        abgelehnt(() -> zeitraum("jahr", "2026-02-01", "2026-12-31"), "von", Grund.NICHT_IM_RASTER);
        // Mitternacht in UTC ist nicht Mitternacht am Standort.
        abgelehnt(() -> zeitraum("tag", "2026-11-03T00:00:00Z", "2026-11-04"), "von", Grund.NICHT_IM_RASTER);
    }

    @Test
    void unmoeglicheUndZuLangeZeitraeumeSindBenannt() {
        abgelehnt(() -> zeitraum("tag", "1999-12-31", "2000-01-02"), "von", Grund.AUSSERHALB);
        abgelehnt(() -> zeitraum("jahr", "2099-01-01", "2100-12-31"), "bis", Grund.AUSSERHALB);
        abgelehnt(() -> zeitraum("viertelstunde", "2026-10-01", "2026-10-31"), "bis", Grund.ZU_VIELE_SCHRITTE);
        abgelehnt(() -> zeitraum("stunde", "2026-10-01", "2026-10-31"), "bis", Grund.ZU_VIELE_SCHRITTE);
        assertThat(zeitraum("viertelstunde", "2026-10-01", "2026-10-22").schritte()).hasSize(22 * 96);
        assertThat(zeitraum("stunde", "2026-10-01", "2026-10-22").schritte()).hasSize(22 * 24);
    }

    // ======================================================================== Schritte

    /** F13: der 25-Stunden-Tag hat 100 Viertelstunden und 25 Stunden — die doppelte Stunde zweimal. */
    @Test
    void derFuenfundzwanzigStundenTagHatHundertViertelstundenUndFuenfundzwanzigStunden() {
        Zeitraum v = zeitraum("viertelstunde", "2026-10-25", "2026-10-25");
        assertThat(v.schritte()).hasSize(100);
        assertThat(v.von()).isEqualTo(Instant.parse("2026-10-24T22:00:00Z"));
        assertThat(v.bis()).isEqualTo(Instant.parse("2026-10-25T23:00:00Z"));
        Zeitraum h = zeitraum("stunde", "2026-10-25", "2026-10-25");
        assertThat(h.schritte()).hasSize(25);
        assertThat(h.schritte().stream().map(s -> MessstelleWerteRegeln.iso(s.von(), BERLIN)))
                .contains("2026-10-25T02:00:00+02:00", "2026-10-25T02:00:00+01:00");
        assertThat(zeitraum("tag", "2026-10-25", "2026-10-25").schritte()).containsExactly(
                new Schritt(Instant.parse("2026-10-24T22:00:00Z"), Instant.parse("2026-10-25T23:00:00Z")));
    }

    /** F14: der 23-Stunden-Tag — die fehlende Stunde ist kein Schritt. */
    @Test
    void derDreiundzwanzigStundenTagHatZweiundneunzigViertelstunden() {
        assertThat(zeitraum("viertelstunde", "2027-03-28", "2027-03-28").schritte()).hasSize(92);
        assertThat(zeitraum("stunde", "2027-03-28", "2027-03-28").schritte().stream()
                .map(s -> MessstelleWerteRegeln.iso(s.von(), BERLIN)))
                .hasSize(23).doesNotContain("2027-03-28T02:00:00+01:00", "2027-03-28T02:00:00+02:00");
    }

    @Test
    void monatUndJahrSindKalenderperiodenDerZone() {
        Zeitraum m = zeitraum("monat", "2026-10-01", "2026-12-31");
        assertThat(m.schritte()).extracting(Schritt::von).containsExactly(Instant.parse("2026-09-30T22:00:00Z"),
                Instant.parse("2026-10-31T23:00:00Z"), Instant.parse("2026-11-30T23:00:00Z"));
        assertThat(m.schritte().get(0).bis()).isEqualTo(Instant.parse("2026-10-31T23:00:00Z"));
        Zeitraum j = zeitraum("jahr", "2026-01-01", "2027-12-31");
        assertThat(j.schritte()).hasSize(2);
        // Ein Zeitpunkt auf der Grenze ist dasselbe wie der Tag.
        assertThat(zeitraum("monat", "2026-10-01T00:00:00+02:00", "2026-11-01T00:00:00+01:00").schritte())
                .isEqualTo(zeitraum("monat", "2026-10-01", "2026-10-31").schritte());
    }

    // ========================================================================= Deckung

    private static final Schritt TAG = new Schritt(Instant.parse("2026-11-17T23:00:00Z"),
            Instant.parse("2026-11-18T23:00:00Z"));

    @Test
    void ohneFuehrendeBindungHatDerSchrittKeineQuelle() {
        assertThat(MessstelleWerteRegeln.deckung(List.of(), TAG).grund()).isEqualTo(OhneZahl.KEINE_QUELLE);
        Bindung vorher = bindung(K5, "energy", null, "2024-03-12T00:00:00Z", "2026-11-17T23:00:00Z");
        assertThat(MessstelleWerteRegeln.deckung(List.of(vorher), TAG).grund()).isEqualTo(OhneZahl.KEINE_QUELLE);
    }

    /** Zählerwechsel Z-5a → Z-5b um 10:40 an derselben Komponente: ein Einbau wechselt, nicht die Reihe. */
    @Test
    void einZaehlerwechselAnDerselbenKomponenteBleibtEineReihe() {
        Bindung z5a = bindung(K5, "energy", null, "2024-03-12T00:00:00Z", "2026-11-18T09:40:00Z");
        Bindung z5b = bindung(K5, "energy", null, "2026-11-18T09:40:00Z", null);
        Deckung d = MessstelleWerteRegeln.deckung(List.of(z5b, z5a), TAG);
        assertThat(d.grund()).isNull();
        assertThat(d.reihe()).isEqualTo(new Reihe(K5, "energy"));
        assertThat(d.bindung()).isEqualTo(z5b);
    }

    @Test
    void eineTeilweiseDeckungOderZweiReihenTragenKeineZahl() {
        Bindung abMittag = bindung(K5, "energy", null, "2026-11-18T11:00:00Z", null);
        assertThat(MessstelleWerteRegeln.deckung(List.of(abMittag), TAG).grund()).isEqualTo(OhneZahl.QUELLE_TEILWEISE);
        Bindung bisMittag = bindung(K5, "energy", null, "2024-03-12T00:00:00Z", "2026-11-18T11:00:00Z");
        assertThat(MessstelleWerteRegeln.deckung(List.of(bisMittag), TAG).grund()).isEqualTo(OhneZahl.QUELLE_TEILWEISE);
        Bindung luecke = bindung(K5, "energy", null, "2026-11-18T12:00:00Z", null);
        assertThat(MessstelleWerteRegeln.deckung(List.of(bisMittag, luecke), TAG).grund())
                .isEqualTo(OhneZahl.QUELLE_TEILWEISE);
        Bindung andereReihe = bindung(K8, "energy", null, "2026-11-18T11:00:00Z", null);
        assertThat(MessstelleWerteRegeln.deckung(List.of(bisMittag, andereReihe), TAG).grund())
                .isEqualTo(OhneZahl.QUELLE_TEILWEISE);
    }

    @Test
    void einAnteilIstNichtGespeichert() {
        Bindung positiv = bindung(K8, "power_w", "positiv", "2024-03-12T00:00:00Z", null);
        assertThat(MessstelleWerteRegeln.deckung(List.of(positiv), TAG).grund())
                .isEqualTo(OhneZahl.ANTEIL_NICHT_GESPEICHERT);
    }

    // ======================================================================= OpenAPI

    /** Die geschlossenen Wörter der Route stehen genau so in der OpenAPI — Raster, Ablehnungs- und Schritt-Gründe. */
    @Test
    @SuppressWarnings("unchecked")
    void dieGeschlossenenWoerterStehenGenauSoInDerOpenApi() throws Exception {
        Map<String, Object> schemas;
        try (InputStream in = Files.newInputStream(Path.of("..", "..", "docs", "contracts", "openapi.yaml"))) {
            Map<String, Object> openapi = new Yaml().load(in);
            schemas = (Map<String, Object>) ((Map<String, Object>) openapi.get("components")).get("schemas");
        }
        assertThat(eigenschaftEnum(schemas, "MessstelleWerte", "raster")).containsExactlyElementsOf(Raster.woerter());
        assertThat(eigenschaftEnum(schemas, "MessstelleWerteFehler", "grund"))
                .containsExactlyElementsOf(Arrays.stream(Grund.values()).map(Grund::wort).toList());
        assertThat(eigenschaftEnum(schemas, "MessstelleWerteWert", "grund"))
                .containsExactlyElementsOf(Arrays.stream(OhneZahl.values()).map(OhneZahl::wort).toList());
        assertThat(eigenschaftEnum(schemas, "MessstelleWerteWert", "zustand"))
                .containsExactlyElementsOf(ErgebnisZustand.ZUSTAENDE.stream().map(ErgebnisZustand.Zustand::wort).toList());
        assertThat(eigenschaftEnum(schemas, "MessstelleWerteWert", "fassung"))
                .containsExactly(ViertelstundeRegeln.VORLAEUFIG, ViertelstundeRegeln.ENDGUELTIG);
    }

    @SuppressWarnings("unchecked")
    private static List<String> eigenschaftEnum(Map<String, Object> schemas, String schema, String feld) {
        Map<String, Object> s = (Map<String, Object>) schemas.get(schema);
        Map<String, Object> f = (Map<String, Object>) ((Map<String, Object>) s.get("properties")).get(feld);
        return ((List<Object>) f.get("enum")).stream().map(String::valueOf).toList();
    }

    // ======================================================================= Woche (AP-11 IP-12)

    /**
     * Die Woche einer Kennzahl liegt in der Zone des Standorts: Montag 00:00 bis Montag 00:00 Ortszeit, nie UTC, nie
     * Berlin. KW 43/2026 (19.–25.10.) endet in Berlin mit der Sommerzeit — 169 Stunden. In New York endet die
     * Sommerzeit erst am 01.11.: dort hat KW 43 168 Stunden und beginnt sechs Stunden später, KW 44 hat 169. Über den
     * Jahreswechsel ist sie eine ISO-Woche: KW 53/2026 = 28.12.2026–03.01.2027. (Die Datenbank führt heute nur die drei
     * Zonen von {@link TagRegeln#ZONEN}, alle mit Berliner Versatz — die abweichende Zone zeigt darum die Regel.)
     */
    @Test
    void eineWocheBeginntUndEndetAmMontagInDerZoneDesStandorts() {
        Schritt berlin = MessstelleWerteRegeln.woche(LocalDate.parse("2026-10-21"), BERLIN);
        assertThat(berlin).isEqualTo(new Schritt(Instant.parse("2026-10-18T22:00:00Z"),
                Instant.parse("2026-10-25T23:00:00Z")));
        assertThat(stunden(berlin)).isEqualTo(169);
        assertThat(MessstelleWerteRegeln.woche(LocalDate.parse("2026-10-19"), BERLIN)).isEqualTo(berlin);
        assertThat(MessstelleWerteRegeln.woche(LocalDate.parse("2026-10-25"), BERLIN)).as("der Sonntag gehört dazu")
                .isEqualTo(berlin);
        assertThat(MessstelleWerteRegeln.woche(LocalDate.parse("2026-10-26"), BERLIN).von())
                .as("der Montag beginnt die nächste").isEqualTo(berlin.bis());

        ZoneId newYork = ZoneId.of("America/New_York");
        Schritt ny43 = MessstelleWerteRegeln.woche(LocalDate.parse("2026-10-21"), newYork);
        assertThat(ny43).isEqualTo(new Schritt(Instant.parse("2026-10-19T04:00:00Z"),
                Instant.parse("2026-10-26T04:00:00Z")));
        assertThat(stunden(ny43)).isEqualTo(168);
        assertThat(stunden(MessstelleWerteRegeln.woche(LocalDate.parse("2026-10-28"), newYork))).isEqualTo(169);

        assertThat(MessstelleWerteRegeln.woche(LocalDate.parse("2027-01-01"), BERLIN)).isEqualTo(new Schritt(
                Instant.parse("2026-12-27T23:00:00Z"), Instant.parse("2027-01-03T23:00:00Z")));
    }

    // ========================================================================= Helfer

    private static long stunden(Schritt s) {
        return (s.bis().getEpochSecond() - s.von().getEpochSecond()) / 3600;
    }

    private static Zeitraum zeitraum(String raster, String von, String bis) {
        Form f = MessstelleWerteRegeln.form(raster, von, bis, null);
        return MessstelleWerteRegeln.zeitraum(f, BERLIN);
    }

    private static Bindung bindung(UUID entity, String kanal, String anteil, String ab, String bis) {
        return new Bindung(UUID.randomUUID(), entity, kanal, "zaehlerstand", anteil, Instant.parse(ab),
                bis == null ? null : Instant.parse(bis));
    }

    private static void abgelehnt(Runnable r, String feld, Grund grund) {
        assertThatThrownBy(r::run).isInstanceOfSatisfying(Abgelehnt.class, e -> {
            assertThat(e.ablehnung().feld()).isEqualTo(feld);
            assertThat(e.ablehnung().grund()).isEqualTo(grund);
            assertThat(e.getMessage()).isNotBlank();
        });
    }
}
