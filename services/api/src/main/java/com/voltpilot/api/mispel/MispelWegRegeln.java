package com.voltpilot.api.mispel;

import com.voltpilot.api.mispel.FoerderwegRegeln.Foerderweg;
import java.math.BigDecimal;
import java.text.DecimalFormat;
import java.text.DecimalFormatSymbols;
import java.time.LocalDate;
import java.time.LocalTime;
import java.time.YearMonth;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.UUID;

/**
 * „Der Weg zu MiSpeL“ je Anlage (MiSpeL MP-55, Bedienkonzept BK-52 A, Vertrag {@code docs/contracts/v2/mispel-weg.md}):
 * aus dem, was die Anlage heute in den MiSpeL-Quellen hat (Check, Förderweg samt Vormerkung, Zählerrollen,
 * Partnerangaben, Einverständnis, Monats- und Jahreslauf, Ladepunkte), die Stationen der drei Stationsfolgen mit Zustand,
 * Stand und Tür. Rein: liest nichts, schreibt nichts — {@link MispelWegService} sammelt den Eingang.
 *
 * <p>Wortlaut und Reihenfolge der Stationen sind die des Bedienkonzepts (Teil A BK-52 und Abschnitt 3.3). Eine Station,
 * deren Quelle es noch nicht gibt, bleibt {@code offen} mit einem Satz, der das sagt — nie ein erfundener Stand.
 */
public final class MispelWegRegeln {

    private MispelWegRegeln() {}

    /** Zustand einer Station (Vertrag § 2). */
    public static final String ERLEDIGT = "erledigt";
    public static final String JETZT = "jetzt";
    public static final String OFFEN = "offen";
    public static final String WARTET = "wartet";
    public static final String GESPERRT = "gesperrt";
    public static final List<String> ZUSTAENDE = List.of(ERLEDIGT, JETZT, OFFEN, WARTET, GESPERRT);

    /** Wo der Schritt geschieht (Vertrag § 3): führt das Portal · außerhalb · beides · läuft von selbst. */
    public static final String PORTAL = "portal";
    public static final String AUSSEN = "aussen";
    public static final String BEIDES = "beides";
    public static final String VOLTPILOT = "voltpilot";
    public static final List<String> WER = List.of(PORTAL, AUSSEN, BEIDES, VOLTPILOT);

    /** Die drei Stationsfolgen (Vertrag § 1). */
    public static final String ABGRENZUNG = "abgrenzung";
    public static final String PAUSCHAL = "pauschal";
    public static final String LADEPUNKT = "ladepunkt";

    /** Ziele der Türen: vorhandene Flächen des Portals (Vertrag § 4). */
    public static final String ZIEL_CHECK = "check";
    public static final String ZIEL_FOERDERWEG = "foerderweg";
    public static final String ZIEL_MESSSTELLEN_REGISTER = "messstellen_register";
    public static final String ZIEL_PARTNERANGABEN = "partnerangaben";
    public static final String ZIEL_NACHWEIS = "nachweis";
    public static final String ZIEL_ERLOESE = "erloese";
    public static final String ZIEL_AUFBAU = "aufbau";
    public static final String ZIEL_WALLBOX_KARTE = "wallbox_karte";
    public static final List<String> ZIELE = List.of(ZIEL_CHECK, ZIEL_FOERDERWEG, ZIEL_MESSSTELLEN_REGISTER,
            ZIEL_PARTNERANGABEN, ZIEL_NACHWEIS, ZIEL_ERLOESE, ZIEL_AUFBAU, ZIEL_WALLBOX_KARTE);

    /**
     * Warum „Zurückspeisen fahren“ gesperrt ist: der Schalter der Box ist aus und hat keine Umgebungsvariable; eine
     * Freigabe braucht den Prüfstand MP-42 und die Freigabe des Captains für die Box.
     */
    public static final String RUECKSPEISEN_SPERRE = "edge-app/core/internal/config/config.go, Config.V2XEntladen";

    /** Höchstgrenze der Pauschaloption, wie {@link PauschalVormerkungService#GRENZE_KWP}. */
    private static final BigDecimal GRENZE_KWP = PauschalVormerkungService.GRENZE_KWP;

    private static final String NBSP = " ";
    private static final String MINUS = "−";
    private static final DateTimeFormatter TAG = DateTimeFormatter.ofPattern("dd.MM.yyyy");
    private static final DateTimeFormatter MONAT = DateTimeFormatter.ofPattern("LLLL yyyy", Locale.GERMAN);
    private static final DateTimeFormatter UHR = DateTimeFormatter.ofPattern("HH:mm");
    private static final String[] WOCHENTAG = {"Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"};

    // ------------------------------------------------------------------ Eingang

    /**
     * Was die Anlage heute in den Quellen hat. {@code speicher}: ein stationärer Speicher im Aufbau; {@code profil}:
     * privat · gewerbe · {@code null}; {@code check} {@code null} = keine Zeile; {@code foerderweg}: der Förderweg heute
     * (Fassung oder Bestand); {@code vormerkung}: eine Fassung nach heute; {@code pauschalVormerkung}: die stehende
     * Vormerkung der Pauschaloption; {@code solarKwp} {@code null} = unbekannt; {@code pauschaloptionAb} {@code null} =
     * keine EU-Genehmigung; {@code monat}/{@code jahr}: der jüngste Lauf der Abgrenzungs- bzw. Pauschaloption.
     */
    public record Eingang(LocalDate heute, boolean speicher, String profil, Check check, Weg foerderweg, Weg vormerkung,
            Vormerkung pauschalVormerkung, BigDecimal solarKwp, LocalDate pauschaloptionAb, List<Zaehler> zaehler,
            Monat monat, Jahr jahr, List<Ladepunkt> ladepunkte) {}

    /** Der letzte Stand des Checks ({@code site_mispel_check}). */
    public record Check(String stand, String formelsatz, BigDecimal mittelEur, String hinweis) {}

    /** Eine Fassung des Förderwegs; {@code gueltigAb} {@code null} = Bestand ohne Fassung. */
    public record Weg(String foerderweg, String formelsatz, boolean einverstaendnis, String direktvermarkter,
            Boolean bilanzkreisGesondert, LocalDate gueltigAb) {}

    /** Die stehende Vormerkung der Pauschaloption mit den Bestätigungen des Kunden. */
    public record Vormerkung(BigDecimal steckersolarKwp, boolean einBetreiberBestaetigt,
            boolean steckersolarDvBestaetigt, String direktvermarkter, Boolean bilanzkreisGesondert) {}

    /** Eine Messstelle der Anlage mit Zählerrolle (Z1, Z2, Z3) und dem Urteil des Registers. */
    public record Zaehler(String kennzeichen, String rolle, String urteil) {}

    /** Der jüngste Monatslauf: vorlaeufig · endgueltig. */
    public record Monat(YearMonth monat, String stand) {}

    /** Der jüngste Jahreslauf der Pauschaloption: vorlaeufig · endgueltig. */
    public record Jahr(int jahr, String stand) {}

    /**
     * Ein Ladepunkt: Fähigkeit heute, Urteile des Zählers Z2 am Ladepunkt, Fahrzeugfenster ({@code anwesenheit} leer =
     * nicht eingetragen) und die Wahl des Fahrers ({@code rueckspeisen} {@code null} = nie gewählt).
     */
    public record Ladepunkt(UUID komponenteId, String label, boolean bidirektional, List<String> z2Urteile,
            BigDecimal mindestSocPct, List<LadepunktRegeln.Fenster> anwesenheit, String rueckspeisen) {}

    // ------------------------------------------------------------------ Ausgabe

    public record Tuer(String ziel, String beschriftung) {}

    public record Station(int nr, String schluessel, String titel, String erklaerung, String wer, String zustand,
            String stand, Tuer tuer) {}

    /** Eine Stationsfolge; {@code komponenteId} nur beim Ladepunkt. */
    public record Strecke(String art, String titel, UUID komponenteId, int erledigt, int gesamt, String satz,
            List<Station> stationen) {}

    /** Alle Strecken der Anlage; {@code satz} ist der Satz der ersten (die Zeile in der Übersicht). */
    public record Ergebnis(String satz, List<Strecke> strecken) {}

    /** Eine Station, wie das Konzept sie benennt; {@code kurz}: das Wort im Satz, solange sie wartet oder sperrt. */
    private record Def(int nr, String schluessel, String titel, String erklaerung, String wer, String kurz) {}

    private static final String IHR_WEG = "Ihr Weg zu MiSpeL";
    private static final String AUTO = "Das Auto als Speicher";

    private static final Def A_RECHNEN = new Def(1, "rechnen", "Rechnen: Lohnt es sich?",
            "Dieselbe Anlage, heute gegen mit MiSpeL – über ein ganzes Jahr.", PORTAL, null);
    private static final Def A_FOERDERWEG = new Def(2, "foerderweg", "Förderweg wählen",
            "Je Einspeisestelle gibt es genau einen Förderweg; MiSpeL setzt die Direktvermarktung voraus.", PORTAL, null);
    private static final Def A_ZAEHLER = new Def(3, "zaehler", "Zähler klären",
            "Zwei geeichte Zähler: am Netzanschluss und am Speicher. Hängen Solarstränge am selben Wechselrichter wie der "
                    + "Speicher, zusätzlich eine geeichte Messung auf der Gleichstromseite. Ohne Solaranlage genügt der "
                    + "Zähler am Netzanschluss.", BEIDES, null);
    private static final Def A_DIREKTVERMARKTER = new Def(4, "direktvermarkter", "Direktvermarkter beauftragen",
            "Der Direktvermarkter führt die ganze Einspeisung in einem gesonderten Bilanzkreis. Den Vertrag schließen "
                    + "Sie; im Portal tragen Sie ihn ein.", AUSSEN, null);
    private static final Def A_EINVERSTAENDNIS = new Def(5, "einverstaendnis", "Einverständnis einholen",
            "Bis 30.09.2027 müssen Netzbetreiber und Messstellenbetreiber einverstanden sein; danach nicht mehr.", AUSSEN,
            null);
    private static final Def A_WECHSEL = new Def(6, "wechsel", "Wechsel zum Monatsersten",
            "Der neue Förderweg gilt ab einem Monatsersten. Sie merken ihn im Portal vor; bis dahin bleibt alles, wie es "
                    + "ist.", PORTAL, null);
    private static final Def A_MONAT = new Def(7, "monat", "Monat rechnen und abgleichen",
            "Nach jedem Monat bestimmt VoltPilot die Mengen in Grün, Gelb und Rot und vergleicht die eigenen Gerätewerte "
                    + "mit denen des Messstellenbetreibers.", VOLTPILOT, null);
    private static final Def A_NACHWEIS = new Def(8, "nachweis", "Nachweis weitergeben",
            "Der Monatsnachweis geht an Lieferant, Direktvermarkter und Netzbetreiber; der Jahresnachweis ist für die "
                    + "Mitteilung Ihres Lieferanten, die bis 31.05. des Folgejahres fällig ist.", BEIDES, null);

    private static final Def P_RECHNEN = new Def(1, "rechnen", "Rechnen: Lohnt es sich?",
            "Ihre Anlage, heute gegen mit Pauschaloption.", PORTAL, null);
    private static final Def P_VORMERKEN = new Def(2, "vormerken", "Pauschaloption vormerken",
            "Vormerken kostet nichts und ändert heute nichts.", PORTAL, null);
    private static final Def P_VORAUSSETZUNGEN = new Def(3, "voraussetzungen", "Voraussetzungen prüfen",
            "Solaranlagen bis zusammen 30 kWp; Solaranlage, Speicher und Anschluss gehören derselben Person; keine feste "
                    + "Vergütung und kein Mieterstrom mehr.", PORTAL, null);
    private static final Def P_DIREKTVERMARKTER = new Def(4, "direktvermarkter", "Direktvermarkter beauftragen",
            "Auch ein Haushalt braucht für MiSpeL einen Direktvermarkter. Den Vertrag schließen Sie; im Portal tragen Sie "
                    + "ihn ein.", AUSSEN, null);
    private static final Def P_EU = new Def(5, "eu_genehmigung", "Genehmigung der EU-Kommission",
            "Die Pauschaloption ist erst anwendbar, wenn die EU-Kommission sie genehmigt hat.", AUSSEN,
            "wartet auf die EU");
    private static final Def P_WECHSEL = new Def(6, "wechsel", "Wechsel am Monatsersten danach",
            "VoltPilot stellt Ihre Anlage am ersten Monatsersten nach der Genehmigung um – Sie müssen nichts mehr tun.",
            VOLTPILOT, null);
    private static final Def P_JAHRESSTAND = new Def(7, "jahresstand", "Jahresstand verfolgen",
            "Bis 500 kWh je kWp und Jahr gibt es die Marktprämie; darüber ein Zwischenbereich, danach entfallen Umlagen.",
            VOLTPILOT, null);
    private static final Def P_JAHRESNACHWEIS = new Def(8, "jahresnachweis", "Jahresnachweis",
            "Einmal im Jahr für die Abrechnung Ihres Lieferanten.", BEIDES, null);

    private static final Def L_LADEPUNKT = new Def(1, "ladepunkt", "Ladepunkt eintragen",
            "Ein Ladepunkt, der zurückspeisen kann, zählt wie ein Speicher – egal, welches Auto angesteckt ist.", PORTAL,
            null);
    private static final Def L_ZAEHLER = new Def(2, "zaehler", "Zähler am Ladepunkt",
            "Ein geeichter Zähler an der Wallbox – oder ihre signierten Messwerte.", BEIDES, null);
    private static final Def L_FENSTER = new Def(3, "fahrzeugfenster", "Wann ist das Auto da?",
            "Sie sagen, wann das Auto üblicherweise angesteckt ist, wie voll es zur Abfahrt sein soll und was immer drin "
                    + "bleibt.", PORTAL, null);
    private static final Def L_WAHL = new Def(4, "rueckspeisen_waehlen", "Zurückspeisen wählen",
            "Aus · Ins Haus · Haus + Netz.", PORTAL, null);
    private static final Def L_FAHREN = new Def(5, "rueckspeisen_fahren", "Zurückspeisen fahren",
            "Die Box gibt den Entladebefehl an die Wallbox.", VOLTPILOT, "Zurückspeisen noch aus");
    private static final Def L_MONAT = new Def(6, "monat", "Monat rechnen",
            "Der Strom, mit dem Sie fahren, bleibt voll belastet; Strom, der woanders geladen wurde, zählt beim "
                    + "Zurückspeisen nicht mit.", VOLTPILOT, null);

    // ------------------------------------------------------------------ Wahl der Strecken

    /**
     * Die Strecken der Anlage (Vertrag § 1): mit stationärem Speicher zuerst die des Speichers — Abgrenzungsoption, wenn
     * der Förderweg heute oder vorgemerkt dort steht, sonst Pauschaloption, wenn sie gewählt, vorgemerkt oder gerechnet
     * ist oder die Anlage ein Haushalt bis 30 kWp ist, sonst Abgrenzungsoption —, danach je Ladepunkt eine; ein Ladepunkt,
     * der nur laden kann, zählt nur an einer Anlage ohne Speicher.
     */
    public static Ergebnis strecken(Eingang e) {
        List<Strecke> alle = new ArrayList<>();
        if (e.speicher()) {
            alle.add(pauschalStrecke(e) ? pauschal(e) : abgrenzung(e));
        }
        for (Ladepunkt lp : liste(e.ladepunkte())) {
            if (lp.bidirektional() || !e.speicher()) {
                alle.add(ladepunkt(e, lp));
            }
        }
        String satz = alle.isEmpty()
                ? "Diese Anlage hat keinen Speicher und keinen Ladepunkt im Aufbau – MiSpeL betrifft sie nicht."
                : alle.get(0).satz();
        return new Ergebnis(satz, List.copyOf(alle));
    }

    static boolean pauschalStrecke(Eingang e) {
        if (abgrenzungGewaehlt(e.foerderweg()) || abgrenzungGewaehlt(e.vormerkung())) {
            return false;
        }
        if (pauschalGewaehlt(e.foerderweg()) || pauschalGewaehlt(e.vormerkung()) || e.pauschalVormerkung() != null
                || (e.check() != null && e.check().formelsatz() != null && e.check().formelsatz().matches("P\\d.*"))) {
            return true;
        }
        return "privat".equals(e.profil()) && (e.solarKwp() == null || e.solarKwp().compareTo(GRENZE_KWP) <= 0);
    }

    /** Die Anlage 1 gilt: Abgrenzungsoption, oder ungefördert mit einem Formelsatz der Anlage 1 (Tenor Ziff. 1 S. 2). */
    static boolean abgrenzungGewaehlt(Weg w) {
        return w != null && (Foerderweg.MARKTPRAEMIE_ABGRENZUNG.wert().equals(w.foerderweg())
                || (Foerderweg.UNGEFOERDERT.wert().equals(w.foerderweg()) && w.formelsatz() != null));
    }

    static boolean pauschalGewaehlt(Weg w) {
        return w != null && Foerderweg.MARKTPRAEMIE_PAUSCHAL.wert().equals(w.foerderweg());
    }

    // ------------------------------------------------------------------ Abgrenzungsoption (Gewerbe)

    private static Strecke abgrenzung(Eingang e) {
        Weg heute = e.foerderweg();
        boolean gewechselt = abgrenzungGewaehlt(heute);
        boolean vorgemerkt = !gewechselt && abgrenzungGewaehlt(e.vormerkung());
        Weg neuester = e.vormerkung() != null ? e.vormerkung() : heute;
        List<Station> s = new ArrayList<>();

        s.add(rechnen(A_RECHNEN, e.check(), gewechselt || vorgemerkt
                ? "Nicht im Portal gerechnet – der Förderweg ist schon gewählt" : null));

        if (gewechselt) {
            s.add(st(A_FOERDERWEG, ERLEDIGT, "Heute: " + begriff(heute) + formelsatz(heute), foerderwegTuer()));
        } else if (vorgemerkt) {
            s.add(st(A_FOERDERWEG, ERLEDIGT, "Gewählt: " + begriff(e.vormerkung()) + formelsatz(e.vormerkung())
                    + " ab " + tag(e.vormerkung().gueltigAb()), foerderwegTuer()));
        } else {
            s.add(st(A_FOERDERWEG, OFFEN, heute == null ? "Förderweg unbekannt" : "Heute: " + begriff(heute)
                    + (Foerderweg.UNGEFOERDERT.wert().equals(heute.foerderweg())
                            ? ", ohne Formelsatz der Anlage 1" : ""), foerderwegTuer()));
        }

        s.add(zaehler(e.zaehler()));
        s.add(direktvermarkter(A_DIREKTVERMARKTER, neuester == null ? null : neuester.direktvermarkter(),
                neuester == null ? null : neuester.bilanzkreisGesondert()));

        if (e.heute().isAfter(FoerderwegRegeln.EINVERSTAENDNIS_BIS)) {
            s.add(st(A_EINVERSTAENDNIS, ERLEDIGT, "Nach dem " + tag(FoerderwegRegeln.EINVERSTAENDNIS_BIS)
                    + " nicht mehr nötig", null));
        } else if (neuester != null && neuester.einverstaendnis()) {
            s.add(st(A_EINVERSTAENDNIS, ERLEDIGT, "Bestätigt", new Tuer(ZIEL_FOERDERWEG, "Förderweg ändern")));
        } else {
            s.add(st(A_EINVERSTAENDNIS, OFFEN, "Noch nicht bestätigt · nötig bis "
                    + tag(FoerderwegRegeln.EINVERSTAENDNIS_BIS), new Tuer(ZIEL_FOERDERWEG, "Einverständnis bestätigen")));
        }

        LocalDate wechselAb;
        if (gewechselt) {
            wechselAb = null;
            s.add(st(A_WECHSEL, ERLEDIGT, heute.gueltigAb() == null ? "Gewechselt" : "Seit " + tag(heute.gueltigAb()),
                    foerderwegTuer()));
        } else if (vorgemerkt) {
            wechselAb = e.vormerkung().gueltigAb();
            s.add(st(A_WECHSEL, WARTET, "Vorgemerkt zum " + tag(wechselAb),
                    new Tuer(ZIEL_FOERDERWEG, "Vormerkung ansehen")));
        } else {
            wechselAb = FoerderwegRegeln.naechsterMonatserster(e.heute());
            s.add(st(A_WECHSEL, OFFEN, "Frühestens zum " + tag(wechselAb), foerderwegTuer()));
        }

        Monat m = e.monat();
        if (gewechselt && m != null) {
            boolean endgueltig = "endgueltig".equals(m.stand());
            s.add(st(A_MONAT, endgueltig ? ERLEDIGT : WARTET, monat(m.monat()) + (endgueltig ? " endgültig" : " vorläufig"),
                    new Tuer(ZIEL_ERLOESE, "Monat ansehen")));
            s.add(st(A_NACHWEIS, endgueltig ? OFFEN : WARTET, endgueltig
                    ? "Nachweis für " + monat(m.monat()) + " liegt bereit"
                    : "Vorläufig für " + monat(m.monat()) + " – weitergeben, wenn der Monat endgültig ist",
                    new Tuer(ZIEL_NACHWEIS, "Nachweis öffnen")));
        } else if (gewechselt) {
            s.add(st(A_MONAT, WARTET, "Noch kein Monat gerechnet", null));
            s.add(st(A_NACHWEIS, WARTET, "Kommt mit dem ersten gerechneten Monat", null));
        } else {
            s.add(st(A_MONAT, OFFEN, "Beginnt mit dem ersten Monat nach dem Wechsel", null));
            s.add(st(A_NACHWEIS, OFFEN, "Erster Nachweis frühestens Anfang " + monat(YearMonth.from(wechselAb)
                    .plusMonths(1)), null));
        }

        String vorrang = !gewechselt && !vorgemerkt ? lohntNicht(e.check()) : null;
        return strecke(ABGRENZUNG, IHR_WEG, null, s, vorrang);
    }

    // ------------------------------------------------------------------ Pauschaloption (Haushalt)

    private static Strecke pauschal(Eingang e) {
        Weg heute = e.foerderweg();
        boolean gewechselt = pauschalGewaehlt(heute);
        boolean fassungVorgemerkt = !gewechselt && pauschalGewaehlt(e.vormerkung());
        Vormerkung v = e.pauschalVormerkung();
        LocalDate eu = e.pauschaloptionAb();
        List<Station> s = new ArrayList<>();

        s.add(rechnen(P_RECHNEN, e.check(), gewechselt || fassungVorgemerkt
                ? "Nicht im Portal gerechnet – der Förderweg ist schon gewählt"
                : v != null ? "Nicht im Portal gerechnet – die Pauschaloption ist schon vorgemerkt" : null));

        if (gewechselt) {
            s.add(st(P_VORMERKEN, ERLEDIGT, "Heute: " + begriff(heute), foerderwegTuer()));
        } else if (fassungVorgemerkt) {
            s.add(st(P_VORMERKEN, ERLEDIGT, "Gewählt ab " + tag(e.vormerkung().gueltigAb()), foerderwegTuer()));
        } else if (v != null) {
            s.add(st(P_VORMERKEN, ERLEDIGT, "Vorgemerkt · " + (eu == null ? "Termin offen"
                    : "Umstellung zum " + tag(laeuferAb(eu, e.heute()))),
                    new Tuer(ZIEL_FOERDERWEG, "Vormerkung ansehen")));
        } else {
            s.add(st(P_VORMERKEN, OFFEN, "Noch nicht vorgemerkt", new Tuer(ZIEL_FOERDERWEG, "Pauschaloption vormerken")));
        }

        s.add(voraussetzungen(e, gewechselt || fassungVorgemerkt));

        String dv = v != null && v.direktvermarkter() != null ? v.direktvermarkter()
                : e.vormerkung() != null && e.vormerkung().direktvermarkter() != null ? e.vormerkung().direktvermarkter()
                : heute == null ? null : heute.direktvermarkter();
        Boolean bk = v != null && v.direktvermarkter() != null ? v.bilanzkreisGesondert()
                : e.vormerkung() != null && e.vormerkung().direktvermarkter() != null
                        ? e.vormerkung().bilanzkreisGesondert() : heute == null ? null : heute.bilanzkreisGesondert();
        s.add(direktvermarkter(P_DIREKTVERMARKTER, dv, bk));

        if (eu == null) {
            s.add(st(P_EU, WARTET, "Ausstehend – einen Termin gibt es nicht", null));
        } else {
            s.add(st(P_EU, ERLEDIGT, "Genehmigt · anwendbar ab " + tag(eu), null));
        }

        if (gewechselt) {
            s.add(st(P_WECHSEL, ERLEDIGT, heute.gueltigAb() == null ? "Gewechselt" : "Seit " + tag(heute.gueltigAb()),
                    null));
        } else if (fassungVorgemerkt) {
            s.add(st(P_WECHSEL, WARTET, "Umstellung zum " + tag(e.vormerkung().gueltigAb()), null));
        } else if (eu == null) {
            s.add(st(P_WECHSEL, GESPERRT, "Wartet auf die Genehmigung", null));
        } else if (v != null) {
            s.add(st(P_WECHSEL, WARTET, "Umstellung zum " + tag(laeuferAb(eu, e.heute())) + ohneEinverstaendnis(eu,
                    e.heute()), null));
        } else {
            s.add(st(P_WECHSEL, OFFEN, "Nach der Vormerkung frühestens zum " + tag(laeuferAb(eu, e.heute()))
                    + ohneEinverstaendnis(eu, e.heute()), null));
        }

        Jahr j = e.jahr();
        if (gewechselt && j != null) {
            boolean endgueltig = "endgueltig".equals(j.stand());
            s.add(st(P_JAHRESSTAND, endgueltig ? ERLEDIGT : WARTET, j.jahr() + (endgueltig ? " endgültig" : " läuft, vorläufig"),
                    new Tuer(ZIEL_ERLOESE, "Jahresstand ansehen")));
        } else if (gewechselt) {
            s.add(st(P_JAHRESSTAND, WARTET, "Noch kein Jahr gerechnet", null));
        } else {
            s.add(st(P_JAHRESSTAND, eu == null ? GESPERRT : OFFEN, "Beginnt mit dem Wechsel", null));
        }

        if (!gewechselt && eu == null) {
            s.add(st(P_JAHRESNACHWEIS, GESPERRT, "Beginnt mit dem Wechsel", null));
        } else {
            // Eine Quelle dafür gibt es noch nicht: der Nachweis (MP-16) liest nur Läufe der Abgrenzungsoption.
            s.add(st(P_JAHRESNACHWEIS, OFFEN, "Noch nicht erfasst: einen Jahresnachweis der Pauschaloption gibt es im "
                    + "Portal noch nicht", null));
        }

        String vorrang = !gewechselt && !fassungVorgemerkt && v == null ? lohntNicht(e.check()) : null;
        return strecke(PAUSCHAL, IHR_WEG, null, s, vorrang);
    }

    private static Station voraussetzungen(Eingang e, boolean mitFassung) {
        Vormerkung v = e.pauschalVormerkung();
        Tuer tuer = new Tuer(ZIEL_FOERDERWEG, "Voraussetzungen ansehen");
        if (mitFassung) {
            return st(P_VORAUSSETZUNGEN, ERLEDIGT, "Mit dem Förderweg eingetragen", tuer);
        }
        if (v == null) {
            return st(P_VORAUSSETZUNGEN, OFFEN, "Noch nicht geprüft – das geschieht beim Vormerken", tuer);
        }
        if (e.solarKwp() == null) {
            return st(P_VORAUSSETZUNGEN, OFFEN, "Solarleistung im Aufbau unbekannt", tuer);
        }
        String leistung = zahl(e.solarKwp()) + NBSP + "kWp" + (v.steckersolarKwp() != null
                && v.steckersolarKwp().signum() > 0 ? " + Steckersolar " + zahl(v.steckersolarKwp()) + NBSP + "kWp" : "");
        if (e.solarKwp().compareTo(GRENZE_KWP) > 0) {
            return st(P_VORAUSSETZUNGEN, OFFEN, leistung + " – die Pauschaloption gilt bis " + zahl(GRENZE_KWP) + NBSP
                    + "kWp", tuer);
        }
        boolean steckersolar = v.steckersolarKwp() == null || v.steckersolarKwp().signum() == 0
                || v.steckersolarDvBestaetigt();
        boolean bestaetigt = v.einBetreiberBestaetigt() && steckersolar;
        return st(P_VORAUSSETZUNGEN, bestaetigt ? ERLEDIGT : OFFEN, leistung + (bestaetigt ? " · bestätigt"
                : " · noch nicht bestätigt"), tuer);
    }

    /**
     * Der Monatserste, zu dem der {@link PauschalVormerkungService#umsetzen PauschalVormerkungLaeufer} eine stehende
     * Vormerkung umstellt: der nächste nach heute und nach dem Tag der Genehmigung — bis 30.09.2027 aber nicht, denn die
     * Vormerkung trägt kein Einverständnis von Netz- und Messstellenbetreiber (Tenor S. 3 Ziff. 9a).
     */
    private static LocalDate laeuferAb(LocalDate pauschaloptionAb, LocalDate heute) {
        LocalDate d = umstellung(pauschaloptionAb, heute);
        return d.isAfter(FoerderwegRegeln.EINVERSTAENDNIS_BIS) ? d : FoerderwegRegeln.EINVERSTAENDNIS_BIS.plusDays(1);
    }

    private static String ohneEinverstaendnis(LocalDate pauschaloptionAb, LocalDate heute) {
        return umstellung(pauschaloptionAb, heute).isAfter(FoerderwegRegeln.EINVERSTAENDNIS_BIS) ? ""
                : " · früher nur mit Einverständnis von Netz- und Messstellenbetreiber";
    }

    private static LocalDate umstellung(LocalDate pauschaloptionAb, LocalDate heute) {
        LocalDate erster = pauschaloptionAb.getDayOfMonth() == 1 ? pauschaloptionAb
                : FoerderwegRegeln.naechsterMonatserster(pauschaloptionAb);
        LocalDate naechster = FoerderwegRegeln.naechsterMonatserster(heute);
        return erster.isAfter(naechster) ? erster : naechster;
    }

    // ------------------------------------------------------------------ Ladepunkt (Auto)

    private static Strecke ladepunkt(Eingang e, Ladepunkt lp) {
        List<Station> s = new ArrayList<>();
        String name = lp.label() == null || lp.label().isBlank() ? "Ladepunkt" : lp.label();
        s.add(st(L_LADEPUNKT, lp.bidirektional() ? ERLEDIGT : OFFEN,
                name + (lp.bidirektional() ? " · kann laden und zurückspeisen" : " · nur Laden eingetragen"),
                new Tuer(ZIEL_AUFBAU, "Aufbau ansehen")));

        List<String> z2 = liste(lp.z2Urteile());
        Tuer register = new Tuer(ZIEL_MESSSTELLEN_REGISTER, "Zähler im Register ansehen");
        if (z2.isEmpty()) {
            s.add(st(L_ZAEHLER, OFFEN, "Kein Zähler am Ladepunkt im Register", register));
        } else {
            String u = gruppenUrteil(z2);
            s.add(st(L_ZAEHLER, "tauglich".equals(u) ? ERLEDIGT : OFFEN, "Zähler an der Wallbox: " + urteilWort(u),
                    register));
        }

        List<LadepunktRegeln.Fenster> fenster = liste(lp.anwesenheit());
        Tuer karte = new Tuer(ZIEL_WALLBOX_KARTE, "Abfahrt und Reserve");
        if (fenster.isEmpty()) {
            s.add(st(L_FENSTER, OFFEN, "Noch nicht eingetragen", karte));
        } else {
            s.add(st(L_FENSTER, ERLEDIGT, fensterText(fenster) + (lp.mindestSocPct() == null ? ""
                    : " · nie unter " + prozent(lp.mindestSocPct())), karte));
        }

        Tuer wahl = new Tuer(ZIEL_WALLBOX_KARTE, "Wallbox-Karte");
        if (lp.rueckspeisen() == null) {
            s.add(st(L_WAHL, OFFEN, "Noch nicht gewählt – bis dahin aus", wahl));
        } else {
            s.add(st(L_WAHL, ERLEDIGT, "Gewählt: " + switch (lp.rueckspeisen()) {
                case LadepunktRegeln.RUECKSPEISEN_V2H -> "Ins Haus";
                case LadepunktRegeln.RUECKSPEISEN_V2G -> "Haus + Netz";
                default -> "Aus";
            }, wahl));
        }

        // Der Schalter der Box ist aus, bis der Prüfstand das Zurückspeisen freigibt (RUECKSPEISEN_SPERRE).
        s.add(st(L_FAHREN, GESPERRT, "Bei VoltPilot noch ausgeschaltet – erst nach der Prüfung an echter Wallbox und "
                + "echtem Auto", null));

        boolean anlage1 = abgrenzungGewaehlt(e.foerderweg());
        Monat m = e.monat();
        if (anlage1 && m != null) {
            boolean endgueltig = "endgueltig".equals(m.stand());
            s.add(st(L_MONAT, endgueltig ? ERLEDIGT : WARTET, monat(m.monat()) + (endgueltig ? " endgültig" : " vorläufig"),
                    new Tuer(ZIEL_ERLOESE, "Erträge am Ladepunkt")));
        } else if (anlage1) {
            s.add(st(L_MONAT, WARTET, "Noch kein Monat gerechnet", null));
        } else {
            s.add(st(L_MONAT, OFFEN, "Beginnt mit dem ersten Monat in der Abgrenzungsoption", null));
        }
        return strecke(LADEPUNKT, AUTO, lp.komponenteId(), s, null);
    }

    /** „Mo–Fr 17:45 bis 07:15 · Abfahrt 80 %“ — gleiche Fenster an aufeinanderfolgenden Tagen zusammengefasst. */
    static String fensterText(List<LadepunktRegeln.Fenster> fenster) {
        List<LadepunktRegeln.Fenster> sortiert = new ArrayList<>(fenster);
        sortiert.sort((a, b) -> a.wochentag() != b.wochentag() ? Integer.compare(a.wochentag(), b.wochentag())
                : a.ankunft().compareTo(b.ankunft()));
        List<String> teile = new ArrayList<>();
        int i = 0;
        while (i < sortiert.size()) {
            LadepunktRegeln.Fenster f = sortiert.get(i);
            int j = i;
            while (j + 1 < sortiert.size() && gleich(sortiert.get(j + 1), f)
                    && sortiert.get(j + 1).wochentag() == sortiert.get(j).wochentag() + 1) {
                j++;
            }
            String tage = WOCHENTAG[f.wochentag() - 1] + (j > i ? "–" + WOCHENTAG[sortiert.get(j).wochentag() - 1] : "");
            teile.add(tage + " " + uhr(f.ankunft()) + " bis " + uhr(f.abfahrt())
                    + (f.abfahrtSocPct() == null ? "" : " · Abfahrt " + prozent(f.abfahrtSocPct())));
            i = j + 1;
        }
        return String.join("; ", teile);
    }

    private static boolean gleich(LadepunktRegeln.Fenster a, LadepunktRegeln.Fenster b) {
        return a.ankunft().equals(b.ankunft()) && a.abfahrt().equals(b.abfahrt())
                && (a.abfahrtSocPct() == null ? b.abfahrtSocPct() == null
                        : b.abfahrtSocPct() != null && a.abfahrtSocPct().compareTo(b.abfahrtSocPct()) == 0);
    }

    // ------------------------------------------------------------------ gemeinsame Stationen

    /** {@code schonGewaehlt}: der Satz, wenn ohne Rechnung schon gewählt ist; {@code null} = noch nichts gewählt. */
    private static Station rechnen(Def d, Check c, String schonGewaehlt) {
        Tuer tuer = new Tuer(ZIEL_CHECK, "Rechnung ansehen");
        if (c != null && "fertig".equals(c.stand()) && c.mittelEur() != null) {
            return st(d, ERLEDIGT, euro(c.mittelEur()) + " im Jahr · " + urteil(c.mittelEur()), tuer);
        }
        if (schonGewaehlt != null) {
            return st(d, ERLEDIGT, schonGewaehlt, tuer);
        }
        if (c == null) {
            return st(d, OFFEN, "Noch nicht gerechnet", tuer);
        }
        return switch (c.stand()) {
            case "wird_gerechnet" -> st(d, WARTET, "Wird gerechnet", tuer);
            case "fehlgeschlagen" -> st(d, OFFEN, hinweis(c, "Der Check konnte für diese Anlage nicht gerechnet werden."),
                    tuer);
            default -> st(d, OFFEN, hinweis(c, "Diesen Formelsatz rechnet der Check noch nicht."), tuer);
        };
    }

    private static Station zaehler(List<Zaehler> zaehler) {
        List<String> netz = new ArrayList<>();
        List<String> speicher = new ArrayList<>();
        for (Zaehler z : liste(zaehler)) {
            if ("Z1".equals(z.rolle())) {
                netz.add(z.urteil());
            } else if ("Z2".equals(z.rolle()) || "Z3".equals(z.rolle())) {
                speicher.add(z.urteil());
            }
        }
        Tuer tuer = new Tuer(ZIEL_MESSSTELLEN_REGISTER, "Zähler im Register ansehen");
        if (netz.isEmpty() && speicher.isEmpty()) {
            return st(A_ZAEHLER, OFFEN, "Noch keine Zählerrolle im Register", tuer);
        }
        String n = gruppenUrteil(netz);
        String sp = gruppenUrteil(speicher);
        boolean fertig = "tauglich".equals(n) && "tauglich".equals(sp);
        return st(A_ZAEHLER, fertig ? ERLEDIGT : OFFEN, "Netzanschluss: " + urteilWort(n) + " · Speicher: "
                + urteilWort(sp), tuer);
    }

    private static Station direktvermarkter(Def d, String name, Boolean bilanzkreisGesondert) {
        Tuer tuer = new Tuer(ZIEL_PARTNERANGABEN, "Partner eintragen");
        if (name == null || name.isBlank()) {
            return st(d, OFFEN, "Noch keiner eingetragen", tuer);
        }
        return st(d, ERLEDIGT, "Eingetragen: " + name + (Boolean.TRUE.equals(bilanzkreisGesondert)
                ? " · gesonderter Bilanzkreis" : ""), new Tuer(ZIEL_PARTNERANGABEN, "Partner ansehen"));
    }

    /** Das Urteil einer Gruppe: tauglich nur, wenn jede Messstelle tauglich ist; sonst das schlechteste. */
    static String gruppenUrteil(List<String> urteile) {
        if (urteile.isEmpty()) {
            return "keine_rolle";
        }
        if (urteile.stream().allMatch("tauglich"::equals)) {
            return "tauglich";
        }
        return urteile.contains("nicht_tauglich") ? "nicht_tauglich"
                : urteile.contains("nicht_pruefbar") ? "nicht_pruefbar" : "keine_rolle";
    }

    private static String urteilWort(String urteil) {
        return switch (urteil) {
            case "tauglich" -> "tauglich";
            case "nicht_tauglich" -> "nicht tauglich";
            case "nicht_pruefbar" -> "nicht prüfbar";
            default -> "keine Rolle";
        };
    }

    // ------------------------------------------------------------------ jetzt und Satz

    /**
     * Setzt {@code jetzt} und den Satz (Vertrag § 2): {@code jetzt} ist die erste offene Station, die nicht von selbst
     * läuft, vor der ersten wartenden oder gesperrten; der Satz nennt „n von m erledigt“ und danach, was hängt — eine
     * Sperre von außen (EU, Prüfstand) vor dem Urteil „lohnt sich nicht“ vor {@code jetzt} vor dem, was läuft.
     */
    private static Strecke strecke(String art, String titel, UUID komponente, List<Station> roh, String vorrang) {
        List<Station> s = new ArrayList<>(roh);
        for (int i = 0; i < s.size(); i++) {
            Station x = s.get(i);
            if (WARTET.equals(x.zustand()) || GESPERRT.equals(x.zustand())) {
                break;
            }
            if (OFFEN.equals(x.zustand()) && !VOLTPILOT.equals(x.wer())) {
                s.set(i, new Station(x.nr(), x.schluessel(), x.titel(), x.erklaerung(), x.wer(), JETZT, x.stand(),
                        x.tuer()));
                break;
            }
        }
        int erledigt = (int) s.stream().filter(x -> ERLEDIGT.equals(x.zustand())).count();
        String zusatz = null;
        for (Station x : s) {
            String kurz = kurz(art, x.schluessel());
            if (kurz != null && (WARTET.equals(x.zustand()) || GESPERRT.equals(x.zustand()))) {
                zusatz = kurz;
                break;
            }
        }
        if (zusatz == null) {
            zusatz = vorrang;
        }
        if (zusatz == null) {
            zusatz = s.stream().filter(x -> JETZT.equals(x.zustand())).findFirst().map(x -> "jetzt: " + x.titel())
                    .orElse(null);
        }
        if (zusatz == null) {
            zusatz = s.stream().filter(x -> WARTET.equals(x.zustand()) || GESPERRT.equals(x.zustand())).findFirst()
                    .map(x -> (VOLTPILOT.equals(x.wer()) ? "läuft: " : "wartet: ") + x.titel()).orElse(null);
        }
        if (zusatz == null && erledigt < s.size()) {
            zusatz = s.stream().filter(x -> !ERLEDIGT.equals(x.zustand())).findFirst()
                    .map(x -> "als Nächstes: " + x.titel()).orElse(null);
        }
        String satz = erledigt + " von " + s.size() + " erledigt" + (zusatz == null ? "" : " · " + zusatz);
        return new Strecke(art, titel, komponente, erledigt, s.size(), satz, List.copyOf(s));
    }

    private static String kurz(String art, String schluessel) {
        if (PAUSCHAL.equals(art) && P_EU.schluessel().equals(schluessel)) {
            return P_EU.kurz();
        }
        if (LADEPUNKT.equals(art) && L_FAHREN.schluessel().equals(schluessel)) {
            return L_FAHREN.kurz();
        }
        return null;
    }

    /** Vorrang im Satz vor {@code jetzt}, solange nichts gewählt ist: der Check rät ab. */
    private static String lohntNicht(Check c) {
        if (c != null && "fertig".equals(c.stand()) && c.mittelEur() != null && ganz(c.mittelEur()) < 0) {
            return "gerechnet: lohnt sich voraussichtlich nicht";
        }
        return null;
    }

    // ------------------------------------------------------------------ Wörter und Zahlen

    private static Station st(Def d, String zustand, String stand, Tuer tuer) {
        return new Station(d.nr(), d.schluessel(), d.titel(), d.erklaerung(), d.wer(), zustand, stand, tuer);
    }

    private static Tuer foerderwegTuer() {
        return new Tuer(ZIEL_FOERDERWEG, "Förderweg ändern");
    }

    private static String begriff(Weg w) {
        return Foerderweg.von(w.foerderweg()).map(Foerderweg::begriff).orElse(w.foerderweg());
    }

    private static String formelsatz(Weg w) {
        return w.formelsatz() == null ? "" : " · Formelsatz " + w.formelsatz();
    }

    private static String hinweis(Check c, String sonst) {
        return c.hinweis() == null || c.hinweis().isBlank() ? sonst : c.hinweis().trim();
    }

    /** Wie das Urteil der Check-Karte im Portal ({@code mispelCheck.ts}, {@code kurzfassung}): auf ganze Euro. */
    private static String urteil(BigDecimal mittel) {
        long g = ganz(mittel);
        return g > 0 ? "lohnt sich voraussichtlich" : g < 0 ? "lohnt sich voraussichtlich nicht"
                : "bringt voraussichtlich weder mehr noch weniger";
    }

    private static long ganz(BigDecimal v) {
        return v.setScale(0, java.math.RoundingMode.HALF_UP).longValueExact();
    }

    /** „+ 1.899 €“ / „− 555 €“ / „0 €“ wie {@code jahresEuro} im Portal: ganze Euro, eigenes Vorzeichen. */
    static String euro(BigDecimal v) {
        long g = ganz(v);
        DecimalFormat f = new DecimalFormat("#,##0", DecimalFormatSymbols.getInstance(Locale.GERMANY));
        String betrag = f.format(Math.abs(g)) + NBSP + "€";
        return g == 0 ? betrag : (g < 0 ? MINUS : "+") + NBSP + betrag;
    }

    private static String zahl(BigDecimal v) {
        DecimalFormat f = new DecimalFormat("#,##0.##", DecimalFormatSymbols.getInstance(Locale.GERMANY));
        return f.format(v);
    }

    private static String prozent(BigDecimal v) {
        DecimalFormat f = new DecimalFormat("#,##0", DecimalFormatSymbols.getInstance(Locale.GERMANY));
        return f.format(v) + NBSP + "%";
    }

    private static String tag(LocalDate d) {
        return TAG.format(d);
    }

    private static String monat(YearMonth m) {
        return MONAT.format(m);
    }

    private static String uhr(LocalTime t) {
        return UHR.format(t);
    }

    private static <T> List<T> liste(List<T> l) {
        return l == null ? List.of() : l;
    }
}
