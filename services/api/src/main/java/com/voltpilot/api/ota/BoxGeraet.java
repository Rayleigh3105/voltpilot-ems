package com.voltpilot.api.ota;

import com.fasterxml.jackson.databind.JsonNode;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * Was eine Box über ihr GERÄT meldet ({@code update.geraet}, Geräte &amp; Updates
 * G8, Vertrag {@code docs/contracts/v2/box-geraet.md}) - die Annahme der Cloud,
 * rein und an denselben Vektoren geprüft wie die Erkennung der Box
 * ({@code box-geraet-vectors.json}, Teil {@code herzschlag}).
 *
 * <ul>
 *   <li>{@code modell}: Leerraum zusammengefasst, hart auf {@value #MAX_MODELL}
 *       Zeichen gekürzt; leer = keine Angabe.</li>
 *   <li>{@code arch}: {@code [a-z0-9_]{1,16}} (runtime.GOARCH), sonst verworfen.</li>
 *   <li>{@code loader}: nur Edge Light, geschlossenes Vokabular
 *       {@value #LOADER_UPDATE} (Stufe 2) | {@value #LOADER_FLASH} (Stufe 1);
 *       ein anderes Wort wird verworfen, nie geraten.</li>
 *   <li>{@code loader_stand}: nur Edge Light, die {@code LOADER_STAND}-Marke
 *       des Loaders im Flash (Loader-Selbstupdate) - eine ganze Zahl von 1 bis
 *       {@value #MAX_LOADER_STAND}, alles andere wird verworfen, nie geraten.</li>
 * </ul>
 */
public final class BoxGeraet {

    /** Der Loader kennt das Update-Protokoll (Stufe 2). */
    public static final String LOADER_UPDATE = "update";
    /** Der Loader startet immer die Fassung aus dem Flash (Stufe 1). */
    public static final String LOADER_FLASH = "flash";

    static final int MAX_MODELL = 80;
    static final int MAX_LOADER_STAND = 1_000_000;
    private static final Set<String> LOADER = Set.of(LOADER_UPDATE, LOADER_FLASH);
    private static final Pattern ARCH = Pattern.compile("^[a-z0-9_]{1,16}$");

    private BoxGeraet() {
    }

    /** Die angenommene Angabe; jedes Feld darf {@code null} sein. */
    public record Angabe(String modell, String arch, String loader, Integer loaderStand) {
    }

    /**
     * Liest {@code update.geraet}; {@code null}, wenn der Block fehlt (eine
     * ältere Box) - dann bleibt die zuletzt gemeldete Angabe stehen.
     */
    public static Angabe of(JsonNode geraet) {
        if (geraet == null || !geraet.isObject()) {
            return null;
        }
        return new Angabe(modell(text(geraet.get("modell"))), arch(text(geraet.get("arch"))),
                loader(text(geraet.get("loader"))), loaderStand(geraet.get("loader_stand")));
    }

    static String modell(String roh) {
        if (roh == null) {
            return null;
        }
        String s = roh.replace('\u0000', ' ').trim().replaceAll("\\s+", " ");
        if (s.isEmpty()) {
            return null;
        }
        if (s.codePointCount(0, s.length()) > MAX_MODELL) {
            s = s.substring(0, s.offsetByCodePoints(0, MAX_MODELL)).trim();
        }
        return s;
    }

    static String arch(String roh) {
        return roh != null && ARCH.matcher(roh.trim()).matches() ? roh.trim() : null;
    }

    static String loader(String roh) {
        return roh != null && LOADER.contains(roh.trim()) ? roh.trim() : null;
    }

    static Integer loaderStand(JsonNode n) {
        if (n == null || !n.isIntegralNumber()) {
            return null;
        }
        long v = n.asLong();
        return v >= 1 && v <= MAX_LOADER_STAND ? (int) v : null;
    }

    private static String text(JsonNode n) {
        return n == null || n.isNull() || !n.isTextual() ? null : n.asText();
    }
}
