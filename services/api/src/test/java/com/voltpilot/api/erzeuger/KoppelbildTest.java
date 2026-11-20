package com.voltpilot.api.erzeuger;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.erzeuger.KoppelbildRepository.Freigabe;
import com.voltpilot.api.web.dto.KoppelbildDto;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;

/**
 * PFC200 Stufe 4 rein: der Herzschlag-Block {@code koppel} (koppelbild.md §15) wird bereinigt gelesen, die Form eines
 * Angebots trägt Test-Beleg und Freigabe, die Fähigkeit {@code actuate} rechnet das Band in die Einheiten des
 * Schiedsrichters um, und der Stand je Stellplatz (offen, getestet, freigegeben, verfallen) folgt aus Angebot und
 * Freigabe-Zeile.
 */
class KoppelbildTest {

    private static final ObjectMapper JSON = new ObjectMapper();
    private static final UUID STEUERUNG = UUID.fromString("7d3c9a10-1111-4222-8333-944455556666");
    private static final Instant T = Instant.parse("2026-11-19T21:30:02Z");
    private static final Koppelbild.Angebot PV = new Koppelbild.Angebot("limit_w", "erzeugung_gesamt", 0, 0, 265_000);

    /** Das Beispiel aus koppelbild.md §15. */
    private static final String VERTRAG = """
            [{"steuerung": "%s", "data_source_id": "DQ-1",
              "lage": "bereit", "gelesen_at": "2026-11-19T21:30:02Z",
              "bibliothek": "1.0", "kopf_urteil": "angenommen", "rest_s": 58, "q_bits": ["fernsteuerung_frei", "edge_lebt"],
              "angenommen_zaehler": 97, "abgelehnt_zaehler": 0,
              "plaetze": [{
                "platz": 1,
                "angebot": {"art": "limit_w", "ziel": "erzeugung_gesamt", "nr": 0, "min": 0, "max": 265000, "bits": ["bereit"]},
                "wunsch": {"art": "limit_w", "grund": "markt", "wert": 159000, "folge": 7}, "test": false,
                "urteil": "angenommen", "folge": 7, "wirksam": 159000
              }]}]""".formatted(STEUERUNG);

    private static JsonNode json(String text) throws Exception {
        return JSON.readTree(text);
    }

    @Test
    void liestDasBeispielDesVertragsVollstaendig() throws Exception {
        List<Koppelbild.Eintrag> e = Koppelbild.lies(json(VERTRAG));
        assertThat(e).singleElement().satisfies(x -> {
            assertThat(x.steuerung()).isEqualTo(STEUERUNG);
            Koppelbild.Stand s = x.stand();
            assertThat(s.lage()).isEqualTo("bereit");
            assertThat(s.gelesenAt()).isEqualTo(T);
            assertThat(s.bibliothek()).isEqualTo("1.0");
            assertThat(s.qBits()).containsExactly("fernsteuerung_frei", "edge_lebt");
            assertThat(s.angenommenZaehler()).isEqualTo(97);
            assertThat(s.angebot(1)).isEqualTo(PV);
            assertThat(s.platz(1).wunsch()).isEqualTo(new Koppelbild.Wunsch("limit_w", "markt", 159_000, 7));
            assertThat(s.platz(1).wirksam()).isEqualTo(159_000L);
            assertThat(s.platz(2)).isNull();
        });
        // Gespeichert und wieder gelesen: dieselbe Aussage (idempotent).
        Koppelbild.Stand s = e.get(0).stand();
        assertThat(Koppelbild.stand(Koppelbild.json(JSON, s))).isEqualTo(s);
    }

    @Test
    void ohneBlockBleibtDerStandEineLeereListeLeertIhn() throws Exception {
        assertThat(Koppelbild.lies(null)).isNull();
        assertThat(Koppelbild.lies(json("{}"))).isNull();
        assertThat(Koppelbild.lies(json("[]"))).isEmpty();
    }

    @Test
    void kaputteEintraegeFallenWegUnbekanntesIstKeinWert() throws Exception {
        List<Koppelbild.Eintrag> e = Koppelbild.lies(json("""
                [{"steuerung": "keine-uuid", "lage": "bereit"},
                 {"steuerung": "%1$s", "lage": "erfunden"},
                 {"steuerung": "%1$s", "lage": "nicht_lesbar", "grund": "signatur_fremd", "kopf_urteil": "neu_in_1_1",
                  "rest_s": 65535, "q_bits": ["fernsteuerung_frei", "frei_ab_bit_3"], "bibliothek": "eins",
                  "plaetze": [{"platz": 9}, {"platz": 2, "angebot": {"art": "limit_pct", "ziel": "erzeugung_gesamt",
                   "nr": 0, "min": 0, "max": 1001, "bits": []}, "urteil": "fremd", "wirksam": 2147483647},
                   {"platz": 3, "angebot": {"art": "mode", "ziel": "verbraucher", "nr": 1, "min": 2, "max": 4,
                   "bits": ["bereit", "grund_vorrang", "bit_6"]}}]},
                 {"steuerung": "%1$s", "lage": "bereit"}]""".formatted(STEUERUNG)));
        assertThat(e).as("ohne UUID oder gültige Lage fällt ein Eintrag weg, die Steuerung zählt einmal").hasSize(1);
        Koppelbild.Stand s = e.get(0).stand();
        assertThat(s.lage()).isEqualTo("nicht_lesbar");
        assertThat(s.grund()).isEqualTo("signatur_fremd");
        assertThat(s.kopfUrteil()).isNull();
        assertThat(s.restS()).isNull();
        assertThat(s.bibliothek()).isNull();
        assertThat(s.qBits()).containsExactly("fernsteuerung_frei");
        assertThat(s.plaetze()).extracting(Koppelbild.Platz::platz).containsExactly(2, 3);
        assertThat(s.angebot(2)).as("Band außerhalb des natürlichen Bands (K27)").isNull();
        assertThat(s.platz(2).urteil()).isNull();
        assertThat(s.platz(2).wirksam()).as("das Typ-Maximum ist kein Wert").isNull();
        assertThat(s.angebot(3)).isEqualTo(new Koppelbild.Angebot("mode", "verbraucher", 1, 2, 4));
        assertThat(s.platz(3).bits()).containsExactly("bereit", "grund_vorrang");
    }

    @Test
    void dieFaehigkeitRechnetInDieEinheitenDesSchiedsrichters() throws Exception {
        assertThat(Koppelbild.faehigkeit(JSON, 1, PV)).isEqualTo(json(
                "{\"command\":\"limit_kw\",\"platz\":1,\"ziel\":\"erzeugung_gesamt\",\"min\":0.0,\"max\":265.0}"));
        assertThat(Koppelbild.faehigkeit(JSON, 2, new Koppelbild.Angebot("limit_pct", "erzeugung_gesamt", 0, 0, 1000)))
                .isEqualTo(json("{\"command\":\"limit_pct\",\"platz\":2,\"ziel\":\"erzeugung_gesamt\",\"min\":0.0,"
                        + "\"max\":100.0}"));
        assertThat(Koppelbild.faehigkeit(JSON, 3, new Koppelbild.Angebot("setpoint_w", "speicher", 1, -20_000, 20_000)))
                .isEqualTo(json("{\"command\":\"setpoint_kw\",\"platz\":3,\"ziel\":\"speicher\",\"min\":-20.0,"
                        + "\"max\":20.0}"));
        assertThat(Koppelbild.faehigkeit(JSON, 4, new Koppelbild.Angebot("setpoint_c", "verbraucher", 2, 455, 700)))
                .isEqualTo(json("{\"command\":\"setpoint_c\",\"platz\":4,\"ziel\":\"verbraucher\",\"min\":45.5,"
                        + "\"max\":70.0,\"step\":0.1}"));
        assertThat(Koppelbild.faehigkeit(JSON, 5, new Koppelbild.Angebot("mode", "verbraucher", 1, 2, 4)))
                .isEqualTo(json("{\"command\":\"mode\",\"platz\":5,\"ziel\":\"verbraucher\",\"modes\":[\"2\",\"3\",\"4\"]}"));
        assertThat(Koppelbild.faehigkeit(JSON, 8, new Koppelbild.Angebot("on_off", "probe", 0, 0, 1)))
                .isEqualTo(json("{\"command\":\"on_off\",\"platz\":8,\"ziel\":\"probe\"}"));
    }

    @Test
    void einAngebotFaelltNurAusEinemStandDerDieStellplaetzeKennt() {
        Koppelbild.Stand lesbar = stand("bereit", List.of(platz(1, PV)));
        assertThat(Koppelbild.angebotGeaendert(lesbar, 1, PV)).isFalse();
        assertThat(Koppelbild.angebotGeaendert(stand("bereit",
                List.of(platz(1, new Koppelbild.Angebot("limit_w", "erzeugung_gesamt", 0, 0, 250_000)))), 1, PV))
                .as("anderes Band").isTrue();
        assertThat(Koppelbild.angebotGeaendert(stand("bereit", List.of()), 1, PV)).as("Stellplatz weg").isTrue();
        assertThat(Koppelbild.angebotGeaendert(stand("keine_antwort", null), 1, PV)).as("unbekannt").isFalse();
        assertThat(Koppelbild.angebotGeaendert(stand("steuerung_fremd", List.of()), 1, PV))
                .as("eine fremde Steuerung spricht nicht für diese").isFalse();
    }

    @Test
    void derStandJeStellplatzFolgtAusAngebotUndFreigabe() {
        Koppelbild.Platz p = platz(1, PV);
        KoppelbildDto.Stellplatz offen = KoppelbildService.stellplatz(1, p, null, List.of(), true);
        assertThat(offen.freigabe().status()).isEqualTo("offen");
        assertThat(offen.freigabeGrund()).isEqualTo("kein_test");
        assertThat(offen.kommando()).isEqualTo("limit_kw");
        assertThat(offen.angebot().bereit()).isTrue();

        Freigabe getestet = zeile(1, PV, T, null, null, null);
        KoppelbildDto.Stellplatz g = KoppelbildService.stellplatz(1, p, getestet, List.of(getestet), true);
        assertThat(g.freigabe().status()).isEqualTo("getestet");
        assertThat(g.freigabeMoeglich()).isTrue();
        assertThat(g.freigabe().test().wert()).isEqualTo(200_000);
        assertThat(KoppelbildService.stellplatz(1, p, getestet, List.of(getestet), false).freigabeGrund())
                .isEqualTo("box_kann_nicht");

        Freigabe frei = zeile(1, PV, T, T.plusSeconds(60), null, null);
        KoppelbildDto.Stellplatz f = KoppelbildService.stellplatz(1, p, frei, List.of(frei), true);
        assertThat(f.freigabe().status()).isEqualTo("freigegeben");
        assertThat(f.freigabeMoeglich()).isFalse();
        assertThat(f.freigabeGrund()).isNull();

        // Ein zweiter Stellplatz mit demselben Kommando: belegt.
        Koppelbild.Angebot pv2 = new Koppelbild.Angebot("limit_w", "einspeisung", 0, 0, 100_000);
        Freigabe zweiter = zeile(2, pv2, T, null, null, null);
        assertThat(KoppelbildService.stellplatz(2, platz(2, pv2), zweiter, List.of(frei, zweiter), true)
                .freigabeGrund()).isEqualTo("kommando_belegt");

        // Das Angebot änderte sich, die Freigabe fiel: verfallen, bis ein neuer Test kommt.
        Freigabe verfallen = zeile(1, PV, T, T.plusSeconds(60), T.plusSeconds(120), "angebot_geaendert");
        Koppelbild.Angebot neu = new Koppelbild.Angebot("limit_w", "erzeugung_gesamt", 0, 0, 250_000);
        KoppelbildDto.Stellplatz v = KoppelbildService.stellplatz(1, platz(1, neu), verfallen, List.of(verfallen), true);
        assertThat(v.freigabe().status()).isEqualTo("verfallen");
        assertThat(v.freigabe().verfallenGrund()).isEqualTo("angebot_geaendert");
        assertThat(v.freigabeGrund()).isEqualTo("kein_test");

        // Zurückgenommen: der alte Test reicht nicht, er muss wiederholt werden.
        Freigabe zurueck = zeile(1, PV, T, T.plusSeconds(60), T.plusSeconds(120), "zurueckgenommen");
        assertThat(KoppelbildService.stellplatz(1, p, zurueck, List.of(zurueck), true).freigabe().status())
                .isEqualTo("offen");

        // Ohne Angebot, aber mit Zeile: der Stellplatz bleibt sichtbar, Kommando aus der Zeile.
        KoppelbildDto.Stellplatz ohne = KoppelbildService.stellplatz(1, null, frei, List.of(frei), true);
        assertThat(ohne.angebot()).isNull();
        assertThat(ohne.kommando()).isEqualTo("limit_kw");
        assertThat(ohne.freigabe().status()).isEqualTo("freigegeben");
    }

    @Test
    void stellplaetzeSindDieDesStandsUndDieMitZeile() {
        Freigabe z = zeile(4, PV, T, null, null, null);
        List<KoppelbildDto.Stellplatz> s = KoppelbildService.stellplaetze(stand("bereit", List.of(platz(1, PV))),
                List.of(z), true);
        assertThat(s).extracting(KoppelbildDto.Stellplatz::platz).containsExactly(1, 4);
        assertThat(KoppelbildService.stellplaetze(null, List.of(), true)).isEmpty();
    }

    private static Koppelbild.Platz platz(int nr, Koppelbild.Angebot a) {
        return new Koppelbild.Platz(nr, a, List.of("bereit"), null, false, "kein_wunsch", 0, null);
    }

    private static Koppelbild.Stand stand(String lage, List<Koppelbild.Platz> plaetze) {
        return new Koppelbild.Stand("DQ-1", lage, null, plaetze == null ? null : T, "1.0", "angenommen", 58,
                List.of("fernsteuerung_frei"), 97, 0, plaetze);
    }

    private static Freigabe zeile(int platz, Koppelbild.Angebot form, Instant testAt, Instant freigegebenAt,
            Instant widerrufenAt, String grund) {
        return new Freigabe(UUID.randomUUID(), UUID.randomUUID(), UUID.randomUUID(), platz, form, form.kommando(),
                testAt, "angenommen", true, 200_000L, "angenommen", 200_000L, 3, testAt, "sub-a", freigegebenAt,
                freigegebenAt == null ? null : "sub-a", freigegebenAt != null, null, widerrufenAt,
                widerrufenAt == null ? null : "sub-a", grund);
    }
}
