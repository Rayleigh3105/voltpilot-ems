package com.voltpilot.api.mispel;

import java.time.LocalDate;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;

/**
 * Die reinen Regeln des Förderwegs je Einspeisestelle (MiSpeL MP-5, Entscheid E2 = B; Vertrag
 * {@code docs/contracts/v2/mispel-foerderweg.md}, Vektoren {@code mispel-foerderweg-vectors.json}) — ohne
 * Spring, Datenbank und Uhr. Zitierweise wie MP-4: „A1 S. 24“ = Anlage 1, Seite 24; „T“ = Tenor.
 */
public final class FoerderwegRegeln {

    private FoerderwegRegeln() {}

    /** Wirkung der Festlegung mit der Bekanntgabe (T Ziff. 8); Beschluss vom 01.10.2026. */
    public static final LocalDate FESTLEGUNG_AB = LocalDate.of(2026, 10, 1);
    /** Bis 30.09.2027 nur im Einverständnis mit Netz- und Messstellenbetreiber (T S. 3 Ziff. 9a). */
    public static final LocalDate EINVERSTAENDNIS_BIS = LocalDate.of(2027, 9, 30);

    /**
     * Die fünf Werte (Bauplan § 5.1). {@code netzladenMoeglich}: ob der Speicher aus dem Netz laden darf, ohne
     * die Förderung zu verlieren — wo ja, bleibt es eine Einstellung des Kunden. {@code plantKind}: die heutige
     * Spalte {@code site.plant_kind}, die der Weg bedeutet ({@code null} = er sagt nichts darüber).
     */
    public enum Foerderweg {
        EINSPEISEVERGUETUNG("einspeiseverguetung", "Einspeisevergütung",
                "§ 19 Abs. 1 Nr. 2 EEG; Speicher nur in der Ausschließlichkeitsoption förderfähig (§ 19 Abs. 3a EEG)",
                false, "eigenverbrauch"),
        MARKTPRAEMIE_AUSSCHLIESSLICHKEIT("marktpraemie_ausschliesslichkeit", "Marktprämie mit Ausschließlichkeitsoption",
                "§ 19 Abs. 3 S. 1 Nr. 1, Abs. 3a EEG; A1 S. 11", false, "direktvermarktung"),
        MARKTPRAEMIE_ABGRENZUNG("marktpraemie_abgrenzung", "Marktprämie mit Abgrenzungsoption",
                "§ 19 Abs. 3b EEG; Tenor Ziff. 3, Anlage 1", true, "direktvermarktung"),
        MARKTPRAEMIE_PAUSCHAL("marktpraemie_pauschal", "Marktprämie mit Pauschaloption",
                "§ 19 Abs. 3c EEG; Tenor Ziff. 4, Anlage 2", true, "direktvermarktung"),
        UNGEFOERDERT("ungefoerdert", "ungeförderte Direktvermarktung",
                "§ 21a EEG; Tenor Ziff. 1 S. 2, Ziff. 2 S. 2", true, null);

        private final String wert;
        private final String begriff;
        private final String rechtsgrundlage;
        private final boolean netzladenMoeglich;
        private final String plantKind;

        Foerderweg(String wert, String begriff, String rechtsgrundlage, boolean netzladenMoeglich, String plantKind) {
            this.wert = wert;
            this.begriff = begriff;
            this.rechtsgrundlage = rechtsgrundlage;
            this.netzladenMoeglich = netzladenMoeglich;
            this.plantKind = plantKind;
        }

        public String wert() {
            return wert;
        }

        public String begriff() {
            return begriff;
        }

        public String rechtsgrundlage() {
            return rechtsgrundlage;
        }

        public boolean netzladenMoeglich() {
            return netzladenMoeglich;
        }

        public String plantKind() {
            return plantKind;
        }

        /** Eine MiSpeL-Option der Festlegung (Abgrenzung oder Pauschal). */
        public boolean mispel() {
            return this == MARKTPRAEMIE_ABGRENZUNG || this == MARKTPRAEMIE_PAUSCHAL;
        }

        public static Optional<Foerderweg> von(String wert) {
            return Arrays.stream(values()).filter(f -> f.wert.equals(wert)).findFirst();
        }
    }

    /** Die Formelsätze des Vertrags MP-4 ({@code mispel-abgrenzung-vectors.json} → {@code formelsaetze}, E5 = B). */
    public static final List<String> FORMELSAETZE = List.of("A1", "A5", "A5-Variante", "A10", "A11");

    /**
     * Vereinfachter Formelsatz → der umfangreichere, an dessen Stelle er tritt (A1 S. 24, Abschn. 3.2.3), soweit
     * beide im Umfang sind: „der A5-Variante anstelle von A5“, „des Sonderfalls A10 anstelle des Basisfalls A1“,
     * „des Sonderfalls A11 anstelle der Basisfälle A1 bis A4“.
     */
    public static final Map<String, String> VEREINFACHT_STATT = Map.of("A5-Variante", "A5", "A10", "A1", "A11", "A1");

    /**
     * Die AW-Differenzierungen (MP-12b): „In welchen Viertelstunden sich der anzulegende Wert nach den verschiedenen
     * gesetzlichen Differenzierungen aufgrund von negativen (bzw. schwach positiven) Spotmarktpreisen auf null
     * verringert, veröffentlichen die Übertragungsnetzbetreiber“ (A1 S. 17 Fn. 8) — je Veröffentlichung ein Wert,
     * dasselbe Vokabular wie {@code eeg_aw_zeit.regel} (MP-7). Die Regel trägt der Betreiber ein; VoltPilot leitet sie
     * nicht ab.
     */
    public static final List<String> AW_REGELN = List.of("viertelstunde", "viertelstunde_2ct", "stunden_1",
            "stunden_2", "stunden_3", "stunden_4", "stunden_6");

    /**
     * Eine Fassung, wie die Regeln sie sehen; {@code formelsatz} nur in Abgrenzung (Pflicht) und ungefördert
     * (wahlfrei); {@code awRegel} nur in Abgrenzung und Pauschal (wahlfrei, {@code null} = W4-Rückfall, vorläufig).
     */
    public record Angaben(Foerderweg foerderweg, String formelsatz, boolean einverstaendnis, String awRegel) {

        public Angaben(Foerderweg foerderweg, String formelsatz, boolean einverstaendnis) {
            this(foerderweg, formelsatz, einverstaendnis, null);
        }
    }

    /** Ein Antrag auf eine neue Fassung. */
    public record Antrag(Angaben angaben, LocalDate gueltigAb, Boolean netzladen, boolean erstmaligeZuordnung,
            boolean messkonzeptGeaendert) {}

    /** Was vorher galt: die Fassung am Tag vor {@code gueltig_ab}, oder der Bestand ({@code bestand} = ohne Fassung). */
    public record Vorher(Angaben angaben, boolean bestand, LocalDate letzteFassungAb) {}

    /** Eine Ablehnung mit Code, Status, Satz und Fakten (Vertrag § 4). */
    public record Ablehnung(String code, int status, String satz, Map<String, Object> fakten) {}

    /**
     * Der Förderweg einer Anlage ohne Fassung, aus ihren heutigen Schaltern (die Übernahme, Entscheid E2): Netzladen
     * erlaubt = der Händler-Modus = ungefördert (W6); sonst der EEG-Modus nach {@code plant_kind}.
     */
    public static Angaben ausBestand(boolean netzladenErlaubt, String plantKind) {
        if (netzladenErlaubt) {
            return new Angaben(Foerderweg.UNGEFOERDERT, null, false);
        }
        return new Angaben("direktvermarktung".equals(plantKind) ? Foerderweg.MARKTPRAEMIE_AUSSCHLIESSLICHKEIT
                : Foerderweg.EINSPEISEVERGUETUNG, null, false);
    }

    /** Ob zwei Formelsätze die Wahl zwischen vereinfacht und umfangreich sind (A1 S. 24). */
    public static boolean wahlPaar(String a, String b) {
        return a != null && b != null && (b.equals(VEREINFACHT_STATT.get(a)) || a.equals(VEREINFACHT_STATT.get(b)));
    }

    /** Bis wann die Wahl des Formelsatzes am Tag {@code am} bindet: das Ende des Kalenderjahres (A1 S. 24). */
    public static LocalDate gebundenBis(String formelsatz, LocalDate am) {
        if (formelsatz == null || am == null) {
            return null;
        }
        boolean hatPaar = FORMELSAETZE.stream().anyMatch(f -> wahlPaar(formelsatz, f));
        return hatPaar ? LocalDate.of(am.getYear(), 12, 31) : null;
    }

    /** Die Netzlade-Einstellung nach der neuen Fassung: ausgeschlossen = aus; sonst die Angabe, ohne sie die bisherige. */
    public static boolean netzladenNachher(Foerderweg neu, Boolean angabe, boolean bisher) {
        return neu.netzladenMoeglich() && (angabe != null ? angabe : bisher);
    }

    /** Die Form des Antrags ohne Vorgeschichte: Werte, Formelsatz zum Weg, Netzladen zum Weg. */
    public static Ablehnung formPruefen(Antrag a) {
        Angaben n = a.angaben();
        String fs = n.formelsatz();
        if (fs != null && !FORMELSAETZE.contains(fs)) {
            return ab("formelsatz_ungueltig", 422, "Der Formelsatz „" + fs + "“ wird noch nicht unterstützt (E5 = B: "
                    + String.join(", ", FORMELSAETZE) + ").", "formelsatz", fs, "A1 S. 9, Übersicht 1; Bauplan § 8.5");
        }
        if (n.foerderweg() == Foerderweg.MARKTPRAEMIE_ABGRENZUNG && fs == null) {
            return ab("formelsatz_fehlt", 422, "Die Abgrenzungsoption braucht einen Formelsatz der Anlage 1.",
                    "foerderweg", n.foerderweg().wert(), "Tenor Ziff. 3; A1 S. 24, Abschn. 3.2");
        }
        if (fs != null && n.foerderweg() != Foerderweg.MARKTPRAEMIE_ABGRENZUNG
                && n.foerderweg() != Foerderweg.UNGEFOERDERT) {
            return ab("formelsatz_passt_nicht", 422, "Ein Formelsatz der Anlage 1 gehört nur zur Abgrenzungsoption oder "
                    + "zur ungeförderten Direktvermarktung.", "foerderweg", n.foerderweg().wert(),
                    "Tenor Ziff. 1 S. 2, Ziff. 3");
        }
        String aw = n.awRegel();
        if (aw != null && !AW_REGELN.contains(aw)) {
            return ab("aw_regel_ungueltig", 422, "„" + aw + "“ ist keine AW-Differenzierung der Übertragungsnetzbetreiber ("
                    + String.join(", ", AW_REGELN) + ").", "aw_regel", aw, "A1 S. 17 Fn. 8");
        }
        if (aw != null && !n.foerderweg().mispel()) {
            return ab("aw_regel_passt_nicht", 422, "Die AW-Differenzierung bestimmt die AW>0-Zeiten der Abgrenzungs- "
                    + "und der Pauschaloption; " + n.foerderweg().begriff() + " rechnet nicht danach.", "foerderweg",
                    n.foerderweg().wert(), "A1 S. 17 und S. 38, Formel (24); A2 S. 31, Formel (P12)");
        }
        if (Boolean.TRUE.equals(a.netzladen()) && !n.foerderweg().netzladenMoeglich()) {
            return ab("netzladen_ausgeschlossen", 422, n.foerderweg().begriff() + ": der Speicher darf nicht aus dem "
                    + "Netz laden, sonst entfällt die Förderung.", "foerderweg", n.foerderweg().wert(),
                    "§ 19 Abs. 3a EEG; A1 S. 11");
        }
        return null;
    }

    /**
     * Die Regeln gegen die Vorgeschichte, in der Reihenfolge des Vertrags § 3. {@code heute} ist der Tag in
     * gesetzlicher Zeit; {@code pauschaloptionAb} der erste Tag nach der EU-Genehmigung ({@code null} = noch keine).
     */
    public static Ablehnung pruefen(Antrag a, Vorher v, LocalDate heute, LocalDate pauschaloptionAb) {
        Ablehnung form = formPruefen(a);
        if (form != null) {
            return form;
        }
        Angaben n = a.angaben();
        LocalDate ab = a.gueltigAb();
        if (ab.isAfter(heute)) {
            return ab("gueltig_ab_in_zukunft", 422, "Ein Förderweg wird eingetragen, wenn er gilt — ab " + ab
                    + " also frühestens an diesem Tag.", "heute", heute.toString(), "Vertrag § 5");
        }
        if (v.letzteFassungAb() != null && ab.isBefore(v.letzteFassungAb())) {
            return ab("foerderweg_rueckwirkend", 409, "Seit " + v.letzteFassungAb() + " gilt eine spätere Fassung; "
                    + "davor wird nichts mehr eingeschoben.", "letzte_fassung_ab", v.letzteFassungAb().toString(),
                    "Vertrag § 3");
        }
        boolean mispel = n.foerderweg().mispel() || n.formelsatz() != null;
        if (mispel && ab.isBefore(FESTLEGUNG_AB)) {
            return ab("vor_der_festlegung", 422, "Die Festlegung wirkt erst ab " + FESTLEGUNG_AB + ".",
                    "frueheste", FESTLEGUNG_AB.toString(), "Tenor Ziff. 8");
        }
        if (n.foerderweg() == Foerderweg.MARKTPRAEMIE_PAUSCHAL
                && (pauschaloptionAb == null || ab.isBefore(pauschaloptionAb))) {
            Map<String, Object> f = new LinkedHashMap<>();
            f.put("anwendbar_ab", pauschaloptionAb == null ? null : pauschaloptionAb.toString());
            f.put("fundstelle", "Tenor S. 3 Ziff. 9b");
            return new Ablehnung("pauschaloption_noch_nicht_anwendbar", 422, "Die Pauschaloption gilt erst ab dem "
                    + "Monatsersten nach der beihilferechtlichen Genehmigung der EU-Kommission.", f);
        }
        if (mispel && !ab.isAfter(EINVERSTAENDNIS_BIS) && !n.einverstaendnis()) {
            return ab("einverstaendnis_fehlt", 422, "Bis " + EINVERSTAENDNIS_BIS + " gilt die Festlegung nur im "
                    + "Einverständnis mit Netz- und Messstellenbetreiber.", "bis", EINVERSTAENDNIS_BIS.toString(),
                    "Tenor S. 3 Ziff. 9a");
        }
        Angaben alt = v.angaben();
        if (a.erstmaligeZuordnung() && !v.bestand()) {
            return ab("erstmalige_zuordnung_vorbei", 409, "Die Anlage hat schon einen eingetragenen Förderweg; "
                    + "jede weitere Fassung ist ein Wechsel.", "letzte_fassung_ab",
                    v.letzteFassungAb() == null ? null : v.letzteFassungAb().toString(), "A1 S. 103");
        }
        if (alt.foerderweg() != n.foerderweg() && ab.getDayOfMonth() != 1 && !a.erstmaligeZuordnung()) {
            return ab("wechsel_nur_zum_monatsersten", 422, "Ein Wechsel des Förderwegs gilt nur ab dem ersten "
                    + "Kalendertag eines Monats.", "naechster_monatserster",
                    ab.withDayOfMonth(1).plusMonths(1).toString(), "§ 21b Abs. 1 S. 2 EEG; A1 S. 103, Fn. 56; "
                    + "Tenor Ziff. 5 S. 2");
        }
        if (wahlPaar(alt.formelsatz(), n.formelsatz()) && !(ab.getMonthValue() == 1 && ab.getDayOfMonth() == 1)
                && !a.messkonzeptGeaendert()) {
            Map<String, Object> f = new LinkedHashMap<>();
            f.put("formelsatz", alt.formelsatz());
            f.put("gebunden_bis", gebundenBis(alt.formelsatz(), ab).toString());
            f.put("fundstelle", "A1 S. 24, Abschn. 3.2.3");
            return new Ablehnung("formelsatz_gebunden", 422, "Die Wahl zwischen " + alt.formelsatz() + " und "
                    + n.formelsatz() + " ist verbindlich und erst mit Wirkung für ein folgendes Kalenderjahr "
                    + "änderbar.", f);
        }
        if (Objects.equals(alt, n) && !v.bestand()) {
            return ab("foerderweg_unveraendert", 409, "Ab " + ab + " gilt bereits genau dieser Förderweg.", "am",
                    ab.toString(), "Vertrag § 3");
        }
        return null;
    }

    private static Ablehnung ab(String code, int status, String satz, String fakt, Object wert, String fundstelle) {
        Map<String, Object> f = new LinkedHashMap<>();
        f.put(fakt, wert);
        f.put("fundstelle", fundstelle);
        return new Ablehnung(code, status, satz, f);
    }
}
