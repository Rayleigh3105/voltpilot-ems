package com.voltpilot.api.ueberwachung;

import com.voltpilot.api.erzeuger.AnlagensteuerungService;
import com.voltpilot.api.erzeuger.ErzeugerRegisterbild;
import com.voltpilot.api.erzeuger.Programmstand;
import java.math.BigDecimal;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;

/**
 * Die Alarm-Vorlagen für Erzeugeranlagen (UEMS EZ-11, Konzept vp-erzeuger-wago-konzept §4.8, EW-9 A; EZ-11b
 * „Programmstand veraltet“) als
 * reine Auswertung eines Registerbilds: kein Datenbankzugriff, keine Uhr - {@link ErzeugerWerteLeser} liefert die
 * jüngsten Werte der Anlagensteuerung, diese Klasse macht daraus EINEN Zustand mit einem Satz in Kundensprache.
 * Dauer, Erholdauer, Hysterese und Versand bleiben beim Zustandsautomaten der Überwachung
 * ({@link UeberwachungsService}); hier steht nur, was die Werte JETZT bedeuten.
 *
 * <p>Feldnamen und Bits der schlanken Fassung (§3.7, Vertrag {@code docs/contracts/v2/erzeuger-registerbild.md}):
 * {@code n_bits} Bit 1 Verbindung steht · 3 Not-Aus; {@code t_bits} Bit 2 DV bereit · 4-9 Gründe; {@code quelle_p}
 * 0 keine Grenze · 5 Not-Aus; {@code s_bits} Bit 0 gültig · 1 Anlage folgt; Vokabular und Texte aus
 * {@link ErzeugerRegisterbild}.
 *
 * <p><b>Unbekannt ist keine Null:</b> nur ein aktueller Wert zählt - Qualität {@code good} und höchstens
 * {@link AnlagensteuerungService#AKTUELL_BIS_S} alt, dieselbe Grenze wie die Werte-Fläche der Anlagensteuerung. Ein
 * fehlender oder veralteter Wert ergibt {@code zustand == null} (unbekannt), nie einen geratenen Zustand; das
 * Veralten selbst meldet nur die Vorlage „Daten veraltet“.
 */
final class ErzeugerAlarme {

    /** {@code quelle_p}: keine Grenze. */
    static final int QUELLE_KEINE = 0;
    /** {@code quelle_p}: Not-Aus. */
    static final int QUELLE_NOT_AUS = 5;
    /** {@code n_kanal}: Fernwirktechnik. */
    static final int KANAL_FERNWIRK = 3;
    /** {@code d_kanal}: keiner. */
    static final int DV_KEINER = 0;

    private static final List<String> ABSCHNITTE = List.of("a", "nb", "dv", "wirkung");

    /** Ein jüngster Wert eines Punkts; {@code zeit == null} = es gab nie einen. */
    record Wert(BigDecimal zahl, Instant zeit, String qualitaet) {}

    /** Das Bild einer Steuerung, wie es gerade in der Cloud liegt: Punktschlüssel → jüngster Wert. */
    record Bild(Map<String, Wert> werte, int teAnzahl, Instant jetzt) {

        /** Der aktuelle Wert eines Felds als ganze Zahl - leer, wenn er fehlt oder nicht aktuell ist. */
        Long ganz(String schluessel) {
            Wert w = werte.get(schluessel);
            return aktuell(w, jetzt) ? w.zahl().longValue() : null;
        }

        Double zahl(String schluessel) {
            Wert w = werte.get(schluessel);
            return aktuell(w, jetzt) ? w.zahl().doubleValue() : null;
        }

        Instant zeit(String schluessel) {
            Wert w = werte.get(schluessel);
            return w == null ? null : w.zeit();
        }
    }

    /** Das Ergebnis: Zustand ({@code null} = unbekannt), Satz in Kundensprache und Messzeit. */
    record Urteil(String zustand, String text, Instant messzeit) {
        static final Urteil UNBEKANNT = new Urteil(null, null, null);

        boolean bekannt() {
            return zustand != null;
        }
    }

    private ErzeugerAlarme() {
    }

    static boolean aktuell(Wert w, Instant jetzt) {
        return w != null && w.zeit() != null && w.zahl() != null && "good".equals(w.qualitaet())
                && !w.zeit().isBefore(jetzt.minusSeconds(AnlagensteuerungService.AKTUELL_BIS_S));
    }

    // ------------------------------------------------------------------ Fernsteuerung nicht bereit

    /**
     * „Fernsteuerung nicht bereit“ für EINE Einheit: {@code t_bits} Bit 2 (bereit für den Direktvermarkter) aus,
     * solange ein Direktvermarkter-Kanal eingerichtet ist ({@code d_kanal ≠ 0}); die Gründe aus Bit 4-9 stehen im
     * Satz. Die DV-Signale gelten unabhängig von {@code t_bits} Bit 0 (Vertrag §4: sie kommen von der Poolbox).
     */
    static Urteil fernsteuerung(Bild bild, int teNr, String einheitName) {
        Long dKanal = bild.ganz("erzeuger.dv.d_kanal");
        if (dKanal == null) {
            return Urteil.UNBEKANNT;
        }
        String tBitsKey = "erzeuger.te[" + teNr + "].t_bits";
        if (dKanal == DV_KEINER) {
            return new Urteil("kein_direktvermarkter",
                    einheitName + ": an dieser Anlage ist kein Direktvermarkter-Kanal eingerichtet.",
                    bild.zeit("erzeuger.dv.d_kanal"));
        }
        Long tBits = bild.ganz(tBitsKey);
        if (tBits == null) {
            return Urteil.UNBEKANNT;
        }
        if (bit(tBits, 2)) {
            return new Urteil("bereit", einheitName + " ist bereit für den Direktvermarkter.", bild.zeit(tBitsKey));
        }
        ErzeugerRegisterbild.Feld feld = ErzeugerRegisterbild.feld(tBitsKey).orElseThrow();
        List<String> gruende = ErzeugerRegisterbild.gesetzt(feld, tBits).stream()
                .filter(b -> b.bit() >= 4 && b.bit() <= 9).map(ErzeugerRegisterbild.Bit::text).toList();
        String grund = gruende.isEmpty() ? "Die Steuerung nennt keinen Grund."
                : "Grund: " + String.join(", ", gruende) + ".";
        return new Urteil("nicht_bereit", einheitName + " ist nicht bereit für den Direktvermarkter. " + grund,
                bild.zeit(tBitsKey));
    }

    // ------------------------------------------------------------------ Daten veraltet

    /**
     * „Daten veraltet“: ein Abschnitt (Anlage, Netzbetreiber, Direktvermarkter, Wirkung, jede Einheit) ohne einen
     * einzigen aktuellen Wert. Steht der Herzschlag, setzt die Box alle Werte der Steuerung auf {@code stale}
     * (Vertrag §8) - dann ist kein Abschnitt aktuell; liest sie gar nicht mehr, altern alle Werte über die Grenze
     * (Lücke). Ein Abschnitt zählt als aktuell, sobald EIN Wert darin aktuell ist: ein Feld ohne Wert (Gültigkeit
     * aus) macht den Abschnitt nicht veraltet. Ohne irgendeinen Wert im ganzen Bild bleibt es unbekannt (die Box
     * hat noch nie geliefert - das meldet „Datenquelle liefert Daten“).
     */
    static Urteil datenlage(Bild bild) {
        Instant juengster = null;
        List<String> veraltet = new ArrayList<>();
        Instant aeltesterVeraltet = null;
        for (String abschnitt : abschnitte(bild.teAnzahl())) {
            boolean aktuell = false;
            Instant neuester = null;
            for (Map.Entry<String, Wert> e : bild.werte().entrySet()) {
                if (!e.getKey().startsWith(abschnitt) || e.getValue().zeit() == null) {
                    continue;
                }
                aktuell |= aktuell(e.getValue(), bild.jetzt());
                neuester = spaeter(neuester, e.getValue().zeit());
            }
            juengster = spaeter(juengster, neuester);
            if (!aktuell) {
                veraltet.add(abschnittName(abschnitt));
                if (neuester != null && (aeltesterVeraltet == null || neuester.isBefore(aeltesterVeraltet))) {
                    aeltesterVeraltet = neuester;
                }
            }
        }
        if (juengster == null) {
            return Urteil.UNBEKANNT;
        }
        if (veraltet.isEmpty()) {
            return new Urteil("aktuell", "Die Anlagensteuerung liefert aktuelle Werte.", juengster);
        }
        String seit = aeltesterVeraltet == null ? "" : " Letzter Wert " + Anzeige.zeit(aeltesterVeraltet) + ".";
        return new Urteil("veraltet", "Die Anlagensteuerung liefert keine aktuellen Werte für "
                + String.join(", ", veraltet) + "." + seit, juengster);
    }

    /** Die Präfixe der Abschnitte eines Bilds mit {@code teAnzahl} Einheiten (der Kopf ist kein Messwert-Abschnitt). */
    static List<String> abschnitte(int teAnzahl) {
        List<String> out = new ArrayList<>();
        for (String a : ABSCHNITTE) {
            out.add("erzeuger." + a + ".");
        }
        for (int te = 1; te <= teAnzahl; te++) {
            out.add("erzeuger.te[" + te + "].");
        }
        return out;
    }

    private static String abschnittName(String praefix) {
        return switch (praefix) {
            case "erzeuger.a." -> "Anlage";
            case "erzeuger.nb." -> "Netzbetreiber";
            case "erzeuger.dv." -> "Direktvermarkter";
            case "erzeuger.wirkung." -> "Wirkung";
            default -> "Einheit " + praefix.substring("erzeuger.te[".length(), praefix.length() - 2);
        };
    }

    // ------------------------------------------------------------------ Anlage folgt nicht

    /**
     * „Anlage folgt nicht“: die SPS urteilt selbst ({@code s_bits} Bit 0 gültig, Bit 1 = 0), oder die Erzeugung
     * liegt um mehr als max({@code toleranzProzent} % der installierten Leistung, {@code toleranzKw}) ÜBER der
     * wirksamen Grenze, während eine Grenze wirkt ({@code quelle_p ≠ 0}). Nur das Überschreiten zählt: eine
     * PV-Anlage unter einer Grenze von 60 % erzeugt bei Wolken weniger - das ist kein Verstoß.
     */
    static Urteil folgen(Bild bild, double toleranzProzent, double toleranzKw) {
        Long sBits = bild.ganz("erzeuger.wirkung.s_bits");
        boolean urteilGueltig = sBits != null && bit(sBits, 0);
        Long quelle = bild.ganz("erzeuger.wirkung.quelle_p");
        Double erzeugungW = bild.zahl("erzeuger.a.p_erzeugung_w");
        Double grenzeW = bild.zahl("erzeuger.wirkung.p_grenze_w");
        Instant zeit = spaeter(bild.zeit("erzeuger.wirkung.s_bits"), bild.zeit("erzeuger.wirkung.quelle_p"));
        String lage = lage(quelle, erzeugungW, grenzeW);
        if (urteilGueltig && !bit(sBits, 1)) {
            return new Urteil("folgt_nicht", "Die Steuerung meldet: die Anlage folgt der Vorgabe nicht." + lage, zeit);
        }
        if (quelle == null) {
            return urteilGueltig ? new Urteil("folgt", "Die Steuerung meldet: die Anlage folgt." + lage, zeit)
                    : Urteil.UNBEKANNT;
        }
        if (quelle == QUELLE_KEINE) {
            return new Urteil("nicht_begrenzt", "Die Anlage ist gerade nicht begrenzt.", zeit);
        }
        if (erzeugungW == null || grenzeW == null) {
            return urteilGueltig ? new Urteil("folgt", "Die Steuerung meldet: die Anlage folgt." + lage, zeit)
                    : Urteil.UNBEKANNT;
        }
        Double installiertKw = bild.zahl("erzeuger.a.p_installiert_kw");
        double toleranzW = Math.max(installiertKw == null ? 0 : installiertKw * 1000 * toleranzProzent / 100,
                toleranzKw * 1000);
        double ueberW = erzeugungW - grenzeW;
        zeit = spaeter(zeit, bild.zeit("erzeuger.a.p_erzeugung_w"));
        if (ueberW > toleranzW) {
            return new Urteil("folgt_nicht", "Die Anlage erzeugt " + Anzeige.kw(ueberW) + " mehr als die wirksame "
                    + "Grenze erlaubt (Toleranz " + Anzeige.kw(toleranzW) + ")." + lage, zeit);
        }
        return new Urteil("folgt", "Die Anlage hält die wirksame Grenze ein." + lage, zeit);
    }

    /** „ Erzeugung 82,0 kW, wirksame Grenze 60,0 kW (Netzbetreiber).“ - nur mit dem, was aktuell bekannt ist. */
    private static String lage(Long quelle, Double erzeugungW, Double grenzeW) {
        List<String> teile = new ArrayList<>();
        if (erzeugungW != null) {
            teile.add("Erzeugung " + Anzeige.kw(erzeugungW));
        }
        if (grenzeW != null) {
            teile.add("wirksame Grenze " + Anzeige.kw(grenzeW) + (quelle == null ? "" : " (" + quelleText(quelle) + ")"));
        }
        return teile.isEmpty() ? "" : " " + String.join(", ", teile) + ".";
    }

    // ------------------------------------------------------------------ Netzbetreiber hat abgeschaltet

    /** „Netzbetreiber hat abgeschaltet“: {@code quelle_p = 5} (Not-Aus) oder {@code n_bits} Bit 3 (Not-Aus). */
    static Urteil abschaltung(Bild bild) {
        Long quelle = bild.ganz("erzeuger.wirkung.quelle_p");
        Long nBits = bild.ganz("erzeuger.nb.n_bits");
        Instant zeit = spaeter(bild.zeit("erzeuger.wirkung.quelle_p"), bild.zeit("erzeuger.nb.n_bits"));
        if (nBits != null && bit(nBits, 3)) {
            return new Urteil("abgeschaltet", "Der Netzbetreiber hat die Anlage per Not-Aus abgeschaltet.", zeit);
        }
        if (quelle != null && quelle == QUELLE_NOT_AUS) {
            return new Urteil("abgeschaltet", "Die Anlage ist abgeschaltet: die wirksame Grenze kommt vom Not-Aus.",
                    zeit);
        }
        if (quelle == null && nBits == null) {
            return Urteil.UNBEKANNT;
        }
        return new Urteil("nicht_abgeschaltet", "Die Anlage ist nicht abgeschaltet.", zeit);
    }

    // ------------------------------------------------------------------ Fernwirk-Verbindung weg

    /** „Fernwirk-Verbindung weg“: {@code n_bits} Bit 1 (Verbindung steht) = 0, nur bei {@code n_kanal = 3}. */
    static Urteil fernwirk(Bild bild) {
        Long nKanal = bild.ganz("erzeuger.nb.n_kanal");
        if (nKanal == null) {
            return Urteil.UNBEKANNT;
        }
        if (nKanal != KANAL_FERNWIRK) {
            return new Urteil("keine_fernwirktechnik", "Die Anlage ist nicht über Fernwirktechnik angebunden.",
                    bild.zeit("erzeuger.nb.n_kanal"));
        }
        Long nBits = bild.ganz("erzeuger.nb.n_bits");
        if (nBits == null) {
            return Urteil.UNBEKANNT;
        }
        return bit(nBits, 1)
                ? new Urteil("verbunden", "Die Fernwirk-Verbindung zum Netzbetreiber steht.", bild.zeit("erzeuger.nb.n_bits"))
                : new Urteil("getrennt", "Die Fernwirk-Verbindung zum Netzbetreiber steht nicht.",
                        bild.zeit("erzeuger.nb.n_bits"));
    }

    // ------------------------------------------------------------------ Programmstand veraltet

    /**
     * „Programmstand veraltet“ (EZ-11b): der Vergleich aus EZ-16 ({@link Programmstand#vergleiche}) - Kopf-Register
     * {@value Programmstand#PUNKT} gegen den Soll der laufenden Fassung ({@code sollDerFassung}, null = Stand der
     * Bibliothek). Nur ein aktueller Ist-Wert zählt; ein fehlender, veralteter oder ungültiger Stand bleibt unbekannt.
     */
    static Urteil programmstand(Bild bild, Integer sollDerFassung) {
        Wert w = bild.werte().get(Programmstand.PUNKT);
        if (!aktuell(w, bild.jetzt())) {
            return Urteil.UNBEKANNT;
        }
        Programmstand.Vergleich v = Programmstand.vergleiche(w.zahl(), w.zeit(), sollDerFassung);
        if (Programmstand.UNBEKANNT.equals(v.zustand())) {
            return Urteil.UNBEKANNT;
        }
        String soll = v.sollText() + (v.sollAusFassung() ? " (Vorgabe der Fassung)" : " (Stand der VoltPilot-Bibliothek)");
        return v.warnen()
                ? new Urteil(Programmstand.AELTER, "Die Anlagensteuerung fährt den Programmstand " + v.istText()
                        + ", erwartet ist " + soll + ".", v.gemessenAm())
                : new Urteil(Programmstand.AKTUELL, "Die Anlagensteuerung fährt den Programmstand " + v.istText()
                        + ", erwartet ist " + soll + " - der Stand ist aktuell.", v.gemessenAm());
    }

    // ------------------------------------------------------------------ Hilfen

    static boolean bit(long wort, int bit) {
        return ((wort >> bit) & 1L) == 1L;
    }

    private static String quelleText(long quelle) {
        ErzeugerRegisterbild.Feld feld = ErzeugerRegisterbild.feld("erzeuger.wirkung.quelle_p").orElseThrow();
        return ErzeugerRegisterbild.wort(feld, quelle).map(ErzeugerRegisterbild.Wort::text).orElse("Quelle " + quelle);
    }

    private static Instant spaeter(Instant a, Instant b) {
        if (a == null) {
            return b;
        }
        return b == null || a.isAfter(b) ? a : b;
    }

    /** Zahlen und Zeiten im Satz: UEMS-Zahlenformat (kW eine Stelle, deutsches Komma), Ortszeit Berlin. */
    static final class Anzeige {
        private static final java.time.format.DateTimeFormatter ZEIT = java.time.format.DateTimeFormatter
                .ofPattern("dd.MM.yyyy HH:mm 'Uhr'", Locale.GERMANY).withZone(java.time.ZoneId.of("Europe/Berlin"));

        private Anzeige() {
        }

        static String kw(double watt) {
            return String.format(Locale.GERMANY, "%.1f kW", watt / 1000);
        }

        static String zeit(Instant t) {
            return ZEIT.format(Objects.requireNonNull(t));
        }
    }
}
