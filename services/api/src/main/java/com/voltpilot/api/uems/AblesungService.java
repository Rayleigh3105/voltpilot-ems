package com.voltpilot.api.uems;

import static com.voltpilot.api.uems.AblesungAbgelehnt.Grund.*;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.AblesungRepository.Wert;
import com.voltpilot.api.uems.MessreiheKorrekturRepository.Korrektur;
import com.voltpilot.api.uems.MessstelleRepository.Messstelle;
import java.math.BigDecimal;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

/** Ablesungen sind gemessene Stände. Kein Betrag mit Beleg und keine Interpolation (E3, E5, E6). */
@Service
public class AblesungService {
    private static final ObjectMapper JSON = new ObjectMapper();
    private final AblesungRepository werte;
    private final MessstelleRepository messstellen;
    private final MessreiheKorrekturRepository korrekturen;
    private final MessreiheEreignisRepository ereignisse;
    private final AblesungPerioden perioden;
    private final JdbcTemplate jdbc;
    private final TransactionTemplate tx;
    private final com.voltpilot.api.zugriff.RechtPruefung rechte;
    private Clock uhr = Clock.systemUTC();

    public AblesungService(AblesungRepository werte, MessstelleRepository messstellen,
            MessreiheKorrekturRepository korrekturen, MessreiheEreignisRepository ereignisse,
            AblesungPerioden perioden, JdbcTemplate jdbc, PlatformTransactionManager manager,
            com.voltpilot.api.zugriff.RechtPruefung rechte) {
        this.werte=werte; this.messstellen=messstellen; this.korrekturen=korrekturen;
        this.rechte=rechte;
        this.ereignisse=ereignisse; this.perioden=perioden; this.jdbc=jdbc; this.tx=new TransactionTemplate(manager);
    }
    void uhrStellen(Clock clock) { uhr=clock; }

    public record Antwort(String urteil, String korrektur, Wert ablesung, AblesungRegeln.Zeitraum ablesezeitraum) {}

    public List<Wert> lesen(String kz) {
        Messstelle m = finde(kz);
        UUID q = werte.quelle(TenantContext.get(),m.id());
        return q == null ? List.of() : werte.fassungen(TenantContext.get(),q);
    }

    public Antwort eingeben(String kz, String zeitText, String standText, String monatText, boolean monatGesetzt,
            String begruendung, boolean berichtigung, ProtokollAkteur wer) {
        UUID tenant=TenantContext.get();
        Instant jetzt=uhr.instant();
        return tx.execute(t -> {
            Messstelle m=finde(kz);
            boolean vier=werte.vierAugen(tenant);
            werte.sperren(tenant,m.id());
            if (m.archiviertAm()!=null || !"gemessen".equals(m.art())
                    || !"Zählerstand".equals(m.hauptgroesse().wertart())
                    || werte.hatKanal(tenant,m.id())) throw new AblesungAbgelehnt(QUELLE_PASST_NICHT);
            Instant zeit;
            try { zeit=OffsetDateTime.parse(zeitText).toInstant(); }
            catch (RuntimeException e) { throw new AblesungAbgelehnt(ANFRAGE_UNGUELTIG,Map.of("feld","zeitpunkt")); }
            if (!zeit.equals(zeit.truncatedTo(ChronoUnit.MINUTES)) || zeit.isAfter(jetzt))
                throw new AblesungAbgelehnt(ZEITPUNKT_UNGUELTIG);
            var zahl=BezugsdatenRegeln.zahl(standText,"de",false);
            if (zahl.betrag()==null || zahl.betrag().signum()<0 || !Double.isFinite(zahl.betrag().doubleValue()))
                throw new AblesungAbgelehnt(WERT_UNGUELTIG);
            MesswertHerkunft.ablesung(tenant.toString(),m.kennzeichen(),m.hauptgroesse().groesse(),zeit,jetzt,
                    zahl.betrag(),m.hauptgroesse().einheit(),"eingabe",Map.of("sub",wer.sub(),"name",wer.name(),
                            "rolle",wer.rolle(),"art",wer.art()));
            var zone=werte.zone(tenant,m.id(),zeit);
            UUID q=werte.quelle(tenant,m.id());
            if (q==null) {
                if (berichtigung) throw new AblesungAbgelehnt(NICHT_GEFUNDEN);
                q=werte.anlegen(tenant,m,zeit,wer,jetzt);
            }
            List<Wert> alle=werte.werte(tenant,q);
            if (!alle.isEmpty() && zeit.isBefore(alle.get(0).zeitpunkt()))
                throw new AblesungAbgelehnt(ZEITPUNKT_UNGUELTIG);
            Wert alt=alle.stream().filter(a -> a.zeitpunkt().equals(zeit)).findFirst().orElse(null);
            Wert vor=alle.stream().filter(a -> a.zeitpunkt().isBefore(zeit)).reduce((a,b)->b).orElse(null);
            LocalDate monat;
            try { monat=monatGesetzt ? AblesungRegeln.monat(monatText) : alt!=null ? alt.monat() : vor==null ? null
                    : AblesungRegeln.monat(BezugsdatenRegeln.zuordnung(vor.zeitpunkt(),zeit,zone.id()).vorgabe()); }
            catch (RuntimeException e) { throw new AblesungAbgelehnt(ANFRAGE_UNGUELTIG,Map.of("feld","zuordnung_monat")); }
            if (vor==null && monat!=null) throw new AblesungAbgelehnt(ANFRAGE_UNGUELTIG,Map.of("feld","zuordnung_monat"));
            if (alt!=null && alt.stand().compareTo(zahl.betrag())==0 && Objects.equals(alt.monat(),monat))
                return antwort("wiederholung",null,alt,vor,m,zone);
            if (alt!=null && !berichtigung) throw new AblesungAbgelehnt(KONFLIKT);
            if (berichtigung && alt==null) throw new AblesungAbgelehnt(NICHT_GEFUNDEN);
            if (berichtigung && (begruendung==null || begruendung.strip().length()<10 || begruendung.strip().length()>500))
                throw new AblesungAbgelehnt(BEGRUENDUNG_FEHLT);
            if (offen(tenant,m.id(),zeit)) throw new AblesungAbgelehnt(VORSCHLAG_OFFEN);
            Wert neu=new Wert(q,zeit,alt==null?1:alt.fassung()+1,zahl.betrag(),monat,"eingabe",
                    JSON.valueToTree(wer),null,jetzt);
            List<Wert> kandidat=ersetzen(alle,neu);
            pruefeStaende(kandidat);
            // Spätere Erstwerte können endgültige Perioden berühren (z. B. denselben Monat oder das Jahr).
            // Auch dann eine K-Fassung statt eines UPDATE, Erstwerte ohne zusätzliche Freigabe (E6).
            boolean bestehendePeriode=Boolean.TRUE.equals(jdbc.queryForObject("SELECT EXISTS (SELECT 1 FROM "
                    + "messreihe_periode WHERE tenant_id=? AND messstelle_id=? AND ablesung=true)",Boolean.class,tenant,m.id()));
            if (berichtigung || bestehendePeriode) {
                var v=JSON.createObjectNode().put("spur","ablesung").put("messstelle_id",m.id().toString())
                        .put("quelle_id",q.toString()).put("zeitpunkt",zeit.toString());
                v.set("alt",alt==null?JSON.nullNode():fakten(alt)); v.set("neu",fakten(neu));
                List<LocalDate> betroffen = new ArrayList<>();
                java.util.stream.Stream.concat(alle.stream(), kandidat.stream()).forEach(w -> {
                    betroffen.add(w.zeitpunkt().atZone(zone.id()).toLocalDate());
                    if (w.monat() != null) betroffen.add(w.monat());
                });
                Instant von=betroffen.stream().min(LocalDate::compareTo).orElseThrow().withDayOfYear(1)
                        .atStartOfDay(zone.id()).toInstant();
                Instant bis=betroffen.stream().max(LocalDate::compareTo).orElseThrow().withDayOfYear(1)
                        .plusYears(1).atStartOfDay(zone.id()).toInstant();
                Korrektur k=korrekturen.vorschlagen(tenant,new MessreiheKorrekturRepository.Anlage(
                        "ablesestaende_nachgetragen",List.of(MessreiheKorrekturRepository.Reihe.ablesung(m.id(),m.hauptgroesse().groesse())),
                        von,bis,berichtigung?begruendung.strip():"Weitere Ablesung eingetragen.",null,null,
                        JSON.createArrayNode().add(v)),wer,zone.id());
                if (berichtigung && vier) return antwort("vorschlag",k.kennung(),alt,vor,m,zone);
                k=korrekturen.freigeben(tenant,k.kennung(),berichtigung?begruendung.strip():"Weitere Ablesung eingetragen.",wer,false);
                anwenden(tenant,k,false,jetzt);
                Wert gespeichert=werte.werte(tenant,q).stream().filter(a->a.zeitpunkt().equals(zeit)).findFirst().orElseThrow();
                return antwort(berichtigung?"berichtigung":"eingetragen",k.kennung(),gespeichert,vor,m,zone);
            }
            werte.schreiben(tenant,neu);
            perioden.bilden(tenant,m,zone,kandidat,null,0,jetzt);
            return antwort("eingetragen",null,neu,vor,m,zone);
        });
    }

    public void entscheidungPruefen(Korrektur k, String aktion) {
        if (k.anlage() == null || k.anlage().reihen().get(0).messstelleId() == null) return;
        rechte.pruefen(aktion, com.voltpilot.api.zugriff.RechtZiel.MESSSTELLE,
                k.anlage().reihen().get(0).messstelleId(), () -> new AblesungAbgelehnt(NICHT_GEFUNDEN));
    }

    /** In der Transaktion der bestehenden Freigabe-/Rücknahmeroute; Rohwert und Perioden ändern gemeinsam ihre Fassung. */
    public void anwenden(UUID tenant,Korrektur k,boolean ruecknahme,Instant jetzt) {
        if (k.anlage()==null || k.anlage().reihen().get(0).messstelleId()==null) return;
        UUID mId=k.anlage().reihen().get(0).messstelleId();
        werte.sperren(tenant,mId);
        Messstelle m=messstellen.finde(mId).orElseThrow(()->new AblesungAbgelehnt(NICHT_GEFUNDEN));
        JsonNode v=k.anlage().vorschau().get(0);
        UUID q=UUID.fromString(v.path("quelle_id").asText());
        Instant zeit=Instant.parse(v.path("zeitpunkt").asText());
        List<Wert> alle=werte.werte(tenant,q);
        Wert alt=alle.stream().filter(a->a.zeitpunkt().equals(zeit)).findFirst().orElse(null);
        JsonNode ziel=v.path(ruecknahme?"alt":"neu");
        int erwartet=v.path("alt").isNull()?0:v.path("alt").path("fassung").asInt();
        if (ruecknahme ? alt==null || !Objects.equals(alt.korrektur(),k.kennung()) || ziel.isNull()
                : (alt==null?0:alt.fassung())!=erwartet) throw new AblesungAbgelehnt(GLEICHZEITIG);
        Wert neu=new Wert(q,zeit,alt==null?1:alt.fassung()+1,new BigDecimal(ziel.path("stand").asText()),
                ziel.path("monat").isNull()?null:LocalDate.parse(ziel.path("monat").asText()),"eingabe",
                JSON.valueToTree(ruecknahme ? k.fassungen().get(k.fassungen().size()-1).akteur() : k.ersteller()),
                alt==null?null:k.kennung(),jetzt);
        var kandidaten=ersetzen(alle,neu);
        pruefeStaende(kandidaten);
        werte.schreiben(tenant,neu);
        var zone=werte.zone(tenant,mId,zeit);
        perioden.bilden(tenant,m,zone,kandidaten,k.kennung(),k.fassungen().size(),jetzt);
        ObjectNode e=JSON.createObjectNode().put("ereignis_id",UUID.nameUUIDFromBytes(
                (tenant+":"+k.kennung()+":"+k.status()).getBytes(java.nio.charset.StandardCharsets.UTF_8)).toString())
                .put("art","correction").put("von",k.anlage().von().toString()).put("bis",k.anlage().bis().toString())
                .put("messstelle",m.kennzeichen()).put("korrektur",k.kennung()).put("korrektur_art","ablesestaende_nachgetragen")
                .put("status",k.status()).put("fassung_alt",alt==null?1:alt.fassung()).put("fassung_neu",neu.fassung());
        if (alt==null) { e.remove("fassung_alt"); e.remove("fassung_neu"); }
        var ergebnis=ereignisse.anhaengen(tenant,null,EreignisVokabular.Urheber.KUNDE,e,null,jetzt);
        if (ergebnis.ausgang()==MessreiheEreignisRepository.Ausgang.VERWORFEN)
            throw new IllegalStateException("Ablesungs-Korrektur: "+ergebnis);
    }

    private boolean offen(UUID tenant,UUID m,Instant zeit) {
        return Boolean.TRUE.equals(jdbc.queryForObject("SELECT EXISTS (SELECT 1 FROM messreihe_korrektur k "
                + "WHERE k.tenant_id=? AND k.fassung=1 AND k.reihen @> ?::jsonb "
                + "AND k.vorschau->0->>'zeitpunkt'=? AND NOT EXISTS (SELECT 1 FROM messreihe_korrektur f "
                + "WHERE f.tenant_id=k.tenant_id AND f.kennung=k.kennung AND f.fassung>1))",Boolean.class,
                tenant,"[{\"messstelle_id\":\""+m+"\"}]",zeit.toString()));
    }
    private Messstelle finde(String kz) { return messstellen.findeNachKennzeichen(kz)
            .orElseThrow(()->new AblesungAbgelehnt(NICHT_GEFUNDEN)); }
    private static ObjectNode fakten(Wert w) {
        ObjectNode o=JSON.createObjectNode().put("fassung",w.fassung()).put("stand",w.stand().toPlainString());
        if (w.monat()==null) o.putNull("monat"); else o.put("monat",w.monat().toString());
        return o;
    }
    private static List<Wert> ersetzen(List<Wert> alle,Wert w) {
        List<Wert> out=new ArrayList<>(alle.stream().filter(x->!x.zeitpunkt().equals(w.zeitpunkt())).toList());
        out.add(w); out.sort(Comparator.comparing(Wert::zeitpunkt)); return out;
    }
    private static void pruefeStaende(List<Wert> alle) {
        for (int i=1;i<alle.size();i++) if (alle.get(i).stand().compareTo(alle.get(i-1).stand())<0)
            throw new AblesungAbgelehnt(RUECKSPRUNG);
    }
    private static Antwort antwort(String urteil,String k,Wert w,Wert vor,Messstelle m,AblesungRepository.Zone z) {
        return new Antwort(urteil,k,w,vor==null?null:AblesungRegeln.zeitraum(vor.zeitpunkt(),vor.stand(),
                w.zeitpunkt(),w.stand(),m.hauptgroesse().einheit(),z.id()));
    }
}
