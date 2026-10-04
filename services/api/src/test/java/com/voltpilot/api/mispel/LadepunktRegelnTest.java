package com.voltpilot.api.mispel;

import static org.assertj.core.api.Assertions.assertThat;

import com.voltpilot.api.mispel.LadepunktRegeln.Faehigkeit;
import com.voltpilot.api.mispel.LadepunktRegeln.Fahrzeugfenster;
import com.voltpilot.api.mispel.LadepunktRegeln.Fenster;
import com.voltpilot.api.mispel.LadepunktRegeln.Z2;
import com.voltpilot.api.uems.ZaehlerrolleRegeln;
import java.math.BigDecimal;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.LocalTime;
import java.util.List;
import org.junit.jupiter.api.Test;

/** MiSpeL MP-31 rein: Form der Fähigkeit und des Fahrzeugfensters, Einordnung nach Anlage 1, Befunde. */
class LadepunktRegelnTest {

    private static final Faehigkeit V2H = new Faehigkeit("bidirektional", true, false, false, new BigDecimal("7.4"));
    private static final Faehigkeit V2G = new Faehigkeit("bidirektional", true, true, false, null);
    private static final Faehigkeit V2H_GESPERRT = new Faehigkeit("bidirektional", true, false, true, null);

    @Test
    void formDerFaehigkeit() {
        assertThat(LadepunktRegeln.formPruefen(V2H)).isNull();
        assertThat(LadepunktRegeln.formPruefen(V2G)).isNull();
        assertThat(LadepunktRegeln.formPruefen(V2H_GESPERRT)).isNull();
        assertThat(LadepunktRegeln.formPruefen(Faehigkeit.BESTAND)).isNull();
        assertThat(grund(new Faehigkeit("beides", true, false, false, null))).isEqualTo("nutzbarkeit");
        assertThat(grund(new Faehigkeit(null, false, false, false, null))).isEqualTo("nutzbarkeit");
        assertThat(grund(new Faehigkeit("bidirektional", false, false, false, null))).isEqualTo("betriebsweise");
        assertThat(grund(new Faehigkeit("unidirektional", true, false, false, null)))
                .isEqualTo("angaben_ohne_rueckspeisung");
        assertThat(grund(new Faehigkeit("unidirektional", false, false, false, BigDecimal.TEN)))
                .isEqualTo("angaben_ohne_rueckspeisung");
        assertThat(grund(new Faehigkeit("bidirektional", false, true, true, null))).isEqualTo("unterbunden");
        assertThat(grund(new Faehigkeit("bidirektional", true, false, false, BigDecimal.ZERO)))
                .isEqualTo("rueckspeiseleistung");
        assertThat(grund(new Faehigkeit("bidirektional", true, false, false, new BigDecimal("1000.1"))))
                .isEqualTo("rueckspeiseleistung");
    }

    @Test
    void einordnungNachAnlage1() {
        // A1 S. 26: unidirektional = sonstiger Verbrauch; Fn. 21: V2H und V2G sind Ladepunkte der Festlegung;
        // Fn. 22: V2H mit Sperre bei gleichzeitiger Einspeisung = Alternative zur Ausschließlichkeitsoption.
        assertThat(LadepunktRegeln.einordnung(Faehigkeit.BESTAND)).isEqualTo("sonstiger_verbrauch");
        assertThat(LadepunktRegeln.einordnung(V2H)).isEqualTo("ladepunkt_der_festlegung");
        assertThat(LadepunktRegeln.einordnung(V2G)).isEqualTo("ladepunkt_der_festlegung");
        assertThat(LadepunktRegeln.einordnung(V2H_GESPERRT)).isEqualTo("alternative_zur_ausschliesslichkeit");
        assertThat(LadepunktRegeln.einordnungFundstelle("alternative_zur_ausschliesslichkeit"))
                .isEqualTo("Anlage 1 S. 27, Fn. 22; Abschn. 2.1.3");
    }

    @Test
    void befundeAmLadepunkt() {
        Z2 v = z2("Z2V", "MS-03", "tauglich");
        Z2 e = z2("Z2E", "MS-04", "tauglich");
        // Bestand hinter Z2: sonstiger Verbrauch hinter dem Speicher-/Ladepunktzähler (A1 S. 25–26).
        assertThat(codes(LadepunktRegeln.befunde(Faehigkeit.BESTAND, List.of(v), null)))
                .containsExactly("unidirektional_hinter_z2");
        assertThat(LadepunktRegeln.befunde(Faehigkeit.BESTAND, List.of(), null)).isEmpty();
        assertThat(LadepunktRegeln.befunde(V2H, List.of(v, e), null)).isEmpty();
        assertThat(codes(LadepunktRegeln.befunde(V2H, List.of(), null))).containsExactly("z2_fehlt");
        assertThat(codes(LadepunktRegeln.befunde(V2G, List.of(v), null))).containsExactly("z2_richtung_fehlt");
        assertThat(codes(LadepunktRegeln.befunde(V2G, List.of(v, z2("Z2E", "MS-04", "nicht_tauglich")), null)))
                .containsExactly("z2_nicht_tauglich");
        assertThat(codes(LadepunktRegeln.befunde(V2G, List.of(v, z2("Z2E", "MS-04", "nicht_pruefbar")), null)))
                .containsExactly("z2_nicht_pruefbar");
        // Fn. 22: keine Ausschließlichkeitsoption mit bidirektionalem Ladepunkt — außer mit der Sperre.
        assertThat(codes(LadepunktRegeln.befunde(V2H, List.of(v, e),
                FoerderwegRegeln.Foerderweg.MARKTPRAEMIE_AUSSCHLIESSLICHKEIT)))
                .containsExactly("ausschliesslichkeit_mit_ladepunkt");
        assertThat(LadepunktRegeln.befunde(V2H_GESPERRT, List.of(),
                FoerderwegRegeln.Foerderweg.MARKTPRAEMIE_AUSSCHLIESSLICHKEIT)).isEmpty();
    }

    @Test
    void formDesFahrzeugfensters() {
        Fenster nacht = new Fenster(1, LocalTime.of(18, 0), LocalTime.of(7, 0), new BigDecimal("80"));
        Fenster dienstag = new Fenster(2, LocalTime.of(18, 0), LocalTime.of(7, 0), null);
        assertThat(LadepunktRegeln.formPruefen(new Fahrzeugfenster(new BigDecimal("30"), new BigDecimal("60"),
                List.of(nacht, dienstag)))).isNull();
        assertThat(LadepunktRegeln.formPruefen(new Fahrzeugfenster(null, null, List.of()))).isNull();
        assertThat(grund(new Fahrzeugfenster(new BigDecimal("101"), null, List.of()))).isEqualTo("mindest_soc");
        assertThat(grund(new Fahrzeugfenster(null, BigDecimal.ZERO, List.of()))).isEqualTo("kapazitaet");
        assertThat(grund(new Fahrzeugfenster(null, null,
                List.of(new Fenster(8, LocalTime.NOON, LocalTime.MIDNIGHT, null))))).isEqualTo("anwesenheit");
        assertThat(grund(new Fahrzeugfenster(null, null,
                List.of(new Fenster(1, LocalTime.NOON, LocalTime.NOON, null))))).isEqualTo("anwesenheit");
        assertThat(grund(new Fahrzeugfenster(new BigDecimal("90"), null, List.of(nacht)))).isEqualTo("abfahrt_soc");
        // Montag 18:00 bis Dienstag 07:00 überschneidet Dienstag 06:00 bis 08:00.
        assertThat(grund(new Fahrzeugfenster(null, null,
                List.of(nacht, new Fenster(2, LocalTime.of(6, 0), LocalTime.of(8, 0), null)))))
                .isEqualTo("ueberschneidung");
        // Sonntag 20:00 bis Montag 08:00 überschneidet Montag 07:00 bis 09:00 — über das Wochenende hinweg.
        assertThat(grund(new Fahrzeugfenster(null, null, List.of(new Fenster(7, LocalTime.of(20, 0),
                LocalTime.of(8, 0), null), new Fenster(1, LocalTime.of(7, 0), LocalTime.of(9, 0), null)))))
                .isEqualTo("ueberschneidung");
        // Aneinander stoßend ist erlaubt (halboffene Fenster).
        assertThat(LadepunktRegeln.formPruefen(new Fahrzeugfenster(null, null, List.of(nacht,
                new Fenster(2, LocalTime.of(7, 0), LocalTime.of(8, 0), null))))).isNull();
    }

    private static Z2 z2(String groesse, String kz, String urteil) {
        return new Z2(groesse, kz, new ZaehlerrolleRegeln.Angaben("Z2", null, null, "eichrechtskonform",
                LocalDate.of(2030, 12, 31), "messstellenbetreiber"), urteil);
    }

    private static String grund(Faehigkeit f) {
        return (String) LadepunktRegeln.formPruefen(f).fakten().get("grund");
    }

    private static String grund(Fahrzeugfenster f) {
        return (String) LadepunktRegeln.formPruefen(f).fakten().get("grund");
    }

    // ------------------------------------------------------------------ MP-41a: Einstellungen des Fahrers

    private static final LocalDateTime JETZT = LocalDateTime.of(2026, 10, 15, 12, 0);

    private static LadepunktRegeln.FahrerEinstellungen fahrer(String rueckspeisen, String reserve, String zyklen,
            List<LadepunktRegeln.Abfahrt> abfahrten, LadepunktRegeln.NaechsteFahrt naechste) {
        return new LadepunktRegeln.FahrerEinstellungen(rueckspeisen, reserve == null ? null : new BigDecimal(reserve),
                zyklen == null ? null : new BigDecimal(zyklen), abfahrten, naechste);
    }

    private static LadepunktRegeln.Abfahrt abfahrt(List<Integer> tage, String um, String soc) {
        return new LadepunktRegeln.Abfahrt(tage, LocalTime.parse(um), new BigDecimal(soc));
    }

    private static String grundFahrer(LadepunktRegeln.FahrerEinstellungen f) {
        LadepunktRegeln.Ablehnung a = LadepunktRegeln.formPruefen(f, JETZT);
        assertThat(a).isNotNull();
        assertThat(a.code()).isEqualTo("fahrer_einstellungen_ungueltig");
        assertThat(a.status()).isEqualTo(400);
        return (String) a.fakten().get("grund");
    }

    @Test
    void formDerFahrerEinstellungen() {
        var mofr = abfahrt(List.of(1, 2, 3, 4, 5), "07:15", "80");
        var naechste = new LadepunktRegeln.NaechsteFahrt(LocalDateTime.of(2026, 10, 16, 5, 30), new BigDecimal("100"));
        assertThat(LadepunktRegeln.formPruefen(fahrer("v2h", "40", "1", List.of(mofr), naechste), JETZT)).isNull();
        assertThat(LadepunktRegeln.formPruefen(LadepunktRegeln.FahrerEinstellungen.VORGABE, JETZT)).isNull();
        assertThat(LadepunktRegeln.formPruefen(fahrer("aus", null, "0.5", List.of(), null), JETZT)).isNull();
        assertThat(grundFahrer(fahrer(null, null, null, List.of(), null))).isEqualTo("rueckspeisen");
        assertThat(grundFahrer(fahrer("ja", null, null, List.of(), null))).isEqualTo("rueckspeisen");
        assertThat(grundFahrer(fahrer("v2h", "101", null, List.of(), null))).isEqualTo("reserve");
        assertThat(grundFahrer(fahrer("v2h", null, "3", List.of(), null))).isEqualTo("vollzyklen");
        assertThat(grundFahrer(fahrer("v2h", null, "0", List.of(), null))).isEqualTo("vollzyklen");
        assertThat(grundFahrer(fahrer("v2h", null, null, List.of(abfahrt(List.of(), "07:15", "80")), null)))
                .isEqualTo("abfahrt");
        assertThat(grundFahrer(fahrer("v2h", null, null, List.of(abfahrt(List.of(8), "07:15", "80")), null)))
                .isEqualTo("abfahrt");
        assertThat(grundFahrer(fahrer("v2h", null, null, List.of(abfahrt(List.of(1), "07:15:30", "80")), null)))
                .isEqualTo("abfahrt");
        assertThat(grundFahrer(fahrer("v2h", null, null, List.of(mofr, abfahrt(List.of(5, 6), "09:00", "60")), null)))
                .isEqualTo("ueberschneidung");
        assertThat(grundFahrer(fahrer("v2h", "90", null, List.of(mofr), null))).isEqualTo("abfahrt_soc");
        assertThat(grundFahrer(fahrer("v2h", null, null, List.of(abfahrt(List.of(1), "07:15", "120")), null)))
                .isEqualTo("abfahrt_soc");
        assertThat(grundFahrer(fahrer("v2h", null, null, List.of(), new LadepunktRegeln.NaechsteFahrt(
                JETZT.minusMinutes(1), BigDecimal.TEN)))).isEqualTo("naechste_fahrt");
        assertThat(grundFahrer(fahrer("v2h", null, null, List.of(), new LadepunktRegeln.NaechsteFahrt(
                JETZT.plusDays(8), BigDecimal.TEN)))).isEqualTo("naechste_fahrt");
        assertThat(grundFahrer(fahrer("v2h", "50", null, List.of(), new LadepunktRegeln.NaechsteFahrt(
                JETZT.plusDays(1), BigDecimal.TEN)))).isEqualTo("abfahrt_soc");
    }

    /** Der Wunsch des Fahrers nie über der Fähigkeit (Fahrplan 2.0, MP-39); „aus“ macht nicht unidirektional. */
    @Test
    void zurueckspeisenWirksamNieUeberDerFaehigkeit() {
        Faehigkeit nurNetz = new Faehigkeit("bidirektional", false, true, false, null);
        assertThat(LadepunktRegeln.rueckspeisenWirksam("v2g", V2G)).isEqualTo("v2g");
        assertThat(LadepunktRegeln.rueckspeisenWirksam("v2g", V2H)).isEqualTo("v2h");
        assertThat(LadepunktRegeln.rueckspeisenWirksam("v2h", V2G)).isEqualTo("v2h");
        assertThat(LadepunktRegeln.rueckspeisenWirksam("v2h", nurNetz)).isEqualTo("aus");
        assertThat(LadepunktRegeln.rueckspeisenWirksam("v2g", Faehigkeit.BESTAND)).isEqualTo("aus");
        assertThat(LadepunktRegeln.rueckspeisenWirksam("aus", V2G)).isEqualTo("aus");
        assertThat(LadepunktRegeln.traegt(V2H, "v2g")).isFalse();
        assertThat(LadepunktRegeln.traegt(V2H, "v2h")).isTrue();
        assertThat(LadepunktRegeln.traegt(Faehigkeit.BESTAND, "aus")).isTrue();
        assertThat(LadepunktRegeln.einordnung(V2G)).isEqualTo(LadepunktRegeln.LADEPUNKT_DER_FESTLEGUNG);
        // Das Vokabular ist das des Fahrplans 2.0 (mqtt-schedule-2.0.schema.json, entities[].fahrzeug.rueckspeisen).
        assertThat(LadepunktRegeln.RUECKSPEISEN).containsExactly("aus", "v2h", "v2g");
    }

    private static List<String> codes(List<LadepunktRegeln.Befund> befunde) {
        return befunde.stream().map(LadepunktRegeln.Befund::code).toList();
    }
}
