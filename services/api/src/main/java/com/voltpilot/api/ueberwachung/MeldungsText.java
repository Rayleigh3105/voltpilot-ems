package com.voltpilot.api.ueberwachung;

import com.fasterxml.jackson.databind.JsonNode;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.time.ZonedDateTime;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Der Text einer Meldung (Kunden-Alarmierung P1, Konzept vp-kunden-alarmierung-konzept §6.4): Titel als
 * Aussage mit Ort, ein Satz zur Lage, einer zur Ursache, einer „was tun“; Entwarnung mit Uhrzeit und Dauer.
 *
 * <p>Die Vorlagen stehen im Werte-Katalog ({@code meldung_allgemein}, je Eintrag {@code meldung} und
 * {@code zustandsworte}); Mail, Push, Team-Kanal und Telegram rendern hier, das Portal mit dem Zwilling
 * {@code frontend/portal/src/meldungsText.ts}. Beide prüft {@code docs/contracts/v2/meldungs-text-vectors.json}.
 * Keine internen Schlüssel, keine Rohwerte, keine ISO-Zeiten: Zeiten in deutscher Ortszeit, Zahlen mit Einheit.
 *
 * <p>Rein (kein Spring, keine Datenbank): die {@link Eingabe} bringt alles mit, was der Text braucht.
 */
public final class MeldungsText {

    static final ZoneId ZONE = ZoneId.of("Europe/Berlin");
    private static final Pattern PLATZHALTER = Pattern.compile("\\{([A-Za-z_]+)}");
    private static final String MINUS = "−";

    /** Der Wert beim Auslösen: Zahl mit Einheit ODER Zustand, dazu optional der Satz des Lesers. */
    public record Wert(Double zahl, String einheit, String zustand, String satz) {
        public static final Wert UNBEKANNT = new Wert(null, null, null, null);
    }

    /**
     * Alles, was der Text braucht. {@code ort} ist der Name des Bezugs (Anlage, Messstelle, …) oder {@code null};
     * {@code beginn} = seit wann die Bedingung gilt, {@code ende} = seit wann sie nicht mehr gilt (nur Entwarnung).
     */
    public record Eingabe(String wertart, String herkunft, String regelName, String schwere, String bezugArt,
            String ort, JsonNode bedingung, Wert wert, Instant beginn, Instant ende) {}

    /** Eine fertige Nachricht: Titel und Sätze für Portal und Mail, Betreff, Push-Titel und Push-Text. */
    public record Nachricht(String titel, List<String> saetze, String betreff, String pushTitel, String pushText) {}

    private final JsonNode allgemein;
    private final Map<String, JsonNode> eintraege = new HashMap<>();

    /** @param katalog die Wurzel von {@code wertekatalog/katalog.json} */
    public MeldungsText(JsonNode katalog) {
        this.allgemein = katalog.path("meldung_allgemein");
        if (allgemein.isMissingNode()) {
            throw new IllegalStateException("Werte-Katalog ohne meldung_allgemein");
        }
        for (JsonNode e : katalog.path("eintraege")) {
            eintraege.put(e.path("wertart").asText(), e);
        }
    }

    // ------------------------------------------------------------------------------------------- Nachrichten

    public Nachricht ausgeloest(Eingabe e, Instant jetzt) {
        Map<String, String> w = werte(e, jetzt);
        JsonNode art = feste(e);
        String titelKern;
        List<String> saetze = new ArrayList<>();
        String push;
        if (art != null) {
            titelKern = vorlage(art.path("titel"), w);
            hinzu(saetze, vorlage(art.path("lage"), w));
            hinzu(saetze, vorlage(art.path("ursache"), w));
            hinzu(saetze, vorlage(art.path("was_tun"), w));
            push = vorlage(art.path("push"), w);
        } else {
            JsonNode eigene = allgemein.path("eigene");
            String schluessel = eigeneSchluessel(e);
            titelKern = vorlage(eigene.path("titel").path(schluessel), w);
            if (titelKern == null) {
                titelKern = w.get("wertname");
            }
            hinzu(saetze, vorlage(eigene.path("lage").path(schluessel), w));
            hinzu(saetze, vorlage(eigene.path("ursache"), w));
            hinzu(saetze, vorlage(eigene.path("was_tun"), w));
            push = vorlage(eigene.path("push"), w);
        }
        w.put("titel", titelKern);
        String titel = vorlage(allgemein.path("titel"), w);
        boolean dringend = "dringend".equals(e.schwere());
        String pushTitel = (dringend ? allgemein.path("dringend_push").asText() : "")
                + vorlage(allgemein.path("push_titel"), w);
        String zusatz = allgemein.path("push_zusatz").asText();
        String pushText = push == null ? zusatz : push + " " + zusatz;
        String betreff = (dringend ? allgemein.path("dringend_betreff").asText() : "") + titel;
        return new Nachricht(titel, List.copyOf(saetze), betreff, pushTitel, pushText);
    }

    /** Die Entwarnung: braucht {@code ende}; ohne {@code ende} gibt es keine (die Meldung endete anders). */
    public Nachricht entwarnung(Eingabe e, Instant jetzt) {
        if (e.ende() == null) {
            return null;
        }
        Map<String, String> w = werte(e, jetzt);
        JsonNode art = feste(e);
        JsonNode quelle = art != null ? art : allgemein.path("eigene");
        String titelKern = vorlage(quelle.path("entwarnung_titel"), w);
        List<String> saetze = new ArrayList<>();
        String lage = vorlage(quelle.path("entwarnung"), w);
        hinzu(saetze, lage);
        hinzu(saetze, vorlage(quelle.path("entwarnung_dauer"), w));
        w.put("titel", titelKern);
        String titel = vorlage(allgemein.path("titel"), w);
        String pushTitel = vorlage(allgemein.path("push_titel"), w);
        return new Nachricht(titel, List.copyOf(saetze), titel, pushTitel, lage == null ? "" : lage);
    }

    /** Die Erinnerung an eine dringende, noch nicht gesehene Meldung (§6.5: nach 1 Std., dann alle 4 Std.). */
    public Nachricht erinnerung(Eingabe e, Instant jetzt) {
        Nachricht basis = ausgeloest(e, jetzt);
        Map<String, String> w = werte(e, jetzt);
        w.put("titel", basis.titel());
        String titel = vorlage(allgemein.path("erinnerung_titel"), w);
        String satz = vorlage(allgemein.path("erinnerung"), w);
        List<String> saetze = new ArrayList<>();
        hinzu(saetze, satz);
        saetze.addAll(basis.saetze());
        boolean dringend = "dringend".equals(e.schwere());
        String betreff = (dringend ? allgemein.path("dringend_betreff").asText() : "") + titel;
        return new Nachricht(titel, List.copyOf(saetze), betreff, titel, satz == null ? "" : satz);
    }

    /**
     * Der Text einer Mail (auch Team-Kanal und Telegram): die Sätze, ein Link zur Meldung, ein Link
     * „Leiser stellen oder abmelden“ und das Kennzeichen der Meldung.
     */
    public String mailText(Nachricht n, String kennzeichen, String basisUrl) {
        String basis = basisUrl == null ? "" : basisUrl.replaceAll("/+$", "");
        Map<String, String> w = new HashMap<>();
        StringBuilder text = new StringBuilder(String.join("\n", n.saetze()));
        text.append("\n\n");
        w.put("link", basis + "/#/meldungen?meldung=" + kennzeichen);
        text.append(vorlage(allgemein.path("link_meldung"), w)).append('\n');
        w.put("link", basis + "/#/einstellungen");
        text.append(vorlage(allgemein.path("link_einstellen"), w)).append("\n\n");
        w.put("kennzeichen", kennzeichen);
        text.append(vorlage(allgemein.path("kennzeichen"), w)).append('\n');
        return text.toString();
    }

    /** Ein Titel ohne Sätze, für Listen (Tages-Zusammenfassung). */
    public String titel(Eingabe e, Instant jetzt) {
        return ausgeloest(e, jetzt).titel();
    }

    /**
     * Seit wann die Bedingung gilt: Auslösezeit minus Wartezeit der Regel ({@code dauer_s}). Server und Portal rechnen
     * so, damit Mail und Portal dieselbe Uhrzeit nennen (bis auf einen Takt des Läufers genau).
     */
    public static Instant beginn(Instant ausgeloestAm, JsonNode bedingung) {
        long dauerS = bedingung == null ? 0 : bedingung.path("dauer_s").asLong(0);
        return ausgeloestAm.minusSeconds(Math.max(0, dauerS));
    }

    /** Seit wann die Bedingung nicht mehr gilt: „wieder normal“ minus Erholdauer ({@code erholen_s}, Vorgabe 300). */
    public static Instant ende(Instant wiederNormalAm, JsonNode bedingung) {
        long erholenS = bedingung == null ? 300 : bedingung.path("erholen_s").asLong(300);
        return wiederNormalAm.minusSeconds(Math.max(0, erholenS));
    }

    // ---------------------------------------------------------------------------------------- Auswahl, Werte

    /** Die feste Meldungsart des Eintrags, wenn sie für diese Meldung gilt (Zustand oder Herkunft), sonst null. */
    private JsonNode feste(Eingabe e) {
        JsonNode eintrag = eintraege.get(e.wertart());
        JsonNode art = eintrag == null ? null : eintrag.get("meldung");
        if (art == null) {
            return null;
        }
        JsonNode gilt = art.path("gilt_bei");
        String zustand = e.wert() == null ? null : e.wert().zustand();
        if (zustand != null) {
            for (JsonNode z : gilt.path("zustaende")) {
                if (z.asText().equals(zustand)) {
                    return art;
                }
            }
        }
        if (gilt.has("herkunft") && gilt.path("herkunft").asText().equals(e.herkunft())) {
            return art;
        }
        return null;
    }

    private static String eigeneSchluessel(Eingabe e) {
        JsonNode b = e.bedingung();
        String art = b == null ? "" : b.path("art").asText("");
        return switch (art) {
            case "periode" -> "periode_" + ("unter".equals(b.path("richtung").asText("ueber")) ? "unter" : "ueber");
            case "aenderung" -> "aenderung_" + switch (b.path("richtung").asText("hoeher")) {
                case "niedriger" -> "niedriger";
                case "beide" -> "beide";
                default -> "hoeher";
            };
            default -> art;
        };
    }

    private Map<String, String> werte(Eingabe e, Instant jetzt) {
        Map<String, String> w = new LinkedHashMap<>();
        JsonNode eintrag = eintraege.get(e.wertart());
        String name = eintrag != null ? eintrag.path("name").asText() : "Wert";
        String satzname = eintrag != null ? eintrag.path("satzname").asText() : "der Wert";
        w.put("wertname", name);
        w.put("satzname", satzname);
        w.put("Satzname", gross(satzname));
        String ort = e.ort() != null && !e.ort().isBlank() ? e.ort()
                : allgemein.path("ort_ersatz").path(e.bezugArt() == null ? "anlage" : e.bezugArt())
                        .asText(allgemein.path("ort_ersatz").path("anlage").asText());
        w.put("ort", ort);
        if (e.beginn() != null) {
            w.put("beginn", zeit(e.beginn(), jetzt));
        }
        if (e.ende() != null) {
            w.put("ende", zeit(e.ende(), jetzt));
        }
        if (e.beginn() != null && e.ende() != null) {
            w.put("dauer", dauer(e.ende().getEpochSecond() - e.beginn().getEpochSecond()));
        }
        Wert wert = e.wert() == null ? Wert.UNBEKANNT : e.wert();
        String einheit = wert.einheit();
        if (wert.zahl() != null) {
            w.put("wert", zahl(wert.zahl(), einheit));
        }
        if (wert.satz() != null && !wert.satz().isBlank()) {
            w.put("satz", wert.satz());
        }
        JsonNode worte = eintrag == null ? null : eintrag.get("zustandsworte");
        if (wert.zustand() != null) {
            w.put("zustandswort", zustandswort(worte, wert.zustand()));
        }
        JsonNode b = e.bedingung();
        if (b != null) {
            if (b.hasNonNull("schwelle")) {
                w.put("schwelle", zahl(b.path("schwelle").asDouble(), einheit));
            }
            if (b.hasNonNull("schwelle_unten")) {
                w.put("schwelle_unten", zahl(b.path("schwelle_unten").asDouble(), einheit));
            }
            if (b.hasNonNull("schwelle_oben")) {
                w.put("schwelle_oben", zahl(b.path("schwelle_oben").asDouble(), einheit));
            }
            if (b.hasNonNull("schwelle_prozent")) {
                w.put("prozent", zahl(b.path("schwelle_prozent").asDouble(), "%"));
            }
            if (b.path("ziel").isArray() && !b.path("ziel").isEmpty()) {
                List<String> ziele = new ArrayList<>();
                b.path("ziel").forEach(z -> ziele.add(zustandswort(worte, z.asText())));
                w.put("zielworte", String.join(" oder ", ziele));
            }
            long dauerS = b.path("dauer_s").asLong(0);
            String art = b.path("art").asText("");
            boolean mitWartezeit = dauerS > 0 && List.of("ueber", "unter", "ausserhalb", "keine_daten", "zustand")
                    .contains(art);
            Map<String, String> wz = Map.of("wartezeit", dauer(dauerS));
            w.put("wartezeit", mitWartezeit ? vorlage(allgemein.path("eigene").path("wartezeit"), wz) : "");
        } else {
            w.put("wartezeit", "");
        }
        String regelName = e.regelName();
        if (regelName != null && !regelName.isBlank() && !"ab_werk".equals(e.herkunft()) && !regelName.equals(name)) {
            w.put("name", regelName);
        }
        String bedingung = vorlage(allgemein.path("eigene").path("bedingung").path(eigeneSchluessel(e)), w);
        if (bedingung != null) {
            w.put("bedingung", bedingung);
        }
        return w;
    }

    private String zustandswort(JsonNode worte, String zustand) {
        JsonNode wort = worte == null ? null : worte.get(zustand);
        return wort != null ? wort.asText() : allgemein.path("zustandswort_ersatz").asText();
    }

    // -------------------------------------------------------------------------------------------- Vorlagen

    /**
     * Eine Vorlage (Text oder Liste von Alternativen) mit Werten füllen: es gilt die erste Alternative, deren
     * Platzhalter alle belegt sind; keine passt → {@code null} (der Satz entfällt).
     */
    static String vorlage(JsonNode vorlage, Map<String, String> werte) {
        if (vorlage == null || vorlage.isMissingNode() || vorlage.isNull()) {
            return null;
        }
        if (vorlage.isArray()) {
            for (JsonNode alternative : vorlage) {
                String text = fuellen(alternative.asText(), werte);
                if (text != null) {
                    return text;
                }
            }
            return null;
        }
        return fuellen(vorlage.asText(), werte);
    }

    private static String fuellen(String vorlage, Map<String, String> werte) {
        Matcher m = PLATZHALTER.matcher(vorlage);
        StringBuilder out = new StringBuilder();
        while (m.find()) {
            String wert = werte.get(m.group(1));
            if (wert == null) {
                return null;
            }
            m.appendReplacement(out, Matcher.quoteReplacement(wert));
        }
        m.appendTail(out);
        return out.toString();
    }

    private static void hinzu(List<String> saetze, String satz) {
        if (satz != null && !satz.isBlank()) {
            saetze.add(satz);
        }
    }

    private static String gross(String text) {
        return text == null || text.isEmpty() ? text : Character.toUpperCase(text.charAt(0)) + text.substring(1);
    }

    // ------------------------------------------------------------------------------------------- Formate

    /** Uhrzeit in deutscher Ortszeit: „12:18 Uhr“ (heute), „gestern, 23:50 Uhr“, „12.11., 9:05 Uhr“, mit Jahr wenn anders. */
    static String zeit(Instant t, Instant jetzt) {
        ZonedDateTime z = t.atZone(ZONE);
        LocalDate tag = z.toLocalDate();
        LocalDate heute = jetzt.atZone(ZONE).toLocalDate();
        String uhr = z.getHour() + ":" + zweistellig(z.getMinute()) + " Uhr";
        if (tag.equals(heute)) {
            return uhr;
        }
        if (tag.equals(heute.minusDays(1))) {
            return "gestern, " + uhr;
        }
        String datum = z.getDayOfMonth() + "." + z.getMonthValue() + ".";
        if (tag.getYear() != heute.getYear()) {
            datum += tag.getYear();
        }
        return datum + ", " + uhr;
    }

    /** Eine Dauer in Worten, auf die Minute gerundet: „42 Minuten“, „eine Stunde und 5 Minuten“, „2 Tage“. */
    static String dauer(long sekunden) {
        long minuten = (Math.max(0, sekunden) + 30) / 60;
        if (minuten < 1) {
            return "weniger als eine Minute";
        }
        if (minuten < 60) {
            return minuten(minuten);
        }
        if (minuten < 24 * 60) {
            long h = minuten / 60;
            long rest = minuten % 60;
            return (h == 1 ? "eine Stunde" : h + " Stunden") + (rest > 0 ? " und " + minuten(rest) : "");
        }
        long d = minuten / (24 * 60);
        long h = (minuten % (24 * 60)) / 60;
        return (d == 1 ? "einen Tag" : d + " Tage") + (h > 0 ? " und " + (h == 1 ? "eine Stunde" : h + " Stunden") : "");
    }

    private static String minuten(long m) {
        return m == 1 ? "eine Minute" : m + " Minuten";
    }

    /**
     * Eine Zahl mit Einheit, deutsch (UEMS-Zahlenformat des Portals): Euro zwei Stellen („12,30 €“), Prozent keine
     * („45 %“), kWh ab 100 keine („1.234 kWh“), sonst eine („10,0 kW“, „6,6 ct/kWh“); Tausenderpunkt, echtes Minus,
     * geschütztes Leerzeichen vor der Einheit. Ohne Einheit nur die Zahl.
     */
    static String zahl(double wert, String einheit) {
        boolean euro = "EUR".equals(einheit) || "€".equals(einheit);
        int stellen = euro ? 2 : "%".equals(einheit) ? 0 : "kWh".equals(einheit) && Math.abs(wert) >= 100 ? 0 : 1;
        long faktor = stellen == 2 ? 100 : stellen == 1 ? 10 : 1;
        long n = Math.round(Math.abs(wert) * faktor);
        long ganz = n / faktor;
        long rest = n % faktor;
        StringBuilder text = new StringBuilder();
        if (n != 0 && wert < 0) {
            text.append(MINUS);
        }
        text.append(gruppiert(ganz));
        if (stellen > 0) {
            String r = Long.toString(rest);
            while (r.length() < stellen) {
                r = "0" + r;
            }
            text.append(',').append(r);
        }
        String anzeige = euro ? "€" : einheit;
        if (anzeige != null && !anzeige.isBlank()) {
            text.append('\u00a0').append(anzeige);
        }
        return text.toString();
    }

    private static String gruppiert(long ganz) {
        String s = Long.toString(ganz);
        StringBuilder out = new StringBuilder();
        for (int i = 0; i < s.length(); i++) {
            if (i > 0 && (s.length() - i) % 3 == 0) {
                out.append('.');
            }
            out.append(s.charAt(i));
        }
        return out.toString();
    }

    private static String zweistellig(int n) {
        return n < 10 ? "0" + n : Integer.toString(n);
    }
}
