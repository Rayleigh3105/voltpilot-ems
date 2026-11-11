package com.voltpilot.api.erzeuger;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;
import com.voltpilot.api.erzeuger.VorgabenAbleitung.Kontext;
import com.voltpilot.api.erzeuger.VorgabenAbleitung.Luecke;
import com.voltpilot.api.erzeuger.VorgabenAbleitung.Vorgabe;
import com.voltpilot.api.erzeuger.VorgabenAbleitung.Zustand;
import com.voltpilot.api.erzeuger.VorgabenVerlauf.Probe;
import java.math.BigDecimal;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * Rein, ohne Docker: die Ableitung der Vorgaben (UEMS EZ-7, Konzept §4.6 auf die schlanke Fassung übersetzt) mit den
 * Folgen der Simulator-Fälle ({@code docs/contracts/v2/erzeuger-simulator-vectors.json}: E1 Gore, E2 Büttner,
 * F7 Neustart) und den Fällen Lücke, Zählersprung, unbekanntes Bitfeld, „nicht bereit“ und Mitternacht.
 */
class VorgabenAbleitungTest {

    private static final Instant T0 = Instant.parse("2026-10-21T10:00:00Z");
    private static final VorgabenAbleitung.Prognose PROGNOSE_200_KW = t -> new BigDecimal("200000");
    private static final VorgabenAbleitung.Preis PREIS_8_2_CT = t -> 8.2;

    // ------------------------------------------------------------------ Gore (E1)

    /** Gore E1, Lesung 1: Netzbetreiber 60 % über Fernwirktechnik, bindet, Anlage folgt; kein Direktvermarkter. */
    private static Map<String, Number> gore() {
        Map<String, Number> w = new LinkedHashMap<>();
        w.put("erzeuger.a.a_gueltig", 9);
        w.put("erzeuger.a.p_erzeugung_w", 158400);
        w.put("erzeuger.a.p_installiert_kw", 265);
        w.put("erzeuger.nb.n_kanal", 3);
        w.put("erzeuger.nb.n_bits", 7);
        w.put("erzeuger.nb.n_p_prozent", 60.0);
        w.put("erzeuger.nb.n_seit_s", 340);
        w.put("erzeuger.nb.n_zaehler", 17);
        w.put("erzeuger.dv.d_kanal", 0);
        w.put("erzeuger.dv.d_bits", 0);
        w.put("erzeuger.dv.d_zaehler", 0);
        w.put("erzeuger.wirkung.quelle_p", 1);
        w.put("erzeuger.wirkung.s_bits", 3);
        w.put("erzeuger.wirkung.p_grenze_w", 159000);
        int[] ist = {52400, 52900, 53100};
        for (int te = 1; te <= 3; te++) {
            w.put("erzeuger.te[" + te + "].t_zustand", 3);
            w.put("erzeuger.te[" + te + "].t_bits", 3);
            w.put("erzeuger.te[" + te + "].t_nenn_kw", 125);
            w.put("erzeuger.te[" + te + "].t_p_ist_w", ist[te - 1]);
            w.put("erzeuger.te[" + te + "].t_p_soll_w", 53000);
        }
        return w;
    }

    private static Kontext pv() {
        return new Kontext("pv", 3, Map.of(), PROGNOSE_200_KW, PREIS_8_2_CT);
    }

    @Test
    void goreSechzigProzentBeginntAufLesezeitMinusSeitUndEndetGenauMitDemNaechstenTelegramm() {
        Map<String, Number> l1 = gore();
        Map<String, Number> l2 = mit(l1, "erzeuger.nb.n_seit_s", 345);
        // E1 Lesung 3: nach 8 s hebt der Netzbetreiber auf 100 % an (n_zaehler 17 → 18, n_seit_s ab 0),
        // 2 s später läuft die Anlage ohne Grenze (quelle_p 0, Grenze ungültig).
        Map<String, Number> l3 = mit(l1, "erzeuger.nb.n_bits", 3, "erzeuger.nb.n_p_prozent", 100.0,
                "erzeuger.nb.n_seit_s", 2, "erzeuger.nb.n_zaehler", 18, "erzeuger.wirkung.quelle_p", 0,
                "erzeuger.a.p_erzeugung_w", 162000);
        l3.remove("erzeuger.wirkung.p_grenze_w");
        Map<String, Number> l4 = mit(l3, "erzeuger.nb.n_seit_s", 7);

        Ergebnis e = leite(pv(), folge(lesung(0, l1), lesung(5, l2), lesung(10, l3), lesung(15, l4)));

        assertThat(e.vorgaben()).hasSize(1);
        Vorgabe v = e.vorgaben().get(0);
        assertThat(v.urheber).isEqualTo("netzbetreiber");
        assertThat(v.art).isEqualTo("p_begrenzung");
        assertThat(v.teNr).isNull();
        assertThat(v.beginn).isEqualTo(T0.minusSeconds(340));
        assertThat(v.beginnGenau).isTrue();
        assertThat(v.ende).isEqualTo(T0.plusSeconds(8));
        assertThat(v.endeGenau).isTrue();
        assertThat(v.kleinsteProzent).isEqualByComparingTo("60");
        // 60 % von 265 kW installiert = 159 kW — die wirksame Grenze des Bilds.
        assertThat(v.kleinsteW).isEqualByComparingTo("159000");
        assertThat(v.kanal).isEqualTo("fernwirktechnik");
        assertThat(v.bindung()).isEqualTo("bindend");
        assertThat(v.zaehlerBeginn).isEqualTo(17L);
        assertThat(v.zaehlerEnde).isEqualTo(18L);
        // Vor der ersten Lesung fehlt, was geschah: unvollständig, auch wenn der Beginn genau ist.
        assertThat(v.unvollstaendig).isTrue();
        assertThat(v.methode).isEqualTo("pv_prognose");
        // ∫ max(0, 200 kW Prognose − 158,4 kW Ist) über die 10 s, in denen der Netzbetreiber band.
        assertThat(v.energieKwh()).isEqualByComparingTo("0.116");
        assertThat(v.istMittelW()).isEqualByComparingTo("158400");
        assertThat(v.verfuegbarMittelW()).isEqualByComparingTo("200000");
        assertThat(v.wertEur()).isEqualByComparingTo("0.01");
        assertThat(v.energieJeTagKwh()).containsOnlyKeys("2026-10-21");
        assertThat(v.rohBeginn).containsEntry("erzeuger.nb.n_bits", new BigDecimal("7"));
        assertThat(v.rohEnde).containsEntry("erzeuger.nb.n_bits", new BigDecimal("3"));
        assertThat(e.luecken()).isEmpty();
    }

    @Test
    void eineGrenzeDieNieBandIstNichtBindendUndKostetNullKwh() {
        // NB 60 %, aber die Anlage regelt selbst tiefer auf den Netzpunkt (quelle_p 3, Nulleinspeisung bei Gore).
        Map<String, Number> l = mit(gore(), "erzeuger.wirkung.quelle_p", 3, "erzeuger.wirkung.p_grenze_w", 41200,
                "erzeuger.a.p_erzeugung_w", 41000);
        Ergebnis e = leite(pv(), folge(lesung(0, l), lesung(5, l), lesung(10, l)));

        Vorgabe nb = e.eine("p_begrenzung", "netzbetreiber", null);
        assertThat(nb.bindung()).isEqualTo("nicht_bindend");
        assertThat(nb.energieKwh()).isEqualByComparingTo("0");
        assertThat(nb.ende).isNull();
        Vorgabe selbst = e.eine("automatik", "anlage", null);
        assertThat(selbst.bindung()).isEqualTo("bindend");
        assertThat(selbst.kleinsteW).isEqualByComparingTo("41200");
        assertThat(selbst.energieKwh()).isPositive();
    }

    @Test
    void ohnePrognoseBleibtDieEnergieLeerNieNull() {
        Map<String, Number> l = gore();
        Ergebnis e = leite(new Kontext("pv", 3, Map.of(), null, null), folge(lesung(0, l), lesung(5, l)));
        Vorgabe v = e.eine("p_begrenzung", "netzbetreiber", null);
        assertThat(v.methode).isNull();
        assertThat(v.energieKwh()).isNull();
        assertThat(v.wertEur()).isNull();
        assertThat(v.bindung()).isEqualTo("bindend");
    }

    // ------------------------------------------------------------------ Büttner (E2)

    /** Büttner E2, Lesung 1: feste 70-%-Grenze, Direktvermarkter aktiviert mit 66 kW (bindet), ohne Netzpunkt. */
    private static Map<String, Number> buettner() {
        Map<String, Number> w = new LinkedHashMap<>();
        w.put("erzeuger.a.a_gueltig", 24);
        w.put("erzeuger.a.p_erzeugung_w", 65700);
        w.put("erzeuger.a.p_installiert_kw", 99);
        w.put("erzeuger.nb.n_kanal", 1);
        w.put("erzeuger.nb.n_bits", 1);
        w.put("erzeuger.nb.n_p_prozent", 70.0);
        w.put("erzeuger.nb.n_zaehler", 0);
        w.put("erzeuger.dv.d_kanal", 1);
        w.put("erzeuger.dv.d_bits", 27);
        w.put("erzeuger.dv.d_soll_w", 66000);
        w.put("erzeuger.dv.d_seit_s", 412);
        w.put("erzeuger.dv.d_zaehler", 5);
        w.put("erzeuger.wirkung.quelle_p", 2);
        w.put("erzeuger.wirkung.s_bits", 3);
        w.put("erzeuger.wirkung.p_grenze_w", 66000);
        int[] nenn = {66, 33};
        int[] ist = {43800, 21900};
        int[] soll = {44000, 22000};
        for (int te = 1; te <= 2; te++) {
            w.put("erzeuger.te[" + te + "].t_zustand", 3);
            w.put("erzeuger.te[" + te + "].t_bits", 15);
            w.put("erzeuger.te[" + te + "].t_nenn_kw", nenn[te - 1]);
            w.put("erzeuger.te[" + te + "].t_p_ist_w", ist[te - 1]);
            w.put("erzeuger.te[" + te + "].t_p_soll_w", soll[te - 1]);
        }
        return w;
    }

    private static Kontext bhkw() {
        return new Kontext("bhkw", 2, Map.of(), null, null);
    }

    @Test
    void buettnerAktivierungDatiertAufDSeitUndSenktDenSollwertInDerselbenVorgabe() {
        Map<String, Number> l1 = buettner();
        Map<String, Number> l2 = mit(l1, "erzeuger.dv.d_seit_s", 417);
        // E2 Lesung 3: nach 6 s senkt der Direktvermarkter auf 45 kW (d_zaehler 5 → 6), die Motoren folgen.
        Map<String, Number> l3 = mit(l1, "erzeuger.dv.d_soll_w", 45000, "erzeuger.dv.d_seit_s", 4,
                "erzeuger.dv.d_zaehler", 6, "erzeuger.wirkung.p_grenze_w", 45000, "erzeuger.a.p_erzeugung_w", 44700,
                "erzeuger.te[1].t_p_soll_w", 30000, "erzeuger.te[1].t_p_ist_w", 29800,
                "erzeuger.te[2].t_p_soll_w", 15000, "erzeuger.te[2].t_p_ist_w", 14900);
        Map<String, Number> l4 = mit(l3, "erzeuger.dv.d_seit_s", 9);

        Ergebnis e = leite(bhkw(), folge(lesung(0, l1), lesung(5, l2), lesung(10, l3), lesung(15, l4)));

        Vorgabe dv = e.eine("dv_aktivierung", "direktvermarkter", null);
        assertThat(dv.beginn).isEqualTo(T0.minusSeconds(412));
        assertThat(dv.beginnGenau).isTrue();
        assertThat(dv.ende).isNull();
        assertThat(dv.kleinsteW).isEqualByComparingTo("45000");
        assertThat(dv.kleinsteProzent).isEqualByComparingTo("45.45");
        assertThat(dv.kanal).isEqualTo("relais_ma");
        assertThat(dv.bindung()).isEqualTo("bindend");
        assertThat(dv.zaehlerBeginn).isEqualTo(5L);
        assertThat(dv.zaehlerEnde).isEqualTo(6L);
        // Verfügbar = Nennleistung der bereiten Motoren (66 + 33 kW); Ist 65,7 kW für 10 s, dann 44,7 kW für 5 s.
        assertThat(dv.methode).isEqualTo("nennleistung_bereite_motoren");
        assertThat(dv.energieKwh()).isEqualByComparingTo("0.168");
        assertThat(dv.wertEur()).as("Biogas: keine Preisgrundlage bis EZ-12").isNull();
        // Je Einheit dasselbe Signal aus t_bits Bit 3, mit dem Sollwert der Einheit.
        Vorgabe te1 = e.eine("dv_aktivierung", "direktvermarkter", 1);
        assertThat(te1.kleinsteW).isEqualByComparingTo("30000");
        assertThat(te1.kleinsteProzent).isEqualByComparingTo("45.45");
        assertThat(e.eine("dv_aktivierung", "direktvermarkter", 2).kleinsteW).isEqualByComparingTo("15000");
        // Die feste 70-%-Grenze gilt, bindet aber nicht (der Direktvermarkter fährt darunter).
        Vorgabe nb = e.eine("p_begrenzung", "netzbetreiber", null);
        assertThat(nb.kanal).isEqualTo("feste_grenze");
        assertThat(nb.beginnGenau).as("n_seit_s ungültig bei fester Grenze (B5)").isFalse();
        assertThat(nb.bindung()).isEqualTo("nicht_bindend");
        assertThat(nb.kleinsteW).isEqualByComparingTo("69300");
        assertThat(e.vorgaben()).extracting(x -> x.art).doesNotContain("nicht_bereit", "dv_stopp");
    }

    @Test
    void nichtBereitJeEinheitMitGruendenSolangeEinDvKanalEingerichtetIst() {
        Map<String, Number> l1 = buettner();
        // Motor 2: bereit fällt (Bit 2), Grund Gasspeicher leer (Bit 8); Werte und Sollwert gültig (Bit 0, 1).
        Map<String, Number> l2 = mit(l1, "erzeuger.te[2].t_bits", 3 | (1 << 8));
        Map<String, Number> l3 = mit(l1);

        Ergebnis e = leite(bhkw(), folge(lesung(0, l1), lesung(5, l2), lesung(10, l2), lesung(15, l3)));

        Vorgabe v = e.eine("nicht_bereit", "anlage", 2);
        assertThat(v.beginn).isEqualTo(T0.plusSeconds(5));
        assertThat(v.ende).isEqualTo(T0.plusSeconds(15));
        assertThat(v.gruende).containsExactly("gasspeicher_leer");
        assertThat(v.bindung()).isNull();
        assertThat(v.energieKwh()).isNull();
        assertThat(v.unvollstaendig).isFalse();
        // Gore hat keinen Direktvermarkter (d_kanal 0): dort ist „nicht bereit“ kein Thema.
        Ergebnis gore = leite(pv(), folge(lesung(0, mit(gore(), "erzeuger.te[1].t_bits", 1))));
        assertThat(gore.vorgaben()).extracting(x -> x.art).doesNotContain("nicht_bereit");
    }

    @Test
    void eineNetzbetreiberGrenzeWaehrendDesAbrufsSchaetztGegenDenSollwertDavor() {
        Map<String, Number> frei = mit(buettner(), "erzeuger.nb.n_p_prozent", 100.0);
        // Der Netzbetreiber senkt auf 30 % und bindet: die Motoren fahren 29,7 kW statt der 66 kW des Abrufs.
        Map<String, Number> grenze = mit(frei, "erzeuger.nb.n_bits", 5, "erzeuger.nb.n_p_prozent", 30.0,
                "erzeuger.wirkung.quelle_p", 1, "erzeuger.wirkung.p_grenze_w", 29700, "erzeuger.a.p_erzeugung_w", 29700);
        Ergebnis e = leite(bhkw(), folge(lesung(0, frei), lesung(5, grenze), lesung(65, grenze)));

        Vorgabe nb = e.eine("p_begrenzung", "netzbetreiber", null);
        assertThat(nb.methode).isEqualTo("dv_sollwert_davor");
        assertThat(nb.verfuegbarDavorW).isEqualByComparingTo("66000");
        // (66 − 29,7) kW über 60 s.
        assertThat(nb.energieKwh()).isEqualByComparingTo("0.605");
        assertThat(e.eine("dv_aktivierung", "direktvermarkter", null).bindung()).isEqualTo("bindend");
    }

    // ------------------------------------------------------------------ Lücken, Zähler, Neustart

    @Test
    void eineLueckeMitZaehlersprungMeldetWeitereWechselOhneErfundeneZeiten() {
        Map<String, Number> frei = mit(gore(), "erzeuger.nb.n_bits", 3, "erzeuger.nb.n_p_prozent", 100.0,
                "erzeuger.wirkung.quelle_p", 0, "erzeuger.nb.n_seit_s", 100);
        List<Probe> proben = new ArrayList<>();
        for (int s = 0; s <= 20; s += 5) {
            proben.addAll(lesung(s, mit(frei, "erzeuger.nb.n_seit_s", 100 + s)));
        }
        // Zehn Minuten keine Lesung; danach begrenzt der Netzbetreiber seit 30 s, und n_zaehler steht vier weiter.
        Map<String, Number> nachher = mit(gore(), "erzeuger.nb.n_seit_s", 30, "erzeuger.nb.n_zaehler", 21);
        proben.addAll(lesung(620, nachher));
        proben.addAll(lesung(625, mit(nachher, "erzeuger.nb.n_seit_s", 35)));

        Ergebnis e = leite(pv(), proben);

        Vorgabe v = e.eine("p_begrenzung", "netzbetreiber", null);
        assertThat(v.beginn).isEqualTo(T0.plusSeconds(590));
        assertThat(v.beginnGenau).isTrue();
        assertThat(v.unvollstaendig).isTrue();
        assertThat(e.luecken()).hasSize(1);
        Luecke l = e.luecken().get(0);
        assertThat(l.urheber()).isEqualTo("netzbetreiber");
        assertThat(l.beginn()).isEqualTo(T0.plusSeconds(20));
        assertThat(l.ende()).isEqualTo(T0.plusSeconds(620));
        // 17 → 21 sind vier Vorgaben; gesehen ist eine (vorher frei, nachher 60 %): drei weitere.
        assertThat(l.weitereWechsel()).isEqualTo(3);
        assertThat(l.zaehlerVorher()).isEqualTo(17L);
        assertThat(l.zaehlerNachher()).isEqualTo(21L);
        assertThat(l.neustart()).isFalse();
    }

    @Test
    void eineVorgabeOhneSeitEndetInDerLueckeBeiDerLetztenLesungInDerSieGalt() {
        Map<String, Number> an = buettner();
        Map<String, Number> aus = mit(an, "erzeuger.dv.d_bits", 25, "erzeuger.wirkung.quelle_p", 0);
        List<Probe> proben = new ArrayList<>();
        proben.addAll(lesung(0, ohne(an, "erzeuger.dv.d_seit_s")));
        proben.addAll(lesung(5, ohne(an, "erzeuger.dv.d_seit_s")));
        proben.addAll(lesung(400, ohne(aus, "erzeuger.dv.d_seit_s")));

        Vorgabe v = leite(bhkw(), proben).eine("dv_aktivierung", "direktvermarkter", null);
        assertThat(v.ende).isEqualTo(T0.plusSeconds(5));
        assertThat(v.endeGenau).isFalse();
        assertThat(v.unvollstaendig).isTrue();
    }

    @Test
    void zaehlerUeberlaufIstKeinNeustartUndKeineLuecke() {
        Map<String, Number> a = mit(gore(), "erzeuger.nb.n_zaehler", 65535);
        Map<String, Number> b = mit(gore(), "erzeuger.nb.n_zaehler", 1, "erzeuger.nb.n_p_prozent", 50.0,
                "erzeuger.nb.n_seit_s", 1);
        Ergebnis e = leite(pv(), folge(lesung(0, a), lesung(5, b)));
        Vorgabe v = e.eine("p_begrenzung", "netzbetreiber", null);
        assertThat(v.neustart).isFalse();
        assertThat(v.kleinsteProzent).isEqualByComparingTo("50");
        assertThat(e.luecken()).isEmpty();
    }

    @Test
    void neustartDerSteuerungLaesstDieVorgabeLaufenUndDatiertNichtAufDenProgrammstart() {
        // F7: nach Lesung 2 startet das Programm neu; die 60 % bleiben (GVL_RETAIN), die Verbindung steht noch nicht,
        // Herzschlag, n_zaehler und n_seit_s beginnen bei 0.
        Map<String, Number> l1 = gore();
        Map<String, Number> l2 = mit(l1, "erzeuger.nb.n_seit_s", 345);
        Map<String, Number> l3 = mit(l1, "erzeuger.nb.n_bits", 5, "erzeuger.nb.n_seit_s", 3,
                "erzeuger.nb.n_zaehler", 0);
        Map<String, Number> l4 = mit(l3, "erzeuger.nb.n_seit_s", 8);
        List<Probe> proben = new ArrayList<>();
        proben.addAll(lesung(0, l1));
        proben.addAll(lesung(5, l2));
        proben.addAll(lesung(10, l3));
        proben.addAll(lesung(15, l4));

        Ergebnis mitEreignis = leite(pv(), proben, List.of(), List.of(T0.plusSeconds(10)));
        Ergebnis ohneEreignis = leite(pv(), proben, List.of(), List.of());
        for (Ergebnis e : List.of(mitEreignis, ohneEreignis)) {
            assertThat(e.vorgaben()).hasSize(1);
            Vorgabe v = e.vorgaben().get(0);
            assertThat(v.ende).isNull();
            assertThat(v.neustart).isTrue();
            assertThat(v.zaehlerBeginn).isEqualTo(17L);
            assertThat(v.zaehlerEnde).isEqualTo(0L);
            assertThat(e.luecken()).isEmpty();
        }
    }

    @Test
    void einNeustartInEinerLueckeMachtDieZahlDerWechselUnbekanntNichtNull() {
        Map<String, Number> frei = mit(gore(), "erzeuger.nb.n_bits", 3, "erzeuger.nb.n_p_prozent", 100.0,
                "erzeuger.wirkung.quelle_p", 0);
        List<Probe> proben = new ArrayList<>(lesung(0, frei));
        proben.addAll(lesung(300, mit(frei, "erzeuger.nb.n_zaehler", 2, "erzeuger.nb.n_seit_s", 40)));

        Ergebnis e = leite(pv(), proben, List.of(), List.of(T0.plusSeconds(200)));
        assertThat(e.luecken()).singleElement().satisfies(l -> {
            assertThat(l.weitereWechsel()).isNull();
            assertThat(l.neustart()).isTrue();
        });
    }

    @Test
    void einUnbekanntesBitfeldSchliesstNichtsUndMachtUnvollstaendig() {
        Map<String, Number> frei = mit(gore(), "erzeuger.nb.n_bits", 3, "erzeuger.nb.n_p_prozent", 100.0);
        Map<String, Number> an = mit(gore(), "erzeuger.nb.n_seit_s", 2);
        Map<String, Number> unbekannt = mit(an, "erzeuger.nb.n_bits", 0xFFFF, "erzeuger.nb.n_seit_s", 7);
        Map<String, Number> wieder = mit(an, "erzeuger.nb.n_seit_s", 12);

        Vorgabe sauber = leite(pv(), folge(lesung(0, frei), lesung(5, an), lesung(15, wieder)))
                .eine("p_begrenzung", "netzbetreiber", null);
        assertThat(sauber.beginn).isEqualTo(T0.plusSeconds(3));
        assertThat(sauber.unvollstaendig).isFalse();

        Ergebnis e = leite(pv(), folge(lesung(0, frei), lesung(5, an), lesung(10, unbekannt), lesung(15, wieder)));
        Vorgabe v = e.eine("p_begrenzung", "netzbetreiber", null);
        assertThat(v.ende).isNull();
        assertThat(v.unvollstaendig).isTrue();
        assertThat(e.vorgaben()).hasSize(1);
    }

    @Test
    void ueberMitternachtTeiltSichDieEnergieAufZweiTage() {
        Instant abend = Instant.parse("2026-10-21T21:59:30Z"); // 23:59:30 in Berlin (Sommerzeit)
        List<Probe> proben = new ArrayList<>();
        for (int s = 0; s <= 60; s += 5) {
            proben.addAll(lesungAb(abend, s, mit(gore(), "erzeuger.nb.n_seit_s", 340 + s)));
        }
        Vorgabe v = leite(pv(), proben).eine("p_begrenzung", "netzbetreiber", null);
        assertThat(v.energieJeTagKwh()).containsOnlyKeys("2026-10-21", "2026-10-22");
        assertThat(v.energieJeTagWh.get("2026-10-21")).isCloseTo(v.energieJeTagWh.get("2026-10-22"),
                org.assertj.core.data.Offset.offset(1e-9));
    }

    @Test
    void derZustandUeberstehtJsonUndEinZweiterLaufSetztNahtlosFort() throws Exception {
        Map<String, Number> l1 = gore();
        Map<String, Number> l3 = mit(l1, "erzeuger.nb.n_bits", 3, "erzeuger.nb.n_p_prozent", 100.0,
                "erzeuger.nb.n_seit_s", 2, "erzeuger.nb.n_zaehler", 18, "erzeuger.wirkung.quelle_p", 0);
        List<Probe> alle = new ArrayList<>();
        alle.addAll(lesung(0, l1));
        alle.addAll(lesung(5, mit(l1, "erzeuger.nb.n_seit_s", 345)));
        alle.addAll(lesung(10, l3));
        alle.addAll(lesung(15, mit(l3, "erzeuger.nb.n_seit_s", 7)));
        Vorgabe inEinem = leite(pv(), alle).vorgaben().get(0);

        ObjectMapper json = new ObjectMapper().findAndRegisterModules()
                .disable(SerializationFeature.WRITE_DATES_AS_TIMESTAMPS);
        Zustand z = new Zustand();
        VorgabenAbleitung erster = new VorgabenAbleitung(pv(), z);
        Instant mitte = T0.plusSeconds(7);
        VorgabenVerlauf.lesungen(z.getragen, alle, T0.minusSeconds(1), mitte, List.of(), List.of())
                .forEach(erster::lesung);
        Zustand gelesen = json.readValue(json.writeValueAsString(erster.zustand()), Zustand.class);
        VorgabenAbleitung zweiter = new VorgabenAbleitung(pv(), gelesen);
        VorgabenVerlauf.lesungen(gelesen.getragen, alle, mitte, T0.plusSeconds(15), List.of(), List.of())
                .forEach(zweiter::lesung);

        Vorgabe inZwei = zweiter.geaendert().get(0);
        assertThat(inZwei.id).isEqualTo(erster.geaendert().get(0).id);
        assertThat(inZwei.ende).isEqualTo(inEinem.ende);
        assertThat(inZwei.energieKwh()).isEqualByComparingTo(inEinem.energieKwh());
        assertThat(inZwei.zaehlerEnde).isEqualTo(inEinem.zaehlerEnde);
    }

    // ------------------------------------------------------------------ Helfer

    record Ergebnis(List<Vorgabe> vorgaben, List<Luecke> luecken) {
        Vorgabe eine(String art, String urheber, Integer teNr) {
            List<Vorgabe> treffer = vorgaben.stream().filter(v -> v.art.equals(art) && v.urheber.equals(urheber)
                    && java.util.Objects.equals(v.teNr, teNr)).toList();
            assertThat(treffer).as(art + "/" + urheber + "/" + teNr).hasSize(1);
            return treffer.get(0);
        }
    }

    private static Ergebnis leite(Kontext k, List<Probe> proben) {
        return leite(k, proben, List.of(), List.of());
    }

    private static Ergebnis leite(Kontext k, List<Probe> proben, List<Instant> luecken, List<Instant> neustarts) {
        List<Probe> sortiert = new ArrayList<>(proben);
        sortiert.sort(java.util.Comparator.comparing(Probe::zeit));
        Zustand z = new Zustand();
        VorgabenAbleitung a = new VorgabenAbleitung(k, z);
        Instant bis = sortiert.get(sortiert.size() - 1).zeit();
        VorgabenVerlauf.lesungen(z.getragen, sortiert, Instant.EPOCH, bis, luecken, neustarts).forEach(a::lesung);
        return new Ergebnis(a.geaendert(), a.luecken());
    }

    private static List<Probe> lesung(int sekunde, Map<String, Number> werte) {
        return lesungAb(T0, sekunde, werte);
    }

    @SafeVarargs
    private static List<Probe> folge(List<Probe>... lesungen) {
        List<Probe> out = new ArrayList<>();
        for (List<Probe> l : lesungen) {
            out.addAll(l);
        }
        return out;
    }

    private static List<Probe> lesungAb(Instant start, int sekunde, Map<String, Number> werte) {
        Instant t = start.plusSeconds(sekunde);
        List<Probe> out = new ArrayList<>();
        werte.forEach((punkt, wert) -> out.add(new Probe(t, punkt, new BigDecimal(wert.toString()), "good")));
        return out;
    }

    private static Map<String, Number> mit(Map<String, Number> basis, Object... paare) {
        Map<String, Number> w = new LinkedHashMap<>(basis);
        for (int i = 0; i < paare.length; i += 2) {
            w.put((String) paare[i], (Number) paare[i + 1]);
        }
        return w;
    }

    private static Map<String, Number> ohne(Map<String, Number> basis, String punkt) {
        Map<String, Number> w = new LinkedHashMap<>(basis);
        w.remove(punkt);
        return w;
    }
}
