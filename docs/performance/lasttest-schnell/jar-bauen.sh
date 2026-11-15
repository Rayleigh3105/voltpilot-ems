#!/bin/bash
# Baut den api-Jar eines Commits aus einem git-archive-Export (nie im Worktree, der bleibt frei).
# Aufruf: jar-bauen.sh <commit> <name>   -> jars/<name>.jar
set -eu
LAB=$(cd "$(dirname "$0")" && pwd)
WT=$(git -C "$LAB" rev-parse --show-toplevel)
C=$1; N=$2
B=$LAB/bau/$N
rm -rf "$B"; mkdir -p "$B"
git -C "$WT" archive "$C" -- services/api catalog/measurement-points/dist docs/contracts \
  edge-light/gehaeuse/glinet-gl-mt300n-v2/druck infra/local/keycloak | tar -x -C "$B"
export JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home
cd "$B/services/api"
./mvnw -q -o -Dmaven.test.skip=true package > "$LAB/bau-$N.log" 2>&1 || ./mvnw -q -Dmaven.test.skip=true package >> "$LAB/bau-$N.log" 2>&1
cp target/voltpilot-api-0.1.0-SNAPSHOT.jar "$LAB/jars/$N.jar"
echo "$C" > "$LAB/jars/$N.commit"
rm -rf "$B"
echo "jar $N fertig ($C)"
