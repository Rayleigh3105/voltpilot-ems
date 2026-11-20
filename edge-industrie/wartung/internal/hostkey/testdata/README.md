# Host-Schlüssel für den Test

Echte Dateien, wie Dropbear sie schreibt (`dropbearkey -t <art> -f <datei>`), mit dem öffentlichen Teil daneben (`dropbearkey -y -f <datei>`).
RSA und Ed25519 stammen aus Dropbear 2025.89 (OpenWrt 25.12.5), die drei ECDSA-Schlüssel aus dem Dropbear von Alpine 3.20.
Sie wurden nur für diesen Test erzeugt und gehören zu keinem Gerät.
Den ungekürzten privaten ECDSA-Wert, wie ihn der Dropbear 2022.82 des PFC200 schreibt, baut der Test aus `dropbear_ecdsa_host_key` selbst.
