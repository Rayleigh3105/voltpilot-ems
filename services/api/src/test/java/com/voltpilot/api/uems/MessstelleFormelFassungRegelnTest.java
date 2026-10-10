package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.uems.MessstelleFormelRegeln.Fassung;
import com.voltpilot.api.uems.MessstelleFormelRegeln.FassungFehler;
import com.voltpilot.api.uems.MessstelleFormelRegeln.FassungUrteil;
import com.voltpilot.api.uems.MessstelleFormelRegeln.Summand;
import com.voltpilot.api.uems.MessstelleRegeln.Groesse;
import java.nio.file.Path;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * Die Tages-Regeln der Formel-Fassungen (UEMS AP-10 IP-3, Vertrag {@code messstelle-formel.md} §6)
 * in {@link MessstelleFormelRegeln} — rein, ohne Spring, ohne Datenbank.
 *
 * <p>Kennzeichen, Tage und Werte aus dem Referenzunternehmen Ahrenberg (Fassung 1.2): die Formel von
 * MS-22 „MS-16 − MS-17 − MS-18“ (Werk Lindach) und die Tageswerte des 18.10.2026 (100 · 60 · 30 kWh) —
 * die Plan-Abnahme des Captains.
 */
class MessstelleFormelFassungRegelnTest {

    private static final ZoneId BERLIN = ZoneId.of("Europe/Berlin");
    private static final Path REFERENZ = Path.of("..", "..", "docs", "contracts", "v2", "uems-referenzunternehmen.json");

    /** Der Bestand von PR #688: Fassung 1 ohne ersten Tag. */
    private static final Fassung BESTAND = new Fassung(1, null, null);

    private static OffsetDateTime um(String zeit) {
        return OffsetDateTime.parse(zeit);
    }

    private static LocalDate tag(String t) {
        return LocalDate.parse(t);
    }

    // =============================================================== gilt ab ihrem Tag

    @Test
    void eineFassungGiltAbIhremTagUndNichtRueckwaerts() {
        List<Fassung> wirksam = List.of(new Fassung(1, tag("2026-10-15"), tag("2026-10-17")),
                new Fassung(2, tag("2026-10-18"), null));

        assertThat(MessstelleFormelRegeln.fassungAm(wirksam, tag("2026-10-14"))).as("vor Fassung 1").isEmpty();
        assertThat(MessstelleFormelRegeln.fassungAm(wirksam, tag("2026-10-15"))).get()
                .extracting(Fassung::nummer).isEqualTo(1);
        // Der letzte Tag ist eingeschlossen …
        assertThat(MessstelleFormelRegeln.fassungAm(wirksam, tag("2026-10-17"))).get()
                .extracting(Fassung::nummer).isEqualTo(1);
        // … und Fassung 2 gilt ab ihrem Tag, nie davor.
        assertThat(MessstelleFormelRegeln.fassungAm(wirksam, tag("2026-10-18"))).get()
                .extracting(Fassung::nummer).isEqualTo(2);
        assertThat(MessstelleFormelRegeln.fassungAm(wirksam, tag("2027-12-31"))).get()
                .extracting(Fassung::nummer).isEqualTo(2);
    }

    @Test
    void derBestandGiltSeitBeginnBisZumVortagDerNaechstenFassung() {
        assertThat(MessstelleFormelRegeln.fassungAm(List.of(BESTAND), tag("2000-01-01"))).contains(BESTAND);
        List<Fassung> danach = List.of(new Fassung(1, null, tag("2026-10-17")), new Fassung(2, tag("2026-10-18"), null));
        assertThat(MessstelleFormelRegeln.fassungAm(danach, tag("2020-01-01"))).get()
                .extracting(Fassung::nummer).isEqualTo(1);
        assertThat(MessstelleFormelRegeln.fassungAm(danach, tag("2026-10-18"))).get()
                .extracting(Fassung::nummer).isEqualTo(2);
    }

    // ===================================================== neue Fassung beendet die laufende

    @Test
    void eineNeueFassungBeendetDieLaufendeAmVortag() {
        // Eingetragen am 18.10.2026 um 10:00 in Lindach, gültig ab demselben Tag.
        FassungUrteil u = MessstelleFormelRegeln.fassungEintrag(List.of(BESTAND), tag("2026-10-18"),
                um("2026-10-18T10:00:00+02:00"), BERLIN);
        assertThat(u.fehler()).isNull();
        assertThat(u.nummer()).isEqualTo(2);
        assertThat(u.ab()).isEqualTo(tag("2026-10-18"));
        assertThat(u.beenden()).isEqualTo(BESTAND);
        assertThat(u.beendenAm()).isEqualTo(tag("2026-10-17"));
        assertThat(u.rueckwirkend()).as("ab heute ist nicht rückwirkend").isFalse();
        assertThat(u.abzeichen()).isNull();

        // Die erste Fassung einer Messstelle ohne Formel: Fassung 1, nichts zu beenden.
        FassungUrteil erste = MessstelleFormelRegeln.fassungEintrag(List.of(), tag("2026-10-15"),
                um("2026-10-15T08:00:00+02:00"), BERLIN);
        assertThat(erste.fehler()).isNull();
        assertThat(erste.nummer()).isEqualTo(1);
        assertThat(erste.beenden()).isNull();

        // Fassung 3 nach Fassung 2: Fassung 2 endet am Vortag, Fassung 1 bleibt, wie sie ist.
        FassungUrteil dritte = MessstelleFormelRegeln.fassungEintrag(
                List.of(new Fassung(1, null, tag("2026-10-17")), new Fassung(2, tag("2026-10-18"), null)),
                tag("2026-11-01"), um("2026-10-20T09:00:00+02:00"), BERLIN);
        assertThat(dritte.nummer()).isEqualTo(3);
        assertThat(dritte.beenden().nummer()).isEqualTo(2);
        assertThat(dritte.beendenAm()).isEqualTo(tag("2026-10-31"));
        assertThat(dritte.rueckwirkend()).as("geplant ist nicht rückwirkend").isFalse();
    }

    // ============================================================== Überlappung abgelehnt

    @Test
    void eineUeberlappungWirdAbgelehnt() {
        List<Fassung> wirksam = List.of(new Fassung(1, null, tag("2026-10-17")), new Fassung(2, tag("2026-10-18"), null));

        FassungUrteil gleicherTag = MessstelleFormelRegeln.fassungEintrag(wirksam, tag("2026-10-18"),
                um("2026-10-20T09:00:00+02:00"), BERLIN);
        assertThat(gleicherTag.fehler()).isEqualTo(FassungFehler.FORMEL_FASSUNG_UEBERLAPPT);
        assertThat(gleicherTag.fehler().code()).isEqualTo("formel_fassung_ueberlappt");
        assertThat(gleicherTag.fehler().status()).isEqualTo(422);
        // Der Kundensatz des Konzepts (AP-10 §5.9).
        assertThat(gleicherTag.satz()).isEqualTo("Ab diesem Tag gilt schon Fassung 2.");
        assertThat(gleicherTag.konflikt().nummer()).isEqualTo(2);

        FassungUrteil davor = MessstelleFormelRegeln.fassungEintrag(wirksam, tag("2026-10-16"),
                um("2026-10-20T09:00:00+02:00"), BERLIN);
        assertThat(davor.fehler()).isEqualTo(FassungFehler.FORMEL_FASSUNG_UEBERLAPPT);
        assertThat(davor.satz()).isEqualTo("Ab dem 18.10.2026 gilt schon Fassung 2 — eine neue Fassung beginnt nach diesem Tag.");

        // Der Code steht im Vertrag der Bilanz (fehler_neu) — und NICHT in der Fehlertabelle von
        // messstelle-formel-vectors.json, die mit AP-10 unberührt bleibt.
        assertThat(MessstelleFormelRegeln.Fehler.values()).extracting(MessstelleFormelRegeln.Fehler::code)
                .doesNotContain("formel_fassung_ueberlappt");
    }

    // ============================================================= rückwirkend gekennzeichnet

    @Test
    void eineRueckwirkendeFassungTraegtIhrKennzeichenSamtTagen() {
        // Eingetragen am 20.10.2026, gültig ab 15.10.2026: fünf Tage rückwirkend.
        FassungUrteil u = MessstelleFormelRegeln.fassungEintrag(List.of(BESTAND), tag("2026-10-15"),
                um("2026-10-20T09:30:00+02:00"), BERLIN);
        assertThat(u.fehler()).isNull();
        assertThat(u.rueckwirkend()).isTrue();
        assertThat(u.tage()).isEqualTo(5);
        assertThat(u.abzeichen()).isEqualTo("rückwirkend (5 Tage)");

        FassungUrteil einTag = MessstelleFormelRegeln.fassungEintrag(List.of(BESTAND), tag("2026-10-19"),
                um("2026-10-20T09:30:00+02:00"), BERLIN);
        assertThat(einTag.abzeichen()).isEqualTo("rückwirkend (1 Tag)");
    }

    @Test
    void derEintragstagZaehltInDerZeitzoneDesStandorts() {
        // 17.10.2026 22:30 UTC ist in Lindach schon der 18.10. (00:30) — „ab 18.10." ist ab heute.
        FassungUrteil u = MessstelleFormelRegeln.fassungEintrag(List.of(BESTAND), tag("2026-10-18"),
                um("2026-10-17T22:30:00Z"), BERLIN);
        assertThat(u.rueckwirkend()).isFalse();
        // Eine Minute vor Mitternacht am Standort ist „ab 17.10." noch ab heute, nicht rückwirkend.
        FassungUrteil v = MessstelleFormelRegeln.fassungEintrag(List.of(BESTAND), tag("2026-10-17"),
                um("2026-10-17T21:59:00Z"), BERLIN);
        assertThat(v.rueckwirkend()).isFalse();
    }

    // ============================================================= die Hauptgröße bleibt

    @Test
    void eineFassungMitAndererHauptgroesseNenntDasErsteVerletzteMerkmal() {
        Groesse bezug = new Groesse("Wirkenergie", "Bezug", "kWh", "Intervallmenge");
        assertThat(MessstelleFormelRegeln.hauptgroesseAbweichung(bezug, bezug)).isNull();
        assertThat(MessstelleFormelRegeln.hauptgroesseAbweichung(bezug,
                new Groesse("Wirkleistung", "Bezug", "kW", "Momentanwert"))).isEqualTo("groesse");
        assertThat(MessstelleFormelRegeln.hauptgroesseAbweichung(bezug,
                new Groesse("Wirkenergie", "Bezug", "kWh", "Zählerstand"))).isEqualTo("wertart");
        assertThat(MessstelleFormelRegeln.hauptgroesseAbweichung(bezug,
                new Groesse("Wirkenergie", "Abgabe", "kWh", "Intervallmenge"))).isEqualTo("richtung");
    }

    // ===================================================== der Abnahmefall über die Fassung

    /**
     * Die Plan-Abnahme (F1): am 18.10.2026 in Werk Lindach 100 kWh am Hauptzähler MS-16, 60 und 30 kWh
     * an MS-17 und MS-18 — die Formel „MS-16 − MS-17 − MS-18“ ergibt 10 kWh. Gerechnet mit den Termen
     * der Fassung DES TAGES: eine Fassung 2 ab 19.10.2026 (nur MS-16 − MS-17) ändert den 18.10. nicht.
     * Die Richtung „Bezug“ des Typs {@code rest} ist AP-10 IP-4; hier zählt die Summe.
     */
    @Test
    void derAbnahmefallRechnetUeberDieFassungDesTages() throws Exception {
        JsonNode ref = new ObjectMapper().readTree(REFERENZ.toFile());
        Map<String, Double> tageswert = new LinkedHashMap<>();
        for (JsonNode m : ref.path("messstellen")) {
            JsonNode w = m.path("beispielwerte").path("tag_2026_10_18_kwh");
            if (!w.isMissingNode() && !w.isNull()) {
                tageswert.put(m.path("kennzeichen").asText(), w.asDouble());
            }
        }
        assertThat(ref.path("messstellen").findValuesAsText("formel")).contains("MS-16 − MS-17 − MS-18");
        assertThat(tageswert).containsEntry("MS-16", 100.0).containsEntry("MS-17", 60.0)
                .containsEntry("MS-18", 30.0).containsEntry("MS-22", 10.0);

        // Die Fassungen: 1 = MS-16 − MS-17 − MS-18 (seit Beginn bis 18.10.), 2 = MS-16 − MS-17 (ab 19.10.).
        Map<Integer, List<String[]>> terme = Map.of(
                1, List.of(new String[] {"+", "MS-16"}, new String[] {"-", "MS-17"}, new String[] {"-", "MS-18"}),
                2, List.of(new String[] {"+", "MS-16"}, new String[] {"-", "MS-17"}));
        List<Fassung> wirksam = List.of(new Fassung(1, null, tag("2026-10-18")), new Fassung(2, tag("2026-10-19"), null));

        Fassung amTag = MessstelleFormelRegeln.fassungAm(wirksam, tag("2026-10-18")).orElseThrow();
        List<Summand> summanden = new ArrayList<>();
        for (String[] t : terme.get(amTag.nummer())) {
            summanden.add(new Summand(t[0], 1.0, tageswert.get(t[1]), "kWh"));
        }
        MessstelleFormelRegeln.SummeUrteil u = MessstelleFormelRegeln.gewichteteSumme("kWh", summanden);
        assertThat(amTag.nummer()).isEqualTo(1);
        assertThat(u.wert()).isEqualTo(tageswert.get("MS-22")).isEqualTo(10.0);
        assertThat(u.unvollstaendig()).isFalse();
    }
}
