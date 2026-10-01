#!/bin/sh
set -eu

backup_dir=/var/lib/maximum/backups
mkdir -p "$backup_dir"
database_url=$(sed 's/^DATABASE_URL=//' /etc/maximum/postgres-environment)
timestamp=$(date -u +%Y%m%dT%H%M%SZ)
temporary="$backup_dir/maximum-$timestamp.dump.tmp"
target="$backup_dir/maximum-$timestamp.dump"

pg_dump "$database_url" --format=custom --file="$temporary"
chown maximum:maximum "$temporary"
chmod 0600 "$temporary"
mv "$temporary" "$target"
find "$backup_dir" -type f -name 'maximum-*.dump' -mtime +14 -delete
