#!/usr/bin/env bash
# Starts only the seven Python agents in the background, logs in .run/ (debugging aid).
cd "$(dirname "$0")/.." || exit 1
mkdir -p .run
for a in "core_router.py" "home_agent.py" "foreign_agent.py --id FA-1" "foreign_agent.py --id FA-2" \
         "foreign_agent.py --id FA-3" "mobile_node.py" "correspondent.py"; do
  n=$(echo "$a" | tr ' ' '_' | tr -d '.-')
  python -u agents/$a > ".run/$n.log" 2>&1 &
done
echo "agents started, logs in .run/"
