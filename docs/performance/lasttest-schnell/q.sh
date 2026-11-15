#!/bin/sh
PGPASSWORD=voltpilot_dev_pw exec psql -X -q -t -A -F"|" -h 127.0.0.1 -p 25432 -U voltpilot -d voltpilot "$@"
