package com.voltpilot.api.verbraucher;

import com.voltpilot.api.consumers.SgReady;
import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/**
 * Die STEUERART-SAETZE je Verbrauchertyp (Konzept
 * {@code vp-verbrauchsmgmt-konzept-v1} §3.1/§3.2, Captain-Entscheide
 * <b>E1</b> = die Tabelle §3.1, <b>E7</b> = Preisgrenze in ct,
 * <b>E8</b> = kWh-Ziel mit Vorgabe 20 kWh).
 *
 * <p><b>Rein: keine DB, kein Spring, keine Uhr</b> - das
 * {@code SteuerartProjektion}/{@code SgReady}/{@code Tagesprotokoll}-Muster.
 * Sie ist die EINE Stelle, die sagt, WELCHE Steuerart ein Typ ueberhaupt
 * kennt, WARUM eine gerade nicht geht, und mit welcher VORGABE eine Folgefrage
 * startet.
 *
 * <p><b>⚠ SIE IST ZUGLEICH DIE ANZEIGE UND DER ZAUN.</b> Der Dialog rendert
 * {@link #quellen}/{@link #ziele} (samt Sperrgrund), und der Schreibpfad
 * ({@code SteuerartService}) prueft mit {@link #pruefe} DIESELBEN Regeln ein
 * zweites Mal - dem Client zu glauben waere keine Pruefung. Zwei Ableitungen
 * koennen so nicht auseinanderlaufen.
 *
 * <p><b>⚠ EINE GESPERRTE WAHL NENNT IMMER IHREN GRUND</b> (die Haus-Disziplin
 * der gesperrten Karte: „eine Handlung, die strukturell nichts bewirken kann,
 * wird nicht angeboten; stattdessen steht ihr Grund da"). Ein Typ, den dieser
 * Stand nicht kennt, bekommt den generischen Satz aus §3.1 - nie eine leere
 * Auswahl.
 *
 * <p><b>Was bewusst NICHT hier lebt:</b> die Speicher-Position (sie gehoert der
 * Rangliste, Paket P4 - der Dialog ZEIGT sie nur), die Netz-Politik und die
 * Speicher-Entladung (Profil-Felder, die die Rangliste projiziert, §3.3), und
 * die Quellen-Bahn der Box ({@code source}/{@code min_kw} je Ladepunkt, P5).
 */
public final class SteuerartSatz {

    // --- Die Sperr-Gruende, woertlich (§3.1) --------------------------------

    /** Der Tarif ist FLACH - es gibt gar keine guenstigen Stunden. */
    public static final String GRUND_TARIF_FEST =
            "Ihr Stromtarif hat keine stündlichen Preise.";
    /**
     * Der Tarif ist UNBEKANNT. Bewusst ein EIGENER Satz: „hat keine
     * stündlichen Preise" waere eine Aussage ueber einen Vertrag, den uns
     * niemand genannt hat - und dieser hier nennt den Weg, auf dem es geht.
     */
    public static final String GRUND_TARIF_UNBEKANNT =
            "Ihr Stromtarif ist noch nicht hinterlegt — tragen Sie ihn unter "
            + "„Vergütung & Tarif\" ein, dann kann VoltPilot die günstigen Stunden wählen.";
    /** Ohne Erzeugung gibt es keinen Ueberschuss. */
    public static final String GRUND_OHNE_PV =
            "Diese Anlage hat keine PV — ohne Erzeugung gibt es keinen Überschuss.";
    /** Ohne Nennleistung kennt niemand die Schwelle. */
    public static final String GRUND_OHNE_NENNLEISTUNG =
            "Ohne Nennleistung kennt VoltPilot die Schwelle nicht — tragen Sie sie beim "
            + "Verbraucher ein.";
    /** Ohne Nennleistung laesst sich keine Laufzeit planen (§3.1). */
    public static final String GRUND_LAUFZEIT_OHNE_NENNLEISTUNG =
            "Ohne Nennleistung lässt sich keine Laufzeit planen.";
    /** D3: ein kWh-Ziel braucht eine Messung, sonst waere „fertig" geraten. */
    public static final String GRUND_ZIEL_OHNE_MESSUNG =
            "Ohne Messung kann VoltPilot nicht nachweisen, wie viel geflossen ist — "
            + "ein kWh-Ziel wäre eine Zusage ohne Beleg.";
    /** Ein Ziel neben „Sofort" ist immer schon erfuellt (§3, Regel). */
    public static final String GRUND_ZIEL_BEI_SOFORT =
            "Bei Sofort ist das Ziel immer erfüllt.";
    /** Die SG-Ready-Waermepumpe kennt gar kein Ziel (P8/E9). */
    public static final String GRUND_KEIN_ZIEL_SGREADY =
            "Für eine SG-Ready-Wärmepumpe gibt es kein Ziel: VoltPilot gibt die Freigabe, "
            + "anlaufen lässt sich die Pumpe nicht.";

    // --- Vorgaben der Folgefragen (§3.2) ------------------------------------

    /** Mindestlaufzeit einer Ueberschuss-Quelle: 10 min (§3.2). */
    public static final int MINDESTLAUFZEIT_MINUTEN = 10;
    /** Die Frist eines Ziels: 06:00 Uhr (§3.2). */
    public static final String ZIEL_UHRZEIT = "06:00";
    /** Die Menge eines kWh-Ziels: 20 kWh ≈ 100 km (E8). */
    public static final BigDecimal ZIEL_ENERGIE_KWH = new BigDecimal("20");
    /**
     * Die Laufzeit eines Laufzeit-Ziels als STARTWERT des Formulars. §3.2 gibt
     * dafuer keine Zahl vor; 60 min ist ein Startpunkt, den der Kunde
     * ueberschreibt - keine Aussage ueber sein Geraet.
     */
    public static final int ZIEL_LAUFZEIT_MINUTEN = 60;
    /**
     * <b>⚠ Die Laenge des Ziel-FENSTERS vor der Frist.</b> §3.2 fragt nur nach
     * der Uhrzeit, nicht nach dem Beginn - der Server muss ihn also setzen, und
     * er darf ihn nicht verschweigen: der Dialog zeigt das entstehende Fenster
     * woertlich („VoltPilot arbeitet zwischen 18:00 und 06:00"). 12 Stunden ist
     * grosszuegig genug fuer eine Nachtladung und kann nie ein Fenster der
     * Laenge 0 ergeben (das lehnt der Validator ab).
     */
    public static final int ZIEL_FENSTER_STUNDEN = 12;
    /** Das Fenster einer Feste-Zeiten-Quelle als STARTWERT (das Haus-Vorgabe-Paar). */
    public static final Steuerart.Fenster FESTE_ZEITEN_VORGABE =
            new Steuerart.Fenster("daily", "13:00", "14:00");

    // --- Das Vokabular ------------------------------------------------------

    /** Die Tage-Woerter des Vertrags ({@code consumer-policy.schema.json}). */
    public static final Set<String> TAGE = Set.of("daily", "weekdays", "weekend");

    private SteuerartSatz() {}

    /**
     * Die Fakten, an denen eine Wahl haengt. Alles NULLABLE, und {@code null}
     * heisst „unbekannt" - nie 0 und nie „nein".
     *
     * @param entityType       der Katalogtyp der Komponente
     * @param ratedPowerKw     die gepflegte Nennleistung ({@code null} = keine)
     * @param minPowerKw       die Mindestleistung des Profils
     * @param confirmationChannel der D3-Nachweiskanal ({@code power_kw} misst)
     * @param tarifArt         {@code dynamisch|fest|ohne} der Anlage
     * @param hatPv            hat die Anlage eine Erzeugung?
     * @param preisgrenzeVorgabeCtKwh die aus den letzten 7 Tagen abgeleitete
     *                         Preisgrenze (E7); {@code null} = es gibt keine
     *                         belastbare, dann bleibt das Feld leer
     */
    public record Kontext(String entityType, BigDecimal ratedPowerKw, BigDecimal minPowerKw,
            String confirmationChannel, String tarifArt, boolean hatPv,
            BigDecimal preisgrenzeVorgabeCtKwh) {}

    /** Eine anbietbare Wahl - gesperrt heisst: sichtbar MIT Grund. */
    public record Option(String id, boolean gesperrt, String grund) {

        static Option frei(String id) {
            return new Option(id, false, null);
        }

        static Option gesperrt(String id, String grund) {
            return new Option(id, true, grund);
        }
    }

    /** Die Startwerte der Folgefragen (§3.2) - der Dialog erfindet keine. */
    public record Vorgaben(BigDecimal schwelleKw, BigDecimal preisgrenzeCtKwh,
            Integer mindestlaufzeitMinuten, Integer sperrzeitMinuten, Steuerart.Fenster fenster,
            String zielUhrzeit, String zielTage, BigDecimal zielEnergieKwh,
            Integer zielLaufzeitMinuten, int zielFensterStunden) {}

    // -----------------------------------------------------------------------
    // Die Saetze je Typ (§3.1)
    // -----------------------------------------------------------------------

    /**
     * Welche Quellen dieser Typ ueberhaupt kennt - OHNE Sperr-Pruefung.
     * Reihenfolge = die Reihenfolge der Karten im Dialog.
     *
     * <p><b>⚠ {@code sofort} steht in JEDEM Satz, und das ist eine argumentierte
     * Abweichung von der Tabelle §3.1</b> (dort traegt ihn nur der Ladepunkt).
     * Grund: {@code sofort} ist die Steuerart „VoltPilot steuert dieses Geraet
     * nicht" - genau der Zustand, den die Projektion fuer eine Komponente OHNE
     * Policy zurueckgibt (Regel 2), also der ANFANGSZUSTAND jedes Verbrauchers.
     * Ohne ihn im Satz gaebe es keinen Weg ZURUECK: wer seinem Heizstab einmal
     * eine Steuerart gegeben hat, koennte sie nie wieder abgeben, und die
     * Flaeche waere ein Editor, der nur in eine Richtung schreibt. Das WORT
     * haengt am Typ und wohnt im Portal („Sofort laden" am Ladepunkt, „Ohne
     * Steuerung durch VoltPilot" sonst); hier steht nur die Id.
     *
     * <p>Er steht am Ladepunkt VORNE (die abgenommene Mockup-Reihenfolge) und
     * sonst HINTEN - er ist dort die Ruecknahme, nicht der Vorschlag.
     */
    static List<String> quellenIds(String entityType) {
        if (SgReady.is(entityType)) {
            return anhaengen(SgReady.QUELLEN);
        }
        if (VerbraucherService.istLadepunkt(entityType)) {
            return List.of(SteuerartProjektion.QUELLE_SOFORT, SteuerartProjektion.QUELLE_UEBERSCHUSS,
                    SteuerartProjektion.QUELLE_GUENSTIG);
        }
        if ("heating-rod".equals(entityType)) {
            return anhaengen(List.of(SteuerartProjektion.QUELLE_UEBERSCHUSS,
                    SteuerartProjektion.QUELLE_FESTE_ZEITEN, SteuerartProjektion.QUELLE_GUENSTIG));
        }
        if ("pump".equals(entityType)) {
            // Captain-Satz E1: eine Pumpe laeuft nach Zeitplan, nicht nach Preis.
            return anhaengen(List.of(SteuerartProjektion.QUELLE_FESTE_ZEITEN));
        }
        // Schaltlast und alles Uebrige (die Zeile „generisch" aus §3.1).
        return anhaengen(List.of(SteuerartProjektion.QUELLE_UEBERSCHUSS,
                SteuerartProjektion.QUELLE_FESTE_ZEITEN, SteuerartProjektion.QUELLE_GUENSTIG));
    }

    /** Die Ruecknahme haengt hinten an - sie ist nie der Vorschlag. */
    private static List<String> anhaengen(List<String> aktive) {
        List<String> out = new ArrayList<>(aktive);
        out.add(SteuerartProjektion.QUELLE_SOFORT);
        return List.copyOf(out);
    }

    /** Welche Ziele dieser Typ kennt - OHNE Sperr-Pruefung (§3.1). */
    static List<String> zieleIds(String entityType) {
        if (SgReady.is(entityType)) {
            return List.of();
        }
        if (VerbraucherService.istLadepunkt(entityType)) {
            return List.of(SteuerartProjektion.ZIEL_BIS_UHRZEIT);
        }
        if ("heating-rod".equals(entityType) || "pump".equals(entityType)) {
            return List.of(SteuerartProjektion.ZIEL_LAUFZEIT_BIS);
        }
        return List.of();
    }

    /** Die Quellen-Karten des Dialogs, jede frei oder gesperrt MIT Grund. */
    public static List<Option> quellen(Kontext k) {
        List<Option> out = new ArrayList<>();
        for (String id : quellenIds(k.entityType())) {
            String grund = quelleGesperrt(k, id);
            out.add(grund == null ? Option.frei(id) : Option.gesperrt(id, grund));
        }
        return List.copyOf(out);
    }

    /** Die Ziel-Karten des Dialogs; {@code quelle} entscheidet den Sofort-Fall. */
    public static List<Option> ziele(Kontext k, String quelle) {
        List<Option> out = new ArrayList<>();
        for (String id : zieleIds(k.entityType())) {
            String grund = zielGesperrt(k, quelle, id);
            out.add(grund == null ? Option.frei(id) : Option.gesperrt(id, grund));
        }
        return List.copyOf(out);
    }

    /**
     * Der Sperrgrund einer Quelle, oder {@code null}. Die Reihenfolge ist eine
     * Aussage: die STRUKTURELLE Grenze (keine PV, kein flacher Tarif) steht vor
     * der PFLEGE-Luecke (keine Nennleistung) - die erste ist nicht zu beheben,
     * indem man ein Formularfeld ausfuellt.
     */
    static String quelleGesperrt(Kontext k, String quelle) {
        boolean ueberschuss = SteuerartProjektion.QUELLE_UEBERSCHUSS.equals(quelle)
                || SgReady.QUELLE_UEBERSCHUSS.equals(quelle);
        boolean guenstig = SteuerartProjektion.QUELLE_GUENSTIG.equals(quelle)
                || SgReady.QUELLE_GUENSTIG.equals(quelle);
        if (ueberschuss) {
            if (!k.hatPv()) {
                return GRUND_OHNE_PV;
            }
            // ⚠ Die SG-Ready-Freigabe braucht KEINE Nennleistung: sie schaltet
            // einen Kontakt, keine Leistung (P8). Ihre Schwelle hat eine eigene
            // Vorgabe (2 kW), die nicht aus dem Geraet stammt.
            //
            // ⚠ Und ein LADEPUNKT braucht sie seit P5 ebenso wenig: seine
            // Ueberschuss-Quelle ist die Quellen-Bahn der BOX, die gegen den
            // GEMESSENEN Ueberschuss deckelt - die Mindestleistung, ab der er
            // ueberhaupt anfaengt, wohnt dort (`min_kw`) und nicht in einer
            // gepflegten Nennleistung. Ihn hier zu sperren hiesse, eine Wahl zu
            // verweigern, die die Box ohne jede Pflege ausfuehren kann.
            if (!SgReady.is(k.entityType())
                    && !VerbraucherService.istLadepunkt(k.entityType())
                    && k.ratedPowerKw() == null) {
                return GRUND_OHNE_NENNLEISTUNG;
            }
            return null;
        }
        if (guenstig) {
            String tarif = k.tarifArt() == null ? "" : k.tarifArt();
            if ("dynamisch".equals(tarif)) {
                return null;
            }
            return "fest".equals(tarif) ? GRUND_TARIF_FEST : GRUND_TARIF_UNBEKANNT;
        }
        return null;
    }

    /** Der Sperrgrund eines Ziels, oder {@code null}. */
    static String zielGesperrt(Kontext k, String quelle, String ziel) {
        if (SgReady.is(k.entityType())) {
            return GRUND_KEIN_ZIEL_SGREADY;
        }
        if (SteuerartProjektion.QUELLE_SOFORT.equals(quelle)) {
            return GRUND_ZIEL_BEI_SOFORT;
        }
        if (SteuerartProjektion.ZIEL_BIS_UHRZEIT.equals(ziel)) {
            // D3: eine kWh-Zusage braucht einen Messkanal, sonst ist „fertig"
            // geraten (die Regel, an der `questions.ts` seit Inkrement 1 haengt).
            return misst(k) ? null : GRUND_ZIEL_OHNE_MESSUNG;
        }
        if (SteuerartProjektion.ZIEL_LAUFZEIT_BIS.equals(ziel)) {
            return k.ratedPowerKw() == null && !misst(k)
                    ? GRUND_LAUFZEIT_OHNE_NENNLEISTUNG : null;
        }
        return null;
    }

    /** Misst dieser Verbraucher wirklich Leistung (D3 Stufe 2)? */
    private static boolean misst(Kontext k) {
        return "power_kw".equals(k.confirmationChannel());
    }

    /**
     * Die Startwerte der Folgefragen (§3.2).
     *
     * <p><b>⚠ Eine Vorgabe, die nicht BELEGT ist, bleibt {@code null}</b> - das
     * Feld startet dann leer und der Kunde traegt sie ein. Eine erfundene
     * Schwelle waere eine Aussage ueber sein Geraet.
     */
    public static Vorgaben vorgaben(Kontext k) {
        BigDecimal schwelle;
        if (SgReady.is(k.entityType())) {
            schwelle = SgReady.SCHWELLE_KW_VORGABE;
        } else if (VerbraucherService.istLadepunkt(k.entityType())) {
            // Ein Ladepunkt startet bei seiner MINDEST-Ladeleistung: darunter
            // laedt er ohnehin nicht (§3.2 „Mindestleistung … 4,2 kW 3p").
            schwelle = k.minPowerKw() != null ? k.minPowerKw() : k.ratedPowerKw();
        } else {
            // Heizstab/Schaltlast: „Vorgabe = Nennleistung" (§3.2).
            schwelle = k.ratedPowerKw();
        }
        BigDecimal preis = k.preisgrenzeVorgabeCtKwh() != null ? k.preisgrenzeVorgabeCtKwh()
                : (SgReady.is(k.entityType()) ? SgReady.PREISGRENZE_CT_VORGABE : null);
        // ⚠ Die SG-Ready-Freigabe hat ihre EIGENE Vorgabe (30 min „Mindest-
        // freigabe" aus dem WP-Handbuch, P8) - dieselbe Folgefrage, eine andere
        // Zahl, weil sie eine andere Sache beschreibt.
        int mindestlaufzeit = SgReady.is(k.entityType()) ? SgReady.MINDESTFREIGABE_MINUTEN
                : MINDESTLAUFZEIT_MINUTEN;
        return new Vorgaben(schwelle, preis, mindestlaufzeit,
                SgReady.is(k.entityType()) ? SgReady.SPERRZEIT_MINUTEN : null,
                FESTE_ZEITEN_VORGABE, ZIEL_UHRZEIT, "daily", ZIEL_ENERGIE_KWH,
                ZIEL_LAUFZEIT_MINUTEN, ZIEL_FENSTER_STUNDEN);
    }

    // -----------------------------------------------------------------------
    // Der Zaun (§3.1 serverseitig)
    // -----------------------------------------------------------------------

    /**
     * Prueft einen Wunsch gegen den Satz dieses Typs. Leere Liste = zulaessig;
     * sonst der ERSTE Satz, den der Aufrufer als 400 zurueckgibt.
     *
     * <p>Die Regeln stehen hier und nicht im {@code ConsumerPolicyValidator}:
     * der ist ein DOKUMENT-Validator mit einem TS-Zwilling und geteilten
     * Vektoren und kennt den Verbrauchertyp per Konstruktion nicht (dieselbe
     * Begruendung wie bei {@link SgReady#findings}).
     */
    public static List<String> pruefe(Kontext k, SteuerartWunsch w) {
        List<String> out = new ArrayList<>();
        if (w == null || w.quelle() == null || w.quelle().isBlank()) {
            out.add("Bitte wählen Sie, womit dieses Gerät laufen soll.");
            return out;
        }
        Set<String> erlaubt = new LinkedHashSet<>(quellenIds(k.entityType()));
        if (!erlaubt.contains(w.quelle())) {
            out.add("Diese Steuerart kennt " + typWort(k.entityType()) + " nicht.");
            return out;
        }
        String sperre = quelleGesperrt(k, w.quelle());
        if (sperre != null) {
            out.add(sperre);
            return out;
        }
        if (SteuerartProjektion.QUELLE_FESTE_ZEITEN.equals(w.quelle())) {
            pruefeFenster(w.fenster(), "Zeitfenster", out);
        }
        if (SteuerartProjektion.QUELLE_UEBERSCHUSS.equals(w.quelle())
                || SgReady.QUELLE_UEBERSCHUSS.equals(w.quelle())) {
            if (w.schwelleKw() != null && w.schwelleKw().signum() <= 0) {
                out.add("Die Überschuss-Schwelle muss größer als 0 sein.");
            }
        }
        if (w.mindestlaufzeitMinuten() != null
                && (w.mindestlaufzeitMinuten() < 0 || w.mindestlaufzeitMinuten() > 1440)) {
            out.add("Die Mindestlaufzeit muss zwischen 0 und 1440 Minuten liegen.");
        }
        if (w.sperrzeitMinuten() != null
                && (w.sperrzeitMinuten() < 0 || w.sperrzeitMinuten() > 1440)) {
            out.add("Die Sperrzeit muss zwischen 0 und 1440 Minuten liegen.");
        }
        pruefeZiel(k, w, out);
        return out;
    }

    private static void pruefeZiel(Kontext k, SteuerartWunsch w, List<String> out) {
        if (w.ziel() == null || w.ziel().isBlank()) {
            return;
        }
        if (!zieleIds(k.entityType()).contains(w.ziel())) {
            out.add(SgReady.is(k.entityType()) ? GRUND_KEIN_ZIEL_SGREADY
                    : "Dieses Ziel kennt " + typWort(k.entityType()) + " nicht.");
            return;
        }
        String sperre = zielGesperrt(k, w.quelle(), w.ziel());
        if (sperre != null) {
            out.add(sperre);
            return;
        }
        pruefeFenster(w.zielFenster(), "Frist", out, true);
        if (SteuerartProjektion.ZIEL_BIS_UHRZEIT.equals(w.ziel())
                && w.zielEnergieKwh() != null && w.zielEnergieKwh().signum() <= 0) {
            out.add("Die Menge muss größer als 0 sein.");
        }
        if (SteuerartProjektion.ZIEL_LAUFZEIT_BIS.equals(w.ziel())
                && w.zielLaufzeitMinuten() != null
                && (w.zielLaufzeitMinuten() < 1 || w.zielLaufzeitMinuten() > 1440)) {
            out.add("Die Laufzeit muss zwischen 1 und 1440 Minuten liegen.");
        }
    }

    private static void pruefeFenster(Steuerart.Fenster f, String wort, List<String> out) {
        pruefeFenster(f, wort, out, false);
    }

    /**
     * Die FORM eines Fensters. {@code nurBis} = beim Ziel darf der Beginn
     * fehlen (der Server leitet ihn aus {@link #ZIEL_FENSTER_STUNDEN} ab).
     */
    private static void pruefeFenster(Steuerart.Fenster f, String wort, List<String> out,
            boolean nurBis) {
        if (f == null) {
            if (!nurBis) {
                out.add("Bitte geben Sie das " + wort + " an.");
            }
            return;
        }
        if (f.tage() != null && !f.tage().isBlank() && !TAGE.contains(f.tage())) {
            out.add("Unbekannter Tagesbezug im " + wort + ".");
        }
        if (!uhrzeit(f.bis())) {
            out.add("Ungültige Uhrzeit im " + wort + ".");
        }
        if (!nurBis && !uhrzeit(f.von())) {
            out.add("Ungültige Uhrzeit im " + wort + ".");
        } else if (f.von() != null && !f.von().isBlank() && !uhrzeit(f.von())) {
            out.add("Ungültige Uhrzeit im " + wort + ".");
        }
        if (f.von() != null && f.von().equals(f.bis())) {
            out.add("Anfang und Ende des " + wort + "s sind gleich.");
        }
    }

    /** {@code HH:mm}, plus das vertragliche {@code 24:00}. */
    static boolean uhrzeit(String t) {
        if (t == null || t.length() != 5 || t.charAt(2) != ':') {
            return false;
        }
        if ("24:00".equals(t)) {
            return true;
        }
        try {
            int h = Integer.parseInt(t.substring(0, 2));
            int m = Integer.parseInt(t.substring(3));
            return h >= 0 && h <= 23 && m >= 0 && m <= 59;
        } catch (NumberFormatException e) {
            return false;
        }
    }

    private static String typWort(String entityType) {
        return SgReady.is(entityType) ? "eine SG-Ready-Wärmepumpe"
                : VerbraucherService.istLadepunkt(entityType) ? "ein Ladepunkt"
                        : "dieses Gerät";
    }
}
