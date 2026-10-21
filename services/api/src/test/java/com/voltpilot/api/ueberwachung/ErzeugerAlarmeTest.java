package com.voltpilot.api.ueberwachung;

import static org.assertj.core.api.Assertions.assertThat;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * Die fünf Erzeuger-Vorlagen als reine Auswertung (UEMS EZ-11, Konzept §4.8 in der schlanken Fassung §3.7): welcher
 * Zustand aus welchen Werten folgt, welcher Satz in der Meldung steht - und dass ein fehlender oder veralteter Wert
 * nie einen Zustand erfindet. Den Weg durch Dauer, Erholdauer und Versand prüft {@link ErzeugerUeberwachungTest}.
 */
class ErzeugerAlarmeTest {

    private static final Instant JETZT = Instant.parse("2026-10-21T20:00:00Z");

    /** Ein Bild mit lauter aktuellen Werten; {@link #alt}/{@link #stale} machen einzelne davon unbrauchbar. */
    private static final class Werte {
        private final Map<String, ErzeugerAlarme.Wert> werte = new LinkedHashMap<>();

        Werte setze(String schluessel, long zahl) {
            werte.put("erzeuger." + schluessel, new ErzeugerAlarme.Wert(BigDecimal.valueOf(zahl), JETZT.minusSeconds(5),
                    "good"));
            return this;
        }

        Werte alt(String schluessel, long zahl, long sekunden) {
            werte.put("erzeuger." + schluessel, new ErzeugerAlarme.Wert(BigDecimal.valueOf(zahl),
                    JETZT.minusSeconds(sekunden), "good"));
            return this;
        }

        Werte stale(String schluessel, long zahl) {
            werte.put("erzeuger." + schluessel, new ErzeugerAlarme.Wert(BigDecimal.valueOf(zahl), JETZT.minusSeconds(5),
                    "stale"));
            return this;
        }

        ErzeugerAlarme.Bild bild(int teAnzahl) {
            return new ErzeugerAlarme.Bild(werte, teAnzahl, JETZT);
        }
    }

    // ------------------------------------------------------------------ Fernsteuerung nicht bereit

    @Test
    void bereitGemeldetIstBereit() {
        ErzeugerAlarme.Bild bild = new Werte().setze("dv.d_kanal", 1).setze("te[1].t_bits", 0b1111).bild(1);
        ErzeugerAlarme.Urteil u = ErzeugerAlarme.fernsteuerung(bild, 1, "Motor 1");
        assertThat(u.zustand()).isEqualTo("bereit");
        assertThat(u.text()).isEqualTo("Motor 1 ist bereit für den Direktvermarkter.");
    }

    @Test
    void nichtBereitNenntDieGruendeAusBitVierBisNeun() {
        // Bit 0/1 gültig, Bit 2 aus, Bit 4 Störung, Bit 7 Wartung
        long tBits = 0b1 | 0b10 | (1 << 4) | (1 << 7);
        ErzeugerAlarme.Bild bild = new Werte().setze("dv.d_kanal", 1).setze("te[2].t_bits", tBits).bild(2);
        ErzeugerAlarme.Urteil u = ErzeugerAlarme.fernsteuerung(bild, 2, "Motor 2");
        assertThat(u.zustand()).isEqualTo("nicht_bereit");
        assertThat(u.text()).isEqualTo("Motor 2 ist nicht bereit für den Direktvermarkter. Grund: Störung, Wartung.");
    }

    @Test
    void nichtBereitOhneGrundSagtDasAuchSo() {
        ErzeugerAlarme.Bild bild = new Werte().setze("dv.d_kanal", 2).setze("te[1].t_bits", 0b11).bild(1);
        assertThat(ErzeugerAlarme.fernsteuerung(bild, 1, "WR 1").text()).endsWith("Die Steuerung nennt keinen Grund.");
    }

    @Test
    void ohneDirektvermarkterKanalGibtEsNichtsZuMelden() {
        ErzeugerAlarme.Bild bild = new Werte().setze("dv.d_kanal", 0).setze("te[1].t_bits", 0).bild(1);
        assertThat(ErzeugerAlarme.fernsteuerung(bild, 1, "WR 1").zustand()).isEqualTo("kein_direktvermarkter");
    }

    @Test
    void ohneAktuellesTBitsBleibtBereitschaftUnbekannt() {
        assertThat(ErzeugerAlarme.fernsteuerung(new Werte().setze("dv.d_kanal", 1).bild(1), 1, "WR 1").bekannt())
                .isFalse();
        assertThat(ErzeugerAlarme.fernsteuerung(
                new Werte().setze("dv.d_kanal", 1).alt("te[1].t_bits", 0, 600).bild(1), 1, "WR 1").bekannt()).isFalse();
        assertThat(ErzeugerAlarme.fernsteuerung(
                new Werte().setze("dv.d_kanal", 1).stale("te[1].t_bits", 0).bild(1), 1, "WR 1").bekannt()).isFalse();
    }

    // ------------------------------------------------------------------ Daten veraltet

    private static Werte vollesBild() {
        return new Werte().setze("a.a_gueltig", 8).setze("nb.n_kanal", 3).setze("dv.d_kanal", 1)
                .setze("wirkung.quelle_p", 0).setze("te[1].t_art", 2).setze("te[2].t_art", 2);
    }

    @Test
    void jederAbschnittMitEinemAktuellenWertIstAktuell() {
        ErzeugerAlarme.Urteil u = ErzeugerAlarme.datenlage(vollesBild().alt("a.p_nvp_w", 0, 3600).bild(2));
        assertThat(u.zustand()).isEqualTo("aktuell");
    }

    @Test
    void einAbschnittOhneAktuellenWertIstVeraltet() {
        ErzeugerAlarme.Urteil u = ErzeugerAlarme.datenlage(vollesBild().alt("nb.n_kanal", 3, 600)
                .alt("te[2].t_art", 2, 900).bild(2));
        assertThat(u.zustand()).isEqualTo("veraltet");
        assertThat(u.text()).startsWith("Die Anlagensteuerung liefert keine aktuellen Werte für Netzbetreiber, Einheit 2.")
                .contains("Letzter Wert 21.10.2026 21:45 Uhr.");
    }

    @Test
    void stehtDerHerzschlagSindAlleWerteStaleUndDamitVeraltet() {
        Werte w = new Werte().stale("a.a_gueltig", 8).stale("nb.n_kanal", 3).stale("dv.d_kanal", 1)
                .stale("wirkung.quelle_p", 0).stale("te[1].t_art", 2);
        assertThat(ErzeugerAlarme.datenlage(w.bild(1)).zustand()).isEqualTo("veraltet");
    }

    @Test
    void eineEinheitImBildOhneJedenWertIstVeraltet() {
        ErzeugerAlarme.Urteil u = ErzeugerAlarme.datenlage(vollesBild().bild(3));
        assertThat(u.zustand()).isEqualTo("veraltet");
        assertThat(u.text()).contains("Einheit 3");
    }

    @Test
    void ohneJedenWertIstDieDatenlageUnbekannt() {
        assertThat(ErzeugerAlarme.datenlage(new Werte().bild(2)).bekannt()).isFalse();
    }

    // ------------------------------------------------------------------ Anlage folgt nicht

    @Test
    void ueberDerGrenzePlusToleranzFolgtDieAnlageNicht() {
        // 1 000 kW installiert: Toleranz max(5 % = 50 kW, 5 kW) = 50 kW; 60 kW über der Grenze
        ErzeugerAlarme.Bild bild = new Werte().setze("wirkung.quelle_p", 1).setze("wirkung.p_grenze_w", 600_000)
                .setze("a.p_erzeugung_w", 660_000).setze("a.p_installiert_kw", 1000).bild(1);
        ErzeugerAlarme.Urteil u = ErzeugerAlarme.folgen(bild, 5, 5);
        assertThat(u.zustand()).isEqualTo("folgt_nicht");
        assertThat(u.text()).isEqualTo("Die Anlage erzeugt 60,0 kW mehr als die wirksame Grenze erlaubt "
                + "(Toleranz 50,0 kW). Erzeugung 660,0 kW, wirksame Grenze 600,0 kW (Netzbetreiber).");
    }

    @Test
    void innerhalbDerToleranzFolgtDieAnlage() {
        ErzeugerAlarme.Bild bild = new Werte().setze("wirkung.quelle_p", 2).setze("wirkung.p_grenze_w", 600_000)
                .setze("a.p_erzeugung_w", 640_000).setze("a.p_installiert_kw", 1000).bild(1);
        assertThat(ErzeugerAlarme.folgen(bild, 5, 5).zustand()).isEqualTo("folgt");
    }

    @Test
    void unterDerGrenzeIstKeinVerstossAuchWennWolkenDieErzeugungDruecken() {
        ErzeugerAlarme.Bild bild = new Werte().setze("wirkung.quelle_p", 1).setze("wirkung.p_grenze_w", 600_000)
                .setze("a.p_erzeugung_w", 100_000).setze("a.p_installiert_kw", 1000).bild(1);
        assertThat(ErzeugerAlarme.folgen(bild, 5, 5).zustand()).isEqualTo("folgt");
    }

    @Test
    void ohneInstallierteLeistungGiltDieFesteToleranz() {
        ErzeugerAlarme.Bild bild = new Werte().setze("wirkung.quelle_p", 1).setze("wirkung.p_grenze_w", 60_000)
                .setze("a.p_erzeugung_w", 66_000).bild(1);
        assertThat(ErzeugerAlarme.folgen(bild, 5, 5).zustand()).isEqualTo("folgt_nicht");
        assertThat(ErzeugerAlarme.folgen(bild, 5, 10).zustand()).isEqualTo("folgt");
    }

    @Test
    void ohneGrenzeIstDieAnlageNichtBegrenzt() {
        ErzeugerAlarme.Bild bild = new Werte().setze("wirkung.quelle_p", 0).setze("a.p_erzeugung_w", 900_000).bild(1);
        assertThat(ErzeugerAlarme.folgen(bild, 5, 5).zustand()).isEqualTo("nicht_begrenzt");
    }

    @Test
    void dasUrteilDerSpsGiltAuchOhneEigeneRechnung() {
        // s_bits Bit 0 gültig, Bit 1 aus: die SPS sagt „folgt nicht“
        ErzeugerAlarme.Bild bild = new Werte().setze("wirkung.s_bits", 0b01).bild(1);
        assertThat(ErzeugerAlarme.folgen(bild, 5, 5).zustand()).isEqualTo("folgt_nicht");
        assertThat(ErzeugerAlarme.folgen(bild, 5, 5).text()).startsWith("Die Steuerung meldet: die Anlage folgt der "
                + "Vorgabe nicht.");
        // ungültiges s_bits (Bit 0 aus) urteilt nicht
        assertThat(ErzeugerAlarme.folgen(new Werte().setze("wirkung.s_bits", 0).bild(1), 5, 5).bekannt()).isFalse();
    }

    @Test
    void begrenztAberOhneAktuelleLeistungIstUnbekannt() {
        ErzeugerAlarme.Bild bild = new Werte().setze("wirkung.quelle_p", 1).setze("wirkung.p_grenze_w", 600_000)
                .alt("a.p_erzeugung_w", 900_000, 600).bild(1);
        assertThat(ErzeugerAlarme.folgen(bild, 5, 5).bekannt()).isFalse();
    }

    // ------------------------------------------------------------------ Netzbetreiber hat abgeschaltet

    @Test
    void notAusDesNetzbetreibersIstAbgeschaltet() {
        ErzeugerAlarme.Urteil u = ErzeugerAlarme.abschaltung(new Werte().setze("nb.n_bits", 0b1011)
                .setze("wirkung.quelle_p", 1).bild(1));
        assertThat(u.zustand()).isEqualTo("abgeschaltet");
        assertThat(u.text()).isEqualTo("Der Netzbetreiber hat die Anlage per Not-Aus abgeschaltet.");
    }

    @Test
    void quelleNotAusIstAbgeschaltet() {
        assertThat(ErzeugerAlarme.abschaltung(new Werte().setze("wirkung.quelle_p", 5).bild(1)).zustand())
                .isEqualTo("abgeschaltet");
    }

    @Test
    void eineGewoehnlicheGrenzeIstKeineAbschaltung() {
        assertThat(ErzeugerAlarme.abschaltung(new Werte().setze("wirkung.quelle_p", 1).setze("nb.n_bits", 0b0111)
                .bild(1)).zustand()).isEqualTo("nicht_abgeschaltet");
        assertThat(ErzeugerAlarme.abschaltung(new Werte().bild(1)).bekannt()).isFalse();
    }

    // ------------------------------------------------------------------ Fernwirk-Verbindung weg

    @Test
    void fernwirkVerbindungStehtNichtNurBeiFernwirktechnik() {
        assertThat(ErzeugerAlarme.fernwirk(new Werte().setze("nb.n_kanal", 3).setze("nb.n_bits", 0b0001).bild(1))
                .zustand()).isEqualTo("getrennt");
        assertThat(ErzeugerAlarme.fernwirk(new Werte().setze("nb.n_kanal", 3).setze("nb.n_bits", 0b0011).bild(1))
                .zustand()).isEqualTo("verbunden");
        assertThat(ErzeugerAlarme.fernwirk(new Werte().setze("nb.n_kanal", 2).setze("nb.n_bits", 0).bild(1))
                .zustand()).isEqualTo("keine_fernwirktechnik");
        assertThat(ErzeugerAlarme.fernwirk(new Werte().setze("nb.n_kanal", 3).bild(1)).bekannt()).isFalse();
    }

    // ------------------------------------------------------------------ Programmstand veraltet (EZ-11b)

    @Test
    void einAeltererStandAlsDieBibliothekIstAelterMitIstUndSoll() {
        ErzeugerAlarme.Urteil u = ErzeugerAlarme.programmstand(new Werte().setze("kopf.programmstand", 2608).bild(1),
                null);
        assertThat(u.zustand()).isEqualTo("aelter");
        assertThat(u.text()).isEqualTo(
                "Die Anlagensteuerung fährt den Programmstand 26.08, erwartet ist 26.10 (Stand der VoltPilot-Bibliothek).");
        assertThat(u.messzeit()).isEqualTo(JETZT.minusSeconds(5));
    }

    @Test
    void derSollDerFassungGehtDerBibliothekVor() {
        ErzeugerAlarme.Urteil u = ErzeugerAlarme.programmstand(new Werte().setze("kopf.programmstand", 2610).bild(1),
                2701);
        assertThat(u.zustand()).isEqualTo("aelter");
        assertThat(u.text()).endsWith("erwartet ist 27.01 (Vorgabe der Fassung).");
        ErzeugerAlarme.Urteil neuer = ErzeugerAlarme.programmstand(
                new Werte().setze("kopf.programmstand", 2611).bild(1), null);
        assertThat(neuer.zustand()).isEqualTo("aktuell");
        assertThat(neuer.text()).isEqualTo("Die Anlagensteuerung fährt den Programmstand 26.11, erwartet ist 26.10 "
                + "(Stand der VoltPilot-Bibliothek) - der Stand ist aktuell.");
    }

    @Test
    void einUngueltigerFehlenderOderVeralteterStandBleibtUnbekannt() {
        assertThat(ErzeugerAlarme.programmstand(new Werte().bild(1), null).bekannt()).isFalse();
        assertThat(ErzeugerAlarme.programmstand(new Werte().setze("kopf.programmstand", 0xFFFF).bild(1), null)
                .bekannt()).isFalse();
        assertThat(ErzeugerAlarme.programmstand(new Werte().setze("kopf.programmstand", 2613).bild(1), null)
                .bekannt()).isFalse();
        assertThat(ErzeugerAlarme.programmstand(new Werte().alt("kopf.programmstand", 2608, 600).bild(1), null)
                .bekannt()).isFalse();
        assertThat(ErzeugerAlarme.programmstand(new Werte().stale("kopf.programmstand", 2608).bild(1), null)
                .bekannt()).isFalse();
    }
}
