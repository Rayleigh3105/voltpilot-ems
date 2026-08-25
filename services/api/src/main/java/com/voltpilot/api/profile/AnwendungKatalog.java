package com.voltpilot.api.profile;

import com.fasterxml.jackson.databind.JsonNode;
import com.voltpilot.api.cockpit.EigeneAuswertung.CustomBaustein;
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
 * <p><b>Die PRESETS (Stufe 2)</b> leben ebenfalls hier: {@link Profil} trägt
 * Label, den „wir starten mit …"-Satz und die Tonalität eines Profils, die
 * LISTE seiner Anwendungen wird aus dem {@code preset}-Feld je Anwendung
 * abgeleitet ({@link #vorauswahl}) — nie aus einer zweiten Liste, die davon
 * abdriften könnte. Ein Profil ist Vorauswahl + Tonalität + Reset-Basis und
 * <b>nie ein Signal der Ableitung</b> (Captain-Entscheid E3).
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

    /** Das Preset eines Haushalts. */
    public static final String PROFIL_PRIVAT = "privat";
    /** Das Preset eines Betriebs. */
    public static final String PROFIL_GEWERBE = "gewerbe";

    /** Diese Anwendung gehoert zur Vorauswahl des Profils. */
    public static final String PRESET_AN = "an";

    /** Die Fläche „Anlagen-Cockpit". */
    public static final String FLAECHE_COCKPIT = "cockpit";
    /** Die Fläche „Portfolio-Cockpit" (Stufe 4) — sie hängt am KUNDEN. */
    public static final String FLAECHE_PORTFOLIO = "portfolio";

    /** Eine Voraussetzung: der Chip, plus der Satz für genau ihr Fehlen. */
    public record Voraussetzung(String id, String label, String blockedReason) {}

    /**
     * Was eine Anwendung zur Oberfläche beiträgt.
     *
     * <p>{@code cockpit} nennt {@code CockpitBlockId}s (die Blockschicht des
     * Anlagen-Cockpits), {@code portfolio} dagegen unmittelbar
     * BAUSTEIN-Schlüssel der Kunden-Fläche: dort gibt es keine Blockschicht,
     * ein Portfolio-Baustein IST die Einheit (Stufe 4, §3.5).
     */
    public record Bausteine(List<String> cockpit, List<String> portfolio,
            List<String> ansichten, String geldstrom, boolean steuerungskarte,
            boolean navGruppe) {}

    /**
     * Die Vorauswahl je Profil: {@code an} | {@code angeboten} |
     * {@code verborgen} | {@code abgeleitet}. Sie ist die EINZIGE Quelle
     * dafür, was ein Profil einschaltet — der {@link Profil}-Block daneben
     * trägt nur Label, Satz und Tonalität, nie eine zweite Liste.
     */
    public record Preset(String privat, String gewerbe) {

        /** Der Preset-Wert für dieses Profil; ein unbekanntes Profil hat keinen. */
        public String fuer(String profil) {
            if (PROFIL_PRIVAT.equals(profil)) {
                return privat;
            }
            if (PROFIL_GEWERBE.equals(profil)) {
                return gewerbe;
            }
            return null;
        }
    }

    /**
     * Ein Profil-Preset: was der Kunde im Assistenten wählt.
     *
     * <p>Es trägt bewusst KEINE Liste von Anwendungen — die steht je Anwendung
     * im Feld {@code preset} und wird daraus abgeleitet ({@link #vorauswahl}).
     * Zwei Listen über dieselbe Sache wären zwei Wahrheiten, die abdriften.
     *
     * @param id         {@code privat} | {@code gewerbe}
     * @param label      der kundenseitige Name der Karte
     * @param satz       EIN Satz „wir starten mit …"
     * @param tonalitaet {@code sparen} | {@code verdienen} — die Geld-Sprache
     */
    public record Profil(String id, String label, String satz, String tonalitaet) {}

    /**
     * Ein BAUSTEIN des Cockpits (Stufe 3): ein eigenständig gerendertes
     * Element der Fläche — die Sprache, in der „anordnen" und „ausblenden"
     * überhaupt formulierbar sind.
     *
     * <p>Er wohnt in DERSELBEN Ressource wie die Anwendungen (§3.2 C
     * „abgeleitet aus A, keine zweite Datei"); wer ihn BEISTEUERT, wird über
     * {@link AnwendungKatalog#beigesteuertVon} aus {@code bloecke} × den Cockpit-Bausteinen
     * der Anwendungen abgeleitet, nie ein zweites Mal aufgeschrieben.
     *
     * @param id        der Baustein-Schlüssel (das Vokabular des Dokuments)
     * @param label     der kundenseitige deutsche Name
     * @param flaeche   {@code cockpit} heute; {@code portfolio} ist Stufe 4
     * @param pflicht   true = kann NIE ausgeblendet werden (E2: Katalog-
     *                  Eigenschaft, kein Admin-Wille)
     * @param beweglich false = bleibt an seiner kanonischen Stelle (der
     *                  Status-Kopf, und die BÜHNE samt dem, was am Rechner in
     *                  ihr wohnt — der Lead-Wechsel darf sie nicht zerlegen)
     * @param leadBlock die {@code CockpitBlockId}, die sein Stern als Lead
     *                  setzt; null = kein Stern
     * @param bloecke   die {@code CockpitBlockId}s, die er rendert
     * @param aggregation      NUR auf der Fläche {@code portfolio} gesetzt (sonst
     *                  {@code null}): WIE dieser Baustein über die Anlagen des
     *                  Kunden zusammenfasst — {@code summe} (Energie, Leistung,
     *                  Geld, Stückzahlen), {@code gewichtet} (ein Mittel, das
     *                  ein Gewicht trägt) oder {@code je_anlage} (er fasst gar
     *                  nichts zusammen, sondern zeigt je Anlage eine Zeile).
     *                  <b>Ein Prozent-Mittel OHNE Gewicht gibt es in diesem
     *                  Vokabular nicht</b> — genau das ist die Regel, die
     *                  „Ø Autarkie der Flotte" verhindert.
     * @param aggregationRegel der deutsche Satz, der die Regel AUSSPRICHT (und
     *                  ausdrücklich sagt, was NICHT zusammengefasst wird);
     *                  {@code null} ausserhalb der Portfolio-Fläche
     */
    public record Baustein(String id, String label, String flaeche, boolean pflicht,
            boolean beweglich, String leadBlock, List<String> bloecke, String aggregation,
            String aggregationRegel) {}

    /**
     * Eine BAUSTEIN-VORLAGE (Stufe 5): die ART eines eigenen Cockpit-Bausteins,
     * nicht der Baustein selbst.
     *
     * <p>Sie steht bewusst NEBEN {@link Baustein} und nicht darin: ein
     * {@code Baustein} ist eine feste Fläche mit festem Schlüssel, den die
     * kanonische Reihenfolge kennt — eine Vorlage ist erst RENDERBAR, wenn der
     * Kunde eine Instanz davon anlegt ({@code eigen:<id>} in
     * {@code document.custom}). Sie in dieselbe Liste zu legen hiesse, dass die
     * kanonischen Listen einen Schlüssel führen müssten, den niemand rendert.
     *
     * @param id          die Vorlagen-Id (nie ein Baustein-Schlüssel)
     * @param label       der kundenseitige Name der Wahl
     * @param satz        EIN Satz: was diese Art zeigt
     * @param darstellung {@code kachel} | {@code chart}
     * @param flaeche     die Fläche, auf der ihre Instanzen leben
     * @param anwendung   die Anwendung, die sie beisteuert
     * @param nach        hinter WELCHEM Baustein eine Instanz kanonisch steht
     */
    public record BausteinVorlage(String id, String label, String satz, String darstellung,
            String flaeche, String anwendung, String nach) {}

    /**
     * Ein Layout-Dokument: der gespeicherte WILLE, nie die abgeleitete Fläche.
     *
     * <p>{@code order} nennt Bausteine in ihrer Reihenfolge (ungenannte
     * bleiben an ihrer kanonischen Stelle), {@code hidden}/{@code shown} sind
     * ausdrückliche Aussagen — {@code shown} nimmt einer TIEFEREN Schicht ihr
     * {@code hidden} zurück, weshalb es nicht dasselbe ist wie „steht nicht in
     * hidden". {@code lead} ist eine eigene Achse (die lead-fähigen Blöcke),
     * deshalb ein eigenes Feld und keine Position in {@code order}.
     */
    public record LayoutDoc(List<String> order, List<String> hidden, List<String> shown,
            String lead, List<CustomBaustein> custom) {

        /**
         * Ein Dokument OHNE eigene Auswertungen — die Form jedes Aufrufers vor
         * Stufe 5 (Preset-Schichten, Tests, der Katalog selbst). Sie bleibt
         * bestehen, damit das Hinzufügen von {@code custom} keine einzige
         * bestehende Stelle anfasst.
         */
        public LayoutDoc(List<String> order, List<String> hidden, List<String> shown,
                String lead) {
            this(order, hidden, shown, lead, List.of());
        }

        /** Das leere Dokument — es sagt über nichts etwas aus. */
        public static LayoutDoc leer() {
            return new LayoutDoc(List.of(), List.of(), List.of(), null, List.of());
        }

        /**
         * true = dieses Dokument trifft keine einzige Aussage. ⚠ Eine eigene
         * Auswertung IST eine Aussage, auch ohne jede Reihenfolge — ein
         * Dokument, das nur Kacheln definiert, darf nicht als „keine Schicht"
         * durchfallen, sonst verschwänden sie beim Auflösen.
         */
        public boolean istLeer() {
            return order.isEmpty() && hidden.isEmpty() && shown.isEmpty() && lead == null
                    && custom.isEmpty();
        }
    }

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
     * @param sichtbar            false = reserviert: es GIBT sie noch nicht
     * @param regal               false = sie steht nicht im Regal der Steuerung
     *                            (Basis- und Regel-Anwendungen seit Stufe 0);
     *                            ihr Zustand wird trotzdem beantwortet
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
            String nutzen, boolean abschaltbar, boolean sichtbar, boolean regal,
            String strategieKnoten,
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

        /** Ein BETRIEBSMODELL: das Kundenwort für eine Geschäfts-Anwendung. */
        public boolean istBetriebsmodell() {
            return KLASSE_GESCHAEFT.equals(klasse);
        }

        /** Steht sie im Regal der Steuerung? (sichtbar UND {@code regal}) */
        public boolean imRegal() {
            return sichtbar && regal;
        }
    }

    private final JsonNode raw;
    private final Map<String, Anwendung> byId = new LinkedHashMap<>();
    private final List<Anwendung> sichtbare = new ArrayList<>();
    private final List<Anwendung> imRegal = new ArrayList<>();
    private final List<Anwendung> ausserhalbRegal = new ArrayList<>();
    private final Map<String, Profil> profileById = new LinkedHashMap<>();
    private final Map<String, LayoutDoc> presetLayoutById = new LinkedHashMap<>();
    private final Map<String, Baustein> bausteinById = new LinkedHashMap<>();
    private final List<BausteinVorlage> vorlagen = new ArrayList<>();

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
                (a.imRegal() ? imRegal : ausserhalbRegal).add(a);
            }
        }
        for (JsonNode p : raw.path("presets")) {
            Profil profil = new Profil(p.path("id").asText(), p.path("label").asText(),
                    text(p, "satz"), text(p, "tonalitaet"));
            if (profileById.put(profil.id(), profil) != null) {
                throw new IllegalStateException("duplicate preset id: " + profil.id());
            }
            for (String flaeche : List.of(FLAECHE_COCKPIT, FLAECHE_PORTFOLIO)) {
                presetLayoutById.put(layoutKey(profil.id(), flaeche),
                        parseLayout(p.path("layouts").path(flaeche)));
            }
        }
        for (JsonNode b : raw.path("bausteine")) {
            Baustein baustein = new Baustein(b.path("id").asText(), b.path("label").asText(),
                    b.path("flaeche").asText(), b.path("pflicht").asBoolean(false),
                    b.path("beweglich").asBoolean(false), text(b, "lead_block"),
                    strings(b.path("bloecke")), text(b, "aggregation"),
                    text(b, "aggregation_regel"));
            if (bausteinById.put(baustein.id(), baustein) != null) {
                throw new IllegalStateException("duplicate baustein id: " + baustein.id());
            }
        }
        for (JsonNode v : raw.path("baustein_vorlagen")) {
            vorlagen.add(new BausteinVorlage(v.path("id").asText(), v.path("label").asText(),
                    text(v, "satz"), v.path("darstellung").asText(), v.path("flaeche").asText(),
                    v.path("anwendung").asText(), text(v, "nach")));
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
                strings(b.path("portfolio")), strings(b.path("ansichten")), text(b, "geldstrom"),
                b.path("steuerungskarte").asBoolean(false), b.path("nav_gruppe").asBoolean(false));
        JsonNode p = a.path("preset");
        return new Anwendung(a.path("id").asText(), a.path("label").asText(),
                a.path("kategorie").asText(), a.path("klasse").asText(), a.path("rang").asInt(),
                a.path("nutzen").asText(), a.path("abschaltbar").asBoolean(false),
                a.path("sichtbar").asBoolean(false), a.path("regal").asBoolean(false),
                text(a, "strategie_knoten"),
                text(a, "starter"), List.copyOf(voraussetzungen), text(a, "blocked_reason_immer"),
                text(a, "leer_zustand"), bausteine, strings(a.path("unlock_chips")),
                strings(a.path("einstellungen")), text(a, "einstellungen_verweis"),
                new Preset(text(p, "privat"), text(p, "gewerbe")));
    }

    private static LayoutDoc parseLayout(JsonNode node) {
        if (node == null || node.isMissingNode() || node.isNull()) {
            return LayoutDoc.leer();
        }
        // Eine PRESET-Schicht trägt nie eigene Auswertungen: sie ist die
        // VoltPilot-Vorgabe für ein Profil, und eine Kachel gehört dem Kunden.
        return new LayoutDoc(strings(node.path("order")), strings(node.path("hidden")),
                strings(node.path("shown")), text(node, "lead"));
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
     * Das REGAL der Steuerung: die vier BETRIEBSMODELLE in kanonischer
     * Reihenfolge (Steuerung Stufe 0 „Entwirrung", Scout
     * {@code vp-steuerung-konzept-b3} §5).
     *
     * <p>Bis Stufe 0 war das die Menge der SICHTBAREN Anwendungen, und damit
     * standen drei Sorten in EINER Optik untereinander: Basis-Anwendungen mit
     * einem Schalter, den der Server mit 400 ablehnt, Regel-Anwendungen mit
     * einem Schalter ohne jede Wirkung, und die Geschäfts-Anwendungen. Seither
     * entscheidet das Katalog-Feld {@code regal}, und der Server ist die EINE
     * Stelle, die es tut — das Portal filtert ein zweites Mal über seine
     * byte-gleiche Katalog-Kopie, kann die Menge aber nicht erfinden.
     *
     * <p><b>Es wird nur AUSGEBLENDET, nie gelöscht:</b> die Zustände der
     * anderen Anwendungen bleiben gespeichert und werden weiter beantwortet
     * ({@link #ausserhalbRegal()} → {@code SiteProfilesDto.weitere}), denn
     * Flächen ausserhalb der Steuerung lesen sie (das Cockpit-Tor „ist Eigene
     * Auswertung an?" und das Willens-Overlay der M0-Projektion).
     */
    public List<Anwendung> regal() {
        return List.copyOf(imRegal);
    }

    /**
     * Die sichtbaren Anwendungen, die NICHT im Regal stehen — Basis- und
     * Regel-Anwendungen. Sie existieren unverändert, ihr Schalter ist über
     * {@code PUT /profiles} unverändert erreichbar, und ihr Zustand reist
     * neben dem Regal mit; nur die Steuerungs-Seite zeigt sie nicht mehr.
     */
    public List<Anwendung> ausserhalbRegal() {
        return List.copyOf(ausserhalbRegal);
    }

    /** Alle sichtbaren Anwendungen — Regal UND das, was daneben weiterläuft. */
    public List<Anwendung> sichtbare() {
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

    /** Die Profil-Presets in Katalog-Reihenfolge (Privat, Gewerbe). */
    public List<Profil> presets() {
        return List.copyOf(profileById.values());
    }

    /** Das Preset mit dieser Id, oder null (auch für ein unbekanntes Wort). */
    public Profil profil(String id) {
        return id == null ? null : profileById.get(id);
    }

    /** Ist das ein Profil, das dieser Katalog kennt? */
    public boolean isProfil(String id) {
        return profil(id) != null;
    }

    /**
     * Die VORAUSWAHL eines Profils: die Anwendungen, die sein Preset auf
     * {@code an} setzt — sichtbar und abschaltbar, in kanonischer Reihenfolge.
     *
     * <p>Sie wird aus dem {@code preset}-Feld JE ANWENDUNG abgeleitet, nie aus
     * einer zweiten Liste am Profil. Seit Stufe 0 läuft sie über das REGAL,
     * enthält also nur BETRIEBSMODELLE: eine Basis-Anwendung ist ohnehin an
     * und hat gar keinen Schalter (ein Schaltversuch ist ein 400), und eine
     * Regel-Anwendung vorzuschlagen hieße, eine Absicht zu setzen, die nichts
     * auslöst — Regeln entstehen später in der Steuerung.
     *
     * <p><b>Höchstens EIN Eintrag je Profil</b> (Konzept §3.9): der Assistent
     * schlägt genau ein Betriebsmodell vor. Das ist eine Eigenschaft der
     * DATEN — im Katalog trägt je Profil höchstens ein Betriebsmodell
     * {@code "an"} —, festgenagelt von {@code AnwendungKatalogTest}. Welches
     * bei fehlender Voraussetzung einspringt, entscheidet die Fläche über die
     * {@code angeboten}-Einträge und die Voraussetzungs-Chips derselben
     * Antwort.
     *
     * <p><b>Ob eine vorgeschlagene Anwendung wirklich eingeschaltet wird,
     * entscheidet sie NICHT</b> — das tut die Fläche anhand der
     * Voraussetzungs-Chips derselben Antwort (§4.2 „bei Marktzugang" / „bei
     * Leistungspreis"): eine Vorauswahl, die der Kunde nie angefasst hat und
     * die dann „läuft noch nicht" sagt, wäre eine Zusage, die die Anlage nicht
     * halten kann. Ein Schalter, den der KUNDE selbst kippt, darf das sehr
     * wohl (Owner-Entscheid M3).
     */
    /**
     * Alle Bausteine EINER Fläche in Katalog-Reihenfolge. Die Reihenfolge hier
     * ist die Reihenfolge der Ressource — sie ist NICHT die kanonische
     * Render-Reihenfolge (die ist je Bildschirmbreite verschieden und wohnt im
     * Portal, das rendert).
     */
    public List<Baustein> bausteine(String flaeche) {
        List<Baustein> out = new ArrayList<>();
        for (Baustein b : bausteinById.values()) {
            if (flaeche == null || flaeche.equals(b.flaeche())) {
                out.add(b);
            }
        }
        return List.copyOf(out);
    }

    /** Der Baustein mit dieser Id, oder null (auch für ein unbekanntes Wort). */
    public Baustein baustein(String id) {
        return id == null ? null : bausteinById.get(id);
    }

    /** Alle Baustein-Vorlagen EINER Fläche in Katalog-Reihenfolge (Stufe 5). */
    public List<BausteinVorlage> bausteinVorlagen(String flaeche) {
        List<BausteinVorlage> out = new ArrayList<>();
        for (BausteinVorlage v : vorlagen) {
            if (flaeche == null || flaeche.equals(v.flaeche())) {
                out.add(v);
            }
        }
        return List.copyOf(out);
    }

    /**
     * Die Vorlage zu einer Darstellung ({@code kachel} | {@code chart}), oder
     * null. Sie ist der Weg von einer INSTANZ zurück zu ihrer Art — eine
     * Instanz trägt ihre Darstellung, nicht ihre Vorlagen-Id.
     */
    public BausteinVorlage vorlageFuerDarstellung(String darstellung) {
        for (BausteinVorlage v : vorlagen) {
            if (v.darstellung().equals(darstellung)) {
                return v;
            }
        }
        return null;
    }

    /**
     * Die Anwendungen, die diesen Baustein BEISTEUERN — nie aus einer zweiten
     * Liste, sondern aus dem, was die Anwendungen ohnehin nennen.
     *
     * <p>Die zwei Flächen kommen dabei verschieden dorthin, und das ist kein
     * Schönheitsfehler: ein COCKPIT-Baustein rendert mehrere Blöcke, also läuft
     * die Zuordnung über {@code bloecke} × {@code bausteine.cockpit} (ein
     * Baustein ohne Blöcke — Fahrplan, Steuerung, Preis, Komponenten, Zustand —
     * ist Grundausstattung und hat keine Beisteuerer). Ein PORTFOLIO-Baustein
     * hat keine Blockschicht unter sich, er IST die Einheit — dort steht sein
     * Schlüssel direkt in {@code bausteine.portfolio}.
     */
    public List<String> beigesteuertVon(String bausteinId) {
        Baustein b = baustein(bausteinId);
        if (b == null) {
            return List.of();
        }
        List<String> out = new ArrayList<>();
        if (FLAECHE_PORTFOLIO.equals(b.flaeche())) {
            for (Anwendung a : byId.values()) {
                if (a.bausteine().portfolio().contains(b.id())) {
                    out.add(a.id());
                }
            }
            return List.copyOf(out);
        }
        if (b.bloecke().isEmpty()) {
            return List.of();
        }
        for (Anwendung a : byId.values()) {
            for (String block : a.bausteine().cockpit()) {
                if (b.bloecke().contains(block)) {
                    out.add(a.id());
                    break;
                }
            }
        }
        return List.copyOf(out);
    }

    /**
     * Das Layout-Dokument eines Profil-PRESETS für EINE Fläche — die zweite
     * Schicht der Auflösung (Katalog → Preset → Vorgabe → Eigen). Ohne Profil
     * oder ohne Eintrag ist es das leere Dokument: ein Preset, das nichts sagt,
     * ändert auch nichts.
     *
     * <p><b>Die Fläche ist ein Parameter, kein Detail:</b> das Cockpit-Preset
     * von {@code privat} setzt den Lead auf den Energiefluss — eine
     * {@code CockpitBlockId}, die es im Portfolio gar nicht gibt. Es dorthin
     * durchzureichen wäre ein Dokument, das die Form-Prüfung zu Recht ablehnt.
     */
    public LayoutDoc presetLayout(String profil, String flaeche) {
        LayoutDoc doc = profil == null ? null : presetLayoutById.get(layoutKey(profil, flaeche));
        return doc == null ? LayoutDoc.leer() : doc;
    }

    private static String layoutKey(String profil, String flaeche) {
        return profil + "\u0000" + flaeche;
    }

    public List<String> vorauswahl(String profil) {
        List<String> ids = new ArrayList<>();
        for (Anwendung a : imRegal) {
            if (a.abschaltbar() && PRESET_AN.equals(a.preset().fuer(profil))) {
                ids.add(a.id());
            }
        }
        return List.copyOf(ids);
    }
}
