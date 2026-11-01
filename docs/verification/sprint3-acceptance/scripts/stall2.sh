#!/bin/sh
# ext:: helper that prints one stderr line, then never answers
echo "stall-helper: waiting for the server" >&2
exec sleep 300
