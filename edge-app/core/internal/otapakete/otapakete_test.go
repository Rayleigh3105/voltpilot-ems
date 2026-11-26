package otapakete

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"strings"
	"testing"
)

type datei struct {
	name   string
	inhalt []byte
}

func tgz(t *testing.T, dateien ...datei) []byte {
	t.Helper()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	for _, d := range dateien {
		if err := tw.WriteHeader(&tar.Header{Name: d.name, Mode: 0o644, Size: int64(len(d.inhalt)), Typeflag: tar.TypeReg}); err != nil {
			t.Fatal(err)
		}
		_, _ = tw.Write(d.inhalt)
	}
	_ = tw.Close()
	_ = gz.Close()
	return buf.Bytes()
}

func sum(b []byte) string { s := sha256.Sum256(b); return hex.EncodeToString(s[:]) }

func TestLiesPrueftInhaltUndDateien(t *testing.T) {
	ovpn := []byte("openvpn apk attrappe")
	kmod := []byte("kmod-tun apk attrappe")
	inhalt := "openwrt 25.12.5\narch mipsel_24kc\n" +
		sum(ovpn) + "  openvpn-mbedtls-2.7.8-r1.apk\n" +
		sum(kmod) + "  kmod-tun-6.12.94-r1.apk\n"
	roh := tgz(t,
		datei{"pakete/INHALT", []byte(inhalt)},
		datei{"pakete/openvpn-mbedtls-2.7.8-r1.apk", ovpn},
		datei{"pakete/kmod-tun-6.12.94-r1.apk", kmod})
	in, err := Lies(roh)
	if err != nil {
		t.Fatal(err)
	}
	if in.OpenWrt != "25.12.5" || in.Arch != "mipsel_24kc" || len(in.Eintraege) != 2 {
		t.Fatalf("%+v", in)
	}
	e := in.Eintraege[0]
	if e.Paket() != "openvpn-mbedtls-2.7.8-r1" || e.Name() != "openvpn-mbedtls" {
		t.Fatalf("Paket %q, Name %q", e.Paket(), e.Name())
	}
	if in.Eintraege[1].Name() != "kmod-tun" {
		t.Fatalf("Name %q", in.Eintraege[1].Name())
	}
	if !bytes.Equal(in.Dateien["openvpn-mbedtls-2.7.8-r1.apk"], ovpn) {
		t.Fatal("Dateibytes")
	}
}

func TestLiesLehntKaputtesAb(t *testing.T) {
	ovpn := []byte("openvpn apk attrappe")
	zeile := sum(ovpn) + "  openvpn-mbedtls-2.7.8-r1.apk\n"
	kopf := "openwrt 25.12.5\narch mipsel_24kc\n"
	faelle := map[string][]byte{
		"kein gzip":   []byte("kein gzip"),
		"ohne INHALT": tgz(t, datei{"pakete/openvpn-mbedtls-2.7.8-r1.apk", ovpn}),
		"Datei ausserhalb pakete/": tgz(t,
			datei{"pakete/INHALT", []byte(kopf + zeile)},
			datei{"anders/openvpn-mbedtls-2.7.8-r1.apk", ovpn}),
		"Pfad im Namen": tgz(t,
			datei{"pakete/INHALT", []byte(kopf + zeile)},
			datei{"pakete/../openvpn-mbedtls-2.7.8-r1.apk", ovpn}),
		"falsche Pruefsumme": tgz(t,
			datei{"pakete/INHALT", []byte(kopf + strings.Repeat("0", 64) + "  openvpn-mbedtls-2.7.8-r1.apk\n")},
			datei{"pakete/openvpn-mbedtls-2.7.8-r1.apk", ovpn}),
		"Datei ohne INHALT-Zeile": tgz(t,
			datei{"pakete/INHALT", []byte(kopf + zeile)},
			datei{"pakete/openvpn-mbedtls-2.7.8-r1.apk", ovpn},
			datei{"pakete/fremd.apk", []byte("fremd")}),
		"INHALT nennt fehlende Datei": tgz(t,
			datei{"pakete/INHALT", []byte(kopf + zeile + sum(ovpn) + "  kmod-tun-6.12.94-r1.apk\n")},
			datei{"pakete/openvpn-mbedtls-2.7.8-r1.apk", ovpn}),
		"keine Architektur": tgz(t,
			datei{"pakete/INHALT", []byte("openwrt 25.12.5\n" + zeile)},
			datei{"pakete/openvpn-mbedtls-2.7.8-r1.apk", ovpn}),
		"keine .apk-Datei": tgz(t,
			datei{"pakete/INHALT", []byte(kopf + sum(ovpn) + "  openvpn.txt\n")},
			datei{"pakete/openvpn.txt", ovpn}),
	}
	for name, roh := range faelle {
		if _, err := Lies(roh); err == nil {
			t.Errorf("%s: angenommen", name)
		}
	}
}
