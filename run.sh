#!/bin/bash
while true; do
  cd /home/node/.openclaw/workspace/crypto-live-validator
  node src/index.mjs --live >> logs/validator-$(date +%Y-%m-%d).log 2>&1
  echo "[RESTART] $(date)" >> logs/restart.log
  sleep 5
done
