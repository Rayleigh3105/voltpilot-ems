package com.voltpilot.api.uems;

import java.util.Arrays;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Eine Ablehnung der Kennzahl-Schnittstelle (UEMS AP-11 IP-5): Code, Status und Herkunft des Satzes kommen
 * aus dem geschlossenen Satz {@link Ablehnung} — also aus dem Vertrag
 * ({@code kennzahl-vectors.json → schnittstelle.ablehnungen}). Den Satz einer Regel-Ablehnung spricht
 * {@link KennzahlRegeln}, den eines 403 (und eines 404 außerhalb des Geltungsbereichs) die Rechte-Ableitung
 * ({@link RechteAbleitung#TEXTE}) — diese Klasse erfindet keinen. Wenn sie fliegt, ist nichts geschrieben.
 */
public final class KennzahlAbgelehnt extends RuntimeException {

    /** Woher der Satz einer Ablehnung kommt. */
    public static final String QUELLE_SCHNITTSTELLE = "schnittstelle";
    public static final String QUELLE_REGEL = "regel";
    public static final String QUELLE_RECHTE = "rechte";

    /** Der geschlossene Satz, in der Reihenfolge des Vertrags. */
    public enum Ablehnung {
        ANFRAGE_UNGUELTIG(KennzahlRegeln.ANFRAGE_UNGUELTIG, 400, QUELLE_SCHNITTSTELLE,
                "Die Anfrage ist unvollständig oder nennt ein Feld, das es hier nicht gibt.", "feld"),
        KENNZEICHEN_FORMAT("kennzeichen_format", 400, QUELLE_SCHNITTSTELLE,
                "Ein Kennzeichen hat 2 bis 16 Zeichen: Großbuchstaben, Ziffern, Punkt, Bindestrich oder Schrägstrich.",
                "feld"),
        RECHT_FEHLT("recht_fehlt", 403, QUELLE_RECHTE, null, "rolle_noetig"),
        NICHT_GEFUNDEN("nicht_gefunden", 404, QUELLE_SCHNITTSTELLE, "Diese Kennzahl gibt es nicht."),
        KENNZEICHEN_BELEGT("kennzeichen_belegt", 409, QUELLE_SCHNITTSTELLE,
                "Dieses Kennzeichen trägt oder trug schon eine andere Kennzahl.", "feld"),
        ARCHIVIERT("archiviert", 409, QUELLE_SCHNITTSTELLE, "Diese Kennzahl ist archiviert und wird nicht mehr geändert."),
        HAT_WERTE("hat_werte", 409, QUELLE_SCHNITTSTELLE, "{kennzahl} hat Werte — archivieren Sie sie.", "werte"),
        WIRD_GELESEN("wird_gelesen", 409, QUELLE_SCHNITTSTELLE,
                "{kennzahl} wird von {leser} gelesen — archivieren Sie sie stattdessen.", "leser"),
        PERIODE_PASST_NICHT(KennzahlRegeln.PERIODE_PASST_NICHT, 422, QUELLE_REGEL, null, "grundperiode", "perioden"),
        EINHEIT_UNPASSEND(KennzahlRegeln.EINHEIT_UNPASSEND, 422, QUELLE_REGEL, null),
        GROESSE_UNBEKANNT(KennzahlRegeln.GROESSE_UNBEKANNT, 422, QUELLE_REGEL, null, "eingang"),
        EINGANG_AUSSERHALB_GELTUNG(KennzahlRegeln.EINGANG_AUSSERHALB_GELTUNG, 422, QUELLE_REGEL, null, "eingang"),
        FORMEL_ZYKLUS(KennzahlRegeln.FORMEL_ZYKLUS, 422, QUELLE_REGEL, null, "kette"),
        FASSUNG_UEBERLAPPT(KennzahlRegeln.FASSUNG_UEBERLAPPT, 422, QUELLE_REGEL, null, "fassung", "gueltig_ab"),
        GELTUNG_UNBEKANNT(KennzahlRegeln.GELTUNG_UNBEKANNT, 422, QUELLE_REGEL, null, "feld"),
        EINGANG_UNBEKANNT(KennzahlRegeln.EINGANG_UNBEKANNT, 422, QUELLE_REGEL, null, "eingang"),
        RECHENFORM_UNBEKANNT(KennzahlRegeln.RECHENFORM_UNBEKANNT, 422, QUELLE_REGEL, null, "feld");

        private final String code;
        private final int status;
        private final String quelle;
        private final String satz;
        private final List<String> fakten;

        Ablehnung(String code, int status, String quelle, String satz, String... fakten) {
            this.code = code;
            this.status = status;
            this.quelle = quelle;
            this.satz = satz;
            this.fakten = List.of(fakten);
        }

        public String code() {
            return code;
        }

        public int status() {
            return status;
        }

        public String quelle() {
            return quelle;
        }

        /** Der Satz der Schnittstelle; {@code null}, wenn die Regel oder die Rechte-Ableitung ihn spricht. */
        public String satz() {
            return satz;
        }

        public List<String> fakten() {
            return fakten;
        }

        static Ablehnung vonCode(String code) {
            return Arrays.stream(values()).filter(a -> a.code.equals(code)).findFirst()
                    .orElseThrow(() -> new IllegalArgumentException("kein Code des Vertrags: " + code));
        }
    }

    /** Alle Codes, die die Schnittstelle je antwortet — gepinnt gegen Vertrag und OpenAPI-Enum. */
    public static final List<String> CODES = Arrays.stream(Ablehnung.values()).map(Ablehnung::code).toList();

    private final Ablehnung ablehnung;
    private final Map<String, Object> fakten;

    private KennzahlAbgelehnt(Ablehnung ablehnung, String satz, Map<String, Object> fakten) {
        super(satz);
        this.ablehnung = ablehnung;
        this.fakten = Collections.unmodifiableMap(new LinkedHashMap<>(fakten));
    }

    /** Eine Ablehnung mit dem Satz der Schnittstelle (ohne Platzhalter). */
    public static KennzahlAbgelehnt von(Ablehnung a) {
        if (a.satz() == null || a.satz().contains("{")) {
            throw new IllegalArgumentException(a.code() + " braucht seinen Satz von der Regel oder der Rechte-Ableitung");
        }
        return new KennzahlAbgelehnt(a, a.satz(), Map.of());
    }

    /** {@code anfrage_ungueltig} mit dem Feld, das fehlt, falsch geformt ist oder hier nicht existiert. */
    public static KennzahlAbgelehnt anfrage(String feld) {
        return new KennzahlAbgelehnt(Ablehnung.ANFRAGE_UNGUELTIG, Ablehnung.ANFRAGE_UNGUELTIG.satz(), Map.of("feld", feld));
    }

    /** Ein Feld mit dem Satz der Schnittstelle, z. B. {@code kennzeichen_format} oder {@code kennzeichen_belegt}. */
    public static KennzahlAbgelehnt feld(Ablehnung a, String feld) {
        return new KennzahlAbgelehnt(a, von(a).getMessage(), Map.of("feld", feld));
    }

    /** Das Urteil einer Regel aus {@link KennzahlRegeln}: Code und Kundensatz von dort, dazu die Fakten. */
    public static KennzahlAbgelehnt regel(String code, String kundensatz, Map<String, Object> fakten) {
        Ablehnung a = Ablehnung.vonCode(code);
        String satz = kundensatz != null ? kundensatz : a.satz();
        if (satz == null) {
            throw new IllegalStateException("Die Regel nennt für " + code + " keinen Satz");
        }
        return new KennzahlAbgelehnt(a, satz, fakten);
    }

    /** V5: eine Kennzahl mit Werten wird nicht gelöscht. */
    public static KennzahlAbgelehnt hatWerte(String kennzeichen, long werte) {
        return new KennzahlAbgelehnt(Ablehnung.HAT_WERTE, Ablehnung.HAT_WERTE.satz().replace("{kennzahl}", kennzeichen),
                Map.of("werte", werte));
    }

    /** V5: eine Kennzahl, die eine andere liest, wird nicht gelöscht. */
    public static KennzahlAbgelehnt wirdGelesen(String kennzeichen, List<String> leser) {
        String satz = Ablehnung.WIRD_GELESEN.satz().replace("{kennzahl}", kennzeichen)
                .replace("{leser}", String.join(", ", leser));
        return new KennzahlAbgelehnt(Ablehnung.WIRD_GELESEN, satz, Map.of("leser", List.copyOf(leser)));
    }

    /**
     * Das Nein der Rechte-Ableitung: 403 ist {@code recht_fehlt} mit ihrem Satz und der kleinsten Rolle, die es
     * dürfte ({@code rolle_noetig}); jedes andere Nein (außerhalb des Geltungsbereichs, Zugriff beendet) ist
     * {@code nicht_gefunden} mit ihrem Satz — fremd ist nicht da, nie ein 403.
     */
    public static KennzahlAbgelehnt rechte(RechteAbleitung.DarfErgebnis d) {
        if (d.darf()) {
            throw new IllegalArgumentException("kein Nein");
        }
        if (d.http() == 403) {
            Map<String, Object> fakten = new LinkedHashMap<>();
            fakten.put("rolle_noetig", d.rolleNoetig() == null ? null : d.rolleNoetig().code());
            return new KennzahlAbgelehnt(Ablehnung.RECHT_FEHLT, d.text(), fakten);
        }
        return new KennzahlAbgelehnt(Ablehnung.NICHT_GEFUNDEN,
                d.text() != null ? d.text() : Ablehnung.NICHT_GEFUNDEN.satz(), Map.of());
    }

    public Ablehnung ablehnung() {
        return ablehnung;
    }

    public String code() {
        return ablehnung.code();
    }

    public int status() {
        return ablehnung.status();
    }

    /** Die Fakten (snake_case wie der Vertrag), ohne Code und Satz. */
    public Map<String, Object> fakten() {
        return fakten;
    }
}
