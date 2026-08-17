#!/bin/sh
# Nightly mongodump of darbar's own database.
#
# Exists because on 2026-08-17 the ONLY second copy of mission_control was a stale snapshot
# sitting inside the saturn-v2 container, i.e. the thing we were trying to stop depending on.
# A backup that exists because somebody took it by hand is not a backup.
#
# VERIFIES rather than trusting the exit code: restores the archive into a scratch db, compares
# every collection count against live, and only then keeps it. A dump that exits 0 and restores
# to nothing is the failure mode worth catching, and it is invisible until you need it.
set -eu

ROOT="${DARBAR_ROOT:-$HOME/fafo/darbar}"
CONTAINER="${DARBAR_MONGO:-darbar-mongo}"
DB="${DARBAR_DB:-mission_control}"
KEEP="${DARBAR_BACKUP_KEEP:-14}"
DEST="$ROOT/data/backups"
STAMP=$(date +%Y%m%d-%H%M%S)
ARCHIVE="$DEST/${DB}-${STAMP}.gz"

mkdir -p "$DEST"
log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*"; }

if ! docker exec "$CONTAINER" true 2>/dev/null; then
  log "FAIL: container $CONTAINER is not running; no backup taken"
  exit 1
fi

docker exec "$CONTAINER" mongodump --db="$DB" --archive=/tmp/backup.gz --gzip --quiet
docker cp "$CONTAINER:/tmp/backup.gz" "$ARCHIVE"
docker exec "$CONTAINER" rm -f /tmp/backup.gz

# --- verify by restoring, not by believing ---
docker cp "$ARCHIVE" "$CONTAINER:/tmp/verify.gz"
docker exec "$CONTAINER" mongorestore --archive=/tmp/verify.gz --gzip \
  --nsFrom="$DB.*" --nsTo="backup_verify.*" --drop --quiet
MISMATCH=$(docker exec "$CONTAINER" mongosh --quiet --eval "
  const a = db.getSiblingDB('$DB'), b = db.getSiblingDB('backup_verify');
  const bad = a.getCollectionNames().filter(c => a[c].countDocuments({}) !== b[c].countDocuments({}));
  const out = bad.length ? bad.join(',') : 'OK';
  b.dropDatabase();
  print(out);")
docker exec "$CONTAINER" rm -f /tmp/verify.gz

if [ "$MISMATCH" != "OK" ]; then
  mv "$ARCHIVE" "$ARCHIVE.UNVERIFIED"
  log "FAIL: restore mismatch on [$MISMATCH]; kept as $ARCHIVE.UNVERIFIED and NOT counted as a backup"
  exit 1
fi

# Prune only VERIFIED archives, so a run of failures can never age out the last good one.
ls -1t "$DEST"/${DB}-*.gz 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r old; do
  rm -f "$old"; log "pruned $(basename "$old")"
done

log "ok: $(basename "$ARCHIVE") ($(du -h "$ARCHIVE" | cut -f1)), verified, $(ls -1 "$DEST"/${DB}-*.gz | wc -l | tr -d ' ') kept"
