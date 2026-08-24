package com.voltpilot.api.profile;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.flows.FlowCatalog;
import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.springframework.stereotype.Component;

/**
 * Der EINE Anwendungs-Katalog (Zielbild {@code vp-portal-zielbild-anwendungen}
 * §3.2/§4.1, Stufe 1): lädt {@code anwendungen/catalog.json} einmal beim Start
 * und ist die EINZIGE Wahrheit über Id, Label, Nutzen-Satz, Voraussetzungen
 * samt ihrer Sperr-Sätze, beigesteuerte Bausteine, Einstellungen, Starter und
 * Preset-Zugehörigkeit (das {@code EntityTypeCatalog}/{@code FlowCatalog}-Muster).
 *
 * <p>Vor dieser Stufe lag derselbe Katalog an ACHT Stellen in zwei Sprachen
 * (Scout §2.2): die Java-Liste dieser Klasse, {@code SiteProfileService}s
 * hand-codierte {@code requirements}/{@code unlocks}/{@code blockedReason},
 * dazu im Portal {@code surface.ts MODE_LABELS}, {@code profiles.ts COPY},
 * {@code modeSettings.ts SETTING_DEFS.claimedBy}. Die Portal-Kopie
 * {@code frontend/portal/src/anwendungen/catalog.json} ist BYTE-GLEICH gepinnt
 * ({@code anwendungen.sync.test.ts}) — <b>beide zusammen ändern</b>.
 *
 * <p><b>Was hier NICHT lebt:</b> die Aktivierungs-Logik. Sie bleibt Code
 * ({@link AnwendungDerivation}) und wird beidseitig über
 * {@code docs/contracts/v2/anwendung-vectors.json} gepinnt — das
 * {@code usage-profile-vectors.json}-Muster.
 *
 * <p><b>Die gated Knotentypen einer Anwendung bleiben ABGELEITET</b>
 * ({@link #gatedNodeTypes}), nie eine Hand-Liste: eine Anwendung öffnet genau
 * den Knotentyp, aus dem IHRE Strategie besteht, und auch den nur, wenn der
 * Flow-Katalog ihn wirklich {@code gated} nennt. Ein pauschales „schalte jeden
 * gated Knoten dieser Anlage frei" gäbe einem Kunden die atypische Netznutzung
 * (deren Ökonomie nicht gebaut ist) als Nebenwirkung der Marktoptimierung.
 */
@Component
public class AnwendungKatalog {

    public static final String MONITORING = "monitoring";
    public static final String SPEICHER_FAHRPLAN = "speicher-fahrplan";
    public static final String UEBERSCHUSS = "ueberschuss";
    public static final String VERBRAUCHER = "verbraucher";
    public static final String MARKTVERMARKTUNG = "marktvermarktung";
    public static final String LASTSPITZENKAPPUNG = "lastspitzenkappung";
    public static final String ATYPISCHE_NETZNUTZUNG = "atypische-netznutzung";
    public static final String LASTMANAGEMENT = "lastmanagement";
    public static final String EIGENE_AUSWERTUNG = "eigene-auswertung";
    public static final String BERICHTE = "berichte";

    /** Nicht abschaltbar — läuft, sobald die Fähigkeit da ist. */
    public static final String KLASSE_BASIS = "basis";
    /** Schalter = reine ABSICHT: kein Gate, kein Starter. */
    public static final String KLASSE_REGEL = "regel";
    /** Schalter öffnet die eigenen gated Knoten und sät den eigenen Starter. */
    public static final String KLASSE_GESCHAEFT = "geschaeft";
    /** Erweiterungspunkt: nicht sichtbar, nicht schaltbar. */
    public static final String KLASSE_RESERVIERT = "reserviert";

    /** Eine Voraussetzung: der Chip, plus der Satz für genau ihr Fehlen. */
    public record Voraussetzung(String id, String label, String blockedReason) {}

    /** Was eine Anwendung zur Oberfläche beiträgt. */
    public record Bausteine(List<String> cockpit, List<String> ansichten, String geldstrom,
            boolean steuerungskarte, boolean navGruppe) {}

    /** Die Vorauswahl je Profil (Stufe 2 liest sie; Stufe 1 trägt sie nur). */
    public record Preset(String privat, String gewerbe) {}

    /**
     * Ein Katalog-Eintrag.
     *
     * @param id                  die Anwendungs-Id (zugleich die M0-{@code ModeKind}
     *                            der vier Geschäfts-Anwendungen und der Schlüssel
     *                            in {@code site_profile_state.profile})
     * @param label               der kundenseitige deutsche Name
     * @param kategorie           basis | steuerung | geschaeft | auswertung
     * @param klasse              basis | regel | geschaeft | reserviert
     * @param rang                die kanonische Regal-Reihenfolge
     * @param nutzen              EIN Satz: was die Anwendung für den Kunden tut
     * @param abschaltbar         false = Basis-Anwendung (ruhige Zeile „immer an")
     * @param sichtbar            false = reserviert, erscheint nicht im Regal
     * @param strategieKnoten     der {@code vp.strategy.*}-Knoten, oder null
     * @param starter             der AE7-Starter-Schlüssel, oder null
     * @param voraussetzungen     die ✓/fehlt-Chips samt ihren Sperr-Sätzen
     * @param blockedReasonImmer  ein Satz, der IMMER gilt (Ökonomie nicht gebaut)
     * @param leerZustand         der ehrliche Leer-Satz einer Regel-Anwendung
     * @param bausteine           was sie zur Oberfläche beiträgt
     * @param unlockChips         die Kundenworte für „Schaltet frei"
     * @param einstellungen       die beanspruchten Einstellungs-Ids
     * @param einstellungenVerweis wo diese Einstellungen wohnen, oder null
     * @param preset              die Vorauswahl je Profil
     */
    public record Anwendung(String id, String label, String kategorie, String klasse, int rang,
            String nutzen, boolean abschaltbar, boolean sichtbar, String strategieKnoten,
            String starter, List<Voraussetzung> voraussetzungen, String blockedReasonImmer,
            String leerZustand, Bausteine bausteine, List<String> unlockChips,
            List<String> einstellungen, String einstellungenVerweis, Preset preset) {

        /** Diese Anwendung ist immer an und hat keinen Schalter. */
        public boolean istBasis() {
            return KLASSE_BASIS.equals(klasse);
        }

        /** Ihr Schalter speichert nur Absicht — kein Gate, kein Starter. */
        public boolean istRegel() {
            return KLASSE_REGEL.equals(klasse);
        }
    }

    private final JsonNode raw;
    private final Map<String, Anwendung> byId = new LinkedHashMap<>();
    private final List<Anwendung> sichtbare = new ArrayList<>();

    public AnwendungKatalog(ObjectMapper mapper) {
        try (InputStream in = getClass().getResourceAsStream("/anwendungen/catalog.json")) {
            if (in == null) {
                throw new IllegalStateException("anwendungen/catalog.json missing from classpath");
            }
            this.raw = mapper.readTree(in);
        } catch (IOException e) {
            throw new IllegalStateException("anwendungen/catalog.json unreadable", e);
        }
        List<Anwendung> all = new ArrayList<>();
        for (JsonNode a : raw.path("anwendungen")) {
            all.add(parse(a));
        }
        if (all.isEmpty()) {
            throw new IllegalStateException("anwendungen/catalog.json declares no anwendungen");
        }
        all.sort(Comparator.comparingInt(Anwendung::rang).thenComparing(Anwendung::id));
        for (Anwendung a : all) {
            if (byId.put(a.id(), a) != null) {
                throw new IllegalStateException("duplicate anwendung id: " + a.id());
            }
            if (a.sichtbar()) {
                sichtbare.add(a);
            }
        }
    }

    private static Anwendung parse(JsonNode a) {
        List<Voraussetzung> voraussetzungen = new ArrayList<>();
        for (JsonNode v : a.path("voraussetzungen")) {
            voraussetzungen.add(new Voraussetzung(v.path("id").asText(), v.path("label").asText(),
                    text(v, "blocked_reason")));
        }
        JsonNode b = a.path("bausteine");
        Bausteine bausteine = new Bausteine(strings(b.path("cockpit")),
                strings(b.path("ansichten")), text(b, "geldstrom"),
                b.path("steuerungskarte").asBoolean(false), b.path("nav_gruppe").asBoolean(false));
        JsonNode p = a.path("preset");
        return new Anwendung(a.path("id").asText(), a.path("label").asText(),
                a.path("kategorie").asText(), a.path("klasse").asText(), a.path("rang").asInt(),
                a.path("nutzen").asText(), a.path("abschaltbar").asBoolean(false),
                a.path("sichtbar").asBoolean(false), text(a, "strategie_knoten"),
                text(a, "starter"), List.copyOf(voraussetzungen), text(a, "blocked_reason_immer"),
                text(a, "leer_zustand"), bausteine, strings(a.path("unlock_chips")),
                strings(a.path("einstellungen")), text(a, "einstellungen_verweis"),
                new Preset(text(p, "privat"), text(p, "gewerbe")));
    }

    private static String text(JsonNode node, String field) {
        return node.hasNonNull(field) ? node.get(field).asText() : null;
    }

    private static List<String> strings(JsonNode array) {
        List<String> out = new ArrayList<>();
        for (JsonNode n : array) {
            out.add(n.asText());
        }
        return List.copyOf(out);
    }

    /** Das rohe Dokument (für Drift-Tests und einen späteren Auslieferpfad). */
    public JsonNode document() {
        return raw;
    }

    /** Alle Einträge, kanonisch nach Rang sortiert — auch die reservierten. */
    public List<Anwendung> alle() {
        return List.copyOf(byId.values());
    }

    /**
     * Das REGAL: die sichtbaren Anwendungen in kanonischer Reihenfolge. Eine
     * reservierte Anwendung steht bewusst NICHT darin — ein Schalter, der
     * nichts bewirken kann, wäre eine Zusage, die niemand einlöst.
     */
    public List<Anwendung> regal() {
        return List.copyOf(sichtbare);
    }

    /** Die Anwendung mit dieser Id, oder null. */
    public Anwendung find(String id) {
        return id == null ? null : byId.get(id);
    }

    /**
     * Die gated Knotentypen, die diese Anwendung öffnet — katalog-abgeleitet:
     * ihr eigener Strategie-Knoten, behalten nur, wenn der Flow-Katalog ihn
     * {@code gated} nennt. Eine Anwendung ohne Strategie-Knoten öffnet nichts.
     */
    public static Set<String> gatedNodeTypes(Anwendung anwendung, FlowCatalog catalog) {
        Set<String> types = new LinkedHashSet<>();
        if (anwendung != null && anwendung.strategieKnoten() != null
                && catalog.isGated(anwendung.strategieKnoten())) {
            types.add(anwendung.strategieKnoten());
        }
        return types;
    }
}
