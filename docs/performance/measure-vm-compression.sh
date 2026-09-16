#!/usr/bin/env bash
set -euo pipefail

# Absichtlich kein DB-URL-/Credential-Parameter: Der Lauf startet ausschliesslich
# eine wegwerfbare lokale Testcontainers-Datenbank mit synthetischen Daten.
repo_root="$(cd "$(dirname "$0")/../.." && pwd -P)"
export JAVA_HOME="${VP_JAVA_HOME:-/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home}"

cd "$repo_root/services/api"
exec ./mvnw test -Dtest=VmCompressionMeasurementTest
