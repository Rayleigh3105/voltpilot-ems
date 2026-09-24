package com.voltpilot.api.uems;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.web.dto.BezugsbasisDto;
import java.math.BigDecimal;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.YearMonth;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.springframework.jdbc.core.JdbcTemplate;

/**
 * Die Anstöße einer Bezugsbasis LESEN (UEMS AP-17 Nachlese 3, A2–A4): jede Zeile von {@code bezugsbasis_anstoss} an einer
 * Fassung der Basis, jüngste zuerst, mit dem Kundensatz nach §10 ({@code bezugsbasis.md}). Geschrieben werden Anstöße nur
 * von {@link BezugsbasisAnstoss} (IP-15), beantwortet von „bleibt“/„beenden“ (IP-17) — hier wird nichts geändert.
 *
 * <p><b>Der Satz</b> entsteht aus den Feldern der Zeile und aus dem, worauf ihre Anlass-Kennung zeigt:
 * <ul>
 *   <li>Pfad 1 ({@code grundlage_korrigiert}): der Vorgang (Korrektur-Kennung) und je Treffer des Anlasses die zitierte
 *       Version aus der gespeicherten Grundlage gegen die jetzt gültige aus {@code kennzahl_wert} — „Grundlage korrigiert
 *       (K-2026-0007, 12.11.2026) — Fassung 1 zitiert Version 1 (0,1488), gültig ist jetzt Version 2 (0,1473).“</li>
 *   <li>Pfad 2 ({@code <protokoll>:<id>}): die Protokollzeile selbst (Objekt, Art, alt/neu, gilt ab) — „Die Fläche des
 *       Gebäudes Halle 2 hat sich geändert (3 100 → 3 400 m² ab 01.01.2027) — Fassung 1 prüfen.“</li>
 * </ul>
 * Was sich nicht auflösen lässt, bekommt den Satz der Art ohne Code-Wörter — nie den technischen Anlass-Text.
 */
final class BezugsbasisAnstoesse {

    private BezugsbasisAnstoesse() {}

    private static final ObjectMapper JSON = new ObjectMapper();
    private static final DateTimeFormatter TAG = DateTimeFormatter.ofPattern("dd.MM.yyyy");
    /** Die Wörter der Anstoß-Arten (A1-Wörter an der Kundenfläche). */
    static final Map<String, String> ART_WORT = Map.of(
            BezugsbasisAnstoss.GRUNDLAGE_KORRIGIERT, "Grundlage korrigiert",
            BezugsbasisAnstoss.STRUKTUR_GEAENDERT, "Struktur geändert",
            BezugsbasisAnstoss.VARIABLE_GEAENDERT, "Einflussgröße geändert",
            BezugsbasisAnstoss.NICHT_MEHR_ANWENDBAR, "Nicht mehr anwendbar");
    /** Höchstens so viele Treffer nennt ein Satz; der Rest wird gezählt. */
    private static final int HOECHSTENS = 3;
    /** Der Anlass des Pfads 1: {@code <kennung> (<status>): <treffer>, <treffer>}. */
    private static final Pattern PFAD1 = Pattern.compile("^(.+?) \\(([^)]*)\\): (.+)$");
    private static final Pattern KZ = Pattern.compile("^(KZ-\\S+) (\\d{4}-\\d{2}) Version (\\d+)$");
    private static final Pattern FLAECHE = Pattern.compile("^Fläche (\\S+) (\\d{4}-\\d{2})$");
    private static final Pattern FASSUNG = Pattern.compile("^(\\S+) (\\d{4}-\\d{2}) Fassung (\\d+)$");
    private static final Pattern OBJEKT = Pattern.compile("^(\\S+) (\\d{4}-\\d{2})$");

    private record Zeile(String art, int pfad, String kennung, String anlass, OffsetDateTime zeitpunkt, int fassung,
            String grundlage, String antwort, String begruendung, OffsetDateTime am, String person) {}

    /** Alle Anstöße der Basis {@code basisId}, jüngster zuerst; Tage in der Zone {@code zone} der Kennzahl. */
    static List<BezugsbasisDto.Anstoss> lesen(JdbcTemplate jdbc, UUID basisId, String kennzahlKennzeichen, ZoneId zone) {
        List<Zeile> zeilen = jdbc.query("SELECT s.art, s.pfad, s.anlass_kennung, s.anlass, s.angestossen_am, f.fassung, "
                + "f.grundlage, s.antwort, s.antwort_begruendung, s.beantwortet_am, s.beantwortet_name "
                + "FROM bezugsbasis_anstoss s JOIN bezugsbasis_fassung f ON f.id = s.fassung_id "
                + "AND f.tenant_id = s.tenant_id WHERE f.bezugsbasis_id = ? "
                + "ORDER BY s.angestossen_am DESC, f.fassung DESC, s.anlass_kennung", (rs, i) -> new Zeile(
                        rs.getString("art"), rs.getInt("pfad"), rs.getString("anlass_kennung"), rs.getString("anlass"),
                        rs.getObject("angestossen_am", OffsetDateTime.class), rs.getInt("fassung"),
                        rs.getString("grundlage"), rs.getString("antwort"), rs.getString("antwort_begruendung"),
                        rs.getObject("beantwortet_am", OffsetDateTime.class), rs.getString("beantwortet_name")), basisId);
        List<BezugsbasisDto.Anstoss> aus = new ArrayList<>();
        for (Zeile z : zeilen) {
            String satz = z.pfad() == 1 ? pfadEins(jdbc, z, kennzahlKennzeichen, zone) : pfadZwei(jdbc, z, zone);
            aus.add(new BezugsbasisDto.Anstoss(z.art(), z.pfad(), z.kennung(), satz, z.zeitpunkt(), z.fassung(),
                    z.antwort() == null, z.antwort() == null ? null
                            : new BezugsbasisDto.AnstossAntwort(z.antwort(), z.person(), z.am(), z.begruendung())));
        }
        return aus;
    }

    // ============================================================================ Pfad 1 (A2)

    private static String pfadEins(JdbcTemplate jdbc, Zeile z, String eigene, ZoneId zone) {
        String kopf = kopf(z.art(), beleg(z.kennung()) + ", " + tag(z.zeitpunkt(), zone));
        Matcher m = z.anlass() == null ? null : PFAD1.matcher(z.anlass());
        if (m == null || !m.matches()) {
            return kopf + " — Fassung " + z.fassung() + " prüfen.";
        }
        boolean zurueck = m.group(2).startsWith("zurückgenommen");
        JsonNode grundlage = lies(z.grundlage());
        List<String> treffer = new ArrayList<>();
        for (String t : m.group(3).split(", ")) {
            if (!t.endsWith("…")) {
                treffer.add(t.strip());
            }
        }
        boolean mehrere = treffer.size() > 1;
        List<String> teile = new ArrayList<>();
        for (String t : treffer.subList(0, Math.min(HOECHSTENS, treffer.size()))) {
            teile.add(treffer(jdbc, t, grundlage, eigene, mehrere, zurueck));
        }
        if (teile.isEmpty()) {
            return kopf + " — Fassung " + z.fassung() + " prüfen.";
        }
        String rest = treffer.size() > HOECHSTENS ? " und " + (treffer.size() - HOECHSTENS) + " weitere" : "";
        return kopf + " — Fassung " + z.fassung() + " zitiert " + String.join("; ", teile) + rest + ".";
    }

    /** Ein Treffer in Worten, ohne „Fassung n zitiert“ davor. */
    private static String treffer(JdbcTemplate jdbc, String t, JsonNode grundlage, String eigene, boolean mehrere,
            boolean zurueck) {
        Matcher kz = KZ.matcher(t);
        if (kz.matches()) {
            String objekt = kz.group(1);
            YearMonth monat = YearMonth.parse(kz.group(2));
            int neu = Integer.parseInt(kz.group(3));
            JsonNode alt = zitat(grundlage, monat, objekt);
            String neuWert = jdbc.queryForList("SELECT w.wert::text FROM kennzahl_wert w JOIN kennzahl k "
                    + "ON k.id = w.kennzahl_id AND k.tenant_id = w.tenant_id WHERE k.kennzeichen = ? "
                    + "AND w.periode_art = 'monat' AND w.periode_von = ? AND w.version = ? LIMIT 1", String.class,
                    objekt, monat.atDay(1), neu).stream().findFirst().orElse(null);
            StringBuilder s = new StringBuilder();
            if (!objekt.equals(eigene)) {
                s.append(objekt).append(' ');
            }
            if (mehrere) {
                s.append("für ").append(monat(monat)).append(' ');
            }
            if (alt != null && alt.hasNonNull("version")) {
                s.append("Version ").append(alt.path("version").asInt()).append(wert(alt.path("wert").asText(null)));
            } else {
                s.append("einen älteren Stand");
            }
            return s.append(", gültig ist jetzt Version ").append(neu).append(wert(neuWert)).toString();
        }
        Matcher fl = FLAECHE.matcher(t);
        if (fl.matches()) {
            return "die Fläche " + fl.group(1) + " für " + monat(YearMonth.parse(fl.group(2)))
                    + ", sie wurde rückwirkend geändert";
        }
        Matcher fa = FASSUNG.matcher(t);
        if (fa.matches()) {
            JsonNode alt = zitat(grundlage, YearMonth.parse(fa.group(2)), fa.group(1));
            return fa.group(1) + " für " + monat(YearMonth.parse(fa.group(2)))
                    + (alt != null && alt.hasNonNull("fassung") ? " in Fassung " + alt.path("fassung").asInt() : "")
                    + (zurueck ? ", der Wert wurde zurückgenommen" : ", gültig ist jetzt Fassung " + fa.group(3));
        }
        Matcher ob = OBJEKT.matcher(t);
        if (ob.matches()) {
            return ob.group(1) + " für " + monat(YearMonth.parse(ob.group(2)))
                    + (zurueck ? ", die Korrektur wurde zurückgenommen" : ", dort gilt jetzt ein korrigierter Wert");
        }
        return "einen Wert, der korrigiert wurde";
    }

    /** Der zitierte Eingang {@code objekt} im Periodeneintrag {@code monat} der gespeicherten Grundlage. */
    private static JsonNode zitat(JsonNode grundlage, YearMonth monat, String objekt) {
        for (JsonNode eintrag : BezugsbasisAnstoss.perioden(grundlage)) {
            if (!monat.toString().equals(eintrag.path("periode").asText())) {
                continue;
            }
            for (JsonNode feld : eintrag) {
                List<JsonNode> werte = new ArrayList<>();
                if (feld.isArray()) {
                    feld.forEach(werte::add);
                } else {
                    werte.add(feld);
                }
                for (JsonNode wert : werte) {
                    if (objekt.equals(wert.path("objekt").asText(null))) {
                        return wert;
                    }
                }
            }
        }
        return null;
    }

    /** Die Kennung des Vorgangs in Worten: „K-2026-0007“, „K-2026-0007 zurückgenommen“, „KZ-0001 Fassung 2“. */
    static String beleg(String kennung) {
        String[] teile = kennung.split("/");
        StringBuilder s = new StringBuilder(teile[0]);
        for (int i = 1; i < teile.length; i++) {
            String t = teile[i];
            if (t.equals("zurueckgenommen")) {
                s.append(" zurückgenommen");
            } else if (t.startsWith("Fassung-")) {
                s.append(" Fassung ").append(t.substring("Fassung-".length()));
            } else if (t.startsWith("ab-")) {
                try {
                    s.append(" ab ").append(LocalDate.parse(t.substring(3)).format(TAG));
                } catch (RuntimeException e) {
                    // eine unbekannte Endung bleibt weg statt als Code zu erscheinen
                }
            }
        }
        return s.toString();
    }

    // ============================================================================ Pfad 2 (A3)

    private record Protokoll(String objektArt, UUID objekt, String art, JsonNode alt, JsonNode neu, LocalDate giltAb) {}

    private static String pfadZwei(JdbcTemplate jdbc, Zeile z, ZoneId zone) {
        String fassung = "Fassung " + z.fassung();
        Protokoll p = protokoll(jdbc, z.kennung(), zone);
        String folge = BezugsbasisAnstoss.NICHT_MEHR_ANWENDBAR.equals(z.art()) ? " — " + fassung
                + " ist nicht mehr anwendbar." : " — " + fassung + " prüfen.";
        if (p == null) {
            return kopf(z.art(), tag(z.zeitpunkt(), zone)) + folge;
        }
        String name = name(jdbc, p.objektArt(), p.objekt());
        // §5.8 nennt nur „ab TT.MM.JJJJ“ — ob rückwirkend eingetragen, steht im Protokoll der Änderung, nicht am Anstoß.
        String wann = p.giltAb() == null ? "" : "ab " + p.giltAb().format(TAG);
        String klammer = wann.isEmpty() ? "" : " (" + wann + ")";
        return switch (p.art()) {
            case "flaeche_geaendert" -> {
                String alt = flaeche(p.alt()), neu = flaeche(p.neu());
                String werte = alt == null || neu == null ? "" : alt + " → " + neu + " m²";
                String inhalt = String.join(" ", List.of(werte, wann).stream().filter(x -> !x.isEmpty()).toList());
                yield "Die Fläche " + genitiv(p.objektArt()) + " " + name + " hat sich geändert"
                        + (inhalt.isEmpty() ? "" : " (" + inhalt + ")") + folge;
            }
            case "verschoben" -> nominativ(p.objektArt()) + " " + name + " wurde verschoben" + klammer + folge;
            case "korrigiert" -> "Die Zuordnung " + genitiv(p.objektArt()) + " " + name + " wurde berichtigt" + klammer
                    + folge;
            case "archiviert" -> nominativ(p.objektArt()) + " " + name + " wurde archiviert" + klammer + folge;
            case "geloescht" -> nominativ(p.objektArt()) + " " + name + " wurde gelöscht" + klammer + folge;
            case "prozesse_zugeordnet" -> "Die Prozesse der Messstelle " + name + " haben sich geändert" + klammer + folge;
            case "verteilung_geaendert" -> "Die Verteilung der Messstelle " + name + " auf Kostenstellen hat sich geändert"
                    + klammer + folge;
            case "kennzahl_archiviert" -> "Die Kennzahl " + name + " wurde archiviert" + klammer + folge;
            default -> "bezugsgroesse".equals(p.objektArt())
                    ? "Die Einflussgröße " + name + " hat sich geändert" + klammer + folge
                    : kopf(z.art(), tag(z.zeitpunkt(), zone)) + folge;
        };
    }

    /** Die Protokollzeile hinter {@code <protokoll>:<id>}; {@code null}, wenn sie nicht (mehr) lesbar ist. */
    private static Protokoll protokoll(JdbcTemplate jdbc, String kennung, ZoneId zone) {
        int doppelpunkt = kennung.indexOf(':');
        if (doppelpunkt < 0) {
            return null;
        }
        long id;
        try {
            id = Long.parseLong(kennung.substring(doppelpunkt + 1));
        } catch (NumberFormatException e) {
            return null;
        }
        String sql = switch (kennung.substring(0, doppelpunkt)) {
            case "ort_aenderung" -> "SELECT objekt_art, objekt_id, art, alt::text, neu::text, gilt_ab::text AS ab "
                    + "FROM ort_aenderung WHERE id = ?";
            case "messstelle_aenderung" -> "SELECT 'messstelle' AS objekt_art, messstelle_id AS objekt_id, art, alt::text, "
                    + "neu::text, gilt_ab::text AS ab FROM messstelle_aenderung WHERE id = ?";
            case "kennzahl_aenderung" -> "SELECT 'kennzahl' AS objekt_art, kennzahl_id AS objekt_id, art, alt::text, "
                    + "neu::text, gilt_ab::text AS ab FROM kennzahl_aenderung WHERE id = ?";
            case "bezugsgroesse_aenderung" -> "SELECT 'bezugsgroesse' AS objekt_art, bezugsgroesse_id AS objekt_id, art, "
                    + "alt::text, neu::text, gilt_ab::text AS ab FROM bezugsgroesse_aenderung WHERE id = ?";
            default -> null;
        };
        if (sql == null) {
            return null;
        }
        return jdbc.query(sql, (rs, i) -> new Protokoll(rs.getString("objekt_art"),
                rs.getObject("objekt_id", UUID.class), rs.getString("art"), lies(rs.getString("alt")),
                lies(rs.getString("neu")), giltAb(rs.getString("ab"), zone)), id)
                .stream().findFirst().orElse(null);
    }

    /** {@code gilt_ab} als Tag: ein DATE bleibt, ein Zeitpunkt wird in der Zone der Kennzahl zum Tag. */
    private static LocalDate giltAb(String text, ZoneId zone) {
        if (text == null) {
            return null;
        }
        if (text.length() == 10) {
            return LocalDate.parse(text);
        }
        return OffsetDateTime.parse(text.replace(' ', 'T').replaceAll("([+-]\\d{2})$", "$1:00"))
                .atZoneSameInstant(zone).toLocalDate();
    }

    /** Der Name des Objekts, wie ihn die Kundenfläche zeigt; ohne Treffer das Wort ohne Namen. */
    private static String name(JdbcTemplate jdbc, String objektArt, UUID id) {
        String sql = switch (objektArt) {
            case StrukturAufloesung.GEBAEUDE, StrukturAufloesung.BEREICH -> "SELECT name FROM ort WHERE id = ?";
            case StrukturAufloesung.STANDORT -> "SELECT name FROM standort WHERE id = ?";
            case StrukturAufloesung.ANLAGE -> "SELECT name FROM site WHERE id = ?";
            case StrukturAufloesung.MESSSTELLE -> "SELECT kennzeichen FROM messstelle WHERE id = ?";
            case "kennzahl" -> "SELECT kennzeichen FROM kennzahl WHERE id = ?";
            case "bezugsgroesse" -> "SELECT kennzeichen FROM bezugsgroesse WHERE id = ?";
            default -> null;
        };
        String name = sql == null ? null : jdbc.queryForList(sql, String.class, id).stream().findFirst().orElse(null);
        return name == null ? "" : name;
    }

    private static String nominativ(String objektArt) {
        return switch (objektArt) {
            case StrukturAufloesung.GEBAEUDE -> "Das Gebäude";
            case StrukturAufloesung.BEREICH -> "Der Bereich";
            case StrukturAufloesung.STANDORT -> "Der Standort";
            case StrukturAufloesung.ANLAGE -> "Die Anlage";
            default -> "Der Ort";
        };
    }

    private static String genitiv(String objektArt) {
        return switch (objektArt) {
            case StrukturAufloesung.GEBAEUDE -> "des Gebäudes";
            case StrukturAufloesung.BEREICH -> "des Bereichs";
            case StrukturAufloesung.STANDORT -> "des Standorts";
            case StrukturAufloesung.ANLAGE -> "der Anlage";
            default -> "des Orts";
        };
    }

    private static String flaeche(JsonNode seite) {
        if (seite == null || !seite.hasNonNull("flaeche_m2")) {
            return null;
        }
        try {
            return BezugsbasisVergleichSatz.menge(new BigDecimal(seite.path("flaeche_m2").asText()).toPlainString());
        } catch (NumberFormatException e) {
            return null;
        }
    }

    // ============================================================================ gemeinsam

    /** „Grundlage korrigiert (K-2026-0007, 12.11.2026)“ — das Wort der Art und in Klammern, was die Zeile weiß. */
    private static String kopf(String art, String klammer) {
        return ART_WORT.getOrDefault(art, "Anstoß") + " (" + klammer + ")";
    }

    /** „ (0,1488)“ — vier Stellen wie der Basiswert (M5); ohne Wert nichts. */
    private static String wert(String wert) {
        if (wert == null) {
            return "";
        }
        try {
            return " (" + BezugsbasisRegeln.de(BezugsbasisRegeln.runden(new BigDecimal(wert).toPlainString(), 4)) + ")";
        } catch (RuntimeException e) {
            return "";
        }
    }

    private static String monat(YearMonth m) {
        return KennzahlRegeln.MONATSNAMEN.get(m.getMonthValue() - 1) + " " + m.getYear();
    }

    private static String tag(OffsetDateTime zeitpunkt, ZoneId zone) {
        return zeitpunkt.atZoneSameInstant(zone).toLocalDate().format(TAG);
    }

    private static JsonNode lies(String text) {
        if (text == null) {
            return null;
        }
        try {
            return JSON.readTree(text);
        } catch (Exception e) {
            return null;
        }
    }
}
