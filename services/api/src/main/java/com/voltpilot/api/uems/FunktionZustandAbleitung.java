package com.voltpilot.api.uems;

import com.voltpilot.api.uems.ZustandAbleitung.AnlageErgebnis;
import com.voltpilot.api.uems.ZustandAbleitung.AnlageGrund;
import com.voltpilot.api.uems.ZustandAbleitung.BoxZustand;
import com.voltpilot.api.uems.ZustandAbleitung.LiefertDaten;
import com.voltpilot.api.uems.ZustandAbleitung.SteuertErgebnis;
import java.time.Instant;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.List;

/**
 * Die REINE Ableitung des <b>Funktions-Zustands</b> je Standort und der
 * <b>Teilnahme</b> je Anlage (UEMS AP-01 IP-1; Regeln im AP-01-Konzept §4.2–§4.7,
 * Entscheide E6 = C, E7, E8, E9, Auflösungen W3, W5, W7).
 *
 * <p>Der Funktions-Zustand ist ein OBJEKT-Zustand aus Fakten, kein
 * Absichts-Schalter (W3): er entsteht bei jedem Lesen neu aus Bestandsfakten
 * (Betriebsmodell an, Freigaben, Scharfschaltung, Ruhe-Eintrag) und der
 * Prüfliste. Ohne Spring, ohne Repository, ohne Uhr — wie {@link ZustandAbleitung},
 * dessen „liefert Daten“ und „steuert“ hier WIEDERVERWENDET und nie nachgebaut
 * werden.
 *
 * <p>Der Zwilling im Portal ist {@code frontend/portal/src/uemsFunktion.ts};
 * beide fahren dieselben Vektoren
 * ({@code docs/contracts/v2/funktion-zustand-vectors.json}).
 * <b>Wer die Regel ändert, ändert beide Seiten und die Vektor-Datei.</b>
 *
 * <h2>⚠ Noch ruft niemand an</h2>
 *
 * Keine Tabelle (IP-2), kein Endpunkt (IP-3), keine Fläche ist umgestellt;
 * Steuerung, Publisher und Box sind unberührt. Diese Klasse ist der Vertrag,
 * gegen den der Backfill und die Endpunkte gebaut werden.
 *
 * <h2>Die Rangfolge</h2>
 *
 * <pre>
 *   kein_objekt &lt; archiviert &lt; entwurf &lt; eingerichtet &lt; angehalten &lt; aktiv
 * </pre>
 *
 * Der Standort trägt den HÖCHSTEN Zustand seiner Teilnahmen (W7). angehalten
 * schlägt eingerichtet — „angehalten, solange keine Anlage aktiv teilnimmt“ (A4);
 * archiviert liegt unter entwurf — eine neue Aufnahme nach dem Beenden ist eine
 * neue Einrichtung.
 *
 * <h2>Die Naht zu „steuert“</h2>
 *
 * Die Beobachtung wird mit {@link ZustandAbleitung#steuert} gebildet, aber mit
 * {@code ruheEintrag = (Zustand angehalten)} — nie mit dem rohen Ruhe-Eintrag.
 * Vor dem Start trägt jede Anlage die Ruhe R0 ohne Ende; der Kunde soll dort „noch
 * nicht gestartet“ lesen, nicht „angehalten“.
 */
public final class FunktionZustandAbleitung {

    private FunktionZustandAbleitung() {}

    private static final DateTimeFormatter DATUM = DateTimeFormatter.ofPattern("dd.MM.yyyy");

    // ---------------------------------------------------------------- Vokabular

    /** Die zwei Funktionen, je mit ihrem Kundenwort. */
    public enum Funktion {
        MESSEN("messen", "Messen & Auswerten"),
        STEUERN("steuern", "Steuern & Optimieren");

        private final String code;
        private final String kundenwort;

        Funktion(String code, String kundenwort) {
            this.code = code;
            this.kundenwort = kundenwort;
        }

        public String code() {
            return code;
        }

        public String kundenwort() {
            return kundenwort;
        }

        public static Funktion vonCode(String code) {
            for (Funktion f : values()) {
                if (f.code.equals(code)) {
                    return f;
                }
            }
            throw new IllegalArgumentException("unbekannte Funktion: " + code);
        }
    }

    /** Das E8-Vokabular plus „kein Objekt“ — AUFSTEIGEND nach Rang (die Reihenfolge IST die Regel). */
    public enum Zustand {
        KEIN_OBJEKT("kein_objekt"),
        ARCHIVIERT("archiviert"),
        ENTWURF("entwurf"),
        EINGERICHTET("eingerichtet"),
        ANGEHALTEN("angehalten"),
        AKTIV("aktiv");

        private final String code;

        Zustand(String code) {
            this.code = code;
        }

        public String code() {
            return code;
        }

        public static Zustand vonCode(String code) {
            for (Zustand z : values()) {
                if (z.code.equals(code)) {
                    return z;
                }
            }
            throw new IllegalArgumentException("unbekannter Zustand: " + code);
        }
    }

    /** Die Zeilen der Prüfliste vor dem Start, in der Reihenfolge von AP-01 §5.3 Schritt 5. */
    public enum Pruefung {
        BOX("box"),
        FREIGABE("freigabe"),
        VERBINDUNGSTEST("verbindungstest"),
        GRENZE("grenze"),
        HAUPTZAEHLER("hauptzaehler"),
        BETRIEBSWEISE("betriebsweise");

        private final String code;

        Pruefung(String code) {
            this.code = code;
        }

        public String code() {
            return code;
        }
    }

    /** Was der Kunde auslöst. */
    public enum Aktion {
        AUFNEHMEN("aufnehmen"),
        EINRICHTEN("einrichten"),
        STARTEN("starten"),
        ANHALTEN("anhalten"),
        FORTSETZEN("fortsetzen"),
        BEENDEN("beenden");

        private final String code;

        Aktion(String code) {
            this.code = code;
        }

        public String code() {
            return code;
        }

        public static Aktion vonCode(String code) {
            for (Aktion a : values()) {
                if (a.code.equals(code)) {
                    return a;
                }
            }
            throw new IllegalArgumentException("unbekannte Aktion: " + code);
        }
    }

    /** Warum ein Übergang abgelehnt wird — je Grund GENAU EIN Kundensatz. */
    public enum Grund {
        NICHT_AUFGENOMMEN("nicht_aufgenommen", "Nimmt noch nicht an Steuern & Optimieren teil"),
        BEREITS_AUFGENOMMEN("bereits_aufgenommen", "Nimmt bereits an Steuern & Optimieren teil"),
        /** Sein Satz wird um „ — es fehlt: …“ ergänzt. */
        PRUEFLISTE_OFFEN("pruefliste_offen", "Noch nicht möglich"),
        NOCH_NICHT_GESTARTET("noch_nicht_gestartet", "Steuerung noch nicht gestartet"),
        LAEUFT_BEREITS("laeuft_bereits", "Steuerung läuft bereits"),
        IST_ANGEHALTEN("ist_angehalten", "Steuerung angehalten — fortsetzen statt neu starten"),
        BEREITS_ANGEHALTEN("bereits_angehalten", "Steuerung bereits angehalten"),
        BEENDET("beendet", "Steuerung beendet — ein Neubeginn ist eine neue Einrichtung"),
        BEREITS_ANGELEGT("bereits_angelegt", "Messen & Auswerten ist hier bereits angelegt"),
        STANDORT_ARCHIVIERT("standort_archiviert", "Der Standort ist archiviert"),
        STARTET_AUTOMATISCH(
                "startet_automatisch", "Messen & Auswerten startet mit der Einrichtung von selbst"),
        NICHT_ALS_GANZES(
                "nicht_als_ganzes",
                "Messen & Auswerten wird nicht als Ganzes angehalten — angehalten wird je Messstelle"),
        NUR_MIT_DEM_STANDORT(
                "nur_mit_dem_standort", "Messen & Auswerten endet mit dem Archivieren des Standorts");

        private final String code;
        private final String text;

        Grund(String code, String text) {
            this.code = code;
            this.text = text;
        }

        public String code() {
            return code;
        }

        public String text() {
            return text;
        }
    }

    /** Wofür eine freigegebene Komponente eine Betriebsweise braucht. */
    public enum KomponentenArt {
        /** Braucht eine Steuerart (Ladepunkt, Wärmepumpe, …). */
        VERBRAUCHER("verbraucher"),
        /** Wechselrichter/Speicher: braucht ein Betriebsmodell der Anlage. */
        SPEICHER("speicher");

        private final String code;

        KomponentenArt(String code) {
            this.code = code;
        }

        public String code() {
            return code;
        }

        public static KomponentenArt vonCode(String code) {
            for (KomponentenArt a : values()) {
                if (a.code.equals(code)) {
                    return a;
                }
            }
            throw new IllegalArgumentException("unbekannte Komponenten-Art: " + code);
        }
    }

    // ---------------------------------------------------------- Teilnahme je Anlage

    /**
     * @param ende {@code null} = ohne Enddatum: die Ruhe R0 vor dem Start oder das Anhalten
     *     (E7). Mit Ende ist es ein Handeingriff (S7), kein Anhalten.
     */
    public record RuheEintrag(Instant seit, Instant ende) {}

    /** Der Hauptzähler der Anlage mit seinem Kennzeichen und seinem Zustand „liefert Daten“. */
    public record Hauptzaehler(String kennzeichen, LiefertDaten zustand, Instant seit) {}

    /**
     * Eine steuerbare Komponente der Anlage.
     *
     * @param freigegeben die Freigabe-Zeile je Schreib-Fähigkeit; beim Wechselrichter
     *     Zertifizierung UND Scharfschaltung (VoltPilot)
     * @param steuerart die Steuerart eines Verbrauchers; {@code null} = keine gewählt
     */
    public record Komponente(
            String name,
            KomponentenArt art,
            boolean freigegeben,
            boolean verbindungstestBestanden,
            String steuerart) {}

    /** Was die Box gerade ausführt — nur für die Beobachtung „steuert“. */
    public record Ausfuehrung(
            boolean laeuft, String laeuftArt, String laeuftName, boolean boxBestaetigt) {}

    /**
     * Die Fakten EINER Anlage zu „Steuern & Optimieren“.
     *
     * @param aufgenommen ob die Teilnahme existiert („Anlage aufnehmen“ ist geschehen)
     * @param eingerichtetAm wann die Prüfliste grün wurde; nur für den Satz, {@code null} = unbekannt
     * @param gestartetAm „Steuerung starten“; {@code null} = nie gestartet
     * @param uebernommen aus dem Bestand abgeleitet (W5)
     * @param beendetAm „Steuerung beenden“; {@code null} = nicht beendet
     * @param hauptzaehler {@code null}, wenn keiner zugeordnet ist
     * @param betriebsmodell die Betriebsmodell-WAHL für den Speicher; {@code null} = keine
     * @param ausfuehrung {@code null} = die Beobachtung ist nicht gefragt
     */
    public record TeilnahmeEingang(
            String anlage,
            boolean aufgenommen,
            Instant eingerichtetAm,
            Instant gestartetAm,
            boolean uebernommen,
            RuheEintrag ruheEintrag,
            Instant beendetAm,
            List<BoxZustand> boxen,
            Hauptzaehler hauptzaehler,
            List<Komponente> komponenten,
            String betriebsmodell,
            boolean grenzePlausibel,
            Ausfuehrung ausfuehrung,
            Instant jetzt,
            ZoneId zeitzone) {}

    /** Eine Zeile der Prüfliste; {@code bestanden == null} heißt „nicht prüfbar“, nie „bestanden“. */
    public record PruefZeile(Pruefung pruefung, Boolean bestanden) {}

    /**
     * @param pruefliste nur in entwurf, eingerichtet und angehalten — dort entscheidet sie
     *     über Start und Fortsetzen; sonst leer
     * @param fehlt je roter Zeile, WAS fehlt (W3), mit dem Namen des Objekts
     * @param steuert die Beobachtung aus {@link ZustandAbleitung#steuert}; {@code null}, wenn
     *     keine {@link Ausfuehrung} übergeben wurde
     */
    public record TeilnahmeErgebnis(
            Zustand zustand,
            Instant seit,
            List<PruefZeile> pruefliste,
            List<String> fehlt,
            String text,
            SteuertErgebnis steuert) {}

    /** Die Teilnahme einer Anlage — was sie gerade ist und was die Standort-Ableitung braucht. */
    public static TeilnahmeErgebnis teilnahme(TeilnahmeEingang e) {
        ZoneId zone = zone(e.zeitzone());
        Zustand zustand;
        List<PruefZeile> pruefliste = List.of();
        List<String> fehlt = List.of();
        if (!e.aufgenommen()) {
            zustand = Zustand.KEIN_OBJEKT;
        } else if (e.beendetAm() != null) {
            zustand = Zustand.ARCHIVIERT;
        } else if (e.gestartetAm() != null) {
            boolean ohneEnde = e.ruheEintrag() != null && e.ruheEintrag().ende() == null;
            zustand = ohneEnde ? Zustand.ANGEHALTEN : Zustand.AKTIV;
        } else {
            zustand = null; // entscheidet die Prüfliste
        }
        if (zustand == null || zustand == Zustand.ANGEHALTEN) {
            List<PruefZeile> zeilen = new ArrayList<>();
            List<String> offen = new ArrayList<>();
            pruefe(e, zone, zeilen, offen);
            pruefliste = zeilen;
            fehlt = offen;
            if (zustand == null) {
                zustand = offen.isEmpty() && alleBestanden(zeilen) ? Zustand.EINGERICHTET : Zustand.ENTWURF;
            }
        }
        Instant seit =
                switch (zustand) {
                    case EINGERICHTET -> e.eingerichtetAm();
                    case AKTIV -> e.gestartetAm();
                    case ANGEHALTEN -> e.ruheEintrag().seit();
                    case ARCHIVIERT -> e.beendetAm();
                    default -> null;
                };
        String text =
                switch (zustand) {
                    case KEIN_OBJEKT -> "Diese Anlage misst nur";
                    case ENTWURF -> fehltSatz("Noch nicht eingerichtet", fehlt);
                    case EINGERICHTET -> eingerichtetSatz(seit, zone);
                    case AKTIV ->
                            (seit == null ? "Gestartet" : "Gestartet am " + datum(seit, zone))
                                    + (e.uebernommen() ? " (übernommen)" : "");
                    case ANGEHALTEN -> mitDatum("Angehalten seit ", "Angehalten", seit, zone);
                    case ARCHIVIERT ->
                            mitDatum("Steuerung beendet am ", "Steuerung beendet", seit, zone);
                };
        return new TeilnahmeErgebnis(zustand, seit, pruefliste, fehlt, text, beobachtung(e, zustand));
    }

    /**
     * Die sechs Zeilen der Prüfliste. Box und Hauptzähler kommen aus EINEM Aufruf von
     * {@link ZustandAbleitung#liefertDatenAnlage}: eine stumme Box erklärt den stillen Zähler,
     * dessen Zeile ist dann nicht prüfbar. Test und Betriebsweise hängen an den freigegebenen
     * Komponenten; ohne Freigabe sind sie nicht prüfbar.
     */
    private static void pruefe(
            TeilnahmeEingang e, ZoneId zone, List<PruefZeile> zeilen, List<String> fehlt) {
        ZustandAbleitung.Quellzustand hz =
                e.hauptzaehler() == null
                        ? null
                        : new ZustandAbleitung.Quellzustand(
                                e.hauptzaehler().zustand(), e.hauptzaehler().seit());
        AnlageErgebnis messung =
                ZustandAbleitung.liefertDatenAnlage(
                        new ZustandAbleitung.AnlageEingang(e.boxen(), hz, e.jetzt(), zone));
        boolean boxFehlt =
                messung.grund() == AnlageGrund.KEINE_BOX
                        || messung.grund() == AnlageGrund.BOX_MELDET_SICH_NICHT;

        // box
        zeilen.add(new PruefZeile(Pruefung.BOX, !boxFehlt));
        if (messung.grund() == AnlageGrund.KEINE_BOX) {
            fehlt.add("Box " + e.anlage());
        } else if (messung.grund() == AnlageGrund.BOX_MELDET_SICH_NICHT) {
            for (BoxZustand b : e.boxen()) {
                if (!b.verbunden()) {
                    fehlt.add("Verbindung " + b.name());
                }
            }
        }

        // freigabe
        List<Komponente> freigegeben = new ArrayList<>();
        for (Komponente k : e.komponenten()) {
            if (k.freigegeben()) {
                freigegeben.add(k);
            }
        }
        boolean freigabe = !freigegeben.isEmpty();
        zeilen.add(new PruefZeile(Pruefung.FREIGABE, freigabe));
        if (!freigabe) {
            fehlt.add("Steuer-Freigabe " + e.anlage());
        }

        // verbindungstest
        if (!freigabe) {
            zeilen.add(new PruefZeile(Pruefung.VERBINDUNGSTEST, null));
        } else {
            boolean alle = true;
            for (Komponente k : freigegeben) {
                if (!k.verbindungstestBestanden()) {
                    alle = false;
                    fehlt.add("Verbindungstest " + k.name());
                }
            }
            zeilen.add(new PruefZeile(Pruefung.VERBINDUNGSTEST, alle));
        }

        // grenze
        zeilen.add(new PruefZeile(Pruefung.GRENZE, e.grenzePlausibel()));
        if (!e.grenzePlausibel()) {
            fehlt.add("plausible Grenze " + e.anlage());
        }

        // hauptzaehler
        if (boxFehlt) {
            zeilen.add(new PruefZeile(Pruefung.HAUPTZAEHLER, null));
        } else {
            zeilen.add(new PruefZeile(Pruefung.HAUPTZAEHLER, messung.liefert()));
            if (!messung.liefert()) {
                fehlt.add(hauptzaehlerFehlt(e, messung, zone));
            }
        }

        // betriebsweise
        if (!freigabe) {
            zeilen.add(new PruefZeile(Pruefung.BETRIEBSWEISE, null));
        } else {
            boolean gewaehlt = true;
            boolean speicher = false;
            for (Komponente k : freigegeben) {
                if (k.art() == KomponentenArt.SPEICHER) {
                    speicher = true;
                } else if (k.steuerart() == null || k.steuerart().isBlank()) {
                    gewaehlt = false;
                    fehlt.add("Steuerart " + k.name());
                }
            }
            if (speicher && (e.betriebsmodell() == null || e.betriebsmodell().isBlank())) {
                gewaehlt = false;
                fehlt.add("Betriebsmodell " + e.anlage());
            }
            zeilen.add(new PruefZeile(Pruefung.BETRIEBSWEISE, gewaehlt));
        }
    }

    /** Was am Hauptzähler fehlt — mit dem Wort des Zustandsvokabulars. */
    private static String hauptzaehlerFehlt(
            TeilnahmeEingang e, AnlageErgebnis messung, ZoneId zone) {
        if (messung.grund() == AnlageGrund.KEIN_HAUPTZAEHLER) {
            return "Hauptzähler " + e.anlage();
        }
        String kz = "Hauptzähler " + e.hauptzaehler().kennzeichen();
        return switch (messung.grund()) {
            case KEINE_DATENQUELLE -> "Datenquelle " + kz;
            case WARTET_AUF_ERSTE_DATEN -> "erste Daten " + kz;
            default ->
                    messung.seit() == null
                            ? "Daten " + kz
                            : "Daten "
                                    + kz
                                    + " seit "
                                    + ZustandAbleitung.zeitpunktText(
                                            messung.seit(), e.jetzt(), zone);
        };
    }

    /**
     * Die Beobachtung „steuert“ — aus dem Zustandsvokabular, mit dem ZUSTAND statt dem rohen
     * Ruhe-Eintrag: vor dem Start ist die Ruhe R0 kein Anhalten.
     */
    private static SteuertErgebnis beobachtung(TeilnahmeEingang e, Zustand zustand) {
        Ausfuehrung a = e.ausfuehrung();
        if (a == null) {
            return null;
        }
        boolean freigabe = false;
        for (Komponente k : e.komponenten()) {
            freigabe |= k.freigegeben();
        }
        boolean boxVerbunden = !e.boxen().isEmpty();
        for (BoxZustand b : e.boxen()) {
            boxVerbunden &= b.verbunden();
        }
        return ZustandAbleitung.steuert(
                new ZustandAbleitung.SteuertEingang(
                        freigabe,
                        zustand == Zustand.AKTIV || zustand == Zustand.ANGEHALTEN,
                        a.laeuft(),
                        a.laeuftArt(),
                        a.laeuftName(),
                        boxVerbunden,
                        a.boxBestaetigt(),
                        zustand == Zustand.ANGEHALTEN));
    }

    // ------------------------------------------------------------- Standort (Steuern)

    /** Eine abgeleitete Teilnahme, so wie sie Standort und Übergänge brauchen. */
    public record TeilnahmeStand(String anlage, Zustand zustand, Instant seit, List<String> fehlt) {}

    public record StandortErgebnis(Zustand zustand, Instant seit, String text) {}

    /**
     * „Steuern & Optimieren“ am Standort = der HÖCHSTE Zustand seiner Teilnahmen (E6 = C, W7);
     * kein Objekt, wenn keine. {@code seit}: aktiv/eingerichtet der früheste (die erste Anlage),
     * angehalten/archiviert der späteste (erst mit der letzten ist der Standort dort).
     */
    public static StandortErgebnis standort(List<TeilnahmeStand> teilnahmen, ZoneId zeitzone) {
        ZoneId zone = zone(zeitzone);
        Zustand hoechster = Zustand.KEIN_OBJEKT;
        for (TeilnahmeStand t : teilnahmen) {
            if (t.zustand().ordinal() > hoechster.ordinal()) {
                hoechster = t.zustand();
            }
        }
        if (hoechster == Zustand.KEIN_OBJEKT) {
            return new StandortErgebnis(
                    Zustand.KEIN_OBJEKT, null, Funktion.STEUERN.kundenwort() + " — noch nicht eingerichtet");
        }
        boolean fruehester = hoechster == Zustand.AKTIV || hoechster == Zustand.EINGERICHTET;
        Instant seit = null;
        List<String> anlagen = new ArrayList<>();
        List<String> fehlt = new ArrayList<>();
        for (TeilnahmeStand t : teilnahmen) {
            if (t.zustand() != hoechster) {
                continue;
            }
            anlagen.add(t.anlage());
            fehlt.addAll(t.fehlt());
            if (t.seit() != null
                    && (seit == null
                            || (fruehester ? t.seit().isBefore(seit) : t.seit().isAfter(seit)))) {
                seit = t.seit();
            }
        }
        if (hoechster == Zustand.ENTWURF) {
            seit = null;
        }
        String text =
                switch (hoechster) {
                    case ENTWURF -> fehltSatz("Noch nicht eingerichtet", fehlt);
                    case EINGERICHTET -> eingerichtetSatz(seit, zone);
                    case AKTIV -> "Läuft mit " + ZustandAbleitung.aufzaehlung(anlagen);
                    case ANGEHALTEN -> mitDatum("Angehalten seit ", "Angehalten", seit, zone);
                    case ARCHIVIERT ->
                            mitDatum("Steuerung beendet am ", "Steuerung beendet", seit, zone);
                    case KEIN_OBJEKT -> throw new IllegalStateException("oben behandelt");
                };
        return new StandortErgebnis(hoechster, seit, text);
    }

    // ------------------------------------------------------------ Messen & Auswerten

    /**
     * Eine Messstelle des Standorts.
     *
     * @param manuell manuell abgelesen (AP-09) — zählt als „mit Daten“, hat keine Reihe
     */
    public record Messstelle(
            String kennzeichen,
            boolean manuell,
            boolean quelleVorhanden,
            Instant letzterGuterWert,
            boolean jeEinWert,
            long kadenzS) {}

    /** Eine Anlage des Standorts MIT Netzanschluss und die Zahl ihrer Hauptzähler. */
    public record MessenAnlage(String name, int hauptzaehlerAnzahl) {}

    /**
     * @param angelegt ob „Einrichten“ gedrückt wurde (die Funktion existiert)
     * @param standortEingerichtet Name + Adresse + Zeitzone (AP-02)
     * @param standortArchiviertAm das Archivieren des Standorts (AP-02); {@code null} = nicht
     * @param eingerichtetAm wann Messen eingerichtet wurde; einmal gesetzt, bleibt es aktiv
     */
    public record MessenEingang(
            String standort,
            boolean angelegt,
            boolean standortEingerichtet,
            Instant standortArchiviertAm,
            Instant eingerichtetAm,
            List<BoxZustand> boxen,
            List<Messstelle> messstellen,
            List<MessenAnlage> anlagen,
            Instant jetzt,
            ZoneId zeitzone) {}

    /** @param datenlage „x von y Messstellen liefern Daten“ (+ manuell abgelesene); {@code null} ohne Funktion */
    public record MessenErgebnis(
            Zustand zustand, Instant seit, List<String> fehlt, String text, String datenlage) {}

    /**
     * „Messen & Auswerten“ am Standort. Kennt nur kein_objekt · entwurf · aktiv · archiviert:
     * „eingerichtet“ geht sofort in „aktiv“ über, angehalten wird es nicht als Ganzes (§4.2/§4.3).
     */
    public static MessenErgebnis messen(MessenEingang e) {
        ZoneId zone = zone(e.zeitzone());
        if (!e.angelegt()) {
            return new MessenErgebnis(
                    Zustand.KEIN_OBJEKT,
                    null,
                    List.of(),
                    Funktion.MESSEN.kundenwort() + " — noch nicht eingerichtet",
                    null);
        }
        if (e.standortArchiviertAm() != null) {
            return new MessenErgebnis(
                    Zustand.ARCHIVIERT,
                    e.standortArchiviertAm(),
                    List.of(),
                    "Archiviert am " + datum(e.standortArchiviertAm(), zone),
                    null);
        }
        List<LiefertDaten> reihen = new ArrayList<>();
        List<String> messstellenFehlen = new ArrayList<>();
        int manuell = 0;
        boolean mitDaten = false;
        for (Messstelle m : e.messstellen()) {
            if (m.manuell()) {
                manuell++;
                mitDaten = true;
                continue;
            }
            ZustandAbleitung.LiefertDatenErgebnis r =
                    ZustandAbleitung.liefertDaten(
                            new ZustandAbleitung.LiefertDatenEingang(
                                    m.quelleVorhanden(),
                                    m.letzterGuterWert(),
                                    m.jeEinWert(),
                                    m.kadenzS(),
                                    e.jetzt(),
                                    zone));
            reihen.add(r.zustand());
            switch (r.zustand()) {
                case LIEFERT -> mitDaten = true;
                case WARTET_AUF_ERSTE_DATEN -> messstellenFehlen.add("erste Daten " + m.kennzeichen());
                case LIEFERT_NICHT_SEIT ->
                        messstellenFehlen.add(
                                "Daten "
                                        + m.kennzeichen()
                                        + " seit "
                                        + ZustandAbleitung.zeitpunktText(r.seit(), e.jetzt(), zone));
                case KEINE_DATENQUELLE -> {
                    // AP-04 E8: eingerichtet und aktiv, nie eine 0 — blockiert nicht.
                }
            }
        }
        String datenlage =
                reihen.isEmpty() && manuell > 0
                        ? manuell + " manuell abgelesen"
                        : ZustandAbleitung.aggregatLiefertDaten(
                                                reihen, ZustandAbleitung.Einheit.MESSSTELLE)
                                        .text()
                                + (manuell > 0 ? " · " + manuell + " manuell abgelesen" : "");

        if (e.eingerichtetAm() != null) {
            return new MessenErgebnis(
                    Zustand.AKTIV,
                    e.eingerichtetAm(),
                    List.of(),
                    "Eingerichtet am " + datum(e.eingerichtetAm(), zone),
                    datenlage);
        }
        List<String> fehlt = new ArrayList<>();
        if (!e.standortEingerichtet()) {
            fehlt.add("Standort-Angaben " + e.standort());
        }
        for (BoxZustand b : e.boxen()) {
            if (!b.verbunden()) {
                fehlt.add("Verbindung " + b.name());
            }
        }
        if (!mitDaten && messstellenFehlen.isEmpty()) {
            fehlt.add("Messstelle mit Daten");
        }
        fehlt.addAll(messstellenFehlen);
        for (MessenAnlage a : e.anlagen()) {
            if (a.hauptzaehlerAnzahl() == 0) {
                fehlt.add("Hauptzähler " + a.name());
            } else if (a.hauptzaehlerAnzahl() > 1) {
                fehlt.add("eindeutiger Hauptzähler " + a.name());
            }
        }
        if (fehlt.isEmpty()) {
            return new MessenErgebnis(Zustand.AKTIV, null, List.of(), "Eingerichtet", datenlage);
        }
        return new MessenErgebnis(
                Zustand.ENTWURF, null, fehlt, fehltSatz("Noch nicht eingerichtet", fehlt), datenlage);
    }

    // --------------------------------------------------------------------- Übergänge

    /**
     * @param nachher der Zustand danach — bei Ablehnung der unveränderte; bei Standort-Aktionen
     *     der des STANDORTS
     * @param betroffen die Anlagen, deren Teilnahme sich ändert
     * @param text der Grund in Kundensprache; {@code null}, wenn erlaubt
     */
    public record UebergangErgebnis(
            boolean erlaubt, Grund grund, Zustand nachher, List<String> betroffen, String text) {}

    /**
     * Ein Übergang der Teilnahme EINER Anlage. {@code t} ist aus FRISCHEN Fakten abgeleitet —
     * Start und Fortsetzen prüfen die Liste erneut (R1/R2, E9).
     */
    public static UebergangErgebnis uebergangAnlage(Aktion aktion, TeilnahmeStand t) {
        Zustand z = t.zustand();
        Grund grund = null;
        Zustand ziel = null;
        switch (aktion) {
            case AUFNEHMEN -> {
                if (z == Zustand.KEIN_OBJEKT || z == Zustand.ARCHIVIERT) {
                    ziel = Zustand.ENTWURF;
                } else {
                    grund = Grund.BEREITS_AUFGENOMMEN;
                }
            }
            case STARTEN ->
                    grund =
                            switch (z) {
                                case EINGERICHTET -> null;
                                case ENTWURF -> Grund.PRUEFLISTE_OFFEN;
                                case AKTIV -> Grund.LAEUFT_BEREITS;
                                case ANGEHALTEN -> Grund.IST_ANGEHALTEN;
                                default -> ohneStart(z);
                            };
            case ANHALTEN ->
                    grund =
                            switch (z) {
                                case AKTIV -> null;
                                case ANGEHALTEN -> Grund.BEREITS_ANGEHALTEN;
                                default -> ohneStart(z);
                            };
            case FORTSETZEN ->
                    grund =
                            switch (z) {
                                case ANGEHALTEN -> t.fehlt().isEmpty() ? null : Grund.PRUEFLISTE_OFFEN;
                                case AKTIV -> Grund.LAEUFT_BEREITS;
                                default -> ohneStart(z);
                            };
            case BEENDEN ->
                    grund =
                            switch (z) {
                                case AKTIV, ANGEHALTEN -> null;
                                default -> ohneStart(z);
                            };
            case EINRICHTEN ->
                    throw new IllegalArgumentException("„einrichten“ gilt für Messen & Auswerten");
        }
        if (grund != null) {
            return abgelehnt(grund, z, t.fehlt());
        }
        if (ziel == null) {
            ziel =
                    switch (aktion) {
                        case STARTEN, FORTSETZEN -> Zustand.AKTIV;
                        case ANHALTEN -> Zustand.ANGEHALTEN;
                        case BEENDEN -> Zustand.ARCHIVIERT;
                        default -> throw new IllegalStateException(aktion.code());
                    };
        }
        return new UebergangErgebnis(true, null, ziel, List.of(t.anlage()), null);
    }

    /** Warum eine nie gestartete, beendete oder fehlende Teilnahme nicht gesteuert werden kann. */
    private static Grund ohneStart(Zustand z) {
        return switch (z) {
            case KEIN_OBJEKT -> Grund.NICHT_AUFGENOMMEN;
            case ARCHIVIERT -> Grund.BEENDET;
            default -> Grund.NOCH_NICHT_GESTARTET;
        };
    }

    /**
     * Anhalten, Fortsetzen oder Beenden für den ganzen Standort: wirkt auf jede Teilnahme, für
     * die der Übergang der Anlage erlaubt wäre. Fortsetzen ist GANZ ODER GAR NICHT — ist eine
     * Prüfliste rot, wird keine fortgesetzt (IP-3: „in derselben Transaktion“). Passt keine
     * Teilnahme, gilt der Grund, den eine Anlage im Zustand des Standorts bekäme.
     */
    public static UebergangErgebnis uebergangStandort(
            Aktion aktion, List<TeilnahmeStand> teilnahmen, ZoneId zeitzone) {
        Zustand ziel =
                switch (aktion) {
                    case ANHALTEN -> Zustand.ANGEHALTEN;
                    case FORTSETZEN -> Zustand.AKTIV;
                    case BEENDEN -> Zustand.ARCHIVIERT;
                    default ->
                            throw new IllegalArgumentException(
                                    "für den Standort gibt es nur anhalten, fortsetzen, beenden");
                };
        Zustand vorher = standort(teilnahmen, zeitzone).zustand();
        List<TeilnahmeStand> passend = new ArrayList<>();
        List<String> fehlt = new ArrayList<>();
        for (TeilnahmeStand t : teilnahmen) {
            boolean passt =
                    switch (aktion) {
                        case ANHALTEN -> t.zustand() == Zustand.AKTIV;
                        case FORTSETZEN -> t.zustand() == Zustand.ANGEHALTEN;
                        default ->
                                t.zustand() == Zustand.AKTIV || t.zustand() == Zustand.ANGEHALTEN;
                    };
            if (passt) {
                passend.add(t);
                fehlt.addAll(t.fehlt());
            }
        }
        if (passend.isEmpty()) {
            Grund grund =
                    uebergangAnlage(aktion, new TeilnahmeStand("", vorher, null, List.of())).grund();
            return abgelehnt(grund, vorher, List.of());
        }
        if (aktion == Aktion.FORTSETZEN && !fehlt.isEmpty()) {
            return abgelehnt(Grund.PRUEFLISTE_OFFEN, vorher, fehlt);
        }
        List<TeilnahmeStand> danach = new ArrayList<>();
        List<String> betroffen = new ArrayList<>();
        for (TeilnahmeStand t : teilnahmen) {
            if (passend.contains(t)) {
                danach.add(new TeilnahmeStand(t.anlage(), ziel, null, List.of()));
                betroffen.add(t.anlage());
            } else {
                danach.add(t);
            }
        }
        return new UebergangErgebnis(
                true, null, standort(danach, zeitzone).zustand(), betroffen, null);
    }

    /** Ein Übergang von „Messen & Auswerten“ am Standort. */
    public static UebergangErgebnis uebergangMessen(Aktion aktion, Zustand vorher) {
        Grund grund =
                switch (aktion) {
                    case EINRICHTEN ->
                            switch (vorher) {
                                case KEIN_OBJEKT -> null;
                                case ARCHIVIERT -> Grund.STANDORT_ARCHIVIERT;
                                default -> Grund.BEREITS_ANGELEGT;
                            };
                    case STARTEN -> Grund.STARTET_AUTOMATISCH;
                    case ANHALTEN, FORTSETZEN -> Grund.NICHT_ALS_GANZES;
                    case BEENDEN -> Grund.NUR_MIT_DEM_STANDORT;
                    case AUFNEHMEN ->
                            throw new IllegalArgumentException(
                                    "„aufnehmen“ gilt für Steuern & Optimieren");
                };
        if (grund != null) {
            return abgelehnt(grund, vorher, List.of());
        }
        return new UebergangErgebnis(true, null, Zustand.ENTWURF, List.of(), null);
    }

    private static UebergangErgebnis abgelehnt(Grund grund, Zustand nachher, List<String> fehlt) {
        String text = grund == Grund.PRUEFLISTE_OFFEN ? fehltSatz(grund.text(), fehlt) : grund.text();
        return new UebergangErgebnis(false, grund, nachher, List.of(), text);
    }

    // ------------------------------------------------------------------ Bestand (W5)

    /**
     * Was der Bestand über eine Anlage weiß — vor dem Umstieg, ohne Teilnahme-Objekt.
     *
     * @param eigenverbrauchLaeuft der scharfgeschaltete Speicher fährt ohne Betriebsmodell den
     *     Eigenverbrauchs-Fahrplan (den Grundmodus) — eine laufende Betriebsweise
     * @param steuerartOderRegelAktiv eine freigegebene Komponente trägt eine wirksame Steuerart
     *     oder Regel
     * @param scharfschaltung die Steuer-Scharfschaltung eines Wechselrichters (VoltPilot)
     */
    public record BestandEingang(
            String anlage,
            boolean betriebsmodellAn,
            Instant betriebsmodellSeit,
            boolean eigenverbrauchLaeuft,
            Instant eigenverbrauchSeit,
            boolean steuerartOderRegelAktiv,
            Instant steuerartSeit,
            boolean scharfschaltung) {}

    public record BestandErgebnis(Zustand zustand, Instant gestartetAm, String text) {}

    /**
     * Der einmalige Umstieg (§4.3 „Bestand → Zustand“, W5, A11): eine LAUFENDE Betriebsweise →
     * aktiv (übernommen), seit der frühesten; Scharfschaltung ohne laufende Betriebsweise →
     * eingerichtet; sonst kein Objekt. LESEND — nichts wird geschaltet, kein Ruhe-Eintrag
     * angelegt.
     */
    public static BestandErgebnis bestand(BestandEingang e, ZoneId zeitzone) {
        ZoneId zone = zone(zeitzone);
        if (e.betriebsmodellAn() || e.eigenverbrauchLaeuft() || e.steuerartOderRegelAktiv()) {
            Instant seit = null;
            seit = frueher(seit, e.betriebsmodellAn() ? e.betriebsmodellSeit() : null);
            seit = frueher(seit, e.eigenverbrauchLaeuft() ? e.eigenverbrauchSeit() : null);
            seit = frueher(seit, e.steuerartOderRegelAktiv() ? e.steuerartSeit() : null);
            String text =
                    (seit == null ? "Gestartet" : "Gestartet am " + datum(seit, zone))
                            + " (übernommen)";
            return new BestandErgebnis(Zustand.AKTIV, seit, text);
        }
        if (e.scharfschaltung()) {
            return new BestandErgebnis(Zustand.EINGERICHTET, null, eingerichtetSatz(null, zone));
        }
        return new BestandErgebnis(Zustand.KEIN_OBJEKT, null, "Diese Anlage misst nur");
    }

    /** Der Standort beim Umstieg: der höchste Zustand seiner übernommenen Anlagen. */
    public static StandortErgebnis bestandStandort(List<BestandEingang> anlagen, ZoneId zeitzone) {
        List<TeilnahmeStand> stand = new ArrayList<>();
        for (BestandEingang a : anlagen) {
            BestandErgebnis b = bestand(a, zeitzone);
            stand.add(new TeilnahmeStand(a.anlage(), b.zustand(), b.gestartetAm(), List.of()));
        }
        return standort(stand, zeitzone);
    }

    // -------------------------------------------------------------------------- Text

    /** „01.12.2026“ — das Datum in der Zeitzone des Standorts, nie in UTC. */
    public static String datum(Instant zeitpunkt, ZoneId zeitzone) {
        return DATUM.format(zeitpunkt.atZone(zone(zeitzone)));
    }

    private static String eingerichtetSatz(Instant seit, ZoneId zone) {
        return mitDatum("Eingerichtet am ", "Eingerichtet", seit, zone)
                + " — Steuerung noch nicht gestartet";
    }

    private static String mitDatum(String mit, String ohne, Instant seit, ZoneId zone) {
        return seit == null ? ohne : mit + datum(seit, zone);
    }

    private static String fehltSatz(String kopf, List<String> fehlt) {
        return fehlt.isEmpty() ? kopf : kopf + " — es fehlt: " + ZustandAbleitung.aufzaehlung(fehlt);
    }

    private static boolean alleBestanden(List<PruefZeile> zeilen) {
        for (PruefZeile z : zeilen) {
            if (!Boolean.TRUE.equals(z.bestanden())) {
                return false;
            }
        }
        return true;
    }

    private static Instant frueher(Instant a, Instant b) {
        if (a == null) {
            return b;
        }
        return b == null || !b.isBefore(a) ? a : b;
    }

    private static ZoneId zone(ZoneId zeitzone) {
        return zeitzone == null ? ZustandAbleitung.VORGABE_ZEITZONE : zeitzone;
    }
}
