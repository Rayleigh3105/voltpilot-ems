package com.voltpilot.api.zugriff;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Findet in Java-Quelltext die SQL-Anweisungen, die Messdaten lesen oder schreiben, ohne über {@code site} zu gehen —
 * der Scanner hinter {@link SiteScopeArchitekturTest} (UEMS AP-03 IP-5).
 *
 * <p>Eine „Anweisung" ist der Text zwischen zwei {@code ;}, {@code {} oder {@code }} außerhalb von Kommentaren und
 * Literalen. Ihr SQL ist die Folge ihrer String-Literale und Textblöcke, dazu der Inhalt jeder Konstanten
 * ({@code String NAME = …;}) derselben Datei, die sie nennt. SQL-Zeilenkommentare zählen nicht mit.
 *
 * <p>Eine Anweisung trifft eine Messdaten-Tabelle, wenn ihr SQL sie nach {@code FROM}, {@code JOIN}, {@code UPDATE}
 * oder {@code INTO} nennt — oder wenn ein Literal GENAU der Tabellenname ist (dynamisch gewählte Tabelle). Sie ist in
 * Ordnung, wenn dasselbe SQL {@code FROM site} oder {@code JOIN site} enthält. Eine Konstante, die in der Datei
 * benutzt wird, wird an ihren Benutzern geprüft, nicht an ihrer Deklaration.
 */
final class SqlAnweisungen {

    /** Die Hypertables der Telemetrie und ihre Rollups (Migrationen V1 … V20260848000000). */
    static final Pattern TABELLE = Pattern.compile(
            "telemetry(?:_v2)?(?:_rollup_(?:15m|1h|1d))?|device_measurement_(?:sample|rollup_(?:5m|15m))");

    private static final Pattern ZUGRIFF = Pattern.compile(
            "(?i)\\b(?:from|join|update|into)\\s+(?:public\\.)?(" + TABELLE.pattern() + ")\\b");
    private static final Pattern SITE = Pattern.compile("(?i)\\b(?:from|join)\\s+(?:public\\.)?site\\b");
    private static final Pattern KONSTANTE = Pattern.compile("\\bString\\s+([A-Z][A-Z0-9_]*)\\s*=");
    private static final Pattern BEZEICHNER = Pattern.compile("\\b[A-Z][A-Z0-9_]*\\b");
    private static final Pattern SQL_KOMMENTAR = Pattern.compile("--[^\\n]*");

    /** Eine Anweisung, die eine Messdaten-Tabelle ohne {@code site} trifft. */
    record Treffer(int zeile, String tabelle, String auszug) {}

    private record Anweisung(int zeile, List<String> literale, String code) {}

    private SqlAnweisungen() {
    }

    static List<Treffer> treffer(String quelle) {
        List<Anweisung> anweisungen = zerlege(quelle);
        Map<String, Anweisung> konstanten = new HashMap<>();
        for (Anweisung a : anweisungen) {
            Matcher m = KONSTANTE.matcher(a.code());
            if (m.find()) {
                konstanten.put(m.group(1), a);
            }
        }
        Set<String> benutzt = new TreeSet<>();
        for (Anweisung a : anweisungen) {
            String eigene = deklariert(a);
            Matcher m = BEZEICHNER.matcher(a.code());
            while (m.find()) {
                if (konstanten.containsKey(m.group()) && !m.group().equals(eigene)) {
                    benutzt.add(m.group());
                }
            }
        }
        List<Treffer> aus = new ArrayList<>();
        for (Anweisung a : anweisungen) {
            String eigene = deklariert(a);
            if (eigene != null && benutzt.contains(eigene)) {
                continue;
            }
            List<String> literale = new ArrayList<>();
            sammle(a, konstanten, literale, new LinkedHashSet<>(), 0);
            String sql = SQL_KOMMENTAR.matcher(String.join(" ", literale)).replaceAll(" ");
            Set<String> tabellen = new TreeSet<>();
            Matcher z = ZUGRIFF.matcher(sql);
            while (z.find()) {
                tabellen.add(z.group(1).toLowerCase());
            }
            for (String l : literale) {
                if (TABELLE.matcher(l.trim()).matches()) {
                    tabellen.add(l.trim());
                }
            }
            if (tabellen.isEmpty() || SITE.matcher(sql).find()) {
                continue;
            }
            String auszug = sql.replaceAll("\\s+", " ").trim();
            for (String t : tabellen) {
                aus.add(new Treffer(a.zeile(), t, auszug.length() > 160 ? auszug.substring(0, 160) + "…" : auszug));
            }
        }
        return aus;
    }

    private static String deklariert(Anweisung a) {
        Matcher m = KONSTANTE.matcher(a.code());
        return m.find() ? m.group(1) : null;
    }

    private static void sammle(Anweisung a, Map<String, Anweisung> konstanten, List<String> aus, Set<String> besucht,
            int tiefe) {
        aus.addAll(a.literale());
        if (tiefe > 5) {
            return;
        }
        String eigene = deklariert(a);
        Matcher m = BEZEICHNER.matcher(a.code());
        while (m.find()) {
            String name = m.group();
            if (!name.equals(eigene) && konstanten.containsKey(name) && besucht.add(name)) {
                sammle(konstanten.get(name), konstanten, aus, besucht, tiefe + 1);
            }
        }
    }

    /** Zerlegt den Quelltext in Anweisungen; Kommentare fallen weg, Literale werden entschlüsselt gesammelt. */
    private static List<Anweisung> zerlege(String s) {
        List<Anweisung> aus = new ArrayList<>();
        List<String> literale = new ArrayList<>();
        StringBuilder code = new StringBuilder();
        int zeile = 1;
        int start = -1;
        int n = s.length();
        int i = 0;
        while (i < n) {
            char c = s.charAt(i);
            if (s.startsWith("//", i)) {
                while (i < n && s.charAt(i) != '\n') {
                    i++;
                }
                continue;
            }
            if (s.startsWith("/*", i)) {
                int ende = s.indexOf("*/", i + 2);
                ende = ende < 0 ? n : ende + 2;
                zeile += zeilen(s, i, ende);
                i = ende;
                continue;
            }
            if (s.startsWith("\"\"\"", i)) {
                if (start < 0) {
                    start = zeile;
                }
                StringBuilder inhalt = new StringBuilder();
                int j = i + 3;
                while (j < n && !s.startsWith("\"\"\"", j)) {
                    if (s.charAt(j) == '\\' && j + 1 < n) {
                        inhalt.append(s.charAt(j + 1));
                        j += 2;
                        continue;
                    }
                    inhalt.append(s.charAt(j));
                    j++;
                }
                int ende = Math.min(n, j + 3);
                zeile += zeilen(s, i, ende);
                literale.add(inhalt.toString());
                i = ende;
                continue;
            }
            if (c == '"') {
                if (start < 0) {
                    start = zeile;
                }
                StringBuilder inhalt = new StringBuilder();
                int j = i + 1;
                while (j < n && s.charAt(j) != '"' && s.charAt(j) != '\n') {
                    if (s.charAt(j) == '\\' && j + 1 < n) {
                        char e = s.charAt(j + 1);
                        inhalt.append(e == 'n' ? '\n' : e == 't' ? '\t' : e);
                        j += 2;
                        continue;
                    }
                    inhalt.append(s.charAt(j));
                    j++;
                }
                literale.add(inhalt.toString());
                i = Math.min(n, j + 1);
                continue;
            }
            if (c == '\'') {
                int j = i + 1;
                while (j < n && s.charAt(j) != '\'' && s.charAt(j) != '\n') {
                    j += s.charAt(j) == '\\' ? 2 : 1;
                }
                i = Math.min(n, j + 1);
                continue;
            }
            if (c == ';' || c == '{' || c == '}') {
                if (!literale.isEmpty() || !code.toString().isBlank()) {
                    aus.add(new Anweisung(start < 0 ? zeile : start, List.copyOf(literale), code.toString()));
                }
                literale.clear();
                code.setLength(0);
                start = -1;
                i++;
                continue;
            }
            if (c == '\n') {
                zeile++;
            } else if (start < 0 && !Character.isWhitespace(c)) {
                start = zeile;
            }
            code.append(c);
            i++;
        }
        if (!literale.isEmpty() || !code.toString().isBlank()) {
            aus.add(new Anweisung(start < 0 ? zeile : start, List.copyOf(literale), code.toString()));
        }
        return aus;
    }

    private static int zeilen(String s, int von, int bis) {
        int z = 0;
        for (int k = von; k < bis; k++) {
            if (s.charAt(k) == '\n') {
                z++;
            }
        }
        return z;
    }
}
