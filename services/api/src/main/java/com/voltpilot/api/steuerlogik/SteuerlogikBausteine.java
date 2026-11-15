package com.voltpilot.api.steuerlogik;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.repo.SteuerlogikBausteinRepository;
import com.voltpilot.api.repo.SteuerlogikBausteinRepository.Baustein;
import com.voltpilot.api.uems.RechteAbleitung.Konto;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Clock;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.core.io.Resource;
import org.springframework.core.io.support.PathMatchingResourcePatternResolver;
import org.springframework.stereotype.Service;

/**
 * Bausteine (Steuerlogik Stufe 5, Bericht 6.7, E4 = A): eine Logik mit Lücken und einem Satz. Unter „Neue Regel“
 * wählt man einen Satz, füllt die Lücken mit Geräten und Werten der Anlage, sieht „So verhält sie sich“ und
 * speichert eine gewöhnliche Logik (Fassung 1, geprüft; mitlaufen und vorlegen wie in Stufe 4).
 *
 * <p>Die Sammlung: die Bausteine von VoltPilot für den Start stehen im Vertrag
 * ({@code docs/contracts/v2/steuerlogik/bausteine/}, ins Jar gelegt) und haben den Dateinamen als Kennung; was
 * jemand aus einer Logik als Baustein speichert, liegt in {@code steuerlogik_baustein} - ein Partner-Konto für seine
 * Kunden, die Plattform für alle. Wer welchen sieht, setzt die Datenbank durch.
 *
 * <p>Ein Rechner (Bericht 6.6): Satz, Lücken, Füllen, Prüfen und Proben rechnet nur der Logik-Dienst.
 */
@Service
public class SteuerlogikBausteine {

    /** Wo die Bausteine von VoltPilot im Jar liegen (pom.xml legt sie aus dem Vertrag dorthin). */
    static final String VERTRAG = "classpath:steuerlogik/bausteine/*.block.yaml";
    static final int MAX_NAME = 80;
    static final int MAX_SATZ = 300;
    static final int MAX_BESCHREIBUNG = 300;

    /** Ein Baustein von VoltPilot aus dem Vertrag. */
    record AusDemVertrag(String id, String text) {}

    private final SteuerlogikService logiken;
    private final SteuerlogikDienst dienst;
    private final SteuerlogikBausteinRepository gespeichert;
    private final ObjectMapper json;
    private final Clock clock;
    private final List<AusDemVertrag> vertrag;

    @Autowired
    public SteuerlogikBausteine(SteuerlogikService logiken, SteuerlogikDienst dienst,
            SteuerlogikBausteinRepository gespeichert, ObjectMapper json) {
        this(logiken, dienst, gespeichert, json, Clock.systemUTC(), ladeVertrag());
    }

    SteuerlogikBausteine(SteuerlogikService logiken, SteuerlogikDienst dienst,
            SteuerlogikBausteinRepository gespeichert, ObjectMapper json, Clock clock, List<AusDemVertrag> vertrag) {
        this.logiken = logiken;
        this.dienst = dienst;
        this.gespeichert = gespeichert;
        this.json = json;
        this.clock = clock;
        this.vertrag = List.copyOf(vertrag);
    }

    static List<AusDemVertrag> ladeVertrag() {
        try {
            Resource[] dateien = new PathMatchingResourcePatternResolver().getResources(VERTRAG);
            List<AusDemVertrag> out = new ArrayList<>();
            Arrays.stream(dateien).sorted(Comparator.comparing(Resource::getFilename)).forEach(r -> {
                try (var in = r.getInputStream()) {
                    String id = r.getFilename().replace(".block.yaml", "");
                    out.add(new AusDemVertrag(id, new String(in.readAllBytes(), StandardCharsets.UTF_8)));
                } catch (IOException e) {
                    throw new UncheckedIOException(e);
                }
            });
            return out;
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    /** Wer handelt: Kontoart und Subject (für die Sammlung des Fachbetriebs). */
    public record Akteur(Konto konto, String sub, String rolle) {}

    /**
     * Die Bausteine, die diese Anfrage sieht, je mit Satz und Lücken für diese Anlage: VoltPilot aus dem Vertrag, dann
     * die gespeicherten. {@code eigen} trägt der Baustein, den dieses Konto gespeichert hat (nur der darf ihn
     * entfernen). Ein gespeicherter Baustein, den der Dienst nicht mehr liest, steht nur bei seinem Urheber.
     */
    public List<ObjectNode> liste(UUID siteId, Akteur wer) {
        pruefeAnlage(siteId);
        List<SteuerlogikDienst.BausteinText> texte = new ArrayList<>();
        Map<String, ObjectNode> herkunft = new LinkedHashMap<>();
        for (AusDemVertrag v : vertrag) {
            texte.add(new SteuerlogikDienst.BausteinText(v.id(), v.text()));
            ObjectNode h = json.createObjectNode().put("herkunft", SteuerlogikBausteinRepository.HERKUNFT_VOLTPILOT)
                    .put("eigen", false);
            h.putNull("von");
            herkunft.put(v.id(), h);
        }
        for (Baustein b : gespeichert.sichtbare()) {
            String id = b.id().toString();
            texte.add(new SteuerlogikDienst.BausteinText(id, b.text()));
            ObjectNode h = json.createObjectNode().put("herkunft", b.herkunft()).put("eigen", eigen(b, wer));
            if (SteuerlogikBausteinRepository.HERKUNFT_FACHBETRIEB.equals(b.herkunft())) {
                h.put("von", b.angelegtName() == null ? "Ihr Fachbetrieb" : b.angelegtName());
            } else {
                h.putNull("von");
            }
            herkunft.put(id, h);
        }
        JsonNode koepfe;
        try {
            koepfe = dienst.bausteine(texte, logiken.registryOderNull(siteId));
        } catch (SteuerlogikDienstException e) {
            throw new SteuerlogikService.Abgelehnt(e.grund(), e.getMessage(), null);
        }
        List<ObjectNode> out = new ArrayList<>();
        for (JsonNode k : koepfe) {
            ObjectNode h = herkunft.get(k.path("id").asText());
            if (h == null || !k.isObject()) continue;
            if (!k.path("lesbar").asBoolean() && !h.path("eigen").asBoolean()) continue;
            ObjectNode e = ((ObjectNode) k).deepCopy();
            e.setAll(h);
            out.add(e);
        }
        return out;
    }

    /**
     * Füllt einen Baustein für diese Anlage, ohne etwas zu speichern ("So verhält sie sich"): Lücken mit Vorschlag
     * und Fehlern, die Logik als Text, ihr Prüfbericht und die Proben nach der Uhrzeit.
     */
    public JsonNode vorschau(UUID siteId, String bausteinId, JsonNode fuellung) {
        pruefeAnlage(siteId);
        String text = text(bausteinId);
        try {
            return dienst.baustein(text, fuellung(fuellung), logiken.registryOderNull(siteId));
        } catch (SteuerlogikDienstException e) {
            throw new SteuerlogikService.Abgelehnt(e.grund(), e.getMessage(), null);
        }
    }

    /**
     * Setzt einen Baustein ein: der Dienst füllt ihn erneut (das Portal schickt nur die Füllung, nie den Text), und
     * die Logik wird gespeichert wie jede andere - Fassung 1, geprüft, die Notiz nennt den Baustein. Nur eine
     * vollständige Füllung, die die Prüfung nicht sperrt.
     */
    public SteuerlogikService.Gespeichert einsetzen(UUID siteId, String bausteinId, JsonNode fuellung, String von,
            String rolle) {
        JsonNode e = vorschau(siteId, bausteinId, fuellung);
        if (!e.path("vollstaendig").asBoolean()) {
            throw new SteuerlogikService.Abgelehnt("baustein_unvollstaendig",
                    "Bitte jede Lücke mit einem passenden Gerät oder Wert füllen.", null);
        }
        if (e.path("bericht").path("sperrt").asBoolean()) {
            throw new SteuerlogikService.Abgelehnt("pruefung_sperrt", "Die Prüfung sperrt die Logik.",
                    e.get("bericht"));
        }
        String notiz = abschneiden("Aus dem Baustein „" + e.path("name").asText() + "“", 500);
        return logiken.speichere(siteId, null, e.path("text").asText(), notiz, null, von, rolle);
    }

    /** Ein gespeicherter Baustein: Kennung, Herkunft, Satz und Lücken. */
    public record Neu(UUID id, String herkunft, String name, JsonNode satz, JsonNode luecken) {}

    /**
     * Speichert eine Fassung einer Logik dieser Anlage als Baustein (E4 = A): ein Partner-Konto für seine Kunden,
     * die Plattform für alle. Geräte und Fühler werden Lücken, ihre Kennungen bleiben in der Anlage (der Dienst ersetzt
     * sie durch Platzhalter); der Satz nennt die Lücken mit {@code {name}}.
     */
    public Neu speichere(UUID siteId, UUID logikId, int fassung, String name, String satz, String beschreibung,
            Akteur wer) {
        pruefeAnlage(siteId);
        String herkunft = switch (wer.konto() == null ? Konto.BENUTZER : wer.konto()) {
            case PARTNER -> SteuerlogikBausteinRepository.HERKUNFT_FACHBETRIEB;
            case PLATTFORM -> SteuerlogikBausteinRepository.HERKUNFT_VOLTPILOT;
            case BENUTZER -> throw new SteuerlogikService.Abgelehnt("recht_fehlt",
                    "Bausteine speichert der Fachbetrieb für seine Kunden oder VoltPilot für alle.", null);
        };
        String n = pflicht(name, MAX_NAME, "name_fehlt", "Der Baustein braucht einen Namen");
        String s = pflicht(satz, MAX_SATZ, "satz_fehlt", "Der Baustein braucht einen Satz");
        String b = beschreibung == null || beschreibung.isBlank() ? null
                : pflicht(beschreibung, MAX_BESCHREIBUNG, "beschreibung_zu_lang", "Die Beschreibung");
        String logikText = logiken.text(siteId, logikId, fassung).text();
        JsonNode antwort;
        try {
            antwort = dienst.ausLogik(logikText, n, b, s);
        } catch (SteuerlogikDienstException e) {
            throw new SteuerlogikService.Abgelehnt(e.grund(), e.getMessage(), null);
        }
        String text = antwort.path("baustein").asText();
        UUID id = UUID.randomUUID();
        String partner = SteuerlogikBausteinRepository.HERKUNFT_FACHBETRIEB.equals(herkunft) ? wer.sub() : null;
        String angelegtName = partner == null ? "VoltPilot" : gespeichert.anzeigename(wer.sub());
        gespeichert.lege(new Baustein(id, herkunft, partner, n, text, hash(text), clock.instant(), wer.sub(),
                angelegtName));
        return new Neu(id, herkunft, n, antwort.get("satz"), antwort.get("luecken"));
    }

    /**
     * Entfernt einen gespeicherten Baustein aus der Sammlung: den eines Fachbetriebs nur sein Konto, einen von VoltPilot
     * nur die Plattform. Die Bausteine des Vertrags bleiben (sie ändern sich nur mit dem Vertrag). Logiken, die aus dem
     * Baustein entstanden sind, bleiben, wie sie sind.
     */
    public void entferne(UUID siteId, String bausteinId, Akteur wer) {
        pruefeAnlage(siteId);
        if (vertrag.stream().anyMatch(v -> v.id().equals(bausteinId))) {
            throw new SteuerlogikService.Abgelehnt("aus_dem_vertrag",
                    "Die Bausteine von VoltPilot für den Start ändern sich nur mit dem Vertrag.", null);
        }
        Baustein b = gespeichert.finde(uuid(bausteinId));
        if (b == null) throw unbekannt();
        boolean darf = SteuerlogikBausteinRepository.HERKUNFT_FACHBETRIEB.equals(b.herkunft())
                ? eigen(b, wer) : wer.konto() == Konto.PLATTFORM;
        if (!darf) {
            throw new SteuerlogikService.Abgelehnt("recht_fehlt",
                    "Einen Baustein entfernt nur, wer ihn gespeichert hat, oder VoltPilot.", null);
        }
        gespeichert.entferne(b.id(), wer.sub(), clock.instant());
    }

    // --- Hilfen ------------------------------------------------------------------------------------------------

    private String text(String bausteinId) {
        for (AusDemVertrag v : vertrag) {
            if (v.id().equals(bausteinId)) return v.text();
        }
        Baustein b = gespeichert.finde(uuid(bausteinId));
        if (b == null) throw unbekannt();
        return b.text();
    }

    private static boolean eigen(Baustein b, Akteur wer) {
        return wer.konto() == Konto.PARTNER && b.partnerSub() != null && b.partnerSub().equals(wer.sub());
    }

    private void pruefeAnlage(UUID siteId) {
        logiken.pruefeAnlage(siteId);
    }

    private ObjectNode fuellung(JsonNode f) {
        ObjectNode out = json.createObjectNode();
        if (f == null || !f.isObject()) return out;
        if (f.path("name").isTextual() && !f.path("name").asText().isBlank()) {
            out.put("name", pflicht(f.path("name").asText(), MAX_NAME, "name_fehlt", "Der Name der Logik"));
        }
        if (f.path("werte").isObject()) out.set("werte", f.get("werte"));
        return out;
    }

    private static String pflicht(String wert, int max, String grund, String was) {
        String s = wert == null ? "" : wert.strip();
        if (s.isEmpty() || s.length() > max) {
            throw new SteuerlogikService.Abgelehnt(grund, was + ": 1 bis " + max + " Zeichen.", null);
        }
        return s;
    }

    private static String abschneiden(String s, int max) {
        return s.length() <= max ? s : s.substring(0, max);
    }

    private static UUID uuid(String id) {
        try {
            return UUID.fromString(id);
        } catch (IllegalArgumentException e) {
            throw unbekannt();
        }
    }

    private static SteuerlogikService.Abgelehnt unbekannt() {
        return new SteuerlogikService.Abgelehnt("baustein_unbekannt", "Diesen Baustein gibt es nicht.", null);
    }

    static String hash(String text) {
        try {
            byte[] h = MessageDigest.getInstance("SHA-256").digest(text.getBytes(StandardCharsets.UTF_8));
            return "sha256:" + HexFormat.of().formatHex(h);
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }
}
