#!/bin/bash

# Save current directory
ORIGINAL_DIR=$(pwd)

# Change to the gemini-cli repository directory
cd /Users/hanzhangyin/Documents/GitHub/gemini-cli

# Run the CLI with original directory as target
node scripts/start.js --target-dir "$ORIGINAL_DIR" "$@"

# Return to original directory (optional, since the script will exit)
cd "$ORIGINAL_DIR"