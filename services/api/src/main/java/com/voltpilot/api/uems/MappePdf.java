package com.voltpilot.api.uems;

import com.voltpilot.api.uems.BerichtPdf.Setzer;
import com.voltpilot.api.uems.BerichtPdf.Spalte;
import com.voltpilot.api.web.dto.EnergiemanagementVerzeichnisDto.Gruppe;
import com.voltpilot.api.web.dto.EnergiemanagementVerzeichnisDto.Zeile;
import java.io.IOException;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Das PDF einer Mappe „Unterlagen zusammenstellen“ (Konzept Nachweisen n1, Entscheid 7): Titel, Angaben und ein
 * Inhaltsverzeichnis mit Seitenzahlen, dann „Was am Stichtag gilt“ (die geltende Fassung je Dokument, die laufenden
 * Aufgaben, die geltenden Vermerke), „Was im Zeitraum festgehalten wurde“ (die Zeilen des Verzeichnisses je Gruppe),
 * die Teile, die beim Zusammenstellen offen waren, und Verantwortungs- und Grenz-Satz. Gesetzt mit dem Setzer der
 * Berichte; die Seitenzahlen des Inhaltsverzeichnisses aus einem ersten Durchlauf mit demselben Satz.
 *
 * <p>Es urteilt nicht: jede Zeile nennt, was festgehalten ist, wer entschieden hat und wo das Original liegt - wie das
 * Verzeichnis. Ob es genügt, beurteilt, wer prüft.
 */
final class MappePdf {

    /** Was in die Mappe geht - alles schon gelesen und gefiltert vom Dienst. */
    record Inhalt(String titel, String dateiTitel, String anlassWort, LocalDate von, LocalDate bis, OffsetDateTime stichtag,
            String erstelltVon, List<Gruppe> gilt, List<Gruppe> imZeitraum, List<String> offen, String csvSha256) {}

    private static final DateTimeFormatter TAG = DateTimeFormatter.ofPattern("dd.MM.yyyy");
    private static final DateTimeFormatter ZEIT = DateTimeFormatter.ofPattern("dd.MM.yyyy, HH:mm");
    private static final String TRENNER = " · ";
    static final String INHALT = "Inhalt";
    static final String OFFEN = "Was beim Zusammenstellen offen war";
    static final String GRENZE = "Verantwortung und Grenze";

    private MappePdf() {}

    static String giltTitel(Inhalt m) {
        return "Was am " + m.bis().format(TAG) + " gilt";
    }

    static String zeitraumTitel(Inhalt m) {
        return m.von() == null ? "Was bis " + m.bis().format(TAG) + " festgehalten wurde"
                : "Was vom " + m.von().format(TAG) + " bis " + m.bis().format(TAG) + " festgehalten wurde";
    }

    static byte[] datei(Inhalt m) {
        // Erster Durchlauf: wo jeder Abschnitt beginnt. Zweiter: dasselbe mit den Seitenzahlen im Inhaltsverzeichnis.
        Map<String, Integer> seiten = new LinkedHashMap<>();
        BerichtPdf.dokument(m.dateiTitel(), m.stichtag().toInstant(), m.stichtag().getOffset(), s -> setzen(s, m, null, seiten));
        return BerichtPdf.dokument(m.dateiTitel(), m.stichtag().toInstant(), m.stichtag().getOffset(),
                s -> setzen(s, m, seiten, new LinkedHashMap<>()));
    }

    private static void setzen(Setzer s, Inhalt m, Map<String, Integer> bekannt, Map<String, Integer> merke)
            throws IOException {
        s.titel(m.dateiTitel());
        s.absatz(m.titel() + TRENNER + "Stand " + m.stichtag().format(ZEIT), BerichtPdf.NORMAL, BerichtPdf.GRAU);
        s.abstand(6);
        s.paare(List.of(
                new String[] {"Wofür", m.anlassWort()},
                new String[] {"Zeitraum", m.von() == null ? "alles bis " + m.bis().format(TAG)
                        : m.von().format(TAG) + " bis " + m.bis().format(TAG)},
                new String[] {"Zusammengestellt von", m.erstelltVon()},
                new String[] {"Verzeichnis", "als CSV daneben, Prüfsumme " + m.csvSha256()}));

        // Inhaltsverzeichnis: die Abschnitte in ihrer Reihenfolge, je mit der Seite, auf der er beginnt.
        List<String> abschnitte = new ArrayList<>();
        abschnitte.add(giltTitel(m));
        abschnitte.add(zeitraumTitel(m));
        abschnitte.add(OFFEN);
        abschnitte.add(GRENZE);
        s.ueberschrift(INHALT);
        List<String[]> toc = new ArrayList<>();
        for (int i = 0; i < abschnitte.size(); i++) {
            Integer seite = bekannt == null ? null : bekannt.get(abschnitte.get(i));
            toc.add(new String[] {(i + 1) + "  " + abschnitte.get(i), "Seite " + (seite == null ? "99" : seite)});
        }
        s.tabelle(List.of(new Spalte("Abschnitt", 0, false), new Spalte("Seite", 60, true)),
                toc.stream().map(t -> List.of(List.of(t[0]), List.of(t[1]))).toList());

        abschnitt(s, giltTitel(m), merke);
        if (m.gilt().isEmpty()) {
            s.absatz("In den gewählten Gruppen gilt nichts, was festgehalten ist.", BerichtPdf.NORMAL, BerichtPdf.GRAU);
        }
        for (Gruppe g : m.gilt()) {
            s.zwischentitel(g.gruppeWort());
            s.tabelle(List.of(new Spalte("Was", 0, false), new Spalte("Fassung", 46, true), new Spalte("Seit", 58, false),
                    new Spalte("Entschieden von", 96, false), new Spalte("Original", 120, false)),
                    g.zeilen().stream().map(z -> List.of(List.of(z.titel()), List.of(z.nr() == null ? "" : z.nr().toString()),
                            List.of(tag(z.tag())), List.of(text(z.entschiedenVon())), List.of(text(z.ortSatz())))).toList());
        }

        abschnitt(s, zeitraumTitel(m), merke);
        for (Gruppe g : m.imZeitraum()) {
            s.zwischentitel(g.gruppeWort());
            if (g.zeilen().isEmpty()) {
                s.absatz("Im Zeitraum nichts festgehalten.", BerichtPdf.NORMAL, BerichtPdf.GRAU);
                continue;
            }
            s.tabelle(List.of(new Spalte("Tag", 58, false), new Spalte("Was", 0, false), new Spalte("Nr.", 30, true),
                    new Spalte("Entschieden von", 96, false), new Spalte("Prüfsumme", 70, false)),
                    g.zeilen().stream().map(z -> List.of(List.of(tag(z.tag())), List.of(z.titel()),
                            List.of(z.nr() == null ? "" : z.nr().toString()), List.of(text(z.entschiedenVon())),
                            List.of(kurz(z.pruefsumme())))).toList());
        }

        abschnitt(s, OFFEN, merke);
        if (m.offen().isEmpty()) {
            s.absatz("Kein Teil war offen.", BerichtPdf.NORMAL, BerichtPdf.SCHWARZ);
        } else {
            s.absatz("Zu diesen Teilen war beim Zusammenstellen nichts festgehalten - sie stehen hier als offen:",
                    BerichtPdf.NORMAL, BerichtPdf.SCHWARZ);
            for (String t : m.offen()) {
                s.absatz("○  " + t, BerichtPdf.NORMAL, BerichtPdf.SCHWARZ);
            }
        }

        abschnitt(s, GRENZE, merke);
        s.absatz(EnergiemanagementRegeln.SAETZE.get("verantwortung"), BerichtPdf.NORMAL, BerichtPdf.SCHWARZ);
        s.abstand(4);
        s.absatz(EnergiemanagementRegeln.SAETZE.get("grenz_satz"), BerichtPdf.NORMAL, BerichtPdf.SCHWARZ);

        s.fuesse(List.of(m.dateiTitel() + TRENNER + m.anlassWort() + TRENNER + "Stand " + m.stichtag().format(ZEIT),
                "Verzeichnis-CSV, Prüfsumme " + m.csvSha256()));
    }

    private static void abschnitt(Setzer s, String titel, Map<String, Integer> merke) throws IOException {
        s.ueberschrift(titel);
        merke.put(titel, s.seitenzahl());
    }

    private static String tag(LocalDate t) {
        return t == null ? "" : t.format(TAG);
    }

    private static String text(String t) {
        return t == null ? "" : t;
    }

    /** Eine Prüfsumme gekürzt wie im Portal: die ersten und letzten vier Zeichen; die ganze steht in der CSV. */
    private static String kurz(String p) {
        if (p == null) return "";
        String h = p.startsWith("sha256:") ? p.substring(7) : p;
        return h.length() <= 10 ? h : h.substring(0, 4) + "…" + h.substring(h.length() - 4);
    }
}
